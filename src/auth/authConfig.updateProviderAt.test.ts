import * as assert from 'assert';
import fc from 'fast-check';
import { updateProviderAt } from './authConfig';
import {
    validAuthConfig,
    validProviderConfig,
} from './testUtils.gen';

/**
 * Feature: profile-inline-edit, Property 9: A valid update replaces only the
 * target entry and preserves invariants
 *
 * For any configuration and any valid Update_Message targeting a valid
 * Profile_Index, applying the update leaves `providers.length` unchanged,
 * writes the submitted provider, env vars, and model into
 * `cfg.providers[index]`, preserves that entry's original `tool_method`, and
 * leaves `selected_provider` unchanged.
 *
 * Validates: Requirements 2.8, 4.5, 5.1, 5.4, 4.8
 */
describe('updateProviderAt — Property 9: valid update preserves invariants', () => {
    it('replaces only the target entry and preserves length, tool_method, and selected_provider', () => {
        const scenario = validAuthConfig().chain((config) =>
            fc.record({
                config: fc.constant(config),
                index: fc.integer({ min: 0, max: config.providers.length - 1 }),
                submission: validProviderConfig(),
            })
        );

        fc.assert(
            fc.property(scenario, ({ config, index, submission }) => {
                // Snapshot the original config to compare untouched invariants.
                const original = JSON.parse(JSON.stringify(config));
                const originalLength = original.providers.length;
                const originalSelected = original.selected_provider;
                const originalToolMethod = original.providers[index].tool_method;

                const err = updateProviderAt(
                    config,
                    index,
                    submission.provider,
                    submission.env_vars,
                    submission.model
                );

                // A valid submission must succeed.
                assert.strictEqual(err, null, `expected success, got: ${err}`);

                // providers.length unchanged (Req 4.5 / 5.4).
                assert.strictEqual(config.providers.length, originalLength);

                // selected_provider unchanged (Req 5.1).
                assert.strictEqual(config.selected_provider, originalSelected);

                const target = config.providers[index];

                // Target entry holds the submitted provider/env/model (Req 4.5, 4.8).
                assert.strictEqual(target.provider, submission.provider.trim());
                assert.strictEqual(target.model, submission.model.trim());
                assert.deepStrictEqual(target.env_vars, submission.env_vars);

                // Original tool_method preserved (Req 2.8).
                assert.strictEqual(target.tool_method, originalToolMethod);

                // Every other entry is untouched.
                for (let i = 0; i < config.providers.length; i++) {
                    if (i === index) {
                        continue;
                    }
                    assert.deepStrictEqual(config.providers[i], original.providers[i]);
                }
            }),
            { numRuns: 100 }
        );
    });
});
