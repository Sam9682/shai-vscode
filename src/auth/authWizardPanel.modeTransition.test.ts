import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import {
    ProviderConfig,
    PROVIDER_ENV_FIELDS,
    OVHCLOUD_MODEL_OPTIONS,
    EnvField,
} from './authConfig';

/**
 * Task 9.3 — Example tests for mode transitions.
 *
 * Validates: Requirements 1.2, 4.1, 5.5
 *   - Req 1.2: triggering the edit action opens the Profile_Form in Edit_Mode.
 *   - Req 4.1: while in Edit_Mode the primary action is labeled for updating.
 *   - Req 5.5: when an update is persisted, the form returns to Create_Mode.
 *
 * These are concrete example tests (specific fixtures, not property tests).
 *
 * ---------------------------------------------------------------------------
 * NOTE ON APPROACH (mirror, not import):
 *
 * `enterEditMode`, `updatePrimaryButton`, `clearNewForm`, `prefillForm`,
 * `isEditing`, and the `saved` / `clearNew:true` message handling live inside
 * an inline webview script (a template string) embedded in `getWizardHtml` in
 * `src/auth/authWizardPanel.ts`. Those functions are not exported and cannot be
 * imported, so — per the design's Testing Strategy ("The webview helpers are
 * tested by extracting/exercising them against a DOM (e.g. jsdom) or by testing
 * their pure mapping equivalents") — the helpers below are faithful MIRRORS of
 * the production implementations.
 *
 * Mirror source (src/auth/authWizardPanel.ts):
 *   - functions `enterEditMode`, `prefillForm`, `updatePrimaryButton`,
 *     `isEditing`, `clearNewForm`, `renderEnvInputs`, `renderModelControls`,
 *     `syncOvhCustom`, `applyDefaults`, `updateToggleBtn`, and the
 *     `OVH_CUSTOM = '__custom__'` constant.
 *   - the `saved` message branch: on `m.clearNew` it calls `clearNewForm()`,
 *     then `newProfileBody.classList.add('hidden')`, then `updateToggleBtn()`.
 *
 * If the production implementations change, these mirrors should be updated to
 * match so drift stays detectable.
 * ---------------------------------------------------------------------------
 */

const OVH_CUSTOM = '__custom__';
const CREATE_LABEL = 'Create and activate';
const UPDATE_LABEL = 'Update profile';

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
    newProfileBody: HTMLElement;
    btnNew: HTMLButtonElement;
    btnToggleNew: HTMLButtonElement;
}

