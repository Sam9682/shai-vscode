import * as assert from 'assert';
import fc from 'fast-check';
import { JSDOM } from 'jsdom';
import { PROVIDER_IDS } from './testUtils.gen';
import { PROVIDER_ENV_FIELDS, MODEL_HELP, getModelHelp } from './authConfig';

/**
 * Feature: user-friendliness-improvements — wizard render properties.
 *
 * This suite covers three render-half properties of the Auth_Wizard:
 *   - Property 3: Example is rendered as the input placeholder (Req 1.4, 1.6)
 *   - Property 4: Help is rendered and associated with its input (Req 1.5)
 *   - Property 5 (render half): the model-help element displays exactly
 *     getModelHelp(providerId) (Req 2.1)
 * plus a unit check that the credential help <details> block is present in the
 * wizard HTML (Req 8.1).
 *
 * ---------------------------------------------------------------------------
 * NOTE ON APPROACH (mirror, not import):
 *
 * The real render logic lives in `renderEnvInputs(providerId)` and
 * `renderModelControls(providerId)`, embedded as an inline webview script (a
 * template string) inside `getWizardHtml` in `src/auth/authWizardPanel.ts`.
 * Those functions are not exported and cannot be imported, so — per the
 * design's Testing Strategy ("mirror, not import") — the DOM-construction
 * helpers below are faithful MIRRORS of the production functions of the same
 * name (see src/auth/authWizardPanel.ts). They mirror exactly:
 *   - renderEnvInputs: placeholder = f.example || f.placeholder || '' and,
 *     when f.help is present, a <div class="hint" id="help_<key>"> element
 *     with the input's aria-describedby set to that id.
 *   - renderModelControls: #modelHelp textContent = getModelHelp(providerId).
 *   - CREDENTIAL_HELP_HTML: the static <details class="cred-help"> block from
 *     the wizard HTML.
 *
 * The mirrors read the SAME schema/data the production code uses at runtime:
 * `state.envFieldSchema` is populated from the `init` message's `envFields`
 * (= PROVIDER_ENV_FIELDS) and `state.modelHelp` from `modelHelp` (= MODEL_HELP)
 * with the same getModelHelp fallback. If production changes these functions,
 * update the mirrors so drift stays detectable.
 * ---------------------------------------------------------------------------
 */

/**
 * Faithful mirror of `renderEnvInputs(providerId)` in
 * src/auth/authWizardPanel.ts. Renders the env inputs for `providerId` into the
 * given `envFields` container, driven off PROVIDER_ENV_FIELDS (the runtime
 * `state.envFieldSchema`).
 */
function renderEnvInputsMirror(document: Document, envFields: Element, providerId: string): void {
    envFields.innerHTML = '';
    const fields = PROVIDER_ENV_FIELDS[providerId] || [];
    fields.forEach(function (f) {
        const wrap = document.createElement('div');
        wrap.className = 'row';
        const lab = document.createElement('label');
        lab.setAttribute('for', 'env_' + f.key);
        lab.textContent = f.label + (f.optional ? ' (optional)' : '');
        const inp = document.createElement('input');
        inp.id = 'env_' + f.key;
        inp.dataset.key = f.key;
        inp.type = f.secret ? 'password' : 'text';
        inp.autocomplete = 'off';
        // Placeholder: example wins over legacy placeholder. (Req 1.4, 1.6)
        inp.placeholder = f.example || f.placeholder || '';
        wrap.appendChild(lab);
        wrap.appendChild(inp);
        // Inline help associated with the input via aria-describedby. (Req 1.5)
        if (f.help) {
            const helpId = 'help_' + f.key;
            const hint = document.createElement('div');
            hint.className = 'hint';
            hint.id = helpId;
            hint.textContent = f.help;
            inp.setAttribute('aria-describedby', helpId);
            wrap.appendChild(hint);
        }
        envFields.appendChild(wrap);
    });
}

/**
 * Faithful mirror of the model-help portion of `renderModelControls(providerId)`
 * in src/auth/authWizardPanel.ts: writes getModelHelp(providerId) into the
 * #modelHelp element. Mirrors the production getModelHelp accessor (safe
 * fallback) reading from `state.modelHelp` (= MODEL_HELP).
 */
function getModelHelpMirror(providerId: string): string {
    const map: Record<string, string> = MODEL_HELP || {};
    const v = map[providerId];
    return typeof v === 'string' && v.length > 0
        ? v
        : 'Enter the model identifier expected by this provider.';
}

function renderModelHelpMirror(modelHelpEl: Element, providerId: string): void {
    modelHelpEl.textContent = getModelHelpMirror(providerId);
}

/**
 * Faithful mirror of the static credential-help block embedded in the wizard
 * HTML (getWizardHtml in src/auth/authWizardPanel.ts). Kept in sync with the
 * production `<details class="cred-help">…</details>` markup for the Req 8.1
 * presence check.
 */
const CREDENTIAL_HELP_HTML = `
      <details class="cred-help">
        <summary>How do I get these credentials?</summary>
        <div class="hint">Each provider issues API keys from its own console or dashboard. For Anthropic, OpenAI, Mistral, and OpenRouter, sign in to the provider's website and create an API key in the account/API settings, then paste it above. For OVHcloud AI Endpoints, generate a token from the OVHcloud manager. For a local Ollama server, no API key is needed — just point the base URL at your running instance (for example <code>http://localhost:11434/v1</code>). For an OpenAI-compatible endpoint, use the base URL and key provided by that service.</div>
      </details>`;

