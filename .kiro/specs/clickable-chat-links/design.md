# Design Document

## Overview

This feature makes HTTP/HTTPS links in chat answers clickable and improves how chat results render. All rendering happens in the webview's `formatMessage(text)` function, whose result is assigned to `el.innerHTML`. Because the webview cannot open a system browser, link clicks are relayed to the extension host via `vscode.postMessage`, and the host opens them with `vscode.env.openExternal`.

The change touches two layers:

- **Chat_Webview** (the inline HTML/JS template returned by `getHtmlContent()` in `src/views/chatView.ts`, mirrored by the standalone `src/views/chatView.html`): rewrite `formatMessage` to escape first, then layer link/markdown transforms; add copy-code buttons, per-message timestamps, richer fenced-code and nested-list rendering; and extend the messages-container click delegation to route link and copy clicks.
- **Chat_Host** (`ChatViewProvider` in `src/views/chatView.ts`): add an `openExternal` message case to **both** `onDidReceiveMessage` switches (the one in `resolveWebviewView` and the one in the static `openPanel` handler), each validating scheme and calling `vscode.env.openExternal`.

A key implementation fact: the webview that actually runs is the template string inside `getHtmlContent()`. The separate `src/views/chatView.html` file carries an equivalent copy and must be kept in sync so the two do not diverge. `formatMessage` currently sets `innerHTML` with **no escaping**, so untrusted model output can inject markup today; escaping is the first correctness fix and the foundation the link transforms build on.

### Goals

- Render bare `http(s)` URLs and markdown `[text](url)` links as safe, clickable anchors.
- Open clicked links in the system browser via the host, never navigating inside the webview.
- Escape `<`, `>`, `&` before any other transform, on every rendering path including streaming.
- Add copy-code buttons, per-message timestamps, multiline fenced code with language labels, and nested lists.

### Non-Goals

- Full CommonMark compliance. Rendering remains a lightweight regex-based transformer.
- Supporting schemes beyond `http`/`https` (e.g. `mailto:`, `file:`). These render as plain text.
- Changing the streaming protocol or message types beyond adding `openExternal`.

## Architecture

```
                 raw model text
                       |
                       v
   +-------------------------------------------+
   |            Chat_Webview                   |
   |                                           |
   |   formatMessage(text):                    |
   |     1. escapeHtml(text)   <-- FIRST       |
   |     2. extractFencedCode (placeholders)   |
   |     3. inline transforms (bold/italic/    |
   |        inline-code/headers)               |
   |     4. linkify (markdown links, bare urls)|
   |     5. lists (with nesting)               |
   |     6. restore code blocks (+copy button) |
   |                                           |
   |   appendMessage(): wraps content +        |
   |     timestamp                             |
   |                                           |
   |   messages.click delegation:              |
   |     - .action-button  (existing)          |
   |     - a.chat-link  -> postMessage         |
   |         {type:'openExternal', url}        |
   |     - .copy-code-btn -> clipboard write   |
   +-------------------------------------------+
                       |
             postMessage({type:'openExternal', url})
                       |
                       v
   +-------------------------------------------+
   |               Chat_Host                   |
   |  onDidReceiveMessage (resolveWebviewView) |
   |  onDidReceiveMessage (openPanel)          |
   |    case 'openExternal':                   |
   |      if scheme in {http,https}:           |
   |        vscode.env.openExternal(           |
   |            vscode.Uri.parse(url))         |
   |      else: reject (no call)               |
   +-------------------------------------------+
                       |
                       v
             system default browser
```

### Rendering pipeline ordering (why order matters)

The transforms must run in a fixed order because each step assumes the previous one has run:

1. **Escape** `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;` first. Ampersand must be escaped before `<`/`>` so we never double-escape. After this step no raw markup from the model survives.
2. **Extract fenced code blocks** into placeholders before other inline transforms, so backtick content is not mangled by bold/italic/link rules. Store each block's escaped content and language label; reinsert at the end.
3. **Inline transforms** (bold, italic, inline code, headers, action/button tokens) on the escaped, code-free text.
4. **Linkify** markdown links first (`[text](url)`), then bare URLs, so a URL already inside a markdown link is not linkified twice. Anchors carry the target in `data-href`, not `href`.
5. **Lists** with nesting based on leading indentation.
6. **Restore code blocks**, wrapping each in `<pre>` with a language label and a copy button.

Because the streaming path (`stream`, `complete`, `error`) re-invokes `formatMessage` on accumulated/final text, all guarantees above hold uniformly across streaming and completion. The `error` path routes its text through `formatMessage` (or at minimum the escape step) so error text is escaped.

