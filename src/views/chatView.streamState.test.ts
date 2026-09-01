import * as assert from 'assert';
import fc from 'fast-check';

/**
 * Feature: user-friendliness-improvements, Property 12: Streaming state machine
 * and send-control invariant
 *
 * For any sequence of streaming events (`submit`, `progress`, `complete`,
 * `error`), the resulting indicator state matches the transition rules
 * (`submit`->sending, `progress`->receiving only while sending/receiving,
 * `complete`->completed, `error`->failed), and the send control is disabled
 * exactly when the state is `sending` or `receiving` and enabled exactly when
 * the state is `idle`, `completed`, or `failed`.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 *
 * NOTE (mirror, not import): `nextStreamState`/`sendEnabled` are exported from
 * `src/views/chatView.ts`, but that module executes `import * as vscode from
 * 'vscode'` at load time, which is not resolvable in the Mocha/ts-node test
 * environment. Following the design's "mirror, not import" convention, the two
 * pure reducers are mirrored below verbatim from chatView.ts and must be kept
 * in sync with production.
 */

type StreamState = 'idle' | 'sending' | 'receiving' | 'completed' | 'failed';
type StreamEvent = 'submit' | 'progress' | 'complete' | 'error';

// --- Mirror of src/views/chatView.ts:nextStreamState (keep in sync) ---
function nextStreamState(state: StreamState, event: StreamEvent): StreamState {
    switch (event) {
        case 'submit':
            return 'sending';
        case 'progress':
            return (state === 'sending' || state === 'receiving') ? 'receiving' : state;
        case 'complete':
            return 'completed';
        case 'error':
            return 'failed';
    }
}

// --- Mirror of src/views/chatView.ts:sendEnabled (keep in sync) ---
function sendEnabled(state: StreamState): boolean {
    return state === 'idle' || state === 'completed' || state === 'failed';
}

const streamEventArb: fc.Arbitrary<StreamEvent> = fc.constantFrom(
    'submit',
    'progress',
    'complete',
    'error'
);

const streamStateArb: fc.Arbitrary<StreamState> = fc.constantFrom(
    'idle',
    'sending',
    'receiving',
    'completed',
    'failed'
);

/**
 * Independent oracle for the transition rules, expressed as plain assertions
 * against the spec wording rather than by re-deriving the reducer's structure.
 */
function assertTransition(prev: StreamState, event: StreamEvent, actual: StreamState): void {
    switch (event) {
        case 'submit':
            // Req 5.1: submit always moves to sending.
            assert.strictEqual(actual, 'sending', `submit from ${prev} must yield sending`);
            break;
        case 'progress':
            // Req 5.2: progress yields receiving only while already sending/receiving;
            // otherwise the state is unchanged.
            if (prev === 'sending' || prev === 'receiving') {
                assert.strictEqual(actual, 'receiving', `progress from ${prev} must yield receiving`);
            } else {
                assert.strictEqual(actual, prev, `progress from ${prev} must not change state`);
            }
            break;
        case 'complete':
            // Req 5.3: complete always moves to completed.
            assert.strictEqual(actual, 'completed', `complete from ${prev} must yield completed`);
            break;
        case 'error':
            // Req 5.4: error always moves to failed.
            assert.strictEqual(actual, 'failed', `error from ${prev} must yield failed`);
            break;
    }
}

describe('chatView streaming state machine — Property 12: state machine and send-control invariant', () => {
    it('folds arbitrary event sequences per the transition rules and holds the send-control invariant', () => {
        fc.assert(
            fc.property(
                streamStateArb,
                fc.array(streamEventArb, { minLength: 0, maxLength: 50 }),
                (initial, events) => {
                    let state = initial;

                    for (const event of events) {
                        const prev = state;
                        const next = nextStreamState(prev, event);

                        // Transition matches the spec rules (Req 5.1-5.4).
                        assertTransition(prev, event, next);

                        // Result is always a valid state.
                        assert.ok(
                            ['idle', 'sending', 'receiving', 'completed', 'failed'].includes(next),
                            `invalid state produced: ${next}`
                        );

                        state = next;

                        // Send-control invariant (Req 5.5, 5.6): disabled exactly when in
                        // sending/receiving, enabled exactly when idle/completed/failed.
                        const inProgress = state === 'sending' || state === 'receiving';
                        assert.strictEqual(
                            sendEnabled(state),
                            !inProgress,
                            `sendEnabled(${state}) must be ${!inProgress}`
                        );
                    }
                }
            ),
            { numRuns: 100 }
        );
    });

    it('holds the send-control invariant for every reachable state (Req 5.5, 5.6)', () => {
        fc.assert(
            fc.property(streamStateArb, (state) => {
                const inProgress = state === 'sending' || state === 'receiving';
                assert.strictEqual(sendEnabled(state), !inProgress);
            }),
            { numRuns: 100 }
        );
    });
});
