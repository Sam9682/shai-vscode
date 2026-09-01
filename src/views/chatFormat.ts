/**
 * Testable chat message formatting/validation helpers for the CHAT webview.
 *
 * This module is intentionally free of any VS Code or webview-runtime dependency
 * so that its functions can be exercised in a DOM-capable test environment
 * (e.g. jsdom) independent of VS Code. The webview template in
 * `getHtmlContent()` (and the standalone `chatView.html`) mirror this logic.
 *
 * The `formatMessage` pipeline runs in a fixed order because each step assumes
 * the previous one has already run:
 *
 *   1. escapeHtml            -- escape `&`, `<`, `>` FIRST
 *   2. extractFencedCode     -- pull fenced code into placeholder tokens
 *   3. applyInlineTransforms -- bold/italic/inline-code/headers + action tokens
 *   4. linkify               -- markdown links first, then bare URLs
 *   5. buildNestedLists      -- nest list items by leading indentation
 *   6. restoreCodeBlocks     -- reinsert code blocks with lang label + copy button
 *
 * Each stage assumes the invariants established by the previous ones: escaping
 * removes all raw markup (and the NUL sentinel) up front, fenced-code extraction
 * replaces backtick bodies with opaque NUL-delimited tokens that the later
 * inline/linkify/list stages cannot match or mangle, and restoration reinserts
 * those bodies verbatim at the very end. The pure string transforms here need no
 * DOM types, so the module compiles under the extension's ES2020-only `tsc`
 * build.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Placeholder record for a fenced code block extracted from the text stream
 * before inline transforms run, and reinserted at the end of the pipeline.
 */
export interface CodeBlock {
    /** Language label after the opening fence, or '' if none. */
    lang: string;
    /** Escaped code content, line breaks preserved. */
    content: string;
    /** Unique placeholder token inserted into the text stream. */
    token: string;
}

/**
 * Message posted from the webview to the extension host when a user clicks a
 * rendered link anchor. The host re-validates the scheme before opening.
 */
export interface OpenExternalMessage {
    type: 'openExternal';
    /** Expected http:// or https://; host re-validates. */
    url: string;
}

/** CSS class carried by every rendered link anchor. */
export const CHAT_LINK_CLASS = 'chat-link';

// ---------------------------------------------------------------------------
// escapeHtml (full behavior in Task 2)
// ---------------------------------------------------------------------------

/**
 * The mandatory first transform in the pipeline. Escapes the three characters
 * that can inject markup into `innerHTML`.
 *
 * Order matters: `&` MUST be replaced first so that the entities produced for
 * `<` (`&lt;`) and `>` (`&gt;`) are not themselves re-escaped into
 * `&amp;lt;` / `&amp;gt;`. After this step no raw markup from the input
 * survives, which is the foundation every later transform relies on.
 *
 * The NUL character (`\u0000`) is stripped up front. NUL is the sentinel used
 * to build the internal placeholder tokens for fenced code blocks and markdown
 * links (see `makeCodeToken` / `makeLinkToken`). Because those tokens are minted
 * from the escaped text, removing every NUL originating from the input is what
 * makes the tokens genuinely collision-free: input that literally contains a
 * `\u0000CODEBLOCK_0\u0000`-shaped string can no longer alias a real
 * placeholder, corrupt restoration, or leak raw NUL control characters into
 * `innerHTML`. NUL has no legitimate role in rendered chat text.
 *
 * _Requirements: 3.1, 3.2_
 */
