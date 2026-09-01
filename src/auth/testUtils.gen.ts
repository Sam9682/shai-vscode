/**
 * Shared fast-check generators for profile-inline-edit backend property tests.
 *
 * These generators produce valid `ShaiAuthConfig` values whose entries pass
 * `validateNewProvider`: the `provider` is drawn from the known ids in
 * `PROVIDER_ENV_FIELDS`, every required (non-optional) env field is populated
 * with a non-empty value, and the model is a non-empty string (drawn from
 * `OVHCLOUD_MODEL_OPTIONS` for OVH providers or an arbitrary non-blank string
 * otherwise).
 *
 * Reused across the backend property tests (tasks 2.2 - 2.5).
 */
import fc from 'fast-check';
import {
    ProviderConfig,
    ShaiAuthConfig,
    PROVIDER_ENV_FIELDS,
    OVHCLOUD_MODEL_OPTIONS,
} from './authConfig';

export const PROVIDER_IDS: string[] = Object.keys(PROVIDER_ENV_FIELDS);

const TOOL_METHODS: ProviderConfig['tool_method'][] = [
    'FunctionCall',
    'Auto',
    'FunctionCallRequired',
    'StructuredOutput',
    'Parsing',
];

/** A non-blank string (has at least one non-whitespace character after trim). */
export const nonBlankString = (): fc.Arbitrary<string> =>
    fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0);

/** A model value valid for the given provider. */
export const modelForProvider = (providerId: string): fc.Arbitrary<string> =>
    providerId === 'ovhcloud'
        ? fc.oneof(fc.constantFrom(...OVHCLOUD_MODEL_OPTIONS), nonBlankString())
        : nonBlankString();

/**
 * Build a valid `env_vars` map for a provider: required fields get non-blank
 * values; optional fields are randomly present or absent.
 */
export const envVarsForProvider = (
    providerId: string
): fc.Arbitrary<Record<string, string>> => {
    const fields = PROVIDER_ENV_FIELDS[providerId] || [];
    if (fields.length === 0) {
        return fc.constant({} as Record<string, string>);
    }
    const entryArbs = fields.map((f) => {
        if (f.optional) {
            // optional: either omit the key, or include a non-blank value
            return fc.oneof(
                fc.constant(null as [string, string] | null),
                nonBlankString().map((v) => [f.key, v] as [string, string] | null)
            );
        }
        return nonBlankString().map((v) => [f.key, v] as [string, string] | null);
    });
    return fc.tuple(...entryArbs).map((entries) => {
        const obj: Record<string, string> = {};
        for (const e of entries) {
            if (e) {
                obj[e[0]] = e[1];
            }
        }
        return obj;
    });
};

/** A single valid ProviderConfig entry. */
export const validProviderConfig = (): fc.Arbitrary<ProviderConfig> =>
    fc.constantFrom(...PROVIDER_IDS).chain((providerId) =>
        fc.record({
            provider: fc.constant(providerId),
            env_vars: envVarsForProvider(providerId),
            model: modelForProvider(providerId),
            tool_method: fc.constantFrom(...TOOL_METHODS),
        })
    );

/**
 * A valid ShaiAuthConfig with 1..maxProviders entries and a `selected_provider`
 * that is always a valid index into `providers`.
 */
export const validAuthConfig = (maxProviders = 6): fc.Arbitrary<ShaiAuthConfig> =>
    fc
        .array(validProviderConfig(), { minLength: 1, maxLength: maxProviders })
        .chain((providers) =>
            fc.record({
                providers: fc.constant(providers),
                selected_provider: fc.integer({ min: 0, max: providers.length - 1 }),
                mcp_configs: fc.constant({} as Record<string, unknown>),
            })
        );

/** A valid index into a config's providers array. */
export const validIndexFor = (config: ShaiAuthConfig): fc.Arbitrary<number> =>
    fc.integer({ min: 0, max: config.providers.length - 1 });
