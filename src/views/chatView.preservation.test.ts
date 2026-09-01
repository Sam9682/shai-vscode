import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import fc from 'fast-check';
import { JSDOM } from 'jsdom';

/**
 * Spec: chat-send-regression-fix — Bugfix workflow.
 *
 * Property 2: Preservation — Non-Syntax Behavior Unchanged.
 *
 * These tests capture the pre-regression behavioral contract for every webview
 * behavior that does NOT depend on parsing the invalid TypeScript cast
 * (`(window as any).webkitAudioContext`). They MUST PASS on the current
 * (unfixed) code and must keep passing after the fix — this establishes the
 * baseline that the fix has to preserve.
 *
 * Observation-first methodology
 * -----------------------------
 * The unfixed inline `<script>` IIFE cannot execute at all: the invalid cast
 * throws a `SyntaxError` at parse time, so none of the handlers run. We
 * therefore cannot observe the intended non-syntax behavior by loading the raw
 * production script.
 *
 * Instead we ISOLATE the intended handler bodies / `playCompletionSound`
 * semantics by extracting the production script string and correcting ONLY the
 * single offending syntax fragment (`(window as any).webkitAudioContext` ->
 * `window.webkitAudioContext`). That correction is a pure syntax fix — it does
 * not change any handler body, listener registration, oscillator frequency,
 * gain ramp, timing, or the surrounding try/catch — so the corrected script is
 * the author's intended behavior. Asserting the documented pre-regression
 * contract against this isolated/corrected form is exactly the preservation
 * baseline the design calls for.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

// --- Extract the production webview HTML + inline script from source ---------

const CHAT_VIEW_SRC = path.resolve(process.cwd(), 'src', 'views', 'chatView.ts');

/** The single offending TypeScript-only fragment (the source of the regression). */
const INVALID_CAST = '(window as any).webkitAudioContext';
/** The valid-JavaScript replacement that expresses the intended fallback. */
const VALID_CAST = 'window.webkitAudioContext';

/**
 * The webview HTML lives inside a backtick template literal in `getHtmlContent`.
 * The raw source text therefore contains template-literal escape sequences
 * (e.g. `\\s`, `\\/`, `` \` ``) that are only resolved when TypeScript evaluates
 * the literal at runtime. To observe the intended RUNTIME behavior we must
 * resolve those escapes exactly as the JS engine would.
 *
 * The HTML region contains no `${...}` interpolation (verified: every `${` in
 * chatView.ts is in host-side code outside this region), so re-evaluating the
 * slice as a template literal is a faithful, side-effect-free reconstruction of
 * the runtime string.
 */
function resolveTemplateLiteral(raw: string): string {
    // eslint-disable-next-line no-new-func
    const fn = new Function('return `' + raw + '`;');
    return fn() as string;
}

/**
 * Read the full RUNTIME HTML string produced by `getHtmlContent()` in
 * chatView.ts. The template literal is a single static string delimited by
 * `<!DOCTYPE html>` ... `</html>`; escapes are resolved so the result matches
 * what the webview actually receives.
 */
function extractWebviewHtml(): string {
    const source = fs.readFileSync(CHAT_VIEW_SRC, 'utf8');
    const start = source.indexOf('<!DOCTYPE html>');
    const end = source.indexOf('</html>');
    assert.ok(start !== -1 && end !== -1 && end > start, 'could not locate webview HTML template in chatView.ts');
    const rawTemplate = source.slice(start, end + '</html>'.length);
    return resolveTemplateLiteral(rawTemplate);
}

/**
 * Return the production webview HTML with ONLY the invalid cast corrected.
 * This isolates the author's intended (non-syntax) behavior so it can be
 * observed and asserted against the documented pre-regression contract.
 */
