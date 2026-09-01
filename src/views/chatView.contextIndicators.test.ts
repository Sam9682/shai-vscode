import * as assert from 'assert';
import fc from 'fast-check';
import { JSDOM } from 'jsdom';

/**
 * Feature: user-friendliness-improvements, Property 6: Chat indicators reflect the active context
 *
 * For any sequence of `activeContext` messages, after the last message the
 * Context_Badge (#active-context) text contains the last context's label and
 * the Context_Selector (#context-selector) selected value equals the last
 * context's id.
 *
 * Validates: Requirements 3.1, 3.2, 3.3
 *
 * ---------------------------------------------------------------------------
 * NOTE ON APPROACH (mirror, not import):
 *
 * The real `activeContext` handling lives in the inline webview script (a
 * template string) inside `getHtml`/the webview markup in
 * `src/views/chatView.ts`. That handler is not exported and cannot be
 * imported, so — per the design's Testing Strategy ("run a faithful mirror of
 * the render/handler logic against a jsdom document") — the handler below is a
 * faithful MIRROR of the production `activeContext` branch in
 * src/views/chatView.ts (search for `msg.type === 'activeContext'`).
 *
 * It mirrors the production logic exactly:
 *   - contextBadge.textContent = '📌 ' + (msg.label || msg.id)
 *   - contextBadge.title = 'Active context: ' + msg.id
 *   - for the selector: ensure an <option> for msg.id exists (create one if
 *     absent), then set contextSelector.value = msg.id
 *
 * If the production `activeContext` handler changes, this mirror should be
 * updated to match so drift stays detectable.
 * ---------------------------------------------------------------------------
 */

interface ActiveContextMessage {
    id: string;
    label?: string;
}

/**
 * Faithful mirror of the `activeContext` message branch from the chat webview
 * script in src/views/chatView.ts. Applies a single `activeContext` message to
 * the given badge and selector elements.
 */
function handleActiveContextMirror(
    document: Document,
    contextBadge: HTMLElement | null,
    contextSelector: HTMLSelectElement | null,
    msg: ActiveContextMessage
): void {
    if (contextBadge) {
        contextBadge.textContent = '📌 ' + (msg.label || msg.id);
        contextBadge.title = 'Active context: ' + msg.id;
    }
    if (contextSelector) {
        // Ensure an option for the active id exists before selecting it;
        // otherwise setting .value silently fails and the selector desyncs
        // from the badge (e.g. when activeContext arrives before contextList).
        const hasOption = Array.prototype.some.call(
            contextSelector.options,
            (opt: HTMLOptionElement) => opt.value === msg.id
        );
        if (!hasOption) {
            const opt = document.createElement('option');
            opt.value = msg.id;
            opt.textContent = msg.label || msg.id;
            contextSelector.appendChild(opt);
        }
        contextSelector.value = msg.id;
    }
}

/**
 * Generator for a single `activeContext` message. The `label` is optional to
 * exercise the `msg.label || msg.id` fallback in the production handler.
 */
function activeContextMessage(): fc.Arbitrary<ActiveContextMessage> {
    // Non-empty ids/labels so the badge/selector assertions are meaningful.
    const id = fc.string({ minLength: 1, maxLength: 30 });
    return fc.record(
        {
            id,
            label: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
        },
        { requiredKeys: ['id'] }
    );
}

describe('chatView activeContext — Property 6: Chat indicators reflect the active context', () => {
    it('after the last activeContext message, the badge shows the label and the selector value equals the id', () => {
        fc.assert(
            fc.property(
                fc.array(activeContextMessage(), { minLength: 1, maxLength: 20 }),
                (messages) => {
                    // Fresh DOM: badge + selector seeded with a default option,
                    // matching the production markup (see chatView.ts:
                    // <span id="active-context"> and <select id="context-selector">
                    // with an initial <option value="default">).
                    const dom = new JSDOM(
                        '<!DOCTYPE html><html><body>' +
                            '<span id="active-context" class="context-badge"></span>' +
                            '<select id="context-selector">' +
                            '<option value="default">Default</option>' +
                            '</select>' +
                            '</body></html>'
                    );
                    const document = dom.window.document;
                    const contextBadge = document.getElementById('active-context');
                    const contextSelector = document.getElementById(
                        'context-selector'
                    ) as HTMLSelectElement | null;

                    for (const msg of messages) {
                        handleActiveContextMirror(document, contextBadge, contextSelector, msg);
                    }

                    const last = messages[messages.length - 1];
                    const expectedLabel = last.label || last.id;

                    // Req 3.1 / 3.2: the badge text contains the active context's label.
                    assert.ok(
                        contextBadge!.textContent!.includes(expectedLabel),
                        `badge text "${contextBadge!.textContent}" should contain "${expectedLabel}"`
                    );

                    // Req 3.3: the selector's selected value equals the active context's id.
                    assert.strictEqual(
                        contextSelector!.value,
                        last.id,
                        `selector value "${contextSelector!.value}" should equal last id "${last.id}"`
                    );
                }
            ),
            { numRuns: 100 }
        );
    });
});
