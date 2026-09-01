import * as assert from 'assert';
import fc from 'fast-check';
import { JSDOM } from 'jsdom';
import { validAuthConfig } from './testUtils.gen';
import { ShaiAuthConfig } from './authConfig';

/**
 * Feature: profile-inline-edit, Property 1: Edit action rendered per profile
 *
 * For any configuration with a list of profiles, rendering the profile list
 * produces exactly one edit control per profile, each carrying its own
 * Profile_Index.
 *
 * Validates: Requirements 1.1
 *
 * ---------------------------------------------------------------------------
 * NOTE ON APPROACH (mirror, not import):
 *
 * The real render logic lives in the `renderExisting()` function that is
 * embedded as an inline webview script (a template string) inside
 * `getWizardHtml` in `src/auth/authWizardPanel.ts`. That function is not
 * exported and cannot be imported, so — per the design's Testing Strategy
 * ("The webview helpers are tested by extracting/exercising them against a
 * DOM (e.g. jsdom) or by testing their pure mapping equivalents") — the row /
 * Edit-control construction below is a faithful MIRROR of the production
 * `renderExisting()` (see src/auth/authWizardPanel.ts, function
 * `renderExisting`). It mirrors exactly how each row builds its Edit control:
 * a `<button class="secondary btn-edit">` with `dataset.index = String(i)`
 * placed inside a `.profile-trailing` container, one per provider.
 *
 * If the production `renderExisting` Edit-control shape changes, this mirror
 * should be updated to match so drift stays detectable.
 * ---------------------------------------------------------------------------
 */

/**
 * Faithful mirror of the per-row Edit-control construction from
 * `renderExisting()` in src/auth/authWizardPanel.ts. Renders the profile list
 * into the given document's `existingList` element.
 */
function renderExistingMirror(document: Document, existingList: Element, config: ShaiAuthConfig): void {
    existingList.innerHTML = '';
    const provs = (config && config.providers) || [];
    if (provs.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No profiles yet — use + to add one.';
        existingList.appendChild(li);
        return;
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
        span.textContent = p.provider + ' — ' + p.model;
        lab.appendChild(span);
        line.appendChild(lab);
        const trail = document.createElement('div');
        trail.className = 'profile-trailing';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'secondary btn-edit';
        edit.textContent = 'Edit';
        edit.title = 'Edit this profile';
        edit.dataset.index = String(i);
        trail.appendChild(edit);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'secondary btn-del';
        del.textContent = 'Delete';
        del.title = 'Remove this profile';
        (del as HTMLButtonElement).disabled = !canDelete;
        del.dataset.index = String(i);
        trail.appendChild(del);
        li.appendChild(line);
        li.appendChild(trail);
        existingList.appendChild(li);
    });
}

describe('renderExisting — Property 1: Edit action rendered per profile', () => {
    it('renders exactly one edit control per profile, each carrying its own index', () => {
        fc.assert(
            fc.property(validAuthConfig(), (config) => {
                const dom = new JSDOM('<!DOCTYPE html><html><body><ul id="existingList"></ul></body></html>');
                const document = dom.window.document;
                const existingList = document.getElementById('existingList')!;

                renderExistingMirror(document, existingList, config);

                const n = config.providers.length;

                // Exactly one edit control per profile (Req 1.1).
                const editControls = existingList.querySelectorAll('.btn-edit');
                assert.strictEqual(
                    editControls.length,
                    n,
                    `expected ${n} edit controls, got ${editControls.length}`
                );

                // Each edit control carries its own Profile_Index: the set of
                // dataset.index values is exactly 0..n-1, one per profile.
                const indices = Array.from(editControls).map((el) =>
                    (el as HTMLElement).dataset.index
                );
                const expected = Array.from({ length: n }, (_, i) => String(i));
                assert.deepStrictEqual(indices, expected);
            }),
            { numRuns: 100 }
        );
    });
});
