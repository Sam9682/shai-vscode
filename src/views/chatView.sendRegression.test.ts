import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import fc from 'fast-check';
import { JSDOM } from 'jsdom';

/**
 * Spec: chat-send-regression-fix — Bugfix workflow.
 *
 * Property 1: Bug Condition — Webview Script Parses and Submission Works.
 *
 * This is the BUG CONDITION EXPLORATION test. It is EXPECTED TO FAIL on the
 * unfixed code — the failure confirms the bug exists. When the fix lands (the
 * invalid TypeScript cast `(window as any).webkitAudioContext` is replaced with
 * valid JavaScript), this same test should PASS, confirming the expected
 * behavior.
 *
 * Scope: this is a deterministic parse-time defect, so the property is scoped
 * to the concrete failing artifact — the single inline `<script>` IIFE string
 * produced by `getHtmlContent` in `src/views/chatView.ts`. The script region of
 * that template literal contains no `${}` interpolation, so it is a static
 * string that we extract verbatim from the production source.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4
 */

// --- Extract the production webview HTML + inline script from source ---------

// Resolve from the repo root (mocha runs from the project root) to avoid
// relying on `__dirname`, which is undefined when this file is classified as
// an ES module by ts-node.
const CHAT_VIEW_SRC = path.resolve(process.cwd(), 'src', 'views', 'chatView.ts');

/**
 * The webview HTML lives inside a backtick template literal in `getHtmlContent`.
 * The raw source text therefore contains template-literal escape sequences
 * (e.g. `\\s`, `\\/`, escaped backticks) that are only resolved when TypeScript
 * evaluates the literal at runtime. To faithfully exercise the RUNTIME script in
 * jsdom we must resolve those escapes exactly as the JS engine would; otherwise
 * even the fixed script fails to parse (e.g. `/^https?:\\/\\//i` is not a valid
 * runtime regex — its runtime form is `/^https?:\/\//i`).
 *
 * The HTML/script region contains no `${...}` interpolation (verified: every
 * `${` in chatView.ts is in host-side code outside this region), so
 * re-evaluating the slice as a template literal is a faithful, side-effect-free
 * reconstruction of the runtime string.
 */
function resolveTemplateLiteral(raw: string): string {
    // eslint-disable-next-line no-new-func
    const fn = new Function('return `' + raw + '`;');
    return fn() as string;
}

/**
 * Read the full RUNTIME HTML string produced by `getHtmlContent()` in
 * chatView.ts. The template literal is a single static string (verified: no
 * `${}` inside the HTML/script region), delimited by `<!DOCTYPE html>` ...
 * `</html>`; escapes are resolved so the result matches what the webview
 * actually receives.
 */
function extractWebviewHtml(): string {
    const source = fs.readFileSync(CHAT_VIEW_SRC, 'utf8');
    const start = source.indexOf('<!DOCTYPE html>');
    const end = source.indexOf('</html>');
    assert.ok(start !== -1 && end !== -1 && end > start, 'could not locate webview HTML template in chatView.ts');
    const rawTemplate = source.slice(start, end + '</html>'.length);
    return resolveTemplateLiteral(rawTemplate);
}

/** Extract the inline `<script>` IIFE body from the webview HTML. */
function extractInlineScript(): string {
    const html = extractWebviewHtml();
    const open = html.indexOf('<script>');
    const close = html.indexOf('</script>', open);
    assert.ok(open !== -1 && close !== -1, 'could not locate inline <script> in webview HTML');
    return html.slice(open + '<script>'.length, close);
}

// --- Test-case B/C helpers: load the real script into a jsdom webview --------

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
 * Load the full production webview HTML into jsdom and execute its inline
 * script (runScripts: 'dangerously'). `acquireVsCodeApi` is stubbed to capture
 * every `postMessage` payload so we can assert on `chat-prompt` dispatches.
 *
 * On the UNFIXED code the inline IIFE fails to parse, so no listeners register;
 * `parseError` may be captured and `posted` will not contain a `chat-prompt`.
 */
function loadWebview(): LoadedWebview {
    const posted: PostedMessage[] = [];
    let parseError: Error | null = null;

    const html = extractWebviewHtml();

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
            // Capture any SyntaxError thrown while parsing/executing the inline script.
            window.addEventListener('error', (e: any) => {
                parseError = (e && (e.error || e.message)) as Error;
            });
        },
    });

    return { dom, posted, parseError };
}

