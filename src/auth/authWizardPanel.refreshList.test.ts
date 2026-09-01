import * as assert from 'assert';
import fc from 'fast-check';
import { JSDOM } from 'jsdom';
import { updateProviderAt, ShaiAuthConfig } from './authConfig';
import { validAuthConfig, validProviderConfig } from './testUtils.gen';

/**
 * Feature: profile-inline-edit, Property 12: Refreshed list reflects updated
 * values
 *
 * For any configuration and any valid update, re-rendering the profile list
 * after the update shows the target row's provider and model text equal to the
 * submitted provider and model.
 *
 * Validates: Requirements 4.8
 *
 * ---------------------------------------------------------------------------
 * NOTE ON APPROACH (mirror, not import):
 *
 * The real render logic lives in the `renderExisting()` function that is
 * embedded as an inline webview script (a template string) inside
 * `getWizardHtml` in `src/auth/authWizardPanel.ts`. That function is not
 * exported and cannot be imported, so — per the design's Testing Strategy
 * ("The webview helpers are tested by exercising them against a DOM (e.g.
 * jsdom) or by testing their pure mapping equivalents") — the row construction
 * below is a faithful MIRROR of the production `renderExisting()` (see
 * src/auth/authWizardPanel.ts, function `renderExisting`). Each row's label
 * text is built as `p.provider + ' — ' + p.model` in a `<span>` inside
 * `.profile-row` > `.profile-line` > `label.inline`.
 *
 * This mirror matches the one already used in
 * src/auth/authWizardPanel.renderExisting.test.ts. If the production
 * `renderExisting` row shape changes, both mirrors should be updated to match
 * so drift stays detectable.
 *
 * This test exercises the end-to-end refresh: it applies a valid update to a
 * config via the real `updateProviderAt` (imported from authConfig.ts), then
 * renders the list from the mutated config and asserts the target row's
 * displayed text reflects the updated provider and model.
 * ---------------------------------------------------------------------------
 */

/**
 * Faithful mirror of the per-row label construction from `renderExisting()` in
 * src/auth/authWizardPanel.ts. Renders the profile list into the given
 * document's `existingList` element and returns the label span text for each
 * row, in order.
 */
function renderExistingMirror(document: Document, existingList: Element, config: ShaiAuthConfig): string[] {
    existingList.innerHTML = '';
    const provs = (config && config.providers) || [];
    const texts: string[] = [];
    if (provs.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No profiles yet — use + to add one.';
        existingList.appendChild(li);
        return texts;
    }
    const canDelete = provs.length > 1;
    const sel = typeof config.selected_provider === 'number' ? config.selected_provider : 0;
    const selectedIdx = Math.min(sel, provs.length - 1);
    provs.forEach(function (p, i) {
        const li = document.createElement('li');
        li.className = 'profile-row';
        const line = document.createElement('div');
        line.className = 'profile-line';
        const id = 'ep_' + i;
        const lab = document.createElement('label');
        lab.className = 'inline';
        lab.innerHTML =
            '<input type="radio" name="which" value="' + i + '" id="' + id + '" ' +
            (i === selectedIdx ? 'checked' : '') + ' />';
        const span = document.createElement('span');
        // Row label text mirrors production renderExisting: provider — model.
        span.textContent = p.provider + ' — ' + p.model;
        lab.appendChild(span);
        line.appendChild(lab);
        const trail = document.createElement('div');
        trail.className = 'profile-trailing';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'secondary btn-edit';
        edit.textContent = 'Edit';
        edit.dataset.index = String(i);
        trail.appendChild(edit);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'secondary btn-del';
        del.textContent = 'Delete';
        (del as HTMLButtonElement).disabled = !canDelete;
        del.dataset.index = String(i);
        trail.appendChild(del);
        li.appendChild(line);
        li.appendChild(trail);
        existingList.appendChild(li);
        texts.push(span.textContent || '');
    });
    return texts;
}

describe('renderExisting — Property 12: refreshed list reflects updated values', () => {
    it('shows the target row provider/model text equal to the submitted values after a valid update', () => {
        const scenario = validAuthConfig().chain((config) =>
            fc.record({
                config: fc.constant(config),
                index: fc.integer({ min: 0, max: config.providers.length - 1 }),
                submission: validProviderConfig(),
            })
        );

        fc.assert(
            fc.property(scenario, ({ config, index, submission }) => {
                // Apply a valid update via the real backend mutation.
                const err = updateProviderAt(
                    config,
                    index,
                    submission.provider,
                    submission.env_vars,
                    submission.model
                );
                assert.strictEqual(err, null, `expected success, got: ${err}`);

                // Re-render the list from the mutated config.
                const dom = new JSDOM('<!DOCTYPE html><html><body><ul id="existingList"></ul></body></html>');
                const document = dom.window.document;
                const existingList = document.getElementById('existingList')!;

                const texts = renderExistingMirror(document, existingList, config);

                // updateProviderAt writes the trimmed provider/model, so the row
                // reflects the trimmed submitted values.
                const expectedProvider = submission.provider.trim();
                const expectedModel = submission.model.trim();

                assert.strictEqual(
                    texts[index],
                    expectedProvider + ' — ' + expectedModel,
                    `row ${index} text should reflect the submitted provider/model`
                );
            }),
            { numRuns: 100 }
        );
    });
});