## Components and Interfaces

### Chat_Webview (in-webview JavaScript)

```typescript
// escapeHtml: the mandatory first transform.
// For any string, returns the string with &, <, > replaced by entities.
function escapeHtml(text: string): string;

// isAllowedUrl: scheme gate shared by markdown-link and bare-url linkifying.
// Returns true only for http:// and https:// targets.
function isAllowedUrl(url: string): boolean;

// formatMessage: full pipeline. Input is raw (unescaped) model text.
// Output is an HTML string safe to assign to innerHTML.
function formatMessage(text: string): string;

// appendMessage: creates a .message element, sets its formatted content,
// and renders a per-message timestamp (local time at render).
function appendMessage(text: string, cls: 'user' | 'assistant'): HTMLElement;
```

Anchor shape produced by the linkifier:

```html
<a class="chat-link" data-href="https://example.com">visible text</a>
```

Using `data-href` (not `href`) plus `class="chat-link"` guarantees clicks are handled by delegation and cannot navigate the webview. The visible text is the URL itself for bare URLs, and the escaped `text` portion for markdown links.

Code block shape produced on restore:

```html
<pre class="code-block" data-lang="python">
  <div class="code-header">
    <span class="code-lang">python</span>
    <button class="copy-code-btn" type="button">Copy</button>
  </div>
  <code>...escaped, line-breaks preserved...</code>
</pre>
```

The copy button reads the associated block's raw code text (the escaped entities are decoded back to their literal characters before writing) and writes it to the clipboard, then shows a transient confirmation ("Copied").

### Click delegation (messages container)

Extend the existing single `messages.addEventListener('click', ...)` handler. Order of checks:

```text
target (or closest matching ancestor):
  .action-button  -> existing command/customAction behavior (unchanged)
  a.chat-link     -> event.preventDefault();
                     vscode.postMessage({ type: 'openExternal', url: <data-href> })
  .copy-code-btn  -> copy associated code text to clipboard; show confirmation
```

Use `event.target.closest(...)` so clicks on inner nodes of an anchor or button still resolve to the intended element.

### Chat_Host (`ChatViewProvider`)

A new case is added to both switches. Because the two handlers already duplicate cases (`chat-prompt`, `clear`, `ready`, `shai-auth`, `executeCommand`, `customAction`), the `openExternal` case follows the same pattern and must appear in both to satisfy the parity requirement.

```typescript
case 'openExternal': {
    const url: string = message.url; // (data.url in the openPanel handler)
    if (typeof url === 'string' && isHttpUrl(url)) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }
    // Non-http(s) schemes are silently rejected: no openExternal call.
    break;
}
```

```typescript
// Host-side scheme validation, mirrors the webview gate.
// Returns true only when the parsed scheme is http or https.
function isHttpUrl(raw: string): boolean {
    try {
        const scheme = vscode.Uri.parse(raw, true).scheme.toLowerCase();
        return scheme === 'http' || scheme === 'https';
    } catch {
        return false;
    }
}
```

Validation is enforced on **both** sides (webview and host). The webview gate prevents non-http(s) anchors from being produced; the host gate is defense-in-depth against any message that reaches the host with a disallowed scheme.

## Data Models

### Webview → Host message (new)

```typescript
interface OpenExternalMessage {
    type: 'openExternal';
    url: string; // expected http:// or https://; host re-validates
}
```

### Internal code-block placeholder (within `formatMessage`)

```typescript
interface CodeBlock {
    lang: string;      // language label after opening fence, or '' if none
    content: string;   // escaped code content, line breaks preserved
    token: string;     // unique placeholder inserted into the text stream
}
```

No host-side persisted data models change. Chat history restore (`restoreHistory`) continues to pass raw message text through `appendMessage`, so restored messages get the same escaping, linkifying, and timestamp treatment.

## Error Handling

- **Disallowed scheme (webview):** the candidate is left as escaped plain text; no anchor is emitted.
- **Disallowed scheme (host):** `openExternal` is not called; the message is dropped. This is the primary guard against `javascript:`/`file:`/`data:` style targets reaching the browser layer.
- **Unparseable URL (host):** `vscode.Uri.parse(raw, true)` throws; `isHttpUrl` catches and returns `false`, so nothing opens.
- **Clipboard write failure:** the copy handler catches the rejection and leaves the button label unchanged (no confirmation shown); it does not throw into the click handler.
- **Malformed markdown (unbalanced fences/brackets):** transforms are best-effort regex; unmatched fences fall through as escaped text rather than producing broken markup.
- **Streaming partial input:** because escaping runs first and transforms are best-effort, partially streamed text renders safely (worst case: an incomplete anchor or fence renders as escaped text until more chunks arrive).

