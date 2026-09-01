import * as assert from 'assert';
import fc from 'fast-check';
import {
    PROVIDER_ENV_FIELDS,
    EnvField,
    validateNewProvider,
} from './authConfig';
import { PROVIDER_IDS, nonBlankString, modelForProvider } from './testUtils.gen';

/** Whitespace-only strings that must count as "empty" after trim. */
const blankString = (): fc.Arbitrary<string> =>
    fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'), {
        minLength: 0,
        maxLength: 6,
    });

/** Providers that have at least one required (non-optional) field. */
const PROVIDERS_WITH_REQUIRED = PROVIDER_IDS.filter((id) =>
    (PROVIDER_ENV_FIELDS[id] || []).some((f) => !f.optional)
);

const requiredCount = (providerId: string): number =>
    (PROVIDER_ENV_FIELDS[providerId] || []).filter((f) => !f.optional).length;

/**
 * Feature: user-friendliness-improvements, Property 13: Required-field
 * validation names the empty field
 *
 * For any Provider and any env-var map in which at least one required
 * (non-optional) Env_Field is empty or whitespace, `validateNewProvider`
 * returns a non-null message that includes the label of an empty required
 * field. This guarantees the Auth_Wizard can always tell the user which field
 * to fix. (Req 6.1)
 *
 * Note on argument order: `validateNewProvider(providerId, envVars, model)`
 * checks the model first, so this property supplies a non-blank model to
 * exercise the required-field branch.
 *
 * Validates: Requirements 6.1
 */
describe('validateNewProvider — Property 13: Required-field validation names the empty field', () => {
    /**
     * Arbitrary yielding a provider id, a non-blank model, an env-var map in
     * which at least one required field is blank, and the labels of the fields
     * left blank.
     */
    const scenario = (): fc.Arbitrary<{
        providerId: string;
        model: string;
        envVars: Record<string, string>;
        emptyLabels: string[];
    }> =>
        fc.constantFrom(...PROVIDERS_WITH_REQUIRED).chain((providerId) => {
            const fields = PROVIDER_ENV_FIELDS[providerId] || [];
            const reqCount = requiredCount(providerId);
            // One boolean per required field marking whether it is blanked;
            // force at least one true so the map is guaranteed invalid.
            const blankFlags = fc
                .array(fc.boolean(), { minLength: reqCount, maxLength: reqCount })
                .map((flags) => (flags.some((b) => b) ? flags : flags.map((_, i) => i === 0)));

            return blankFlags.chain((flags) => {
                let reqIdx = 0;
                const perField = fields.map((f: EnvField) => {
                    if (f.optional) {
                        return nonBlankString().map(
                            (v) => ({ key: f.key, label: f.label, value: v, blank: false })
                        );
                    }
                    const blank = flags[reqIdx++];
                    return (blank ? blankString() : nonBlankString()).map((v) => ({
                        key: f.key,
                        label: f.label,
                        value: v,
                        blank,
                    }));
                });
                return fc
                    .tuple(modelForProvider(providerId), fc.tuple(...perField))
                    .map(([model, entries]) => {
                        const envVars: Record<string, string> = {};
                        const emptyLabels: string[] = [];
                        for (const e of entries) {
                            envVars[e.key] = e.value;
                            if (e.blank) {
                                emptyLabels.push(e.label);
                            }
                        }
                        return { providerId, model, envVars, emptyLabels };
                    });
            });
        });

    it('returns a non-null message naming an empty required field', () => {
        fc.assert(
            fc.property(scenario(), ({ providerId, model, envVars, emptyLabels }) => {
                const msg = validateNewProvider(providerId, envVars, model);
                assert.notStrictEqual(msg, null, 'expected a non-null validation message');
                const message = msg as string;
                // The message must name at least one of the empty required fields.
                const namesAnEmptyField = emptyLabels.some((label) =>
                    message.includes(label)
                );
                assert.ok(
                    namesAnEmptyField,
                    `message ${JSON.stringify(message)} should name one of the empty ` +
                        `required fields ${JSON.stringify(emptyLabels)}`
                );
            }),
            { numRuns: 100 }
        );
    });
});

/**
 * Feature: user-friendliness-improvements, Property 14: Empty model is rejected
 * with a model message
 *
 * For any Provider and any model string consisting only of whitespace,
 * `validateNewProvider` returns a non-null message that mentions the model.
 * (Req 6.2)
 *
 * Validates: Requirements 6.2
 */
describe('validateNewProvider — Property 14: Empty model is rejected with a model message', () => {
    it('returns a non-null message mentioning the model for a whitespace-only model', () => {
        fc.assert(
            fc.property(
                fc.constantFrom(...PROVIDER_IDS),
                blankString(),
                (providerId, model) => {
                    const msg = validateNewProvider(providerId, {}, model);
                    assert.notStrictEqual(
                        msg,
                        null,
                        'expected a non-null validation message for an empty model'
                    );
                    const message = msg as string;
                    assert.ok(
                        /model/i.test(message),
                        `message ${JSON.stringify(message)} should mention the model`
                    );
                }
            ),
            { numRuns: 100 }
        );
    });
});
