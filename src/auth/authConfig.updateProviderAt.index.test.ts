import * as assert from 'assert';
import fc from 'fast-check';
import {
    updateProviderAt,
    PROVIDER_ENV_FIELDS,
    ShaiAuthConfig,
    ProviderConfig,
} from './authConfig';

// Locally-defined generators (kept in this file to avoid collisions with
// generator helpers other subagents may be adding concurrently).

const PROVIDER_IDS = Object.keys(PROVIDER_ENV_FIELDS);

const TOOL_METHODS: ProviderConfig['tool_method'][] = [
    'FunctionCall',
    'Auto',
    'FunctionCallRequired',
    'StructuredOutput',
    'Parsing',
];

/** A single ProviderConfig whose env_vars cover the schema keys for its provider. */
function providerConfigArb(): fc.Arbitrary<ProviderConfig> {
    return fc.constantFrom(...PROVIDER_IDS).chain((provider) => {
        const fields = PROVIDER_ENV_FIELDS[provider];
        const envEntries = fields.map((f) =>
            fc.string({ minLength: 1, maxLength: 20 }).map((v) => [f.key, v] as [string, string])
        );
        return fc.record({
            provider: fc.constant(provider),
            env_vars:
                envEntries.length === 0
                    ? fc.constant({} as Record<string, string>)
                    : fc.tuple(...envEntries).map((pairs) => Object.fromEntries(pairs)),
            model: fc.string({ minLength: 1, maxLength: 20 }),
            tool_method: fc.constantFrom(...TOOL_METHODS),
        });
    });
}

function configArb(): fc.Arbitrary<ShaiAuthConfig> {
    return fc
        .array(providerConfigArb(), { minLength: 1, maxLength: 6 })
        .chain((providers) =>
            fc.record({
                providers: fc.constant(providers),
                selected_provider: fc.integer({ min: 0, max: providers.length - 1 }),
                mcp_configs: fc.constant({} as Record<string, unknown>),
            })
        );
}

/** Env vars that would pass validateNewProvider for a given provider (so only
 * the index check can be the source of any rejection). */
function validEnvVarsFor(provider: string): Record<string, string> {
    const fields = PROVIDER_ENV_FIELDS[provider] || [];
    const out: Record<string, string> = {};
    for (const f of fields) {
        out[f.key] = 'value';
    }
    return out;
}

describe('updateProviderAt — out-of-range index rejection', () => {
    // Feature: profile-inline-edit, Property 11: An out-of-range index is rejected without mutation
    it('rejects any out-of-range/non-integer index and leaves the config unchanged', () => {
        // An index that is negative, >= length, or a non-integer (float / NaN).
        const outOfRangeIndexArb = (len: number) =>
            fc.oneof(
                fc.integer({ min: -1000, max: -1 }), // negative
                fc.integer({ min: len, max: len + 1000 }), // >= length
                fc
                    .float({ min: 0, max: len, noNaN: true })
                    .filter((n) => !Number.isInteger(n)), // non-integer float in range
                fc.constant(Number.NaN),
                fc.constant(Number.POSITIVE_INFINITY),
                fc.constant(Number.NEGATIVE_INFINITY),
                fc.constant(len + 0.5)
            );

        fc.assert(
            fc.property(
                configArb(),
                fc.constantFrom(...PROVIDER_IDS),
                fc.string({ minLength: 1, maxLength: 20 }),
                (config, providerId, model) => {
                    return fc.assert(
                        fc.property(outOfRangeIndexArb(config.providers.length), (index) => {
                            const snapshot = JSON.parse(JSON.stringify(config));
                            const envVars = validEnvVarsFor(providerId);

                            const err = updateProviderAt(config, index, providerId, envVars, model);

                            // A non-null error string is returned.
                            assert.strictEqual(
                                typeof err,
                                'string',
                                `expected an error string for index ${String(index)}`
                            );
                            assert.ok(
                                err && err.length > 0,
                                'error string must be non-empty'
                            );

                            // Config is unchanged (deep equality against snapshot).
                            assert.deepStrictEqual(config, snapshot);
                        }),
                        { numRuns: 20 }
                    );
                }
            ),
            { numRuns: 100 }
        );
    });
});