export function escapeHtml(text: string): string {
    return text
        // eslint-disable-next-line no-control-regex
        .replace(/\u0000/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// isAllowedUrl (full behavior in Task 3)
// ---------------------------------------------------------------------------

/**
 * Scheme gate shared by the markdown-link and bare-url linkifiers. Returns
 * `true` only for `http://` and `https://` targets (scheme matched
 * case-insensitively). Every other scheme -- `javascript:`, `mailto:`,
 * `file:`, `data:`, protocol-relative `//host`, scheme-less text, etc. -- is
 * rejected so the linkifiers leave the candidate as escaped plain text.
 *
 * Robustness notes:
 * - The input is trimmed of surrounding whitespace before matching.
 * - Any embedded whitespace or control character (including newlines/tabs that
 *   could be used to smuggle a benign-looking prefix ahead of a dangerous
 *   scheme) causes rejection.
 * - Matching is anchored at the start, so a disallowed scheme cannot pass by
 *   embedding an `http://` substring later in the string.
 *
 * _Requirements: 1.3_
 */
export function isAllowedUrl(url: string): boolean {
    if (typeof url !== 'string') {
        return false;
    }
    const trimmed = url.trim();
    if (trimmed.length === 0) {
        return false;
    }
    // Reject any whitespace or ASCII control characters anywhere in the target.
    // eslint-disable-next-line no-control-regex
    if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) {
        return false;
    }
    return /^https?:\/\//i.test(trimmed);
}

// ---------------------------------------------------------------------------
// Fenced code extraction / restoration (full behavior in Task 4)
// ---------------------------------------------------------------------------

/**
 * Extracts triple-backtick fenced code blocks into placeholder tokens before
 * any inline transforms run, so backtick content is not mangled by the
 * bold/italic/inline-code/link rules that follow.
 *
 * This helper is called AFTER `escapeHtml`, so `escapedText` already has its
 * `&`/`<`/`>` replaced with entities; the surviving triple-backtick fences are
 * literal characters (backticks are not escaped) and match directly. The
 * captured `content` is therefore already escaped and safe to reinsert into
 * `<code>` later.
 *
 * Behavior:
 * - Captures the optional language label that follows the opening fence on the
 *   same line (`` ```python ``). The label is trimmed; when absent it is `''`.
 * - Preserves the multiline body verbatim including internal line breaks. Only
 *   the single line break introduced by the opening fence and the one directly
 *   before the closing fence are consumed as fence delimiters, not treated as
 *   code content. CRLF (`\r\n`) line endings are normalized at those two seams.
 * - Replaces each block with a unique, collision-resistant placeholder token
 *   and records the blocks in source order for later restoration.
 *
 * _Requirements: 6.1, 6.2_
 */
export function extractFencedCode(escapedText: string): { text: string; blocks: CodeBlock[] } {
    const blocks: CodeBlock[] = [];
    // Group 1: language label = rest of the opening-fence line (no backticks).
    // The opening fence is followed by an optional CR then a LF (or the end of
    // input for a fence that opens the body immediately).
    // Group 2: body, lazily matched so the first closing fence terminates it.
    const fenceRe = /```([^\n`]*)\r?\n?([\s\S]*?)```/g;
    const text = escapedText.replace(fenceRe, (_match, langLabel: string, body: string) => {
        const token = makeCodeToken(blocks.length);
        blocks.push({
            lang: (langLabel || '').trim(),
            // Drop only the single trailing line break that precedes the closing
            // fence; all interior line breaks are preserved.
            content: body.replace(/\r?\n$/, ''),
            token,
        });
        return token;
    });
    return { text, blocks };
}

/**
 * Reinserts each extracted code block, wrapping it in a `<pre class="code-block">`
 * with a `.code-header` (language label + copy button) and a `<code>` body that
 * preserves line breaks.
 *
 * Restoration replaces each placeholder token with the rendered block. Tokens
 * are literal sentinel strings (see `makeCodeToken`) that cannot appear in the
 * escaped/transformed text, so a plain string replace per block is safe and
 * avoids treating `$`-sequences in the block HTML as regex replacement
 * patterns.
 *
 * _Requirements: 4.1, 6.1, 6.2_
 */
export function restoreCodeBlocks(text: string, blocks: CodeBlock[]): string {
    let restored = text;
    for (const block of blocks) {
        const html = renderCodeBlock(block);
        const idx = restored.indexOf(block.token);
        if (idx === -1) {
            continue;
        }
        restored = restored.slice(0, idx) + html + restored.slice(idx + block.token.length);
    }
    return restored;
}

/** Builds a unique, collision-resistant placeholder token for a code block. */
function makeCodeToken(index: number): string {
    return `\u0000CODEBLOCK_${index}\u0000`;
}

/**
 * Escapes a string for safe inclusion inside a double-quoted HTML attribute.
 * The block content is already HTML-escaped (`&`,`<`,`>` -> entities); the only
 * remaining character that could terminate the attribute early is the double
 * quote, which becomes `&quot;`.
 */
function escapeAttribute(escapedContent: string): string {
    return escapedContent.replace(/"/g, '&quot;');
}

/**
 * Renders a single extracted code block to its final HTML shape.
 *
 * Shape:
 *   <pre class="code-block" data-lang="LANG">
 *     <div class="code-header">
 *       <span class="code-lang">LANG</span>   (omitted when there is no label)
 *       <button class="copy-code-btn" data-code="ESCAPED" type="button">Copy</button>
 *     </div>
 *     <code>ESCAPED-CONTENT</code>
 *   </pre>
 *
 * The `<code>` body holds the HTML-escaped content with line breaks preserved.
 * The copy button additionally carries the escaped content in `data-code` so
 * the webview copy handler (task 9.3) can recover the EXACT original code text
 * by decoding the entities back to their literal characters -- independent of
 * how the DOM normalizes whitespace/line breaks when read via `textContent`.
 *
 * When the block has no language label, `data-lang` is rendered empty and the
 * `.code-lang` label span is omitted (no label text) rather than emitting an
 * empty span.
 *
 * _Requirements: 4.1, 6.1, 6.2_
 */
function renderCodeBlock(block: CodeBlock): string {
    const lang = block.lang || '';
    const langSpan = lang ? `<span class="code-lang">${lang}</span>` : '';
    const dataCode = escapeAttribute(block.content);
    return (
        `<pre class="code-block" data-lang="${lang}">` +
        `<div class="code-header">` +
        langSpan +
        `<button class="copy-code-btn" type="button" data-code="${dataCode}">Copy</button>` +
        `</div>` +
        `<code>${block.content}</code>` +
        `</pre>`
    );
}

// ---------------------------------------------------------------------------
// Inline transforms (full behavior in Task 6)
// ---------------------------------------------------------------------------

/**
 * Applies inline markdown transforms (headers, bold, italic, inline code) plus
 * the existing `[ACTION:...]` / `[BUTTON:...]` tokens on escaped, code-free
 * text. Runs after `escapeHtml` and fenced-code extraction, so the input has no
 * raw markup and no backtick code bodies to mangle.
 *
 * _Requirements: 6.3, 6.4_
 */
export function applyInlineTransforms(escapedCodeFreeText: string): string {
    let out = escapedCodeFreeText;

    // Headers (#, ##, ### ... up to ######) at the start of a line. Processed
    // line-anchored and before emphasis so the marker is consumed cleanly and
    // the header body still receives bold/italic/inline-code transforms below.
    out = out.replace(/^(#{1,6})[ \t]+(.*)$/gm, (_m, hashes: string, body: string) => {
        const level = hashes.length;
        return `<h${level}>${body}</h${level}>`;
    });

    // Action buttons: [ACTION:commandId:label]
    out = out.replace(/\[ACTION:([^:]+):([^\]]+)\]/g, (_m, commandId: string, label: string) => {
        return `<button class="action-button" data-command="${commandId}">${label}</button>`;
    });

    // Custom button actions: [BUTTON:label:data]
    out = out.replace(/\[BUTTON:([^:]+):([^\]]+)\]/g, (_m, label: string, data: string) => {
        return `<button class="action-button" data-action="${label}" data-value="${data}">${label}</button>`;
    });

    // Inline code (`code`)
    out = out.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

    // Bold (**bold**)
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic (*italic*)
    out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    return out;
}

// ---------------------------------------------------------------------------
// Linkify (full behavior in Task 5)
// ---------------------------------------------------------------------------

/**
 * Linkifies markdown links `[text](url)` first, then bare `http(s)` URLs, so a
 * URL already inside a markdown link is not linkified twice. Only emits anchors
 * for `isAllowedUrl` targets; disallowed candidates remain escaped plain text
 * (the original matched substring is returned unchanged).
 *
 * Anchor shape: `<a class="chat-link" data-href="url">visible text</a>` where
 * the visible text is the escaped markdown `text` for markdown links and the
 * URL itself for bare URLs.
 *
 * Ordering / safety:
 * - Markdown links are converted to placeholder tokens FIRST, then the bare-URL
 *   pass runs over the remaining text, then the markdown anchors are restored.
 *   Converting to opaque tokens guarantees the bare-URL pass can never see the
 *   URL inside a markdown link's target or the anchor markup it produced, so no
 *   URL is linkified twice and no match runs over anchor attributes.
 * - Trailing punctuation commonly adjacent to a URL in prose
 *   (`. , ; : ! ? )` and closing brackets/quotes) is excluded from the captured
 *   URL and left as plain text after the anchor, so a sentence like
 *   "see https://example.com." does not swallow the period.
 *
 * _Requirements: 1.1, 1.2, 1.3, 6.4_
 */
export function linkify(text: string): string {
    const mdAnchors: string[] = [];

    // 1. Markdown links first: [text](url). Emit a placeholder token for each
    //    allowed link so the bare-URL pass below cannot re-process its target.
    let out = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
        if (!isAllowedUrl(url)) {
            return match;
        }
        const token = makeLinkToken(mdAnchors.length);
        // `label` is already escaped (linkify runs after escapeHtml); keep as-is.
        mdAnchors.push(renderAnchor(url, label));
        return token;
    });

    // 2. Bare URLs second, over text that no longer contains markdown-link
    //    targets or emitted anchors. The URL body stops before whitespace and
    //    `<` (start of any following markup) and is then trimmed of trailing
    //    punctuation that is more likely sentence punctuation than URL content.
    out = out.replace(/https?:\/\/[^\s<]+/gi, (match: string) => {
        const { url, trailing } = splitTrailingPunctuation(match);
        if (!isAllowedUrl(url)) {
            return match;
        }
        return renderAnchor(url, url) + trailing;
    });

    // 3. Restore markdown-link anchors.
    for (let i = 0; i < mdAnchors.length; i++) {
        const token = makeLinkToken(i);
        const idx = out.indexOf(token);
        if (idx === -1) {
            continue;
        }
        out = out.slice(0, idx) + mdAnchors[i] + out.slice(idx + token.length);
    }

    return out;
}

/** Builds a unique, collision-resistant placeholder token for a markdown link. */
function makeLinkToken(index: number): string {
    return `\u0000CHATLINK_${index}\u0000`;
}

/**
 * Splits trailing punctuation off a bare-URL match so sentence punctuation is
 * not absorbed into the link target. Trailing `. , ; : ! ?`, closing brackets,
 * and quotes are peeled off. A trailing `)` is kept when the URL contains a
 * matching unbalanced `(` (e.g. Wikipedia-style URLs) so balanced parentheses
 * inside the URL are preserved.
 */
function splitTrailingPunctuation(match: string): { url: string; trailing: string } {
    let end = match.length;
    while (end > 0) {
        const ch = match[end - 1];
        if (ch === ')') {
            const opens = countChar(match.slice(0, end), '(');
            const closes = countChar(match.slice(0, end), ')');
            if (closes > opens) {
                end--;
                continue;
            }
            break;
        }
        if ('.,;:!?]}\'"'.indexOf(ch) !== -1) {
            end--;
            continue;
        }
        break;
    }
    return { url: match.slice(0, end), trailing: match.slice(end) };
}

/** Counts occurrences of a single character in a string. */
function countChar(s: string, ch: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === ch) {
            n++;
        }
    }
    return n;
}

/** Renders a single link anchor with the target in `data-href`, not `href`. */
function renderAnchor(url: string, visibleText: string): string {
    return `<a class="${CHAT_LINK_CLASS}" data-href="${url}">${visibleText}</a>`;
}

// ---------------------------------------------------------------------------
// Nested lists (full behavior in Task 6)
// ---------------------------------------------------------------------------

/** A single parsed markdown list item line. */
interface ListItem {
    /** Indentation depth (0 = top level), derived from leading whitespace. */
    depth: number;
    /** `true` for ordered (`1.`) items, `false` for bullets (`-`/`*`). */
    ordered: boolean;
    /** Rendered inner HTML of the item (marker stripped). */
    content: string;
}

/** Matches a bullet (`-`/`*`) or ordered (`1.`) list-item line, capturing indent + body. */
const LIST_ITEM_RE = /^([ \t]*)(?:[-*]|\d+\.)[ \t]+(.*)$/;

/**
 * Builds nested lists from leading indentation so items indented beneath a
 * parent item render as a nested list within the parent list item.
 *
 * Behavior:
 * - Recognizes bullet items (`-` or `*`) and ordered items (`1.`, `2.`, ...).
 *   The list type (`<ul>` vs `<ol>`) is decided by the marker of the first item
 *   at each nesting level.
 * - Groups consecutive list-item lines into a single list; nesting is driven by
 *   each item's leading indentation (spaces or tabs, a tab counting as one
 *   indent step). An item indented more than the current item opens a nested
 *   list attached inside the preceding `<li>`; a dedent closes nested lists back
 *   to the matching level.
 * - Non-list lines are emitted unchanged, terminating any open list.
 *
 * Runs after escaping/inline transforms, so item bodies already contain safe
 * HTML (bold/italic/anchors/etc.); only list structure is added here.
 *
 * _Requirements: 6.3, 6.4_
 */
export function buildNestedLists(text: string): string {
    const lines = text.split('\n');
    const outParts: string[] = [];
    let run: ListItem[] = [];

    const flush = () => {
        if (run.length > 0) {
            outParts.push(renderList(run, { i: 0 }));
            run = [];
        }
    };

    for (const line of lines) {
        const m = LIST_ITEM_RE.exec(line);
        if (m) {
            const indent = m[1];
            const body = m[2];
            const ordered = /^\s*\d+\./.test(line);
            run.push({ depth: indentDepth(indent), ordered, content: body });
        } else {
            flush();
            outParts.push(line);
        }
    }
    flush();

    return outParts.join('\n');
}

/**
 * Converts a leading-whitespace string to a nesting depth. Tabs count as one
 * level each; runs of spaces count as one level per two spaces (rounded down),
 * so both 2-space and tab indentation nest predictably.
 */
function indentDepth(indent: string): number {
    let depth = 0;
    let spaceRun = 0;
    for (const ch of indent) {
        if (ch === '\t') {
            depth += Math.floor(spaceRun / 2);
            spaceRun = 0;
            depth += 1;
        } else {
            spaceRun += 1;
        }
    }
    depth += Math.floor(spaceRun / 2);
    return depth;
}

/**
 * Renders a contiguous run of list items starting at the item at `cursor.i`.
 * The current level's depth and list type are taken from that first item.
 * Consumes items from the shared cursor and recurses to build nested lists for
 * items indented deeper than the current level. Returns the `<ul>`/`<ol>` HTML.
 */
function renderList(items: ListItem[], cursor: { i: number }): string {
    // The depth and tag for this level follow the first item at this level.
    const levelDepth = items[cursor.i].depth;
    const tag = items[cursor.i].ordered ? 'ol' : 'ul';
    let html = `<${tag}>`;

    while (cursor.i < items.length && items[cursor.i].depth >= levelDepth) {
        if (items[cursor.i].depth > levelDepth) {
            // A deeper item with no same-level parent yet: wrap the nested list
            // in its own <li> so it stays valid list markup.
            html += `<li>${renderList(items, cursor)}</li>`;
            continue;
        }

        // Same-level item: open its <li> with the item body.
        let liInner = items[cursor.i].content;
        cursor.i++;

        // Immediately-following deeper items nest inside this <li>.
        if (cursor.i < items.length && items[cursor.i].depth > levelDepth) {
            liInner += renderList(items, cursor);
        }

        html += `<li>${liInner}</li>`;
    }

    html += `</${tag}>`;
    return html;
}

// ---------------------------------------------------------------------------
// formatMessage (full pipeline wired in Task 7)
// ---------------------------------------------------------------------------

/**
 * Full formatting pipeline. Input is raw (unescaped) model text; output is an
 * HTML string safe to assign to `innerHTML`.
 *
 * Fixed order: escape -> extract fenced code -> inline transforms ->
 * linkify -> lists -> restore code blocks.
 *
 * Composition invariants (all verified end-to-end):
 * - Code-block placeholders minted by `extractFencedCode` are NUL-delimited
 *   tokens. Since `escapeHtml` strips NUL from the input first, no user text can
 *   alias a token. The tokens carry no `<`, `>`, `&`, backticks, brackets, list
 *   markers, or `http` prefix, so they pass through `applyInlineTransforms`,
 *   `linkify`, and `buildNestedLists` untouched and are restored intact last.
 * - `linkify` runs on escaped, code-free text, so URLs inside fenced code are
 *   never linkified and no anchor is emitted over already-escaped markup.
 * - No stage double-processes another's output: fenced bodies bypass the inline/
 *   linkify/list stages entirely, and markdown-link targets are tokenized before
 *   the bare-URL pass so a URL is never linkified twice.
 *
 * _Requirements: 3.1, 3.2, 1.1, 1.2, 1.3, 6.1, 6.2, 6.3, 6.4_
 */
export function formatMessage(text: string): string {
    // 1. Escape first.
    const escaped = escapeHtml(text);

    // 2. Extract fenced code into placeholders.
    const { text: withPlaceholders, blocks } = extractFencedCode(escaped);

    // 3. Inline transforms on escaped, code-free text.
    let out = applyInlineTransforms(withPlaceholders);

    // 4. Linkify markdown links then bare URLs.
    out = linkify(out);

    // 5. Lists (with nesting).
    out = buildNestedLists(out);

    // 6. Restore code blocks (+ language label + copy button).
    out = restoreCodeBlocks(out, blocks);

    return out;
}
