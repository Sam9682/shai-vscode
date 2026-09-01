import * as assert from 'assert';
import fc from 'fast-check';
import { JSDOM } from 'jsdom';
import { validProviderConfig } from './testUtils.gen';
import {
    ProviderConfig,
    PROVIDER_ENV_FIELDS,
    OVHCLOUD_MODEL_OPTIONS,
    EnvField,
} from './authConfig';

/**
 * Feature: profile-inline-edit, Property 2: Edit_Mode prefill mirrors the stored profile
 *
 * For any profile in the configuration, entering Edit_Mode for that profile
 * stores its Profile_Index, sets the provider select to the profile's
 * `provider`, renders exactly the Env_Field inputs defined by that provider's
 * schema, populates each rendered Env_Field (including secret fields) with the
 * corresponding stored `env_vars` value, and sets the effective model control
 * value to the profile's `model`.
 *
 * Validates: Requirements 1.3, 1.4, 1.5, 1.6, 1.7, 3.1
 *
 * ---------------------------------------------------------------------------
 * NOTE ON APPROACH (mirror, not import):
 *
 * `enterEditMode`, `prefillForm`, `renderEnvInputs`, `renderModelControls`, and
 * `getModelValue` live inside an inline webview script (a template string)
 * embedded in `getWizardHtml` in `src/auth/authWizardPanel.ts`. Those functions
 * are not exported and cannot be imported, so — per the design's Testing
 * Strategy ("The webview helpers are tested by extracting/exercising them
 * against a DOM (e.g. jsdom) or by testing their pure mapping equivalents") —
 * the helpers below are faithful MIRRORS of the production implementations
 * (see src/auth/authWizardPanel.ts, functions `enterEditMode`, `prefillForm`,
 * `renderEnvInputs`, `renderModelControls`, `getModelValue`, and the
 * `OVH_CUSTOM = '__custom__'` constant).
 *
 * If the production implementations change, these mirrors should be updated to
 * match so drift stays detectable.
 * ---------------------------------------------------------------------------
 */

const OVH_CUSTOM = '__custom__';

/**
 * A minimal, mutable copy of the webview `state` used by the mirrored helpers.
 * In production this is populated from the host `init` message; here we build
 * it from the real `PROVIDER_ENV_FIELDS` / `OVHCLOUD_MODEL_OPTIONS` exports.
 */
interface WizardState {
    config: { providers: ProviderConfig[] } | null;
    envFieldSchema: Record<string, EnvField[]>;
    ovhcloudModels: string[];
    editingIndex: number | null;
}

/**
 * The set of DOM elements the mirrored helpers operate on, matching the ids in
 * the wizard's form markup (`newProvider`, `envFields`, `model`, `modelOvh`,
 * `modelOvhCustom`, `modelLabel`).
 */
interface WizardDom {
    document: Document;
    newProvider: HTMLSelectElement;
    envFields: HTMLElement;
    model: HTMLInputElement;
    modelOvh: HTMLSelectElement;
    modelOvhCustom: HTMLInputElement;
    modelLabel: HTMLElement;
}

/** Build a jsdom DOM mirroring the wizard's Profile_Form elements. */
function buildDom(): WizardDom {
    const dom = new JSDOM(
        '<!DOCTYPE html><html><body>' +
            '<select id="newProvider"></select>' +
            '<div id="envFields"></div>' +
            '<label id="modelLabel" for="model"></label>' +
            '<input id="model" type="text" />' +
            '<select id="modelOvh"></select>' +
            '<input id="modelOvhCustom" type="text" />' +
            '</body></html>'
    );
    const document = dom.window.document;
    return {
        document,
        newProvider: document.getElementById('newProvider') as HTMLSelectElement,
        envFields: document.getElementById('envFields') as HTMLElement,
        model: document.getElementById('model') as HTMLInputElement,
        modelOvh: document.getElementById('modelOvh') as HTMLSelectElement,
        modelOvhCustom: document.getElementById('modelOvhCustom') as HTMLInputElement,
        modelLabel: document.getElementById('modelLabel') as HTMLElement,
    };
}

