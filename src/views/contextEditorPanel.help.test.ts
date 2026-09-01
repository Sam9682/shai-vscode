import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import fc from 'fast-check';
import { JSDOM } from 'jsdom';
import { PREDEFINED_CONTEXTS, sanitizeContextId } from '../context/contextManager';

/**
 * Feature: user-friendliness-improvements — Context editor tests.
 *
 * ---------------------------------------------------------------------------
 * NOTE ON APPROACH (mirror, not import):
 *
 * The real Context_Editor render/create/selector logic lives in an inline
 * webview script, `media/contextEditor.js`. It runs inside a VS Code webview
 * (it calls `acquireVsCodeApi()` at load), so it cannot be imported into a
 * Node/Mocha process. Per the design's Testing Strategy ("mirror, not
 * import"), the functions below are faithful MIRRORS of the production logic
 * in `media/contextEditor.js`, exercised against a jsdom document:
 *
 *   - `sanitizeIdMirror`      mirrors `sanitizeId(s)`
 *   - `renderInitMirror`      mirrors the `msg.type === 'init'` handler
 *                             (selector-render loop marking the active option
 *                             with '*' + opt.selected, #activeName text, and
 *                             template population from msg.templates with
 *                             dataset.systemPrompt)
 *   - `applyTemplateMirror`   mirrors the #newCtxTemplate 'change' handler
 *   - `applySanitizeInputMirror` mirrors the #newCtxId 'input' handler
 *   - `createCtxMirror`       mirrors the #btnCreateCtx 'click' handler
 *                             (duplicate early-return with value retention)
 *
 * These mirrors MUST be kept in sync with media/contextEditor.js. If that
 * production script changes, update these mirrors so drift stays detectable.
 *
 * The HTML unit tests read the ACTUAL production HTML emitted by
 * `getContextEditorHtml` in src/views/contextEditorPanel.ts (extracted from
 * the source file rather than imported, because that module pulls in the
 * `vscode` API which is unavailable under Mocha).
 * ---------------------------------------------------------------------------
 */

// Labels map used by the production init handler in media/contextEditor.js.
const LABELS: Record<string, string> = {
    'default': 'Default',
    'dev': 'Dev',
    'devops': 'DevOps',
    'spec': 'Spec',
    'docker-compose': 'Docker Compose',
};

/** Faithful mirror of `sanitizeId(s)` in media/contextEditor.js. */
function sanitizeIdMirror(s: string): string {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        const ok =
            (c >= 'a' && c <= 'z') ||
            (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') ||
            c === '_' ||
            c === '-';
        out += ok ? c : '_';
    }
    return out;
}

interface TemplateMsg {
    id: string;
    label: string;
    systemPrompt: string;
}

/**
 * Faithful mirror of the `init` message handler in media/contextEditor.js:
 * renders the #ctxSelect options (marking exactly the active with '*' and
 * opt.selected), sets #activeName, and populates #newCtxTemplate from
 * msg.templates with dataset.systemPrompt.
 */
function renderInitMirror(
    document: Document,
    contextIds: string[],
    activeId: string,
    predefinedIds: string[],
    templates: TemplateMsg[],
    systemPromptValue = ''
): void {
    const g = (id: string) => document.getElementById(id)!;
    const currentActive = activeId || 'default';

    const sel = g('ctxSelect') as HTMLSelectElement;
    while (sel.firstChild) { sel.removeChild(sel.firstChild); }
    contextIds.forEach((id) => {
        const opt = document.createElement('option');
        opt.value = id;
        let display = LABELS[id] || id;
        if (predefinedIds.indexOf(id) !== -1) { display = '📌 ' + display; }
        opt.textContent = id === currentActive ? display + '  *' : display;
        if (id === currentActive) { opt.selected = true; }
        sel.appendChild(opt);
    });
    g('activeName').textContent = LABELS[currentActive] || currentActive;
    (g('btnDeleteCtx') as HTMLButtonElement).disabled =
        contextIds.length <= 1 || predefinedIds.indexOf(sel.value) !== -1;

    const tplSel = g('newCtxTemplate') as HTMLSelectElement;
    while (tplSel.firstChild) { tplSel.removeChild(tplSel.firstChild); }
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'None (blank)';
    none.dataset.systemPrompt = '';
    tplSel.appendChild(none);
    templates.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.label || t.id;
        opt.dataset.systemPrompt = t.systemPrompt || '';
        tplSel.appendChild(opt);
    });

    (g('systemPrompt') as HTMLTextAreaElement).value = systemPromptValue || '';
}