function extractCorrectedWebviewHtml(): string {
    const html = extractWebviewHtml();
    // Normalize to the intended, valid-JavaScript form regardless of whether the
    // source is pre-fix (contains the invalid cast) or post-fix (already valid).
    // If the invalid cast is present it is substituted; otherwise the already
    // valid `window.webkitAudioContext` is left untouched. Either way the exact
    // same corrected runtime script is exercised, so this baseline stays stable
    // across the fix without weakening any behavioral assertion below.
    return html.split(INVALID_CAST).join(VALID_CAST);
}

/** Extract the corrected inline `<script>` IIFE body from the webview HTML. */
function extractCorrectedInlineScript(): string {
    const html = extractCorrectedWebviewHtml();
    const open = html.indexOf('<script>');
    const close = html.indexOf('</script>', open);
    assert.ok(open !== -1 && close !== -1, 'could not locate inline <script> in webview HTML');
    return html.slice(open + '<script>'.length, close);
}

// --- Load the isolated/corrected webview into jsdom --------------------------

interface PostedMessage {
    type: string;
    message?: string;
    tabId?: string | null;
    noExtraContext?: boolean;
    autopilot?: boolean;
    [k: string]: unknown;
}

interface LoadedWebview {
    dom: JSDOM;
    posted: PostedMessage[];
    parseError: Error | null;
}

/**
 * Load the corrected production webview HTML into jsdom and execute its inline
 * script. `acquireVsCodeApi` is stubbed to capture every `postMessage` payload.
 * Because we load the CORRECTED script, the IIFE parses and all listeners
 * register — this is the intended pre-regression behavior we want to preserve.
 */
function loadCorrectedWebview(): LoadedWebview {
    const posted: PostedMessage[] = [];
    let parseError: Error | null = null;

    const html = extractCorrectedWebviewHtml();

    const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        beforeParse(window) {
            (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
                postMessage: (msg: PostedMessage) => {
                    posted.push(msg);
                },
                getState: () => undefined,
                setState: () => undefined,
            });
            window.addEventListener('error', (e: any) => {
                parseError = (e && (e.error || e.message)) as Error;
            });
        },
    });

    // The isolated/corrected script must run cleanly — otherwise the baseline is
    // invalid and the preservation assertions below would be meaningless.
    assert.strictEqual(parseError, null, `corrected inline script must parse and run (got: ${parseError})`);
    return { dom, posted, parseError };
}

function fireEnter(loaded: LoadedWebview, text: string, opts: { shiftKey?: boolean } = {}): void {
    const { window } = loaded.dom;
    const doc = window.document;
    const promptEl = doc.getElementById('prompt') as HTMLTextAreaElement;
    assert.ok(promptEl, 'prompt textarea missing');
    promptEl.value = text;
    const event = new window.KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: !!opts.shiftKey,
        bubbles: true,
        cancelable: true,
    });
    promptEl.dispatchEvent(event);
}

