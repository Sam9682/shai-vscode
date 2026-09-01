import * as assert from 'assert';
import fc from 'fast-check';
import { getModelHelp } from './authConfig';
import { PROVIDER_IDS } from './testUtils.gen';

/**
 * Feature: user-friendliness-improvements, Property 5: Model help is defined and rendered for every provider
 *
 * Map half: for every Provider id in `PROVIDER_ENV_FIELDS` (exposed as
 * `PROVIDER_IDS`), `getModelHelp(providerId)` returns a non-empty string. This
 * guarantees the Auth_Wizard always has model-field guidance to render for the
 * selected provider. The render half is covered by the wizard render tests.
 *
 * Validates: Requirements 2.1
 */
describe('getModelHelp — Property 5: Model help is defined for every provider', () => {
    it('returns a non-empty string for every provider id', () => {
        fc.assert(
            fc.property(fc.constantFrom(...PROVIDER_IDS), (providerId) => {
                const help = getModelHelp(providerId);
                assert.strictEqual(
                    typeof help,
                    'string',
                    `model help for ${providerId} should be a string`
                );
                assert.ok(
                    help.trim().length > 0,
                    `model help for ${providerId} should be non-empty`
                );
            }),
            { numRuns: 100 }
        );
    });
});

/**
 * Unit test: the ovhcloud model help explains that a model can be chosen from
 * the list or entered as a custom identifier.
 *
 * Validates: Requirements 2.2
 */
describe('getModelHelp — ovhcloud custom-or-list guidance', () => {
    it('mentions choosing from a list and entering a custom identifier', () => {
        const help = getModelHelp('ovhcloud');
        assert.match(help, /custom/i, 'ovhcloud model help should mention a custom identifier');
        assert.match(help, /list/i, 'ovhcloud model help should mention choosing from the list');
    });
});
