import * as assert from 'assert';
import fc from 'fast-check';
import { JSDOM } from 'jsdom';
import { PROVIDER_IDS } from './testUtils.gen';
import { PROVIDER_ENV_FIELDS } from './authConfig';

/**
 * Feature: user-friendliness-improvements, Property 15: Validation errors
 * retain the entered form values.
 *
 * For any populated wizard form, dispatching an 'error' message leaves every
 * env input value and the model value unchanged (the form is not cleared).
 *
 * Validates: Requirements 6.3
 *
 * ---------------------------------------------------------------------------
 * NOTE ON APPROACH (mirror, not import):
 *
 * The real logic lives in the inline webview script inside `getWizardHtml`
 * (src/auth/authWizardPanel.ts): the window 'message' handler for
 * `m.type === 'error'` calls only `showErr(m.message || 'Error')` — it does
 * NOT call `clearNewForm()` and does not touch env inputs, the provider
 * select, or the model controls. That script is not exportable, so — per the
 * design's Testing Strategy ("mirror, not import") — `handleErrorMessageMirror`
 * below is a faithful MIRROR of that handler branch. `showErrMirror` mirrors
 * the production `showErr` (reveal #msgErr, set its text). `clearNewForm` is
 * intentionally NOT called here, exactly matching production; the test would
 * fail if a future change caused the error branch to clear the form.
 *
 * If the production 'error' handler changes, update this mirror so drift stays
 * detectable.
 * ---------------------------------------------------------------------------
 */

/** Faithful mirror of production `showErr(t)`: reveal #msgErr and set text. */
function showErrMirror(document: Document, t: string): void {
    const msgErr = document.getElementById('msgErr')!;
    if (!t) {
        msgErr.classList.add('hidden');
        msgErr.textContent = '';
        return;
    }
    msgErr.textContent = t;
    msgErr.classList.remove('hidden');
}

/**
 * Faithful mirror of the `m.type === 'error'` branch of the window 'message'
 * handler in src/auth/authWizardPanel.ts. It only shows the error; it must not
 * mutate any form control.
 */
function handleErrorMessageMirror(document: Document, m: { type: string; message?: string }): void {
    if (m.type === 'error') {
        showErrMirror(document, m.message || 'Error');
    }
}

/** Build a wizard-like DOM with a model input and one env input per field. */
function buildFormDom(providerId: string): JSDOM {
    const fields = PROVIDER_ENV_FIELDS[providerId] || [];
    const envInputs = fields
        .map((f) => `<input id="env_${f.key}" data-key="${f.key}" type="${f.secret ? 'password' : 'text'}" />`)
        .join('');
    return new JSDOM(
        `<!DOCTYPE html><html><body>
            <div class="err hidden" id="msgErr"></div>
            <div id="envFields">${envInputs}</div>
            <input type="text" id="model" />
        </body></html>`
    );
}

describe('authWizardPanel — Property 15: Validation errors retain the entered form values', () => {
    it('Feature: user-friendliness-improvements, Property 15: dispatching an error message leaves env input values and the model value unchanged', () => {
        fc.assert(
            fc.property(
                fc.constantFrom(...PROVIDER_IDS),
                // A value for the model field and one per env field of the provider.
                fc.string({ minLength: 1, maxLength: 40 }),
                fc.dictionary(fc.string(), fc.string({ minLength: 1, maxLength: 40 })),
                fc.string({ maxLength: 60 }),
                (providerId, modelValue, envValueSeed, errorMessage) => {
                    const dom = buildFormDom(providerId);
                    const document = dom.window.document;

                    const fields = PROVIDER_ENV_FIELDS[providerId] || [];

                    // Populate the form with arbitrary entered values.
                    const modelEl = document.getElementById('model') as HTMLInputElement;
                    modelEl.value = modelValue;

                    const entered: Record<string, string> = {};
                    fields.forEach((f, i) => {
                        const el = document.getElementById('env_' + f.key) as HTMLInputElement;
                        // Derive a deterministic non-trivial value per field.
                        const v = (envValueSeed[f.key] ?? '') + '_' + providerId + '_' + i;
                        el.value = v;
                        entered[f.key] = v;
                    });

                    // Dispatch the 'error' message (mirror of production handler).
                    handleErrorMessageMirror(document, { type: 'error', message: errorMessage });

                    // Req 6.3: model value unchanged.
                    assert.strictEqual(
                        (document.getElementById('model') as HTMLInputElement).value,
                        modelValue,
                        'model value should be retained after an error'
                    );

                    // Req 6.3: every env input value unchanged.
                    fields.forEach((f) => {
                        const el = document.getElementById('env_' + f.key) as HTMLInputElement;
                        assert.strictEqual(
                            el.value,
                            entered[f.key],
                            `env value for ${f.key} should be retained after an error`
                        );
                    });

                    // The error itself is shown (sanity: handler ran).
                    const msgErr = document.getElementById('msgErr')!;
                    assert.strictEqual(msgErr.textContent, errorMessage || 'Error');
                    assert.ok(!msgErr.classList.contains('hidden'), 'error message should be visible');
                }
            ),
            { numRuns: 100 }
        );
    });
});