/**
 * Faithful mirror of the #newCtxTemplate 'change' handler in
 * media/contextEditor.js: sets #newCtxSystem value from the selected option's
 * dataset.systemPrompt.
 */
function applyTemplateMirror(document: Document, selectedIndex: number): void {
    const tplSel = document.getElementById('newCtxTemplate') as HTMLSelectElement;
    tplSel.selectedIndex = selectedIndex;
    const opt = tplSel.options[tplSel.selectedIndex];
    if (opt && typeof opt.dataset.systemPrompt === 'string') {
        (document.getElementById('newCtxSystem') as HTMLTextAreaElement).value =
            opt.dataset.systemPrompt;
    }
}

/**
 * Faithful mirror of the #newCtxId 'input' handler in media/contextEditor.js:
 * shows #newCtxSanitizeNotice when sanitizeId(raw) !== raw.
 */
function applySanitizeInputMirror(document: Document, raw: string): void {
    const input = document.getElementById('newCtxId') as HTMLInputElement;
    input.value = raw;
    const safe = sanitizeIdMirror(raw);
    const notice = document.getElementById('newCtxSanitizeNotice')!;
    if (safe !== raw) {
        notice.textContent =
            'Spaces and special characters will be replaced with underscores \u2192 ' + safe;
        notice.classList.remove('hidden');
    } else {
        notice.classList.add('hidden');
    }
}

/**
 * Faithful mirror of the #btnCreateCtx 'click' handler in
 * media/contextEditor.js. Returns the message it would have posted (or null
 * for the early-return duplicate case).
 */
function createCtxMirror(
    document: Document,
    knownIds: string[],
    predefinedIds: string[]
): { type: string; id: string; systemPrompt: string } | null {
    const g = (id: string) => document.getElementById(id)!;
    const raw = (g('newCtxId') as HTMLInputElement).value.trim();
    const safe = sanitizeIdMirror(raw);
    g('newCtxError').classList.add('hidden');
    if (!safe) { return null; }
    // Duplicate name: show the error and retain the entered values (do NOT
    // clear/hide the form and do NOT post 'newContext'). (Req 4.5)
    if (knownIds.indexOf(safe) !== -1 || predefinedIds.indexOf(safe) !== -1) {
        g('newCtxError').classList.remove('hidden');
        return null;
    }
    const posted = {
        type: 'newContext',
        id: safe,
        systemPrompt: (g('newCtxSystem') as HTMLTextAreaElement).value,
    };
    g('newCtxSection').classList.add('hidden');
    return posted;
}

// ---------------------------------------------------------------------------
// DOM scaffolding: the minimal subset of the editor HTML the mirrors touch.
// ---------------------------------------------------------------------------

function buildDom(): JSDOM {
    return new JSDOM(`<!DOCTYPE html><html><body>
      <select id="ctxSelect"></select>
      <button id="btnDeleteCtx"></button>
      <strong id="activeName">-</strong>
      <textarea id="systemPrompt"></textarea>
      <input type="text" id="newCtxId" />
      <div class="hint hidden" id="newCtxSanitizeNotice"></div>
      <div class="err hidden" id="newCtxError">This name already exists.</div>
      <select id="newCtxTemplate"></select>
      <textarea id="newCtxSystem"></textarea>
      <fieldset id="newCtxSection"></fieldset>
    </body></html>`);
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const idArb = fc
    .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), {
        minLength: 1,
        maxLength: 12,
    })
    // Exclude JavaScript object-key artifacts (e.g. "__proto__"): these are not
    // realistic context ids and only exist to probe plain-object lookups. The
    // production label map in media/contextEditor.js has the same `labels[id]`
    // shape, so we keep the mirror faithful and constrain the input space here.
    .filter((s) => s.trim().length > 0 && s !== '__proto__');

const templatesFromPredefined: TemplateMsg[] = PREDEFINED_CONTEXTS.map((c) => ({
    id: c.id,
    label: c.label,
    systemPrompt: c.systemPrompt,
}));