/**
 * Populate the provider <select> with one <option> per known provider so that
 * `newProvider.value = providerId` resolves to a real option (mirrors the
 * effect of `renderProviderSelect`).
 */
function populateProviderSelect(dom: WizardDom, providerIds: string[]): void {
    dom.newProvider.innerHTML = '';
    providerIds.forEach((id) => {
        const o = dom.document.createElement('option');
        o.value = id;
        o.textContent = id;
        dom.newProvider.appendChild(o);
    });
}

/** Faithful mirror of `renderEnvInputs` from authWizardPanel.ts. */
function renderEnvInputs(dom: WizardDom, state: WizardState, providerId: string): void {
    dom.envFields.innerHTML = '';
    const fields = state.envFieldSchema[providerId] || [];
    fields.forEach(function (f) {
        const wrap = dom.document.createElement('div');
        wrap.className = 'row';
        const lab = dom.document.createElement('label');
        lab.setAttribute('for', 'env_' + f.key);
        lab.textContent = f.label + (f.optional ? ' (optional)' : '');
        const inp = dom.document.createElement('input');
        inp.id = 'env_' + f.key;
        inp.dataset.key = f.key;
        inp.type = f.secret ? 'password' : 'text';
        inp.autocomplete = 'off';
        if (f.placeholder) inp.placeholder = f.placeholder;
        wrap.appendChild(lab);
        wrap.appendChild(inp);
        dom.envFields.appendChild(wrap);
    });
}

/** Faithful mirror of `syncOvhCustom` from authWizardPanel.ts. */
function syncOvhCustom(dom: WizardDom): void {
    if (!dom.modelOvh || !dom.modelOvhCustom) return;
    const show = dom.modelOvh.value === OVH_CUSTOM;
    dom.modelOvhCustom.classList.toggle('hidden', !show);
    if (dom.modelLabel) dom.modelLabel.setAttribute('for', show ? 'modelOvhCustom' : 'modelOvh');
}

/** Faithful mirror of `renderModelControls` from authWizardPanel.ts. */
function renderModelControls(dom: WizardDom, state: WizardState, providerId: string): void {
    const isOvh = providerId === 'ovhcloud';
    if (dom.model) dom.model.classList.toggle('hidden', isOvh);
    if (dom.modelOvh) {
        dom.modelOvh.classList.toggle('hidden', !isOvh);
        if (isOvh) {
            dom.modelOvh.innerHTML = '';
            (state.ovhcloudModels || []).forEach(function (mid) {
                const o = dom.document.createElement('option');
                o.value = mid;
                o.textContent = mid;
                dom.modelOvh.appendChild(o);
            });
            const oth = dom.document.createElement('option');
            oth.value = OVH_CUSTOM;
            oth.textContent = 'Other…';
            dom.modelOvh.appendChild(oth);
            dom.modelOvh.selectedIndex = 0;
        }
    }
    if (dom.modelOvhCustom) {
        if (!isOvh) {
            dom.modelOvhCustom.classList.add('hidden');
            dom.modelOvhCustom.value = '';
        } else {
            syncOvhCustom(dom);
        }
    }
    if (dom.modelLabel) dom.modelLabel.setAttribute('for', isOvh ? 'modelOvh' : 'model');
}

/** Faithful mirror of `prefillForm` from authWizardPanel.ts. */
function prefillForm(dom: WizardDom, state: WizardState, profile: ProviderConfig): void {
    if (!profile) return;
    const providerId = profile.provider;
    if (dom.newProvider) dom.newProvider.value = providerId;
    // Env fields: render the schema inputs then populate each from env_vars.
    renderEnvInputs(dom, state, providerId);
    const envVars = profile.env_vars || {};
    const fields = state.envFieldSchema[providerId] || [];
    fields.forEach(function (f) {
        const el = dom.document.getElementById('env_' + f.key) as HTMLInputElement | null;
        if (el) el.value = envVars[f.key] != null ? envVars[f.key] : '';
    });
    // Model controls: render then set the effective value.
    renderModelControls(dom, state, providerId);
    if (providerId === 'ovhcloud') {
        const opts = state.ovhcloudModels || [];
        if (opts.indexOf(profile.model) !== -1) {
            if (dom.modelOvh) dom.modelOvh.value = profile.model;
            if (dom.modelOvhCustom) dom.modelOvhCustom.value = '';
        } else {
            if (dom.modelOvh) dom.modelOvh.value = OVH_CUSTOM;
            if (dom.modelOvhCustom) dom.modelOvhCustom.value = profile.model || '';
        }
        syncOvhCustom(dom);
    } else {
        if (dom.model) dom.model.value = profile.model || '';
    }
}