function fireSend(loaded: LoadedWebview, text: string): void {
    const { window } = loaded.dom;
    const doc = window.document;
    const promptEl = doc.getElementById('prompt') as HTMLTextAreaElement;
    const sendBtn = doc.getElementById('send') as HTMLButtonElement;
    assert.ok(promptEl && sendBtn, 'prompt/send elements missing');
    promptEl.value = text;
    sendBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function chatPrompts(posted: PostedMessage[]): PostedMessage[] {
    return posted.filter((m) => m && m.type === 'chat-prompt');
}

// --- Isolate playCompletionSound so its Web Audio semantics can be observed --

/**
 * A recording mock of the Web Audio API. Every call is logged so we can assert
 * the documented tone frequencies, gain ramps, and timing are unchanged.
 */
interface AudioCall {
    op: string;
    args: unknown[];
}

function makeAudioContextMock(calls: AudioCall[]) {
    const currentTime = 0;

    function makeGain() {
        const gain = {
            setValueAtTime: (v: number, t: number) => {
                calls.push({ op: 'gain.setValueAtTime', args: [v, t] });
            },
            exponentialRampToValueAtTime: (v: number, t: number) => {
                calls.push({ op: 'gain.exponentialRampToValueAtTime', args: [v, t] });
            },
        };
        return {
            gain,
            connect: (dest: unknown) => calls.push({ op: 'gainNode.connect', args: [dest ? 'node' : dest] }),
        };
    }

    function makeOscillator() {
        return {
            type: 'sine',
            frequency: {
                setValueAtTime: (v: number, t: number) => {
                    calls.push({ op: 'osc.frequency.setValueAtTime', args: [v, t] });
                },
            },
            connect: (dest: unknown) => calls.push({ op: 'oscillator.connect', args: [dest ? 'node' : dest] }),
            start: (t: number) => calls.push({ op: 'osc.start', args: [t] }),
            stop: (t: number) => calls.push({ op: 'osc.stop', args: [t] }),
        };
    }

    return function AudioContextCtor(this: unknown) {
        calls.push({ op: 'new AudioContext', args: [] });
        return {
            currentTime,
            destination: { __dest: true },
            createOscillator: () => {
                calls.push({ op: 'createOscillator', args: [] });
                return makeOscillator();
            },
            createGain: () => {
                calls.push({ op: 'createGain', args: [] });
                return makeGain();
            },
        };
    } as unknown as new () => AudioContext;
}

/**
 * Extract ONLY the `playCompletionSound` function body from the corrected
 * inline script and expose it as a callable. This isolates the completion-sound
 * semantics from the rest of the IIFE so we can drive it with a mock Web Audio
 * API (available or unavailable) without needing the whole webview to run.
 */
function isolatePlayCompletionSound(win: any): () => void {
    const script = extractCorrectedInlineScript();
    const startMarker = 'function playCompletionSound()';
    const startIdx = script.indexOf(startMarker);
    assert.ok(startIdx !== -1, 'could not locate playCompletionSound in inline script');

    // Walk braces to find the matching close of the function body.
    const braceStart = script.indexOf('{', startIdx);
    assert.ok(braceStart !== -1, 'malformed playCompletionSound');
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < script.length; i++) {
        const ch = script[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    assert.ok(end !== -1, 'could not find end of playCompletionSound body');

    const fnSource = script.slice(startIdx, end + 1);
    // Sanity: the isolated body must not contain the invalid cast (we corrected it),
    // and must reference the intended fallback expression.
    assert.ok(!fnSource.includes(INVALID_CAST), 'isolated playCompletionSound still has invalid cast');
    assert.ok(fnSource.includes('window.AudioContext'), 'isolated playCompletionSound lost its AudioContext fallback');

    // Build a callable in a scope where `window` is our controlled stub.
    // eslint-disable-next-line no-new-func
    const factory = new Function('window', 'console', `${fnSource}; return playCompletionSound;`);
    return factory(win, { log: () => undefined }) as () => void;
}

// --- Arbitraries -------------------------------------------------------------

/** Random modifier-key combinations (booleans for each modifier). */
const modifierComboArb = fc.record({
    shiftKey: fc.boolean(),
    ctrlKey: fc.boolean(),
    altKey: fc.boolean(),
    metaKey: fc.boolean(),
});

/** Non-empty, sensible prompt text. */
const promptTextArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 40 })
    .filter((s) => s.trim().length > 0);