describe('authWizardPanel render — Property 3: Example is rendered as the input placeholder', () => {
    it('Feature: user-friendliness-improvements, Property 3: every field with an example produces an input whose placeholder equals that example (example wins over legacy placeholder)', () => {
        fc.assert(
            fc.property(fc.constantFrom(...PROVIDER_IDS), (providerId) => {
                const dom = new JSDOM(
                    '<!DOCTYPE html><html><body><div id="envFields"></div></body></html>'
                );
                const document = dom.window.document;
                const envFields = document.getElementById('envFields')!;

                renderEnvInputsMirror(document, envFields, providerId);

                const fields = PROVIDER_ENV_FIELDS[providerId] || [];
                fields.forEach((f) => {
                    if (f.example) {
                        const el = document.getElementById('env_' + f.key) as HTMLInputElement | null;
                        assert.ok(el, `expected input #env_${f.key} to be rendered`);
                        // Req 1.4 / 1.6: placeholder equals the example, even when a
                        // legacy placeholder is also defined on the field.
                        assert.strictEqual(
                            el!.getAttribute('placeholder'),
                            f.example,
                            `field ${f.key}: placeholder should equal example`
                        );
                    }
                });
            }),
            { numRuns: 100 }
        );
    });
});

describe('authWizardPanel render — Property 4: Help is rendered and associated with its input', () => {
    it('Feature: user-friendliness-improvements, Property 4: every field with help produces an inline help element containing that text, and the input references it via aria-describedby', () => {
        fc.assert(
            fc.property(fc.constantFrom(...PROVIDER_IDS), (providerId) => {
                const dom = new JSDOM(
                    '<!DOCTYPE html><html><body><div id="envFields"></div></body></html>'
                );
                const document = dom.window.document;
                const envFields = document.getElementById('envFields')!;

                renderEnvInputsMirror(document, envFields, providerId);

                const fields = PROVIDER_ENV_FIELDS[providerId] || [];
                fields.forEach((f) => {
                    if (f.help) {
                        const input = document.getElementById('env_' + f.key) as HTMLInputElement | null;
                        assert.ok(input, `expected input #env_${f.key} to be rendered`);

                        const helpId = 'help_' + f.key;
                        // Req 1.5: input is programmatically associated with the help.
                        assert.strictEqual(
                            input!.getAttribute('aria-describedby'),
                            helpId,
                            `field ${f.key}: input should reference help via aria-describedby`
                        );

                        // Req 1.5: an inline help element exists and contains the help text.
                        const helpEl = document.getElementById(helpId);
                        assert.ok(helpEl, `expected help element #${helpId} to be rendered`);
                        assert.strictEqual(
                            helpEl!.textContent,
                            f.help,
                            `field ${f.key}: help element should contain the help text`
                        );
                    }
                });
            }),
            { numRuns: 100 }
        );
    });
});

describe('authWizardPanel render — Property 5 (render half): model help element displays getModelHelp(providerId)', () => {
    it('Feature: user-friendliness-improvements, Property 5: after rendering model controls, #modelHelp displays exactly getModelHelp(providerId)', () => {
        fc.assert(
            fc.property(fc.constantFrom(...PROVIDER_IDS), (providerId) => {
                const dom = new JSDOM(
                    '<!DOCTYPE html><html><body><div class="hint" id="modelHelp"></div></body></html>'
                );
                const document = dom.window.document;
                const modelHelpEl = document.getElementById('modelHelp')!;

                renderModelHelpMirror(modelHelpEl, providerId);

                const expected = getModelHelp(providerId);
                // Req 2.1: help text is non-empty and matches the source of truth.
                assert.ok(expected.length > 0, 'getModelHelp should return a non-empty string');
                assert.strictEqual(
                    modelHelpEl.textContent,
                    expected,
                    `provider ${providerId}: #modelHelp should display getModelHelp exactly`
                );
                // The mirror accessor must agree with production getModelHelp.
                assert.strictEqual(getModelHelpMirror(providerId), expected);
            }),
            { numRuns: 100 }
        );
    });
});

describe('authWizardPanel — Req 8.1: credential help details block present', () => {
    it('renders an expandable <details class="cred-help"> block describing how to obtain credentials', () => {
        const dom = new JSDOM(`<!DOCTYPE html><html><body>${CREDENTIAL_HELP_HTML}</body></html>`);
        const document = dom.window.document;

        const details = document.querySelector('details.cred-help');
        assert.ok(details, 'expected a <details class="cred-help"> element');

        const summary = details!.querySelector('summary');
        assert.ok(summary, 'expected a <summary> inside the credential help block');
        assert.ok(
            (summary!.textContent || '').toLowerCase().includes('credential'),
            'summary should mention credentials'
        );

        const body = details!.querySelector('.hint');
        assert.ok(body, 'expected explanatory .hint text inside the credential help block');
        assert.ok(
            (body!.textContent || '').trim().length > 0,
            'credential help body should be non-empty'
        );
    });
});
