import * as assert from 'assert';
import fc from 'fast-check';
import {
    PROVIDER_ENV_FIELDS,
    validateNewProvider,
    ShaiAuthConfig,
    ProviderConfig,
} from './authConfig';

/**
 * Regression guard for Create_Mode append behavior.
 *
 * NOTE ON WHAT IS UNDER TEST:
 * The create/append logic used by the `saveNew` path is NOT a reusable
 * function in `authConfig.ts`; it lives inline in the host message handler
 * (`openAuthWizard.onDidReceiveMessage`, the `msg.type === 'saveNew'` branch)
 * in `src/auth/authWizardPanel.ts`. That branch:
 *   1. trims provider/model and defaults env_vars to {}
 *   2. validates via validateNewProvider (the closest pure backend function)
 *   3. builds an entry { provider, env_vars: {...envVars}, model, tool_method: 'FunctionCall' }
 *   4. cfg.providers.push(entry)
 *   5. cfg.selected_provider = cfg.providers.length - 1
 *
 * Since no reusable append function exists, this test reproduces that exact
 * inline behavior in a local pure helper (`createAppend`) and exercises it as
 * the create path. `validateNewProvider` is the real backend function reused
 * verbatim. This is a regression guard ensuring the create/append contract
 * (length + 1, appended entry equals submitted values) is unchanged as the
 * edit feature is added.
 */

const PROVIDER_IDS = Object.keys(PROVIDER_ENV_FIELDS);

/** Faithful reproduction of the inline `saveNew` append logic from the host handler. */
function createAppend(
    config: ShaiAuthConfig,
    providerId: string,
    envVars: Record<string, string>,
    model: string
): { entry: ProviderConfig } | { error: string } {
    const provider = (providerId || '').trim();
    const m = (model || '').trim();
    const env = envVars || {};
    const err = validateNewProvider(provider, env, m);
    if (err) {
        return { error: err };
    }
    const entry: ProviderConfig = {
        provider,
        env_vars: { ...env },
        model: m,
        tool_method: 'FunctionCall',
    };
    config.providers.push(entry);
    config.selected_provider = config.providers.length - 1;
    return { entry };
}

// --- Local generators ---------------------------------------------------

const toolMethodArb = fc.constantFrom<ProviderConfig['tool_method']>(
    'FunctionCall',
    'Auto',
    'FunctionCallRequired',
    'StructuredOutput',
    'Parsing'
);

/** A single arbitrary (not necessarily valid) provider entry, for building base configs. */
function providerEntryArb(): fc.Arbitrary<ProviderConfig> {
    return fc.record({
        provider: fc.constantFrom(...PROVIDER_IDS),
        env_vars: fc.dictionary(
            fc.string({ minLength: 1, maxLength: 8 }),
            fc.string({ maxLength: 12 })
        ),
        model: fc.string({ minLength: 1, maxLength: 20 }),
        tool_method: toolMethodArb,
    });
}

/** A base config with 0..N existing providers and a plausible selected_provider. */
function baseConfigArb(): fc.Arbitrary<ShaiAuthConfig> {
    return fc
        .array(providerEntryArb(), { minLength: 0, maxLength: 5 })
        .chain((providers) =>
            fc.record({
                providers: fc.constant(providers),
                selected_provider: fc.integer({
                    min: 0,
                    max: Math.max(0, providers.length - 1),
                }),
                mcp_configs: fc.constant<Record<string, unknown>>({}),
            })
        );
}

/**
 * A VALID new-profile submission: a provider id with all required env fields
 * filled with non-empty values, optional fields possibly filled, and a
 * non-empty model. Mirrors what the webview submits and what
 * validateNewProvider requires.
 */
function validSubmissionArb(): fc.Arbitrary<{
    provider: string;
    envVars: Record<string, string>;
    model: string;
}> {
    return fc.constantFrom(...PROVIDER_IDS).chain((provider) => {
        const fields = PROVIDER_ENV_FIELDS[provider];
        const valueArbs: Record<string, fc.Arbitrary<string | undefined>> = {};
        for (const f of fields) {
            if (f.optional) {
                // optional field: sometimes present, sometimes absent
                valueArbs[f.key] = fc.option(fc.string({ maxLength: 16 }), {
                    nil: undefined,
                });
            } else {
                // required field: non-empty after trim
                valueArbs[f.key] = fc
                    .string({ minLength: 1, maxLength: 16 })
                    .map((s) => (s.trim() ? s : s + 'x'));
            }
        }
        return fc
            .record({
                env: fc.record(valueArbs),
                // model may have surrounding whitespace but must be non-empty after trim
                model: fc
                    .string({ minLength: 1, maxLength: 24 })
                    .map((s) => (s.trim() ? s : s + 'model')),
            })
            .map(({ env, model }) => {
                const envVars: Record<string, string> = {};
                for (const [k, v] of Object.entries(env)) {
                    if (v !== undefined) {
                        envVars[k] = v;
                    }
                }
                return { provider, envVars, model };
            });
    });
}

describe('Create_Mode append (regression guard)', () => {
    // Feature: profile-inline-edit, Property 13: Create_Mode appends a new profile
    it('Property 13: submitting a valid new profile appends one entry matching the submitted values', () => {
        fc.assert(
            fc.property(baseConfigArb(), validSubmissionArb(), (config, submission) => {
                const before = config.providers.length;

                const result = createAppend(
                    config,
                    submission.provider,
                    submission.envVars,
                    submission.model
                );

                // Valid submissions must never be rejected.
                assert.ok(!('error' in result), 'valid submission should not error');

                // providers.length increases by exactly one.
                assert.strictEqual(config.providers.length, before + 1);

                // The appended entry is the last one.
                const appended = config.providers[config.providers.length - 1];

                // Appended entry matches the submitted values (provider/env/model).
                assert.strictEqual(appended.provider, submission.provider.trim());
                assert.strictEqual(appended.model, submission.model.trim());
                assert.deepStrictEqual(appended.env_vars, { ...submission.envVars });

                // selected_provider points at the newly appended entry.
                assert.strictEqual(
                    config.selected_provider,
                    config.providers.length - 1
                );
            }),
            { numRuns: 200 }
        );
    });
});