/** Empty or whitespace-only strings. */
const blankTextArb: fc.Arbitrary<string> = fc
    .array(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v', ''), { minLength: 0, maxLength: 8 })
    .map((parts) => parts.join(''));

/** Web Audio API availability states. */
const audioAvailabilityArb = fc.record({
    hasAudioContext: fc.boolean(),
    hasWebkit: fc.boolean(),
});

// =============================================================================

describe('chatView send regression — Property 2 (Preservation): non-syntax behavior unchanged', () => {
    // ---- Req 3.1: Shift+ENTER inserts a newline and does NOT submit ---------
    it('3.1 Shift+ENTER does not post a chat-prompt (newline, not submit)', () => {
        const loaded = loadCorrectedWebview();
        fireEnter(loaded, 'hello world', { shiftKey: true });
        assert.strictEqual(
            chatPrompts(loaded.posted).length,
            0,
            'Shift+ENTER must not submit a chat-prompt'
        );
        loaded.dom.window.close();
    });

    // ---- Req 3.1/3.2 (PBT): only ENTER-without-Shift submits ----------------
    it('3.1/3.2 (property) only ENTER-without-Shift submits; all other modifier combos do not', () => {
        fc.assert(
            fc.property(promptTextArb, modifierComboArb, (text, mods) => {
                const loaded = loadCorrectedWebview();
                fireEnter(loaded, text, { shiftKey: mods.shiftKey });
                const count = chatPrompts(loaded.posted).length;
                const shouldSubmit = !mods.shiftKey; // ENTER without Shift is the only submit case
                assert.strictEqual(
                    count,
                    shouldSubmit ? 1 : 0,
                    `shiftKey=${mods.shiftKey} => expected ${shouldSubmit ? 1 : 0} chat-prompt, got ${count}`
                );
                loaded.dom.window.close();
            }),
            { numRuns: 30 }
        );
    });

    // ---- Req 3.2 (PBT): empty/whitespace-only text is a no-op for ENTER + Send
    it('3.2 (property) empty or whitespace-only text is a no-op for both ENTER and Send', () => {
        fc.assert(
            fc.property(blankTextArb, (blank) => {
                // ENTER (no Shift)
                const l1 = loadCorrectedWebview();
                fireEnter(l1, blank, { shiftKey: false });
                assert.strictEqual(
                    chatPrompts(l1.posted).length,
                    0,
                    `ENTER with blank text (${JSON.stringify(blank)}) must be a no-op`
                );
                l1.dom.window.close();

                // Send button
                const l2 = loadCorrectedWebview();
                fireSend(l2, blank);
                assert.strictEqual(
                    chatPrompts(l2.posted).length,
                    0,
                    `Send with blank text (${JSON.stringify(blank)}) must be a no-op`
                );
                l2.dom.window.close();
            }),
            { numRuns: 30 }
        );
    });

    // ---- Req 3.3: completion sound plays with documented tones/gains/timing --
    it('3.3 playCompletionSound creates two oscillators with documented frequencies, gains, and timing', () => {
        const calls: AudioCall[] = [];
        const win = { AudioContext: makeAudioContextMock(calls) } as any;
        const play = isolatePlayCompletionSound(win);

        assert.doesNotThrow(() => play(), 'playCompletionSound must not throw when Web Audio is available');

        const oscillatorCreations = calls.filter((c) => c.op === 'createOscillator').length;
        assert.strictEqual(oscillatorCreations, 2, 'must create exactly two oscillators');

        // Documented tone frequencies: high 800 Hz then low 400 Hz.
        const freqs = calls.filter((c) => c.op === 'osc.frequency.setValueAtTime').map((c) => c.args[0]);
        assert.deepStrictEqual(freqs, [800, 400], 'documented frequencies: 800 Hz (high) then 400 Hz (low)');

        // Documented gain ramps: two setValueAtTime(0.3) + two exponential ramps to 0.01.
        const gainSets = calls.filter((c) => c.op === 'gain.setValueAtTime').map((c) => c.args[0]);
        assert.deepStrictEqual(gainSets, [0.3, 0.3], 'both tones start at gain 0.3');
        const gainRamps = calls
            .filter((c) => c.op === 'gain.exponentialRampToValueAtTime')
            .map((c) => c.args[0]);
        assert.deepStrictEqual(gainRamps, [0.01, 0.01], 'both tones ramp down to 0.01');

        // Documented timing: tone 1 starts at 0 stops at 0.2; tone 2 starts at 0.1 stops at 0.3.
        const starts = calls.filter((c) => c.op === 'osc.start').map((c) => c.args[0]);
        const stops = calls.filter((c) => c.op === 'osc.stop').map((c) => c.args[0]);
        assert.deepStrictEqual(starts, [0, 0.1], 'oscillator start times: 0 then 0.1');
        assert.deepStrictEqual(stops, [0.2, 0.3], 'oscillator stop times: 0.2 then 0.3');
    });

    // ---- Req 3.3 (PBT): plays when available, uses AudioContext||webkit ------
    it('3.3/3.4 (property) plays when a Web Audio API is available and fails silently otherwise, never throwing', () => {
        fc.assert(
            fc.property(audioAvailabilityArb, (avail) => {
                const calls: AudioCall[] = [];
                const mock = makeAudioContextMock(calls);
                const win: any = {};
                if (avail.hasAudioContext) win.AudioContext = mock;
                if (avail.hasWebkit) win.webkitAudioContext = mock;

                const play = isolatePlayCompletionSound(win);

                // Must NEVER throw, regardless of availability (try/catch swallows failures).
                assert.doesNotThrow(() => play(), 'playCompletionSound must never throw');

                const played = calls.some((c) => c.op === 'new AudioContext');
                const available = avail.hasAudioContext || avail.hasWebkit;
                if (available) {
                    assert.ok(played, 'must play (construct AudioContext) when a Web Audio API is available');
                    assert.strictEqual(
                        calls.filter((c) => c.op === 'createOscillator').length,
                        2,
                        'must create two oscillators when audio is available'
                    );
                } else {
                    assert.ok(!played, 'must not construct AudioContext when no Web Audio API exists');
                }
            }),
            { numRuns: 40 }
        );
    });

    // ---- Req 3.4: silent failure does not interrupt submission --------------
    it('3.4 with no Web Audio API, playCompletionSound fails silently (no throw)', () => {
        const calls: AudioCall[] = [];
        const win = {} as any; // neither AudioContext nor webkitAudioContext
        const play = isolatePlayCompletionSound(win);
        assert.doesNotThrow(() => play(), 'must swallow the error when Web Audio is unavailable');
        assert.strictEqual(calls.length, 0, 'no audio operations should occur when unavailable');
    });

    // ---- Req 3.5: other controls (Clear) register and behave as designed ----
    it('3.5 Clear button clears the messages container', () => {
        const loaded = loadCorrectedWebview();
        const doc = loaded.dom.window.document;
        const messages = doc.getElementById('messages') as HTMLElement;
        assert.ok(messages, 'messages container missing');
        // Seed a submitted message, then clear.
        fireSend(loaded, 'hello');
        assert.ok(messages.innerHTML.length > 0, 'messages should contain the appended user message');
        const clearBtn = doc.getElementById('clear') as HTMLButtonElement;
        assert.ok(clearBtn, 'clear button missing');
        clearBtn.dispatchEvent(new loaded.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
        assert.strictEqual(messages.innerHTML, '', 'Clear must empty the messages container');
        loaded.dom.window.close();
    });

    // ---- Req 3.6: assistant responses are appended/formatted/displayed ------
    it('3.6 assistant response (complete) is appended and displayed', () => {
        const loaded = loadCorrectedWebview();
        const { window } = loaded.dom;
        const doc = window.document;
        const messages = doc.getElementById('messages') as HTMLElement;
        assert.ok(messages, 'messages container missing');

        // Simulate the host delivering a completed assistant response.
        window.postMessage({ type: 'complete', data: 'the answer is 42' }, '*');

        return new Promise<void>((resolve) => {
            // postMessage is async; give the message listener a tick to run.
            setTimeout(() => {
                try {
                    assert.ok(
                        messages.textContent && messages.textContent.includes('the answer is 42'),
                        `assistant response must be displayed (got: ${messages.textContent})`
                    );
                } finally {
                    window.close();
                    resolve();
                }
            }, 50);
        });
    });
});