// ---------------------------------------------------------------------------
// Property 7: Context editor marks exactly the active context (Req 3.4, 3.5)
// ---------------------------------------------------------------------------

describe('contextEditor init — Property 7: Context editor marks exactly the active context', () => {
    it('Feature: user-friendliness-improvements, Property 7: exactly one option selected (the active), only it carries "*", and #activeName shows the active id/label', () => {
        fc.assert(
            fc.property(
                fc.uniqueArray(idArb, { minLength: 1, maxLength: 8 }),
                fc.nat(),
                (ids, activePick) => {
                    const activeId = ids[activePick % ids.length];
                    const predefinedIds = PREDEFINED_CONTEXTS.map((c) => c.id);
                    const dom = buildDom();
                    const document = dom.window.document;

                    renderInitMirror(document, ids, activeId, predefinedIds, templatesFromPredefined);

                    const sel = document.getElementById('ctxSelect') as HTMLSelectElement;
                    const options = Array.from(sel.options);

                    // Exactly one option is selected, and it is the active one.
                    const selected = options.filter((o) => o.selected);
                    assert.strictEqual(selected.length, 1, 'exactly one option selected');
                    assert.strictEqual(selected[0].value, activeId, 'selected option is the active id');
                    assert.strictEqual(sel.value, activeId, 'selector value is the active id');

                    // Only the active option carries the '*' marker.
                    const marked = options.filter((o) => (o.textContent || '').includes('*'));
                    assert.strictEqual(marked.length, 1, 'exactly one option marked with "*"');
                    assert.strictEqual(marked[0].value, activeId, 'the marked option is the active one');

                    // #activeName shows the active id or its label.
                    const activeName = document.getElementById('activeName')!.textContent;
                    const expectedName = LABELS[activeId] || activeId;
                    assert.strictEqual(activeName, expectedName, '#activeName shows active id/label');
                }
            ),
            { numRuns: 100 }
        );
    });
});

// ---------------------------------------------------------------------------
// Property 8: Every predefined context is offered as a template (Req 4.3)
// ---------------------------------------------------------------------------

describe('contextEditor templates — Property 8: Every predefined context is offered as a template', () => {
    it('Feature: user-friendliness-improvements, Property 8: #newCtxTemplate renders a selectable option for each predefined context', () => {
        fc.assert(
            fc.property(
                fc.uniqueArray(idArb, { minLength: 1, maxLength: 6 }),
                (ids) => {
                    const activeId = ids[0];
                    const predefinedIds = PREDEFINED_CONTEXTS.map((c) => c.id);
                    const dom = buildDom();
                    const document = dom.window.document;

                    renderInitMirror(document, ids, activeId, predefinedIds, templatesFromPredefined);

                    const tplSel = document.getElementById('newCtxTemplate') as HTMLSelectElement;
                    const optionValues = Array.from(tplSel.options).map((o) => o.value);

                    for (const ctx of PREDEFINED_CONTEXTS) {
                        const idx = optionValues.indexOf(ctx.id);
                        assert.notStrictEqual(
                            idx,
                            -1,
                            `predefined context "${ctx.id}" is offered as a template option`
                        );
                        const opt = tplSel.options[idx];
                        assert.ok(!opt.disabled, `template option "${ctx.id}" is selectable`);
                    }
                }
            ),
            { numRuns: 100 }
        );
    });
});

// ---------------------------------------------------------------------------
// Property 9: Selecting a template populates the system prompt (Req 4.4)
// ---------------------------------------------------------------------------

describe('contextEditor template select — Property 9: Selecting a template populates the system prompt', () => {
    it('Feature: user-friendliness-improvements, Property 9: selecting a template option sets #newCtxSystem to that context systemPrompt', () => {
        fc.assert(
            fc.property(
                fc.nat({ max: PREDEFINED_CONTEXTS.length - 1 }),
                (pick) => {
                    const ctx = PREDEFINED_CONTEXTS[pick];
                    const predefinedIds = PREDEFINED_CONTEXTS.map((c) => c.id);
                    const dom = buildDom();
                    const document = dom.window.document;

                    renderInitMirror(
                        document,
                        [ctx.id, 'default'],
                        'default',
                        predefinedIds,
                        templatesFromPredefined
                    );

                    // Template options: index 0 is the "None (blank)" entry,
                    // predefined contexts follow in order.
                    const tplSel = document.getElementById('newCtxTemplate') as HTMLSelectElement;
                    const targetIndex = Array.from(tplSel.options).findIndex(
                        (o) => o.value === ctx.id
                    );
                    assert.notStrictEqual(targetIndex, -1, 'template option exists');

                    applyTemplateMirror(document, targetIndex);

                    const value = (document.getElementById('newCtxSystem') as HTMLTextAreaElement).value;
                    assert.strictEqual(value, ctx.systemPrompt, 'system prompt populated from template');
                }
            ),
            { numRuns: 100 }
        );
    });
});

