import * as assert from 'assert';
import fc from 'fast-check';
import { PROVIDER_ENV_FIELDS } from './authConfig';
import { PROVIDER_IDS } from './testUtils.gen';

/**
 * Feature: user-friendliness-improvements, Property 1: Every provider field has help text
 *
 * For every Provider and every Env_Field in `PROVIDER_ENV_FIELDS`, the field's
 * `help` property is a non-empty string. This guarantees the Auth_Wizard can
 * always render inline Help_Text for any field it presents.
 *
 * Validates: Requirements 1.2
 */

/** A [providerId, fieldIndex] pair identifying one Env_Field. */
type FieldRef = { providerId: string; fieldIndex: number };

/**
 * Arbitrary over every (provider, field) pair in `PROVIDER_ENV_FIELDS`. Drawing
 * from the full flattened list of pairs lets fast-check exercise the property
 * across all fields of all providers.
 */
function fieldRefArbitrary(): fc.Arbitrary<FieldRef> {
    const refs: FieldRef[] = [];
    for (const providerId of PROVIDER_IDS) {
        const fields = PROVIDER_ENV_FIELDS[providerId] || [];
        fields.forEach((_f, fieldIndex) => {
            refs.push({ providerId, fieldIndex });
        });
    }
    return fc.constantFrom(...refs);
}

describe('PROVIDER_ENV_FIELDS — Property 1: Every provider field has help text', () => {
    it('every env field of every provider defines a non-empty help string', () => {
        fc.assert(
            fc.property(fieldRefArbitrary(), ({ providerId, fieldIndex }) => {
                const field = PROVIDER_ENV_FIELDS[providerId][fieldIndex];
                assert.strictEqual(
                    typeof field.help,
                    'string',
                    `help for ${providerId}.${field.key} should be a string`
                );
                assert.ok(
                    (field.help as string).trim().length > 0,
                    `help for ${providerId}.${field.key} should be non-empty`
                );
            }),
            { numRuns: 100 }
        );
    });
});
