import * as assert from 'assert';
import fc from 'fast-check';
import { JSDOM } from 'jsdom';
import { validProviderConfig, nonBlankString } from './testUtils.gen';
import { ProviderConfig, PROVIDER_ENV_FIELDS, EnvField } from './authConfig';

/**
 * Feature: profile-inline-edit, Property 7: Collected env values reflect edits or preserved originals
 *
 * For any profile prefilled in Edit_Mode, collecting the Env_Field values
 * yields, for each field, the newly entered value where the field was
 * overwritten and the original stored value where the field was left
 * unchanged.
 *
 * Validates: Requirements 3.3, 3.4
 *
 * ---------------------------------------------------------------------------
 * NOTE ON APPROACH (mirror, not import):
 *
 * `prefillForm`, `renderEnvInputs`, and `collectEnvVars` live inside an inline
 * webview script (a template string) embedded in `getWizardHtml` in
 * `src/auth/authWizardPanel.ts`. Those functions are not exported and cannot be
 * imported, so — per the design's Testing Strategy ("The webview helpers are
 * tested by extracting/exercising them against a DOM (e.g. jsdom) or by testing
 * their pure mapping equivalents") — the helpers below are faithful MIRRORS of
 * the production implementations (see src/auth/authWizardPanel.ts, functions
 * `renderEnvInputs`, the env portion of `prefillForm`, and `collectEnvVars`).
 *
 * Mirror source of record for `collectEnvVars` (authWizardPanel.ts):
 *   function collectEnvVars(providerId) {
 *     const out = {};
 *     const fields = state.envFieldSchema[providerId] || [];
 *     fields.forEach(function (f) {
 *       const el = document.getElementById('env_' + f.key);
 *       if (el) out[f.key] = (el.value || '').trim();
 *     });
 *     return out;
 *   }
 *
 * This mirror structure matches src/auth/authWizardPanel.prefill.test.ts
 * (Property 2). If the production implementations change, these mirrors should
 * be updated to match so drift stays detectable.
 * ---------------------------------------------------------------------------
 */

interface WizardState {
    envFieldSchema: Record<string, EnvField[]>;
}

interface WizardDom {
    document: Document;
    envFields: HTMLElement;
}

/** Build a jsdom DOM mirroring the wizard's env-field container. */
function buildDom(): WizardDom {
    const dom = new JSDOM(
        '<!DOCTYPE html><html><body><div id="envFields"></div></body></html>'
    );
    const document = dom.window.document;
    return {
        document,
        envFields: document.getElementById('envFields') as HTMLElement,
    };
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

/**
 * Faithful mirror of the env portion of `prefillForm` from authWizardPanel.ts:
 * render the schema inputs, then populate each `#env_<key>` from the stored
 * env_vars (missing keys populate as empty).
 */
function prefillEnv(dom: WizardDom, state: WizardState, profile: ProviderConfig): void {
    const providerId = profile.provider;
    renderEnvInputs(dom, state, providerId);
    const envVars = profile.env_vars || {};
    const fields = state.envFieldSchema[providerId] || [];
    fields.forEach(function (f) {
        const el = dom.document.getElementById('env_' + f.key) as HTMLInputElement | null;
        if (el) el.value = envVars[f.key] != null ? envVars[f.key] : '';
    });
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

describe('collectEnvVars — Property 7: Collected env values reflect edits or preserved originals', () => {
    it('collects new values where overwritten and original stored values where unchanged', () => {
        // For each profile, generate: an "overwrite this field?" flag per schema
        // key plus a replacement value used when the flag is true.
        const scenario = validProviderConfig().chain((profile) => {
            const fields = PROVIDER_ENV_FIELDS[profile.provider] || [];
            const overwriteArbs = fields.map(() =>
                fc.record({
                    overwrite: fc.boolean(),
                    // The new value a user might type: allow surrounding
                    // whitespace and empty strings so trimming is exercised.
                    newValue: fc.oneof(
                        nonBlankString(),
                        fc.constant(''),
                        nonBlankString().map((s) => '  ' + s + '  ')
                    ),
                })
            );
            return fc.record({
                profile: fc.constant(profile),
                edits: fc.tuple(...overwriteArbs),
            });
        });

        fc.assert(
            fc.property(scenario, ({ profile, edits }) => {
                const dom = buildDom();
                const state: WizardState = { envFieldSchema: PROVIDER_ENV_FIELDS };
                const schema = PROVIDER_ENV_FIELDS[profile.provider] || [];

                // (1) prefill populates inputs with the stored values.
                prefillEnv(dom, state, profile);

                // (2) overwrite a randomly chosen subset of fields.
                schema.forEach((f, i) => {
                    if (edits[i] && edits[i].overwrite) {
                        const el = dom.document.getElementById(
                            'env_' + f.key
                        ) as HTMLInputElement;
                        el.value = edits[i].newValue;
                    }
                });

                // (3) collectEnvVars returns trimmed values reflecting edits or
                // preserved originals.
                const collected = collectEnvVars(dom, state, profile.provider);

                schema.forEach((f, i) => {
                    const stored = profile.env_vars[f.key];
                    const originalTrimmed = (stored != null ? stored : '').trim();
                    if (edits[i] && edits[i].overwrite) {
                        // Overwritten: collected equals the trimmed new value.
                        assert.strictEqual(
                            collected[f.key],
                            edits[i].newValue.trim(),
                            `env_${f.key} should reflect the overwritten value`
                        );
                    } else {
                        // Unchanged: collected equals the trimmed original.
                        assert.strictEqual(
                            collected[f.key],
                            originalTrimmed,
                            `env_${f.key} should preserve the original value`
                        );
                    }
                });

                // The collected key set equals exactly the schema keys.
                assert.deepStrictEqual(
                    Object.keys(collected).sort(),
                    schema.map((f) => f.key).sort()
                );
            }),
            { numRuns: 100 }
        );
    });
});
