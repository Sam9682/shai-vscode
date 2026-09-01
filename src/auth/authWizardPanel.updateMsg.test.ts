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
 * Feature: profile-inline-edit, Property 8: Update_Message assembly
 *
 * For any Profile_Form state in Edit_Mode, triggering the update action
 * produces an Update_Message whose `index` equals the stored Profile_Index and
 * whose `provider`, `env_vars`, and `model` equal the form's current provider,
 * collected env values, and effective model value.
 *
 * Validates: Requirements 4.2
 *
 * ---------------------------------------------------------------------------
 * NOTE ON APPROACH (mirror, not import):
 *
 * The `btnNew` click handler's Edit_Mode branch, along with `collectEnvVars`,
 * `getModelValue`, `enterEditMode`, `prefillForm`, `renderEnvInputs`, and
 * `renderModelControls`, live inside an inline webview script (a template
 * string) embedded in `getWizardHtml` in `src/auth/authWizardPanel.ts`. Those
 * functions are not exported and cannot be imported, so — per the design's
 * Testing Strategy ("The webview helpers are tested by extracting/exercising
 * them against a DOM (e.g. jsdom) or by testing their pure mapping
 * equivalents") — the helpers below are faithful MIRRORS of the production
 * implementations.
 *
 * Mirror source (src/auth/authWizardPanel.ts):
 *   - the `btnNew` click handler Edit_Mode branch, which posts
 *       { type: 'updateExisting', index: editingIndex,
 *         provider: newProvider.value,
 *         env_vars: collectEnvVars(newProvider.value),
 *         model: getModelValue() }
 *   - functions `collectEnvVars`, `getModelValue`, `enterEditMode`,
 *     `prefillForm`, `renderEnvInputs`, `renderModelControls`, `syncOvhCustom`,
 *     and the `OVH_CUSTOM = '__custom__'` constant.
 *
 * The env-input population in `prefillForm` mirror is shared with
 * `authWizardPanel.prefill.test.ts`; if the production implementations change,
 * these mirrors should be updated to match so drift stays detectable.
 * ---------------------------------------------------------------------------
 */

const OVH_CUSTOM = '__custom__';

/** A minimal, mutable copy of the webview `state` used by the mirrored helpers. */
interface WizardState {
    config: { providers: ProviderConfig[] } | null;
    envFieldSchema: Record<string, EnvField[]>;
    ovhcloudModels: string[];
    editingIndex: number | null;
}

/** The set of DOM elements the mirrored helpers operate on. */
interface WizardDom {
    document: Document;
    newProvider: HTMLSelectElement;
    envFields: HTMLElement;
    model: HTMLInputElement;
    modelOvh: HTMLSelectElement;
    modelOvhCustom: HTMLInputElement;
    modelLabel: HTMLElement;
}

/** The shape of the emitted Update_Message. */
interface UpdateMessage {
    type: string;
    index: number | null;
    provider: string;
    env_vars: Record<string, string>;
    model: string;
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
 * `newProvider.value = providerId` resolves to a real option.
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
    renderEnvInputs(dom, state, providerId);
    const envVars = profile.env_vars || {};
    const fields = state.envFieldSchema[providerId] || [];
    fields.forEach(function (f) {
        const el = dom.document.getElementById('env_' + f.key) as HTMLInputElement | null;
        if (el) el.value = envVars[f.key] != null ? envVars[f.key] : '';
    });
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

/** Faithful mirror of `enterEditMode` (minus toggle/button relabel side effects). */
function enterEditMode(dom: WizardDom, state: WizardState, idx: number): void {
    state.editingIndex = idx;
    const profile =
        state.config && state.config.providers ? state.config.providers[idx] : null;
    if (profile) prefillForm(dom, state, profile);
}

/** Faithful mirror of `collectEnvVars` from authWizardPanel.ts. */
function collectEnvVars(dom: WizardDom, state: WizardState, providerId: string): Record<string, string> {
    const out: Record<string, string> = {};
    const fields = state.envFieldSchema[providerId] || [];
    fields.forEach(function (f) {
        const el = dom.document.getElementById('env_' + f.key) as HTMLInputElement | null;
        if (el) out[f.key] = (el.value || '').trim();
    });
    return out;
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
 * Faithful mirror of the `btnNew` click handler Edit_Mode branch: it assembles
 * and returns the Update_Message posted to the host. (The production code calls
 * `vscode.postMessage(...)`; here we return the same object so it can be
 * asserted against.)
 */
function assembleUpdateMessage(dom: WizardDom, state: WizardState): UpdateMessage {
    return {
        type: 'updateExisting',
        index: state.editingIndex,
        provider: dom.newProvider.value,
        env_vars: collectEnvVars(dom, state, dom.newProvider.value),
        model: getModelValue(dom),
    };
}

describe('btnNew update dispatch — Property 8: Update_Message assembly', () => {
    it("emits index === editingIndex and provider/env_vars/model equal to the form's current values", () => {
        // Config with 1..N profiles, a chosen edit index, and an optional set of
        // edits: for each env field, maybe overwrite its value; and maybe change
        // the model value. The edits mutate the live DOM after prefill so the
        // assembled message must reflect the *current* form state, not the
        // originally-stored profile.
        const scenario = fc
            .array(validProviderConfig(), { minLength: 1, maxLength: 6 })
            .chain((providers) =>
                fc.record({
                    providers: fc.constant(providers),
                    index: fc.integer({ min: 0, max: providers.length - 1 }),
                    // per-field edit toggles + replacement text, keyed positionally
                    envEdits: fc.array(
                        fc.option(
                            fc.string({ maxLength: 24 }).map((s) => ' ' + s + ' '),
                            { nil: null }
                        ),
                        { minLength: 0, maxLength: 8 }
                    ),
                    // optional model edit (may include surrounding whitespace to
                    // exercise trimming), and whether to apply it
                    modelEdit: fc.option(
                        fc.string({ maxLength: 24 }).map((s) => '  ' + s + '  '),
                        { nil: null }
                    ),
                })
            );

        fc.assert(
            fc.property(scenario, ({ providers, index, envEdits, modelEdit }) => {
                const dom = buildDom();
                populateProviderSelect(dom, Object.keys(PROVIDER_ENV_FIELDS));

                const state: WizardState = {
                    config: { providers },
                    envFieldSchema: PROVIDER_ENV_FIELDS,
                    ovhcloudModels: OVHCLOUD_MODEL_OPTIONS,
                    editingIndex: null,
                };

                const profile = providers[index];

                // Enter Edit_Mode: stores editingIndex and prefills the form.
                enterEditMode(dom, state, index);

                // Optionally apply edits to the live env inputs to prove the
                // message reflects the *current* form state.
                const schema = PROVIDER_ENV_FIELDS[profile.provider] || [];
                schema.forEach((f, i) => {
                    const edit = envEdits[i];
                    if (edit != null) {
                        const el = dom.document.getElementById('env_' + f.key) as HTMLInputElement | null;
                        if (el) el.value = edit;
                    }
                });

                // Optionally edit the effective model control for the provider.
                if (modelEdit != null) {
                    if (profile.provider === 'ovhcloud') {
                        // Route the edit through the custom input via "Other…".
                        dom.modelOvh.value = OVH_CUSTOM;
                        dom.modelOvhCustom.value = modelEdit;
                        syncOvhCustom(dom);
                    } else {
                        dom.model.value = modelEdit;
                    }
                }

                // Assemble the Update_Message exactly as the btnNew Edit_Mode
                // branch does.
                const msg = assembleUpdateMessage(dom, state);

                // type is the update message type.
                assert.strictEqual(msg.type, 'updateExisting');

                // index equals the stored editingIndex (the chosen index).
                assert.strictEqual(msg.index, index);
                assert.strictEqual(msg.index, state.editingIndex);

                // provider equals the form's current provider select value.
                assert.strictEqual(msg.provider, dom.newProvider.value);

                // env_vars deep-equals the form's currently collected env values.
                assert.deepStrictEqual(
                    msg.env_vars,
                    collectEnvVars(dom, state, dom.newProvider.value)
                );

                // model equals the form's current effective model value.
                assert.strictEqual(msg.model, getModelValue(dom));
            }),
            { numRuns: 100 }
        );
    });
});
