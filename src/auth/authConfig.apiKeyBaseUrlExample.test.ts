import * as assert from 'assert';
import fc from 'fast-check';
import { PROVIDER_ENV_FIELDS } from './authConfig';
import { PROVIDER_IDS } from './testUtils.gen';

/**
 * Feature: user-friendliness-improvements, Property 2: API-key and base-URL fields have an example
 *
 * For every Provider and every Env_Field in `PROVIDER_ENV_FIELDS` whose `key`
 * ends with `_API_KEY` or `_BASE_URL`, the field's `example` property is a
 * non-empty string. This guarantees the Auth_Wizard can always render a
 * realistic placeholder for the fields that accept an API key or a base URL.
 *
 * Validates: Requirements 1.3
 */

/** True when a field key identifies an API-key or base-URL field. */
function isApiKeyOrBaseUrl(key: string): boolean {
    return key.endsWith('_API_KEY') || key.endsWith('_BASE_URL');
}

/** A [providerId, fieldIndex] pair identifying one Env_Field. */
type FieldRef = { providerId: string; fieldIndex: number };

/**
 * Arbitrary over every (provider, field) pair in `PROVIDER_ENV_FIELDS` whose
 * key ends with `_API_KEY` or `_BASE_URL`. Drawing from the full flattened list
 * of matching pairs lets fast-check exercise the property across all API-key and
 * base-URL fields of all providers.
 */
function apiKeyOrBaseUrlFieldRefArbitrary(): fc.Arbitrary<FieldRef> {
    const refs: FieldRef[] = [];
    for (const providerId of PROVIDER_IDS) {
        const fields = PROVIDER_ENV_FIELDS[providerId] || [];
        fields.forEach((f, fieldIndex) => {
            if (isApiKeyOrBaseUrl(f.key)) {
                refs.push({ providerId, fieldIndex });
            }
        });
    }
    return fc.constantFrom(...refs);
}

describe('PROVIDER_ENV_FIELDS — Property 2: API-key and base-URL fields have an example', () => {
    it('every _API_KEY / _BASE_URL field of every provider defines a non-empty example string', () => {
        fc.assert(
            fc.property(apiKeyOrBaseUrlFieldRefArbitrary(), ({ providerId, fieldIndex }) => {
                const field = PROVIDER_ENV_FIELDS[providerId][fieldIndex];
                assert.strictEqual(
                    typeof field.example,
                    'string',
                    `example for ${providerId}.${field.key} should be a string`
                );
                assert.ok(
                    (field.example as string).trim().length > 0,
                    `example for ${providerId}.${field.key} should be non-empty`
                );
            }),
            { numRuns: 100 }
        );
    });
});