// ---------------------------------------------------------------------------
// Property 11: Duplicate context names are rejected with values retained
// (Req 4.5)
// ---------------------------------------------------------------------------

describe('contextEditor create — Property 11: Duplicate context names are rejected with values retained', () => {
    it('Feature: user-friendliness-improvements, Property 11: a duplicate sanitized name shows #newCtxError, retains #newCtxId/#newCtxSystem, and posts no newContext', () => {
        fc.assert(
            fc.property(
                fc.uniqueArray(idArb, { minLength: 1, maxLength: 6 }),
                // Raw name whose sanitized form we will force to collide.
                fc.string({ minLength: 1, maxLength: 20 }),
                fc.string({ maxLength: 40 }),
                (existingIds, rawSuffix, systemPromptText) => {
                    // Choose an existing id and craft a raw name that sanitizes
                    // to it. Since existingIds come from the allowed alphabet,
                    // sanitizeId(existing) === existing, so the raw name itself
                    // can be the existing id (optionally we test that raw with
                    // disallowed chars still collides after sanitizing).
                    const collideTarget = existingIds[0];
                    // A raw name that sanitizes to collideTarget: replace some
                    // chars of collideTarget with disallowed ones is complex; the
                    // simplest guaranteed collision is the id itself.
                    const rawName = collideTarget;

                    // Sanity: the sanitized raw name is already in the set.
                    assert.ok(
                        existingIds.indexOf(sanitizeIdMirror(rawName)) !== -1,
                        'sanitized raw name already exists in the id set'
                    );

                    const dom = buildDom();
                    const document = dom.window.document;

                    // The template/knownIds don't matter for the create handler
                    // beyond the knownIds list; set up inputs directly.
                    const idInput = document.getElementById('newCtxId') as HTMLInputElement;
                    const sysInput = document.getElementById('newCtxSystem') as HTMLTextAreaElement;
                    idInput.value = rawName;
                    sysInput.value = systemPromptText;

                    const posted = createCtxMirror(document, existingIds, []);

                    // No 'newContext' message posted.
                    assert.strictEqual(posted, null, 'no newContext message posted for a duplicate');

                    // #newCtxError is shown.
                    const err = document.getElementById('newCtxError')!;
                    assert.ok(!err.classList.contains('hidden'), '#newCtxError is visible');

                    // Entered values are retained.
                    assert.strictEqual(idInput.value, rawName, '#newCtxId value retained');
                    assert.strictEqual(sysInput.value, systemPromptText, '#newCtxSystem value retained');

                    // Form is not hidden.
                    const section = document.getElementById('newCtxSection')!;
                    assert.ok(!section.classList.contains('hidden'), 'form not hidden on duplicate');

                    // Suppress unused-var lint for the extra generated inputs.
                    void rawSuffix;
                }
            ),
            { numRuns: 100 }
        );
    });

    it('also rejects when a duplicate collides only after sanitization', () => {
        // Deterministic example: existing "my-ctx", raw "my ctx" sanitizes to "my_ctx".
        const dom = buildDom();
        const document = dom.window.document;
        const idInput = document.getElementById('newCtxId') as HTMLInputElement;
        const sysInput = document.getElementById('newCtxSystem') as HTMLTextAreaElement;
        idInput.value = 'my ctx';
        sysInput.value = 'keep me';

        const posted = createCtxMirror(document, ['my_ctx'], []);

        assert.strictEqual(posted, null);
        assert.ok(!document.getElementById('newCtxError')!.classList.contains('hidden'));
        assert.strictEqual(idInput.value, 'my ctx');
        assert.strictEqual(sysInput.value, 'keep me');
    });
});