/** Faithful mirror of `getModelValue` from authWizardPanel.ts. */
function getModelValue(dom: WizardDom): string {
    const pid = dom.newProvider.value;
    if (pid === 'ovhcloud') {
        if (dom.modelOvh.value === OVH_CUSTOM) return (dom.modelOvhCustom.value || '').trim();
        return (dom.modelOvh.value || '').trim();
    }
    return (dom.model.value || '').trim();
}

/**
 * Faithful mirror of `enterEditMode` (minus the toggle/button relabel side
 * effects, which are out of scope for this property). Sets the stored index and
 * prefills the form. Returns the resulting editingIndex.
 */
function enterEditMode(dom: WizardDom, state: WizardState, idx: number): number {
    state.editingIndex = idx;
    const profile =
        state.config && state.config.providers ? state.config.providers[idx] : null;
    if (profile) prefillForm(dom, state, profile);
    return state.editingIndex;
}

describe('prefillForm — Property 2: Edit_Mode prefill mirrors the stored profile', () => {
    it('stores the index, sets provider, renders exact env inputs, populates each env value, and sets the effective model', () => {
        // Config with 1..N profiles plus a chosen index into it.
        const configWithIndex = fc
            .array(validProviderConfig(), { minLength: 1, maxLength: 6 })
            .chain((providers) =>
                fc.record({
                    providers: fc.constant(providers),
                    index: fc.integer({ min: 0, max: providers.length - 1 }),
                })
            );

        fc.assert(
            fc.property(configWithIndex, ({ providers, index }) => {
                const dom = buildDom();
                populateProviderSelect(dom, Object.keys(PROVIDER_ENV_FIELDS));

                const state: WizardState = {
                    config: { providers },
                    envFieldSchema: PROVIDER_ENV_FIELDS,
                    ovhcloudModels: OVHCLOUD_MODEL_OPTIONS,
                    editingIndex: null,
                };

                const profile = providers[index];
                const returnedIndex = enterEditMode(dom, state, index);

                // (1.3) editingIndex equals the chosen index.
                assert.strictEqual(state.editingIndex, index);
                assert.strictEqual(returnedIndex, index);

                // (1.4) provider select value equals profile.provider.
                assert.strictEqual(dom.newProvider.value, profile.provider);

                // (1.5) the set of rendered env input ids equals exactly
                // `env_<key>` for the provider's schema keys.
                const schema = PROVIDER_ENV_FIELDS[profile.provider] || [];
                const expectedIds = schema.map((f) => 'env_' + f.key).sort();
                const renderedIds = Array.from(
                    dom.envFields.querySelectorAll('input')
                )
                    .map((el) => (el as HTMLElement).id)
                    .sort();
                assert.deepStrictEqual(renderedIds, expectedIds);

                // (1.6, 3.1) each env input's value equals profile.env_vars[key]
                // (including secret fields; missing keys populate as empty).
                schema.forEach((f) => {
                    const el = dom.document.getElementById('env_' + f.key) as HTMLInputElement;
                    assert.ok(el, `expected input env_${f.key} to exist`);
                    const stored = profile.env_vars[f.key];
                    const expected = stored != null ? stored : '';
                    assert.strictEqual(
                        el.value,
                        expected,
                        `env_${f.key} value mismatch`
                    );
                });

                // (1.7) the effective model value read back equals the
                // profile's model. `getModelValue()` (mirrored) returns the
                // TRIMMED effective value, which is exactly what the
                // create/update backend persists (validateNewProvider + the
                // handlers trim the model before writing). Stored models are
                // therefore already trimmed in practice, so the effective
                // read-back equals `profile.model.trim()`.
                assert.strictEqual(getModelValue(dom), profile.model.trim());
            }),
            { numRuns: 100 }
        );
    });
});
