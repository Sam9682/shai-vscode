import * as assert from 'assert';
import fc from 'fast-check';
import {
    updateProviderAt,
    validateNewProvider,
    PROVIDER_ENV_FIELDS,
    PROVIDER_LABELS,
    ShaiAuthConfig,
    ProviderConfig,
} from './authConfig';

/**
 * Feature: profile-inline-edit, Property 10: An invalid update is rejected without mutation
 *
 * For any configuration and any Update_Message whose provider, env vars, or model fail
 * validateNewProvider, applying the update returns the validation error and leaves the
 * entire configuration unchanged.
 *
 * Validates: Requirements 4.3, 4.4
 */

const PROVIDER_IDS = PROVIDER_LABELS.map((p) => p.id);
const TOOL_METHODS: ProviderConfig['tool_method'][] = [
    'FunctionCall',
    'Auto',
    'FunctionCallRequired',
    'StructuredOutput',
    'Parsing',
];

// Build a valid env_vars record for a given provider: every required (non-optional)
// field gets a non-empty value; optional fields are randomly present.
function envVarsArbFor(providerId: string): fc.Arbitrary<Record<string, string>> {
    const fields = PROVIDER_ENV_FIELDS[providerId] ?? [];
    const entries = fields.map((f) => {
        const value = fc.string({ minLength: 1, maxLength: 12 }).map((s) => s.trim() || 'x');
        if (f.optional) {
            return fc.option(value, { nil: undefined }).map(
                (v) => [f.key, v] as [string, string | undefined]
            );
        }
        return value.map((v) => [f.key, v] as [string, string | undefined]);
    });
    return fc.tuple(...entries).map((pairs) => {
        const rec: Record<string, string> = {};
        for (const [k, v] of pairs) {
            if (v !== undefined) {
                rec[k] = v;
            }
        }
        return rec;
    });
}

// A single valid ProviderConfig.
const providerConfigArb: fc.Arbitrary<ProviderConfig> = fc
    .constantFrom(...PROVIDER_IDS)
    .chain((providerId) =>
        fc.record({
            provider: fc.constant(providerId),
            env_vars: envVarsArbFor(providerId),
            model: fc.string({ minLength: 1, maxLength: 20 }).map((s) => s.trim() || 'model-x'),
            tool_method: fc.constantFrom(...TOOL_METHODS),
        })
    );

// A valid config with 1..N providers.
const configArb: fc.Arbitrary<ShaiAuthConfig> = fc
    .array(providerConfigArb, { minLength: 1, maxLength: 6 })
    .chain((providers) =>
        fc.record({
            providers: fc.constant(providers),
            selected_provider: fc.integer({ min: 0, max: providers.length - 1 }),
            mcp_configs: fc.constant({} as Record<string, unknown>),
        })
    );

// An invalid update input: provider/env/model that fail validateNewProvider.
type Update = { providerId: string; envVars: Record<string, string>; model: string };

// Case A: empty (or whitespace-only) model with an otherwise-valid provider/env.
const emptyModelUpdateArb: fc.Arbitrary<Update> = fc
    .constantFrom(...PROVIDER_IDS)
    .chain((providerId) =>
        fc.record({
            providerId: fc.constant(providerId),
            envVars: envVarsArbFor(providerId),
            model: fc.constantFrom('', '   ', '\t', '\n  '),
        })
    );

// Case B: unknown provider id (not in PROVIDER_ENV_FIELDS), non-empty model.
const unknownProviderUpdateArb: fc.Arbitrary<Update> = fc.record({
    providerId: fc
        .string({ minLength: 1, maxLength: 15 })
        .filter((s) => !PROVIDER_ENV_FIELDS[s.trim()] && s.trim().length > 0),
    envVars: fc.constant({} as Record<string, string>),
    model: fc.string({ minLength: 1, maxLength: 20 }).map((s) => s.trim() || 'model-x'),
});

// Providers that actually have at least one required (non-optional) env field.
const PROVIDERS_WITH_REQUIRED = PROVIDER_IDS.filter((id) =>
    (PROVIDER_ENV_FIELDS[id] ?? []).some((f) => !f.optional)
);

// Case C: a required env field is missing/blank, non-empty model.
const missingRequiredEnvUpdateArb: fc.Arbitrary<Update> = fc
    .constantFrom(...PROVIDERS_WITH_REQUIRED)
    .chain((providerId) => {
        const required = (PROVIDER_ENV_FIELDS[providerId] ?? []).filter((f) => !f.optional);
        return fc
            .integer({ min: 0, max: required.length - 1 })
            .chain((dropIdx) => {
                // Build env with every required field present except one, which is blanked.
                const entries = required.map((f, i) => {
                    if (i === dropIdx) {
                        return fc
                            .constantFrom('', '   ')
                            .map((v) => [f.key, v] as [string, string]);
                    }
                    return fc
                        .string({ minLength: 1, maxLength: 10 })
                        .map((s) => [f.key, s.trim() || 'x'] as [string, string]);
                });
                return fc.tuple(...entries).map((pairs) => {
                    const rec: Record<string, string> = {};
                    for (const [k, v] of pairs) {
                        rec[k] = v;
                    }
                    return {
                        providerId,
                        envVars: rec,
                        model: 'some-model',
                    } as Update;
                });
            });
    });

const invalidUpdateArb: fc.Arbitrary<Update> = fc.oneof(
    emptyModelUpdateArb,
    unknownProviderUpdateArb,
    missingRequiredEnvUpdateArb
);

describe('updateProviderAt — Property 10: An invalid update is rejected without mutation', () => {
    it('returns the validation error and leaves the config unchanged (Validates: Requirements 4.3, 4.4)', () => {
        fc.assert(
            fc.property(
                configArb,
                invalidUpdateArb,
                fc.integer(),
                (config, update, indexSeed) => {
                    // Pick a valid in-range index so rejection is driven by validation,
                    // not the bounds check.
                    const index =
                        ((indexSeed % config.providers.length) + config.providers.length) %
                        config.providers.length;

                    // Confirm the generated update is genuinely invalid per the validator.
                    const expectedErr = validateNewProvider(
                        (update.providerId || '').trim(),
                        update.envVars,
                        (update.model || '').trim()
                    );
                    fc.pre(expectedErr !== null);

                    const before = JSON.parse(JSON.stringify(config)) as ShaiAuthConfig;

                    const err = updateProviderAt(
                        config,
                        index,
                        update.providerId,
                        update.envVars,
                        update.model
                    );

                    // A non-null validation error string is returned.
                    assert.strictEqual(typeof err, 'string');
                    assert.ok(err && err.length > 0, 'expected a non-empty error string');
                    assert.strictEqual(err, expectedErr);

                    // The whole config is unchanged (deep equality against the pre-call clone).
                    assert.deepStrictEqual(config, before);
                }
            ),
            { numRuns: 200 }
        );
    });
});
