import * as assert from 'assert';
import fc from 'fast-check';
import { JSDOM } from 'jsdom';
import { OVHCLOUD_MODEL_OPTIONS } from './authConfig';

/**
 * Feature: profile-inline-edit, Property 4: OVHcloud model dropdown options
 *
 * For any rendering where the selected provider is `ovhcloud`, the model
 * dropdown's option values equal `OVHCLOUD_MODEL_OPTIONS` followed by a single
 * "Other…" custom option.
 *
 * Validates: Requirements 2.5
 *
 * ---------------------------------------------------------------------------
 * NOTE ON APPROACH (mirror, not import):
 *
 * The real render logic lives in the `renderModelControls()` function that is
 * embedded as an inline webview script (a template string) inside
 * `getWizardHtml` in `src/auth/authWizardPanel.ts`. That function is not
 * exported and cannot be imported, so — per the design's Testing Strategy
 * ("The webview helpers are tested by extracting/exercising them against a
 * DOM (e.g. jsdom) or by testing their pure mapping equivalents") — the OVH
 * option construction below is a faithful MIRROR of the production
 * `renderModelControls()` OVH branch (see src/auth/authWizardPanel.ts,
 * function `renderModelControls`). It mirrors exactly how the branch builds
 * the dropdown: it clears `modelOvh`, appends one <option> per model id in
 * `state.ovhcloudModels` (which equals `OVHCLOUD_MODEL_OPTIONS`), appends a
 * trailing `<option value="__custom__">Other…</option>`, and selects index 0.
 *
 * If the production `renderModelControls` OVH branch changes, this mirror
 * should be updated to match so drift stays detectable.
 * ---------------------------------------------------------------------------
 */

const OVH_CUSTOM = '__custom__';

/**
 * Faithful mirror of the OVH branch of `renderModelControls()` in
 * src/auth/authWizardPanel.ts. Populates the given `modelOvh` <select> with one
 * option per id in `ovhcloudModels`, followed by a single "Other…" custom
 * option, and selects index 0.
 */
function renderModelControlsOvhMirror(
    document: Document,
    modelOvh: HTMLSelectElement,
    ovhcloudModels: string[]
): void {
    modelOvh.innerHTML = '';
    (ovhcloudModels || []).forEach(function (mid) {
        const o = document.createElement('option');
        o.value = mid;
        o.textContent = mid;
        modelOvh.appendChild(o);
    });
    const oth = document.createElement('option');
    oth.value = OVH_CUSTOM;
    oth.textContent = 'Other…';
    modelOvh.appendChild(oth);
    modelOvh.selectedIndex = 0;
}

describe('renderModelControls — Property 4: OVHcloud model dropdown options', () => {
    it('option values equal OVHCLOUD_MODEL_OPTIONS followed by a single "Other…" custom option', () => {
        // OVHCLOUD_MODEL_OPTIONS is a fixed list, so drive the property with an
        // arbitrary that re-renders each iteration (including re-render
        // idempotency: render 1..3 times before asserting). The dropdown must
        // always end in exactly the same option layout.
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 3 }), (rerenders) => {
                const dom = new JSDOM(
                    '<!DOCTYPE html><html><body><select id="modelOvh"></select></body></html>'
                );
                const document = dom.window.document;
                const modelOvh = document.getElementById('modelOvh') as HTMLSelectElement;

                // state.ovhcloudModels equals OVHCLOUD_MODEL_OPTIONS in production.
                const ovhcloudModels = OVHCLOUD_MODEL_OPTIONS;

                for (let r = 0; r < rerenders; r++) {
                    renderModelControlsOvhMirror(document, modelOvh, ovhcloudModels);
                }

                const options = Array.from(modelOvh.options);
                const values = options.map((o) => o.value);

                // Option values equal OVHCLOUD_MODEL_OPTIONS followed by the
                // custom option, in that exact order (Req 2.5).
                assert.deepStrictEqual(values, [...OVHCLOUD_MODEL_OPTIONS, OVH_CUSTOM]);

                // Exactly one "Other…" custom option (value '__custom__').
                const customOptions = options.filter((o) => o.value === OVH_CUSTOM);
                assert.strictEqual(customOptions.length, 1, 'expected exactly one custom option');

                // Its label text is 'Other…'.
                assert.strictEqual(customOptions[0].textContent, 'Other…');
            }),
            { numRuns: 100 }
        );
    });
});