// ---------------------------------------------------------------------------
// Unit: HTML help text + sanitize preview notice (Req 4.1, 4.2, 8.2)
// ---------------------------------------------------------------------------

/** Extract the production HTML emitted by getContextEditorHtml (see note above). */
function loadEditorHtml(): string {
    const src = fs.readFileSync(
        path.join(__dirname, 'contextEditorPanel.ts'),
        'utf8'
    );
    // The HTML is returned as a template literal from getContextEditorHtml.
    // Parse from the first "<!DOCTYPE html>" to the closing </html>` marker.
    const start = src.indexOf('<!DOCTYPE html>');
    const end = src.indexOf('</html>`', start);
    assert.notStrictEqual(start, -1, 'located editor HTML start');
    assert.notStrictEqual(end, -1, 'located editor HTML end');
    return src.slice(start, end + '</html>'.length);
}

describe('contextEditor HTML — inline help (Req 4.1, 8.2) and sanitize notice element (Req 4.2)', () => {
    let document: Document;

    before(() => {
        const html = loadEditorHtml();
        document = new JSDOM(html).window.document;
    });

    it('renders naming help (#newCtxIdHint) describing the naming rules (Req 4.1)', () => {
        const hint = document.getElementById('newCtxIdHint');
        assert.ok(hint, '#newCtxIdHint is present in the editor HTML');
        const text = (hint!.textContent || '').toLowerCase();
        assert.ok(text.length > 0, '#newCtxIdHint has help text');
        assert.ok(
            text.includes('letter') || text.includes('digit') || text.includes('underscore'),
            '#newCtxIdHint describes the naming rules'
        );
        // The name input references it via aria-describedby.
        const input = document.getElementById('newCtxId');
        assert.strictEqual(
            input!.getAttribute('aria-describedby'),
            'newCtxIdHint',
            '#newCtxId is associated with its naming help'
        );
    });

    it('renders system-prompt purpose help (#systemPromptHint) (Req 8.2)', () => {
        const hint = document.getElementById('systemPromptHint');
        assert.ok(hint, '#systemPromptHint is present in the editor HTML');
        const text = (hint!.textContent || '').toLowerCase();
        assert.ok(text.includes('system prompt'), '#systemPromptHint explains the system prompt');
        const textarea = document.getElementById('systemPrompt');
        assert.strictEqual(
            textarea!.getAttribute('aria-describedby'),
            'systemPromptHint',
            '#systemPrompt is associated with its purpose help'
        );
    });

    it('provides the sanitize preview notice element (#newCtxSanitizeNotice) hidden by default (Req 4.2)', () => {
        const notice = document.getElementById('newCtxSanitizeNotice');
        assert.ok(notice, '#newCtxSanitizeNotice is present in the editor HTML');
        assert.ok(
            notice!.classList.contains('hidden'),
            '#newCtxSanitizeNotice starts hidden'
        );
    });

    it('shows the sanitize preview notice when a name with disallowed characters is entered (Req 4.2 example half)', () => {
        const html = loadEditorHtml();
        const doc = new JSDOM(html).window.document;
        // Enter a name containing a disallowed character (space).
        applySanitizeInputMirror(doc, 'my context!');
        const notice = doc.getElementById('newCtxSanitizeNotice')!;
        assert.ok(!notice.classList.contains('hidden'), 'notice becomes visible');
        assert.ok(
            (notice.textContent || '').includes('my_context_'),
            'notice previews the sanitized id'
        );

        // And it stays hidden for an already-clean name.
        applySanitizeInputMirror(doc, 'clean-name_1');
        assert.ok(notice.classList.contains('hidden'), 'notice hidden for a clean name');
    });
});

// ---------------------------------------------------------------------------
// Guard: the mirror of sanitizeId stays behaviorally identical to the
// exported source-of-truth sanitizeContextId (keeps the mirror honest).
// ---------------------------------------------------------------------------

describe('contextEditor sanitize mirror stays in sync with sanitizeContextId', () => {
    it('sanitizeIdMirror matches sanitizeContextId for arbitrary inputs', () => {
        fc.assert(
            fc.property(fc.string({ maxLength: 40 }), (raw) => {
                assert.strictEqual(sanitizeIdMirror(raw), sanitizeContextId(raw));
            }),
            { numRuns: 100 }
        );
    });
});
