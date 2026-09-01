import * as assert from 'assert';
import fc from 'fast-check';
import { sanitizeContextId } from './contextManager';

/**
 * Feature: user-friendliness-improvements, Property 10: Sanitization maps disallowed characters to underscore
 *
 * For any input string, `sanitizeContextId` returns a string of the same
 * length in which every position holding a letter, digit, hyphen, or
 * underscore is preserved unchanged, and every other position is replaced
 * with an underscore (so the output contains only characters from the set
 * letters, digits, hyphen, underscore).
 *
 * Validates: Requirements 4.2
 */

/** True when a single character is in the allowed set [A-Za-z0-9_-]. */
function isAllowedChar(ch: string): boolean {
    return /^[a-zA-Z0-9_-]$/.test(ch);
}

describe('sanitizeContextId — Property 10: Sanitization maps disallowed characters to underscore', () => {
    it('preserves length, keeps allowed chars, maps all others to underscore, and yields only allowed chars', () => {
        fc.assert(
            fc.property(fc.string(), (raw) => {
                const out = sanitizeContextId(raw);

                // Same length as the input.
                assert.strictEqual(
                    out.length,
                    raw.length,
                    `output length ${out.length} should equal input length ${raw.length}`
                );

                for (let i = 0; i < raw.length; i++) {
                    const inChar = raw[i];
                    const outChar = out[i];
                    if (isAllowedChar(inChar)) {
                        // Allowed characters are preserved unchanged.
                        assert.strictEqual(
                            outChar,
                            inChar,
                            `allowed char '${inChar}' at index ${i} should be preserved`
                        );
                    } else {
                        // Every other position becomes an underscore.
                        assert.strictEqual(
                            outChar,
                            '_',
                            `disallowed char '${inChar}' at index ${i} should become '_'`
                        );
                    }
                }

                // The output contains only allowed characters.
                assert.ok(
                    /^[a-zA-Z0-9_-]*$/.test(out),
                    `output '${out}' should contain only [A-Za-z0-9_-]`
                );
            }),
            { numRuns: 100 }
        );
    });
});
