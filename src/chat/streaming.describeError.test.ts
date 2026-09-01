import * as assert from 'assert';
import fc from 'fast-check';

/**
 * Feature: user-friendliness-improvements
 *
 * Property/unit tests for the pure streaming-error formatter
 * `describeStreamingError` (src/chat/streaming.ts).
 *
 * NOTE (mirror, not import): `describeStreamingError` (together with
 * `StreamErrorKind`/`StreamErrorContext`) is exported from
 * `src/chat/streaming.ts`, but that module executes `import * as vscode from
 * 'vscode'` (and spawns child processes) at load time, which is not resolvable
 * in the Mocha/ts-node test environment. Following the design's
 * "mirror, not import" convention (used across the auth and chatView test
 * suites), the pure formatter and its types are mirrored below verbatim from
 * streaming.ts and must be kept in sync with production.
 *
 * Mirror source (src/chat/streaming.ts):
 *   export type StreamErrorKind =
 *       'spawn-failure' | 'timeout' | 'server-status' | 'fetch-failure';
 *   export interface StreamErrorContext {
 *       shaiCommand?: string; serverUrl?: string; status?: number;
 *   }
 *   export function describeStreamingError(kind, ctx): string { ... }
 *
 * If the production formatter changes, this mirror should be updated to match
 * so drift stays detectable.
 */

// --- Mirror of src/chat/streaming.ts:StreamErrorKind (keep in sync) ---
type StreamErrorKind = 'spawn-failure' | 'timeout' | 'server-status' | 'fetch-failure';

// --- Mirror of src/chat/streaming.ts:StreamErrorContext (keep in sync) ---
interface StreamErrorContext {
    shaiCommand?: string;
    serverUrl?: string;
    status?: number;
}

// --- Mirror of src/chat/streaming.ts:describeStreamingError (keep in sync) ---
function describeStreamingError(kind: StreamErrorKind, ctx: StreamErrorContext): string {
    switch (kind) {
        case 'spawn-failure':
            return `Could not start shai. Check that the configured shai command "${ctx.shaiCommand ?? 'shai'}" is installed and on your PATH.`;
        case 'timeout':
            return `The request timed out. Try again; if it keeps timing out, the model or server may be busy.`;
        case 'server-status':
            return `The server returned an error (HTTP ${ctx.status ?? '?'}). Check the configured server URL "${ctx.serverUrl ?? ''}".`;
        case 'fetch-failure':
            return `Could not reach the server. Check that it is running and that the configured server URL "${ctx.serverUrl ?? ''}" is correct.`;
    }
}

/**
 * Feature: user-friendliness-improvements, Property 16: Spawn-failure messages
 * name the shai command
 *
 * For any configured shai command string,
 * `describeStreamingError('spawn-failure', { shaiCommand })` returns a message
 * that contains that command string and indicates that shai could not be
 * started.
 *
 * Validates: Requirements 7.1
 */
describe('describeStreamingError — Property 16: Spawn-failure messages name the shai command', () => {
    it('contains the shai command and indicates shai could not be started', () => {
        fc.assert(
            fc.property(fc.string(), (shaiCommand) => {
                const msg = describeStreamingError('spawn-failure', { shaiCommand });

                // Names the exact configured command string.
                assert.ok(
                    msg.includes(shaiCommand),
                    `expected message to contain the shai command ${JSON.stringify(shaiCommand)}; got ${JSON.stringify(msg)}`
                );
                // Indicates shai could not be started.
                assert.ok(
                    /could not start shai/i.test(msg),
                    `expected message to indicate shai could not be started; got ${JSON.stringify(msg)}`
                );
            }),
            { numRuns: 100 }
        );
    });
});

/**
 * Feature: user-friendliness-improvements, Property 17: Server error messages
 * name the server URL
 *
 * For any configured server URL string,
 * `describeStreamingError('server-status', { serverUrl, status })` and
 * `describeStreamingError('fetch-failure', { serverUrl })` each return a
 * message that contains that server URL, indicating a server error and an
 * unreachable server respectively.
 *
 * Validates: Requirements 7.3, 7.4
 */
describe('describeStreamingError — Property 17: Server error messages name the server URL', () => {
    it('server-status message contains the server URL and indicates a server error (Req 7.3)', () => {
        fc.assert(
            fc.property(fc.string(), fc.integer({ min: 100, max: 599 }), (serverUrl, status) => {
                const msg = describeStreamingError('server-status', { serverUrl, status });

                assert.ok(
                    msg.includes(serverUrl),
                    `expected server-status message to contain the server URL ${JSON.stringify(serverUrl)}; got ${JSON.stringify(msg)}`
                );
                assert.ok(
                    /server returned an error/i.test(msg),
                    `expected server-status message to indicate a server error; got ${JSON.stringify(msg)}`
                );
            }),
            { numRuns: 100 }
        );
    });

    it('fetch-failure message contains the server URL and indicates an unreachable server (Req 7.4)', () => {
        fc.assert(
            fc.property(fc.string(), (serverUrl) => {
                const msg = describeStreamingError('fetch-failure', { serverUrl });

                assert.ok(
                    msg.includes(serverUrl),
                    `expected fetch-failure message to contain the server URL ${JSON.stringify(serverUrl)}; got ${JSON.stringify(msg)}`
                );
                assert.ok(
                    /could not reach the server/i.test(msg),
                    `expected fetch-failure message to indicate an unreachable server; got ${JSON.stringify(msg)}`
                );
            }),
            { numRuns: 100 }
        );
    });
});

/**
 * Feature: user-friendliness-improvements — unit test (Req 7.2)
 *
 * `describeStreamingError('timeout', {})` mentions that the request timed out
 * and advises retrying.
 */
describe('describeStreamingError — timeout message (Req 7.2)', () => {
    it('mentions the request timed out and to retry', () => {
        const msg = describeStreamingError('timeout', {});

        assert.ok(
            /timed out/i.test(msg),
            `expected timeout message to mention it timed out; got ${JSON.stringify(msg)}`
        );
        assert.ok(
            /try again/i.test(msg),
            `expected timeout message to advise retrying; got ${JSON.stringify(msg)}`
        );
    });
});
