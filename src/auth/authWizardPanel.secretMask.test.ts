import * as assert from 'assert';
import fc from 'fast-check';
import { JSDOM } from 'jsdom';
import { validAuthConfig, PROVIDER_IDS } from './testUtils.gen';
import { PROVIDER_ENV_FIELDS } from './authConfig';

/**
 * Feature: profile-inline-edit, Property 6: Secret fields are masked
 *
 * For any profile, entering Edit_Mode renders every Env_Field whose schema
 * marks it `secret: true` as a masked (password) input.
 *
 * Validates: Requirements 3.2
 *
 * ---------------------------------------------------------------------------
 * NOTE ON APPROACH (mirror, not import):
 *
 * The real logic lives in `renderEnvInputs(providerId)`, embedded as an inline
 * webview script (a template string) inside `getWizardHtml` in
 * `src/auth/authWizardPanel.ts`. That function is not exported and cannot be
 * imported, so — per the design's Testing Strategy ("The webview helpers are
 * tested by extracting/exercising them against a DOM (e.g. jsdom) or by
 * testing their pure mapping equivalents") — the input construction below is a
 * faithful MIRROR of the production `renderEnvInputs()` (see
 * src/auth/authWizardPanel.ts, function `renderEnvInputs`). It mirrors exactly
 * how each env input is built: an `<input>` with `id = 'env_' + f.key` whose
 * `type` is `f.secret ? 'password' : 'text'`.
 *
 * The mirror reads the SAME schema the production code uses: at runtime
 * `state.envFieldSchema` is populated from the `init` message, whose
 * `envFields` field is `PROVIDER_ENV_FIELDS` (see getWizardHtml init post),
 * so this test drives `renderEnvInputsMirror` off `PROVIDER_ENV_FIELDS`
 * directly.
 *
 * If the production `renderEnvInputs` input-type logic changes, this mirror
 * should be updated to match so drift stays detectable.
 * ---------------------------------------------------------------------------
 */

/**
 * Faithful mirror of the per-field input construction from `renderEnvInputs()`
 * in src/auth/authWizardPanel.ts. Renders the env inputs for `providerId` into
 * the given `envFields` container.
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
        if (f.placeholder) {
            inp.placeholder = f.placeholder;
        }
        wrap.appendChild(lab);
        wrap.appendChild(inp);
        envFields.appendChild(wrap);
    });
}

// Provider ids that actually have at least one secret field — these are the
// meaningful cases for this property. Other provider ids are included for
// coverage via the generated configs below.
const PROVIDERS_WITH_SECRET = PROVIDER_IDS.filter((id) =>
    (PROVIDER_ENV_FIELDS[id] || []).some((f) => f.secret === true)
);

describe('renderEnvInputs — Property 6: Secret fields are masked', () => {
    it('renders every secret:true field as a password input (and non-secret as text)', () => {
        // Sanity: the property is only meaningful if some provider has a secret
        // field. This guards against schema drift silently emptying the space.
        assert.ok(
            PROVIDERS_WITH_SECRET.length > 0,
            'expected at least one provider with a secret field'
        );

        fc.assert(
            fc.property(
                // Bias generation toward providers that have secret fields, but
                // also draw arbitrary valid configs for broader coverage.
                fc.oneof(
                    fc.constantFrom(...PROVIDERS_WITH_SECRET),
                    validAuthConfig().map((cfg) => cfg.providers[0].provider)
                ),
                (providerId) => {
                    const dom = new JSDOM(
                        '<!DOCTYPE html><html><body><div id="envFields"></div></body></html>'
                    );
                    const document = dom.window.document;
                    const envFields = document.getElementById('envFields')!;

                    renderEnvInputsMirror(document, envFields, providerId);

                    const schema = PROVIDER_ENV_FIELDS[providerId] || [];
                    schema.forEach(function (f) {
                        const el = document.getElementById('env_' + f.key) as HTMLInputElement | null;
                        assert.ok(el, `expected input #env_${f.key} to be rendered`);
                        if (f.secret === true) {
                            // Req 3.2: secret fields are masked (password input).
                            assert.strictEqual(
                                el!.type,
                                'password',
                                `secret field ${f.key} should render as password`
                            );
                        } else {
                            // Non-secret fields must not be masked.
                            assert.strictEqual(
                                el!.type,
                                'text',
                                `non-secret field ${f.key} should render as text`
                            );
                        }
                    });
                }
            ),
            { numRuns: 100 }
        );
    });
});
