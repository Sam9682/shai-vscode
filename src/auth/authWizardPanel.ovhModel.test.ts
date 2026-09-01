import * as assert from 'assert';
import fc from 'fast-check';
import { JSDOM } from 'jsdom';
import { OVHCLOUD_MODEL_OPTIONS } from './authConfig';
import { nonBlankString } from './testUtils.gen';

/**
 * Feature: profile-inline-edit, Property 5: OVHcloud model prefill round-trips
 *
 * For any profile whose provider is `ovhcloud`: if its `model` is present in
 * `OVHCLOUD_MODEL_OPTIONS` then Edit_Mode prefill preselects that model in the
 * dropdown; otherwise prefill selects the "Other…" option and places the model
 * in the custom input. In both cases the model read back from the controls
 * equals the profile's original `model`.
 *
 * Validates: Requirements 2.6, 2.7
 *
 * ---------------------------------------------------------------------------
 * NOTE ON APPROACH (mirror, not import):
 *
 * The real OVH model logic lives in the `prefillForm` (OVH branch),
 * `renderModelControls`, and `getModelValue` functions embedded as an inline
 * webview script (a template string) inside `getWizardHtml` in
 * `src/auth/authWizardPanel.ts`. Those functions are not exported and cannot
 * be imported, so — per the design's Testing Strategy ("The webview helpers
 * are tested by extracting/exercising them against a DOM (e.g. jsdom) or by
 * testing their pure mapping equivalents") — the OVH model-control logic below
 * is a faithful MIRROR of the production code.
 *
 * Mirror source (src/auth/authWizardPanel.ts):
 *   - `renderModelControls(providerId)` — populates #modelOvh with each
 *     OVHCLOUD_MODEL_OPTIONS value followed by a single Other… option whose
 *     value is OVH_CUSTOM.
 *   - `prefillForm(profile)` OVH branch — if profile.model is in the options
 *     list, set modelOvh.value = profile.model and clear the custom input;
 *     else set modelOvh.value = OVH_CUSTOM, modelOvhCustom.value = profile.model,
 *     then syncOvhCustom().
 *   - `getModelValue()` OVH branch — if modelOvh.value === OVH_CUSTOM return the
 *     trimmed custom value, else return the trimmed dropdown value.
 *
 * If the production OVH model logic changes, this mirror should be updated to
 * match so drift stays detectable.
 * ---------------------------------------------------------------------------
 */

// Mirror of `var OVH_CUSTOM = '__custom__';` in authWizardPanel.ts.
const OVH_CUSTOM = '__custom__';

/** Elements the mirror operates on, matching the webview control ids. */
interface OvhControls {
    modelOvh: HTMLSelectElement;
    modelOvhCustom: HTMLInputElement;
    modelLabel: HTMLLabelElement;
}

function makeControls(): { dom: JSDOM; controls: OvhControls } {
    const dom = new JSDOM(
        '<!DOCTYPE html><html><body>' +
            '<label id="modelLabel" for="model"></label>' +
            '<select id="modelOvh"></select>' +
            '<input type="text" id="modelOvhCustom" class="hidden" />' +
            '</body></html>'
    );
    const document = dom.window.document;
    return {
        dom,
        controls: {
            modelOvh: document.getElementById('modelOvh') as HTMLSelectElement,
            modelOvhCustom: document.getElementById('modelOvhCustom') as HTMLInputElement,
            modelLabel: document.getElementById('modelLabel') as HTMLLabelElement,
        },
    };
}

// Mirror of `syncOvhCustom()` in authWizardPanel.ts.
function syncOvhCustom(c: OvhControls): void {
    if (!c.modelOvh || !c.modelOvhCustom) {
        return;
    }
    const show = c.modelOvh.value === OVH_CUSTOM;
    c.modelOvhCustom.classList.toggle('hidden', !show);
    if (c.modelLabel) {
        c.modelLabel.setAttribute('for', show ? 'modelOvhCustom' : 'modelOvh');
    }
}

// Mirror of the OVH portion of `renderModelControls(providerId)` in
// authWizardPanel.ts (isOvh === true path).
function renderModelControls(document: Document, c: OvhControls): void {
    c.modelOvh.innerHTML = '';
    OVHCLOUD_MODEL_OPTIONS.forEach(function (mid) {
        const o = document.createElement('option');
        o.value = mid;
        o.textContent = mid;
        c.modelOvh.appendChild(o);
    });
    const oth = document.createElement('option');
    oth.value = OVH_CUSTOM;
    oth.textContent = 'Other…';
    c.modelOvh.appendChild(oth);
    c.modelOvh.selectedIndex = 0;
    syncOvhCustom(c);
    if (c.modelLabel) {
        c.modelLabel.setAttribute('for', 'modelOvh');
    }
}

// Mirror of the OVH branch of `prefillForm(profile)` in authWizardPanel.ts.
function prefillFormOvh(c: OvhControls, profile: { model: string }): void {
    const opts = OVHCLOUD_MODEL_OPTIONS;
    if (opts.indexOf(profile.model) !== -1) {
        c.modelOvh.value = profile.model;
        c.modelOvhCustom.value = '';
    } else {
        c.modelOvh.value = OVH_CUSTOM;
        c.modelOvhCustom.value = profile.model || '';
    }
    syncOvhCustom(c);
}

// Mirror of the OVH branch of `getModelValue()` in authWizardPanel.ts.
function getModelValueOvh(c: OvhControls): string {
    if (c.modelOvh.value === OVH_CUSTOM) {
        return (c.modelOvhCustom.value || '').trim();
    }
    return (c.modelOvh.value || '').trim();
}

describe('OVHcloud model prefill — Property 5: OVHcloud model prefill round-trips', () => {
    it('preset case: prefill preselects the matching dropdown option and reads back the model', () => {
        fc.assert(
            fc.property(fc.constantFrom(...OVHCLOUD_MODEL_OPTIONS), (model) => {
                const { dom, controls } = makeControls();
                renderModelControls(dom.window.document, controls);

                prefillFormOvh(controls, { model });

                // Preset case: dropdown holds the model, not the custom sentinel.
                assert.strictEqual(controls.modelOvh.value, model);
                assert.notStrictEqual(controls.modelOvh.value, OVH_CUSTOM);

                // Read-back effective model equals the original.
                assert.strictEqual(getModelValueOvh(controls), model);
            }),
            { numRuns: 100 }
        );
    });

    it('custom case: prefill selects Other… and fills the custom input, reading back the model', () => {
        // A non-blank model that is NOT one of the preset options. Constrained
        // to already-trimmed values so the round-trip through getModelValue
        // (which trims) can be asserted against the original model verbatim.
        const customModel = nonBlankString()
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && OVHCLOUD_MODEL_OPTIONS.indexOf(s) === -1);
        fc.assert(
            fc.property(customModel, (model) => {
                const { dom, controls } = makeControls();
                renderModelControls(dom.window.document, controls);

                prefillFormOvh(controls, { model });

                // Custom case: dropdown holds the custom sentinel and the custom
                // input carries the model value.
                assert.strictEqual(controls.modelOvh.value, OVH_CUSTOM);
                assert.strictEqual(controls.modelOvhCustom.value, model);

                // Read-back effective model equals the profile's original model.
                assert.strictEqual(getModelValueOvh(controls), model);
            }),
            { numRuns: 100 }
        );
    });
});
