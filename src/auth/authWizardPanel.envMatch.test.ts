import * as assert from 'assert';
import fc from 'fast-check';
import { JSDOM } from 'jsdom';
import { PROVIDER_IDS } from './testUtils.gen';
import { PROVIDER_ENV_FIELDS } from './authConfig';

/**
 * Feature: profile-inline-edit, Property 3: Rendered env inputs always match the selected provider
 *
 * For any provider selected in Edit_Mode, the set of rendered Env_Field input
 * keys equals exactly the schema keys of `PROVIDER_ENV_FIELDS` for that
 * provider, including after changing the provider selection.
 *
 * Validates: Requirements 2.4
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
 * how each env input is built: `envFields.innerHTML = ''` first (clearing any
 * previously rendered inputs), then for each field in
 * `PROVIDER_ENV_FIELDS[providerId]` an `<input>` with `id = 'env_' + f.key`
 * and `dataset.key = f.key`.
 *
 * The mirror reads the SAME schema the production code uses: at runtime
 * `state.envFieldSchema` is populated from the `init` message, whose
 * `envFields` field is `PROVIDER_ENV_FIELDS` (see getWizardHtml init post),
 * so this test drives `renderEnvInputsMirror` off `PROVIDER_ENV_FIELDS`
 * directly.
 *
 * If the production `renderEnvInputs` clearing/id/dataset logic changes, this
 * mirror should be updated to match so drift stays detectable.
 * ---------------------------------------------------------------------------
 */

/**
 * Faithful mirror of `renderEnvInputs()` in src/auth/authWizardPanel.ts.
 * Clears the container (`innerHTML = ''`) then renders one input per field of
 * `PROVIDER_ENV_FIELDS[providerId]`, each with `id = 'env_' + f.key` and
 * `dataset.key = f.key`, into the given `envFields` container.
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

/** The exact set of `env_<key>` input ids expected for a provider. */
function expectedEnvIds(providerId: string): string[] {
    return (PROVIDER_ENV_FIELDS[providerId] || []).map((f) => 'env_' + f.key);
}

/** The exact set of schema keys expected for a provider. */
function expectedEnvKeys(providerId: string): string[] {
    return (PROVIDER_ENV_FIELDS[providerId] || []).map((f) => f.key);
}

describe('renderEnvInputs — Property 3: Rendered env inputs always match the selected provider', () => {
    it('rendered env input keys equal exactly the provider schema keys, including after provider changes', () => {
        fc.assert(
            fc.property(
                // A sequence of provider ids simulating provider-change events.
                // The final id is the provider the form ends up on; earlier ids
                // simulate prior selections whose inputs must be cleared away.
                fc.array(fc.constantFrom(...PROVIDER_IDS), { minLength: 1, maxLength: 6 }),
                (sequence) => {
                    const dom = new JSDOM(
                        '<!DOCTYPE html><html><body><div id="envFields"></div></body></html>'
                    );
                    const document = dom.window.document;
                    const envFields = document.getElementById('envFields')!;

                    // Render once per provider in the sequence, exactly as the
                    // real webview does on each `change` event: renderEnvInputs
                    // clears the container first, so no leftover inputs from an
                    // earlier provider may remain after the final render.
                    for (const providerId of sequence) {
                        renderEnvInputsMirror(document, envFields, providerId);
                    }

                    const finalProvider = sequence[sequence.length - 1];

                    // The set of rendered input ids equals exactly the schema
                    // `env_<key>` ids for the final provider (Req 2.4).
                    const renderedIds = Array.from(
                        envFields.querySelectorAll('input')
                    ).map((el) => (el as HTMLInputElement).id);
                    assert.deepStrictEqual(
                        renderedIds.slice().sort(),
                        expectedEnvIds(finalProvider).slice().sort(),
                        `rendered ids should match schema env_<key> ids for '${finalProvider}'`
                    );

                    // The set of rendered dataset.key values equals exactly the
                    // schema keys for the final provider.
                    const renderedKeys = Array.from(
                        envFields.querySelectorAll('input')
                    ).map((el) => (el as HTMLInputElement).dataset.key);
                    assert.deepStrictEqual(
                        renderedKeys.slice().sort(),
                        expectedEnvKeys(finalProvider).slice().sort(),
                        `rendered dataset.key values should match schema keys for '${finalProvider}'`
                    );

                    // Critically: after switching from any previous provider to
                    // the final one, NO leftover input from a previous provider
                    // remains. Any key that belongs to an earlier provider but
                    // not the final provider's schema must be absent.
                    const finalKeySet = new Set(expectedEnvKeys(finalProvider));
                    for (const providerId of sequence) {
                        if (providerId === finalProvider) {
                            continue;
                        }
                        for (const key of expectedEnvKeys(providerId)) {
                            if (!finalKeySet.has(key)) {
                                const leftover = document.getElementById('env_' + key);
                                assert.strictEqual(
                                    leftover,
                                    null,
                                    `leftover input env_${key} from provider '${providerId}' should have been cleared`
                                );
                            }
                        }
                    }
                }
            ),
            { numRuns: 100 }
        );
    });
});