## Testing Strategy

**Dual approach.** Property-based tests validate the universal transform/validation guarantees over generated inputs; example and integration tests cover UI feedback, clock-dependent formatting, and the two-handler parity requirement.

- **Property tests** (minimum 100 iterations each) target `escapeHtml`, `formatMessage`, `isAllowedUrl`/`isHttpUrl`, the click→postMessage dispatch, copy-content correctness, timestamp presence, fenced-code preservation, language-label display, and nested-list structure. `formatMessage` and the escaping/validation helpers are extracted so they can be exercised in a DOM-capable test environment (e.g. jsdom) independent of VS Code.
- **Example tests** cover the copy-confirmation indication (Req 4.3) and local-time timestamp formatting with a fixed clock (Req 5.2).
- **Integration/parity tests** exercise each host switch (resolveWebviewView and openPanel) with a mocked `vscode.env.openExternal`: one allowed URL (expects a call) and one disallowed URL (expects no call) per handler, covering Req 2.3.

Each property test is tagged **Feature: clickable-chat-links, Property {number}: {property_text}** and references its design property.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: HTML escaping precedes all transforms

For any raw input text, every literal `<`, `>`, and `&` originating from the input appears in the formatted output as `&lt;`, `&gt;`, and `&amp;` respectively, and no attacker-supplied raw tag from the input survives as a live HTML element.

**Validates: Requirements 3.1, 3.2**

### Property 2: Bare URLs become self-targeting anchors

For any text containing a bare `http://` or `https://` URL, the formatted output contains a Link_Anchor whose visible text equals that URL and whose `data-href` target equals that URL.

**Validates: Requirements 1.1**

### Property 3: Markdown links preserve text and target separately

For any markdown link `[text](url)` whose `url` has an `http`/`https` scheme, the formatted output contains a Link_Anchor whose visible text equals `text` and whose `data-href` target equals `url`.

**Validates: Requirements 1.2, 6.4**

### Property 4: Non-http(s) candidates are never linked

For any link candidate (bare or markdown form) whose scheme is neither `http` nor `https`, the formatted output contains no Link_Anchor for that candidate and renders it as escaped plain text.

**Validates: Requirements 1.3**

### Property 5: Anchor clicks post the target URL to the host

For any rendered Link_Anchor, clicking it prevents webview navigation and sends exactly one message to the host of the form `{ type: 'openExternal', url }` where `url` equals that anchor's target.

**Validates: Requirements 1.4**

### Property 6: The host opens valid URLs externally

For any received `openExternal` message whose `url` has an `http` or `https` scheme, the host invokes `vscode.env.openExternal` once with a URI parsed from that `url`.

**Validates: Requirements 2.1**

### Property 7: The host rejects non-http(s) URLs

For any received `openExternal` message whose `url` has a scheme other than `http` or `https`, the host does not invoke `vscode.env.openExternal`.

**Validates: Requirements 2.2**

### Property 8: Every code block gets a copy button

For any text containing N fenced code blocks, the formatted output contains N copy buttons, each associated with its corresponding Code_Block.

**Validates: Requirements 4.1**

### Property 9: Copy writes the exact code content

For any Code_Block, clicking its copy button writes to the clipboard text equal to the original (decoded) code content of that block.

**Validates: Requirements 4.2**

### Property 10: Every message renders a timestamp

For any message appended to the messages container, the rendered message element contains exactly one timestamp element.

**Validates: Requirements 5.1**

### Property 11: Multiline fenced code is preserved as one block

For any fenced code block spanning multiple lines, the formatted output contains exactly one Code_Block whose decoded content equals the original enclosed lines with line breaks preserved.

**Validates: Requirements 6.1**

### Property 12: Language label is displayed and excluded from code

For any fenced code block with a language label after the opening fence, the formatted output displays that language label and the label text is not part of the code content.

**Validates: Requirements 6.2**

### Property 13: Indented list items nest under their parent

For any markdown list containing items indented beneath a parent item, the formatted output nests the indented items as a nested list inside the parent list item.

**Validates: Requirements 6.3**

### Property 14: Error text is escaped before display

For any error text containing `<`, `>`, or `&`, the displayed error output has those characters escaped so no raw markup from the error text is injected.

**Validates: Requirements 7.1, 7.2, 7.3**