/** Build a jsdom DOM mirroring the wizard's Profile_Form elements. */
function buildDom(): WizardDom {
    const dom = new JSDOM(
        '<!DOCTYPE html><html><body>' +
            '<select id="newProvider"></select>' +
            '<button type="button" id="btnToggleNew">+</button>' +
            '<div id="newProfileBody" class="hidden">' +
            '<div id="envFields"></div>' +
            '<label id="modelLabel" for="model"></label>' +
            '<input id="model" type="text" />' +
            '<select id="modelOvh"></select>' +
            '<input id="modelOvhCustom" type="text" />' +
            '<button type="button" id="btnNew">' + CREATE_LABEL + '</button>' +
            '</div>' +
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
        newProfileBody: document.getElementById('newProfileBody') as HTMLElement,
        btnNew: document.getElementById('btnNew') as HTMLButtonElement,
        btnToggleNew: document.getElementById('btnToggleNew') as HTMLButtonElement,
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

// --- Faithful mirrors of the production webview helpers ---------------------

/** Mirror of `isEditing` from authWizardPanel.ts. */
function isEditing(state: WizardState): boolean {
    return state.editingIndex !== null;
}

/** Mirror of `updatePrimaryButton` from authWizardPanel.ts. */
function updatePrimaryButton(dom: WizardDom, state: WizardState): void {
    if (dom.btnNew) dom.btnNew.textContent = isEditing(state) ? UPDATE_LABEL : CREATE_LABEL;
}

/** Mirror of `updateToggleBtn` from authWizardPanel.ts. */
function updateToggleBtn(dom: WizardDom): void {
    const open = dom.newProfileBody && !dom.newProfileBody.classList.contains('hidden');
    if (dom.btnToggleNew) {
        dom.btnToggleNew.textContent = open ? '−' : '+';
    }
}

/** Mirror of `renderEnvInputs` from authWizardPanel.ts. */
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

/** Mirror of `syncOvhCustom` from authWizardPanel.ts. */
function syncOvhCustom(dom: WizardDom): void {
    if (!dom.modelOvh || !dom.modelOvhCustom) return;
    const show = dom.modelOvh.value === OVH_CUSTOM;
    dom.modelOvhCustom.classList.toggle('hidden', !show);
    if (dom.modelLabel) dom.modelLabel.setAttribute('for', show ? 'modelOvhCustom' : 'modelOvh');
}

/** Mirror of `renderModelControls` from authWizardPanel.ts. */
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

/** Mirror of `applyDefaults` from authWizardPanel.ts. */
function applyDefaults(dom: WizardDom, providerId: string): void {
    if (providerId === 'ollama') {
        const el = dom.document.getElementById('env_OLLAMA_BASE_URL') as HTMLInputElement | null;
        if (el && !el.value) el.value = 'http://localhost:11434/v1';
    }
    if (providerId === 'anthropic' && dom.model && !dom.model.value) {
        dom.model.placeholder = 'e.g. claude-sonnet-4-20250514';
    }
}

/** Mirror of `prefillForm` from authWizardPanel.ts. */
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

/** Mirror of `enterEditMode` from authWizardPanel.ts. */
function enterEditMode(dom: WizardDom, state: WizardState, idx: number): void {
    state.editingIndex = idx;
    if (dom.newProfileBody) dom.newProfileBody.classList.remove('hidden');
    updateToggleBtn(dom);
    const profile =
        state.config && state.config.providers ? state.config.providers[idx] : null;
    if (profile) prefillForm(dom, state, profile);
    updatePrimaryButton(dom, state);
}

/** Mirror of `clearNewForm` from authWizardPanel.ts. */
function clearNewForm(dom: WizardDom, state: WizardState): void {
    if (dom.model) dom.model.value = '';
    if (dom.modelOvhCustom) dom.modelOvhCustom.value = '';
    if (dom.newProvider) dom.newProvider.selectedIndex = 0;
    const pid = dom.newProvider ? dom.newProvider.value : 'anthropic';
    renderEnvInputs(dom, state, pid);
    renderModelControls(dom, state, pid);
    applyDefaults(dom, pid);
    // Return the form to Create_Mode (Req 5.5).
    state.editingIndex = null;
    updatePrimaryButton(dom, state);
}

/**
 * Mirror of the `saved` message branch with `clearNew: true`
 * (src/auth/authWizardPanel.ts): it calls `clearNewForm()`, then hides the
 * body, then refreshes the toggle button.
 */
function handleSavedClearNew(dom: WizardDom, state: WizardState): void {
    clearNewForm(dom, state);
    dom.newProfileBody.classList.add('hidden');
    updateToggleBtn(dom);
}

// --- Fixtures ---------------------------------------------------------------

function makeState(providers: ProviderConfig[]): WizardState {
    return {
        config: { providers },
        envFieldSchema: PROVIDER_ENV_FIELDS,
        ovhcloudModels: OVHCLOUD_MODEL_OPTIONS,
        editingIndex: null,
    };
}

// A couple of concrete profiles for the fixtures.
const anthropicProfile: ProviderConfig = {
    provider: 'anthropic',
    env_vars: { ANTHROPIC_API_KEY: 'sk-ant-fixture' },
    model: 'claude-sonnet-4-20250514',
    tool_method: 'FunctionCall',
};

const ovhProfile: ProviderConfig = {
    provider: 'ovhcloud',
    env_vars: { OVH_API_KEY: 'ovh-fixture-token' },
    model: OVHCLOUD_MODEL_OPTIONS[0],
    tool_method: 'FunctionCall',
};

describe('mode transitions (example tests) — Requirements 1.2, 4.1, 5.5', () => {
    it('entering Edit_Mode stores the index, labels the button, reveals the form, and prefills (Req 1.2, 4.1)', () => {
        const dom = buildDom();
        populateProviderSelect(dom, Object.keys(PROVIDER_ENV_FIELDS));
        const state = makeState([anthropicProfile, ovhProfile]);

        // Precondition: Create_Mode — form hidden, create label, no index.
        assert.strictEqual(state.editingIndex, null);
        assert.strictEqual(dom.btnNew.textContent, CREATE_LABEL);
        assert.ok(dom.newProfileBody.classList.contains('hidden'));

        // Edit the second profile (index 1, the ovhcloud one).
        enterEditMode(dom, state, 1);

        // Req 1.2 / 1.3: Edit_Mode entered, stored Profile_Index === 1.
        assert.strictEqual(state.editingIndex, 1);
        assert.strictEqual(isEditing(state), true);

        // Req 4.1: primary button relabeled for updating.
        assert.strictEqual(dom.btnNew.textContent, UPDATE_LABEL);

        // Req 1.2: the form is revealed (no longer hidden).
        assert.strictEqual(dom.newProfileBody.classList.contains('hidden'), false);

        // The form is prefilled: provider select equals the edited profile's provider.
        assert.strictEqual(dom.newProvider.value, ovhProfile.provider);
        // And the ovh preset model round-trips into the dropdown.
        assert.strictEqual(dom.modelOvh.value, ovhProfile.model);
    });

    it('returns to Create_Mode after a saved reply with clearNew (Req 5.5)', () => {
        const dom = buildDom();
        populateProviderSelect(dom, Object.keys(PROVIDER_ENV_FIELDS));
        const state = makeState([anthropicProfile, ovhProfile]);

        // Arrange: be in Edit_Mode for index 0 (the anthropic profile).
        enterEditMode(dom, state, 0);
        assert.strictEqual(state.editingIndex, 0);
        assert.strictEqual(dom.btnNew.textContent, UPDATE_LABEL);
        assert.strictEqual(dom.newProfileBody.classList.contains('hidden'), false);
        assert.strictEqual(dom.newProvider.value, anthropicProfile.provider);

        // Act: simulate the host's `saved` reply with clearNew: true.
        handleSavedClearNew(dom, state);

        // Req 5.5: form returned to Create_Mode — editingIndex cleared,
        // primary button back to the create label.
        assert.strictEqual(state.editingIndex, null);
        assert.strictEqual(isEditing(state), false);
        assert.strictEqual(dom.btnNew.textContent, CREATE_LABEL);

        // The form body is hidden again after the persisted update.
        assert.ok(dom.newProfileBody.classList.contains('hidden'));
    });
});