function typeAndEnter(loaded: LoadedWebview, text: string, opts: { shiftKey?: boolean } = {}): void {
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

function typeAndClickSend(loaded: LoadedWebview, text: string): void {
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

// --- Arbitraries -------------------------------------------------------------

/** Non-empty prompt text (after trimming). */
const promptTextArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 60 })
    .filter((s) => s.trim().length > 0);

// The unfixed script never runs, so activeTabId is null and the checkboxes are
// checked by default in the HTML. On the fixed script the dispatched payload
// should reflect the live control state; we generate the checkbox states we set.
const contextOptsArb = fc.record({
    noExtraContext: fc.boolean(),
    autopilot: fc.boolean(),
});

// =============================================================================

describe('chatView send regression — Property 1 (Bug Condition): script parses and submission works', () => {
    // ---- Test case A: the inline script parses as valid JavaScript ----------
    it('A. the inline webview script parses as valid JavaScript', () => {
        const script = extractInlineScript();
        assert.doesNotThrow(() => {
            // Throws a SyntaxError on the unfixed code near `(window as any).webkitAudioContext`.
            // eslint-disable-next-line no-new-func
            new Function(script);
        }, 'inline webview script must parse as valid JavaScript');
    });

    // ---- Test case D: no TypeScript-only syntax remains in the script -------
    it('D. the inline script contains no TypeScript-only syntax', () => {
        const script = extractInlineScript();
        const tsOnlyPatterns: Array<{ name: string; re: RegExp }> = [
            { name: 'as any', re: /\bas\s+any\b/ },
            { name: 'as-cast', re: /\)\s+as\s+[A-Za-z_$]/ },
            { name: 'angle-bracket cast', re: /<[A-Za-z_$][\w$]*>\s*[\w(]/ },
            { name: 'interface declaration', re: /\binterface\s+[A-Za-z_$]/ },
        ];
        const offenders = tsOnlyPatterns.filter((p) => p.re.test(script)).map((p) => p.name);
        assert.deepStrictEqual(
            offenders,
            [],
            `inline script must not contain TypeScript-only syntax, found: ${offenders.join(', ')}`
        );
    });

    // ---- Test case B: ENTER (no Shift) dispatches a chat-prompt -------------
    it('B. ENTER (without Shift) with non-empty text dispatches a chat-prompt', () => {
        fc.assert(
            fc.property(promptTextArb, contextOptsArb, (text, ctx) => {
                const loaded = loadWebview();
                const doc = loaded.dom.window.document;
                (doc.getElementById('no-extra-context') as HTMLInputElement).checked = ctx.noExtraContext;
                (doc.getElementById('autopilot') as HTMLInputElement).checked = ctx.autopilot;

                typeAndEnter(loaded, text, { shiftKey: false });

                const prompts = chatPrompts(loaded.posted);
                assert.strictEqual(
                    prompts.length,
                    1,
                    `ENTER must post exactly one chat-prompt (got ${prompts.length}; parseError=${loaded.parseError})`
                );
                assert.strictEqual(prompts[0].message, text.trim());
                assert.strictEqual(prompts[0].noExtraContext, ctx.noExtraContext);
                assert.strictEqual(prompts[0].autopilot, ctx.autopilot);
                loaded.dom.window.close();
            }),
            { numRuns: 25 }
        );
    });

    // ---- Test case C: Send click dispatches a chat-prompt -------------------
    it('C. Send click with non-empty text dispatches a chat-prompt', () => {
        fc.assert(
            fc.property(promptTextArb, contextOptsArb, (text, ctx) => {
                const loaded = loadWebview();
                const doc = loaded.dom.window.document;
                (doc.getElementById('no-extra-context') as HTMLInputElement).checked = ctx.noExtraContext;
                (doc.getElementById('autopilot') as HTMLInputElement).checked = ctx.autopilot;

                typeAndClickSend(loaded, text);

                const prompts = chatPrompts(loaded.posted);
                assert.strictEqual(
                    prompts.length,
                    1,
                    `Send must post exactly one chat-prompt (got ${prompts.length}; parseError=${loaded.parseError})`
                );
                assert.strictEqual(prompts[0].message, text.trim());
                assert.strictEqual(prompts[0].noExtraContext, ctx.noExtraContext);
                assert.strictEqual(prompts[0].autopilot, ctx.autopilot);
                loaded.dom.window.close();
            }),
            { numRuns: 25 }
        );
    });
});
