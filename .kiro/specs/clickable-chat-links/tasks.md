# Implementation Plan: clickable-chat-links

## Overview

This plan implements clickable HTTP/HTTPS links in the CHAT webview plus rendering improvements (HTML escaping, copy-code buttons, per-message timestamps, multiline fenced code, nested lists) and the host-side `openExternal` relay.

The work is grounded in three implementation surfaces:
- The extractable webview logic (`escapeHtml`, `isAllowedUrl`, `formatMessage`, code-block/list/linkify helpers) so it can be unit- and property-tested in a jsdom environment.
- The inline webview template in `getHtmlContent()` in `src/views/chatView.ts`, mirrored by the standalone `src/views/chatView.html` (kept in sync).
- The `Chat_Host` (`ChatViewProvider`) with the `openExternal` case added to **both** `onDidReceiveMessage` switches (`resolveWebviewView` and static `openPanel`) plus host-side `isHttpUrl` validation.

The pipeline order is fixed: escape -> extract fenced code -> inline transforms -> linkify (markdown links then bare URLs) -> lists -> restore code blocks. All streaming paths (`stream`, `complete`, `error`) route through this pipeline.

## Tasks

- [x] 1. Set up testable webview formatting module and test harness
  - [x] 1.1 Extract formatting/validation helpers into a testable module
    - Create a module (e.g. `src/views/chatFormat.ts` or `src/webview/chatFormat.js`) exporting `escapeHtml`, `isAllowedUrl`, `formatMessage`, and internal helpers (fenced-code extraction, linkify, nested-list builder) so they run in a DOM-capable environment independent of VS Code
    - Define the `CodeBlock` placeholder shape (`lang`, `content`, `token`) and the `OpenExternalMessage` type
    - _Requirements: 3.1, 3.2, 1.1, 1.2, 1.3, 6.1, 6.2, 6.3_

  - [ ]* 1.2 Set up jsdom-based test framework for the formatting module
    - Configure the test runner to execute helpers against a DOM (jsdom) with property-based testing support
    - Add a fixed-clock utility for timestamp tests
    - _Requirements: 3.1, 5.2_

- [x] 2. Implement HTML escaping (pipeline foundation)
  - [x] 2.1 Implement `escapeHtml` as the mandatory first transform
    - Replace `&` -> `&amp;` first, then `<` -> `&lt;`, `>` -> `&gt;` to avoid double-escaping
    - _Requirements: 3.1, 3.2_

  - [ ]* 2.2 Write property test for HTML escaping
    - **Feature: clickable-chat-links, Property 1: HTML escaping precedes all transforms**
    - **Validates: Requirements 3.1, 3.2**

- [x] 3. Implement URL validation gate
  - [x] 3.1 Implement `isAllowedUrl` scheme gate for the webview
    - Return true only for `http://` and `https://` targets; shared by markdown-link and bare-url linkifying
    - _Requirements: 1.3_

  - [ ]* 3.2 Write property test for the webview URL gate
    - **Feature: clickable-chat-links, Property 4: Non-http(s) candidates are never linked**
    - **Validates: Requirements 1.3**

- [x] 4. Implement fenced code extraction and restoration
  - [x] 4.1 Extract fenced code blocks to placeholders before inline transforms
    - Parse triple-backtick blocks, capture optional language label and escaped multiline content preserving line breaks, replace with unique placeholder tokens
    - _Requirements: 6.1, 6.2_

  - [x] 4.2 Restore code blocks with language label and copy button
    - Reinsert each block as `<pre class="code-block" data-lang>` with `.code-header` (`.code-lang` label + `.copy-code-btn`) and `<code>` body preserving line breaks
    - _Requirements: 4.1, 6.1, 6.2_

  - [ ]* 4.3 Write property test for multiline fenced code preservation
    - **Feature: clickable-chat-links, Property 11: Multiline fenced code is preserved as one block**
    - **Validates: Requirements 6.1**

  - [ ]* 4.4 Write property test for language label display and exclusion
    - **Feature: clickable-chat-links, Property 12: Language label is displayed and excluded from code**
    - **Validates: Requirements 6.2**

  - [ ]* 4.5 Write property test for copy-button presence per code block
    - **Feature: clickable-chat-links, Property 8: Every code block gets a copy button**
    - **Validates: Requirements 4.1**

- [x] 5. Implement linkify transforms
  - [x] 5.1 Linkify markdown links then bare URLs
    - Transform `[text](url)` first, then bare `http(s)` URLs, so a URL inside a markdown link is not linkified twice; only emit anchors for `isAllowedUrl` targets; disallowed candidates remain escaped plain text
    - Produce anchors of shape `<a class="chat-link" data-href="url">visible text</a>` (visible text = URL for bare, escaped `text` for markdown links)
    - _Requirements: 1.1, 1.2, 1.3, 6.4_

  - [ ]* 5.2 Write property test for bare URL anchors
    - **Feature: clickable-chat-links, Property 2: Bare URLs become self-targeting anchors**
    - **Validates: Requirements 1.1**

  - [ ]* 5.3 Write property test for markdown link text/target separation
    - **Feature: clickable-chat-links, Property 3: Markdown links preserve text and target separately**
    - **Validates: Requirements 1.2, 6.4**

- [x] 6. Implement nested list rendering and inline transforms
  - [x] 6.1 Implement inline transforms and nested lists
    - Apply bold/italic/inline-code/headers and existing action/button tokens on escaped, code-free text
    - Build nested lists from leading indentation so indented items nest within the parent list item
    - _Requirements: 6.3, 6.4_

  - [ ]* 6.2 Write property test for nested list structure
    - **Feature: clickable-chat-links, Property 13: Indented list items nest under their parent**
    - **Validates: Requirements 6.3**

- [x] 7. Assemble the full `formatMessage` pipeline
  - [x] 7.1 Wire the pipeline in fixed order
    - Compose escape -> extract fenced code -> inline transforms -> linkify -> lists -> restore code blocks into `formatMessage`, returning HTML safe for `innerHTML`
    - _Requirements: 3.1, 3.2, 1.1, 1.2, 1.3, 6.1, 6.2, 6.3, 6.4_

- [x] 8. Checkpoint - Ensure formatting module tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Integrate formatting and interactions into the inline webview template (`getHtmlContent()`)
  - [x] 9.1 Replace `formatMessage` in the inline template and add styles
    - Swap the inline template's formatter for the extracted pipeline; add CSS for `.chat-link`, `.code-block`/`.code-header`/`.code-lang`/`.copy-code-btn`, and the timestamp element
    - _Requirements: 1.1, 1.2, 1.3, 3.1, 3.2, 4.1, 6.1, 6.2, 6.3, 6.4_

  - [x] 9.2 Render per-message timestamp in `appendMessage`
    - In `appendMessage`, add exactly one timestamp element per message formatted as local time at render
    - _Requirements: 5.1, 5.2_

  - [x] 9.3 Extend messages-container click delegation
    - Extend the single `messages` click handler using `event.target.closest(...)` in order: `.action-button` (unchanged), `a.chat-link` (preventDefault + `postMessage({type:'openExternal', url:<data-href>})`), `.copy-code-btn` (decode + clipboard write + transient "Copied" confirmation, catching write failures)
    - _Requirements: 1.4, 4.2, 4.3_

  - [x] 9.4 Route streaming paths through the formatter
    - Ensure `stream`, `complete`, and `error` handlers run accumulated/final text through `formatMessage` (error text at minimum through escaping)
    - _Requirements: 7.1, 7.2, 7.3_

  - [ ]* 9.5 Write example test for copy-confirmation indication
    - Click a copy button and assert the transient confirmation ("Copied") appears
    - _Requirements: 4.3_

  - [ ]* 9.6 Write example test for local-time timestamp formatting
    - Use a fixed clock and assert one timestamp element formatted as local time (Property 10 presence + formatting)
    - **Feature: clickable-chat-links, Property 10: Every message renders a timestamp**
    - _Requirements: 5.1, 5.2_

  - [ ]* 9.7 Write property test for copy content correctness
    - **Feature: clickable-chat-links, Property 9: Copy writes the exact code content**
    - **Validates: Requirements 4.2**

  - [ ]* 9.8 Write property test for anchor-click dispatch
    - **Feature: clickable-chat-links, Property 5: Anchor clicks post the target URL to the host**
    - **Validates: Requirements 1.4**

  - [ ]* 9.9 Write property test for error-text escaping on the streaming path
    - **Feature: clickable-chat-links, Property 14: Error text is escaped before display**
    - **Validates: Requirements 7.1, 7.2, 7.3**

- [x] 10. Mirror changes into the standalone `chatView.html`
  - [x] 10.1 Sync `src/views/chatView.html` with the inline template
    - Apply the same formatter, styles, timestamp, click delegation, and streaming routing so the standalone copy does not diverge from `getHtmlContent()`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.1, 3.2, 4.1, 4.2, 4.3, 5.1, 5.2, 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3_

- [x] 11. Implement host-side `openExternal` handling
  - [x] 11.1 Add host-side `isHttpUrl` validation helper
    - Implement `isHttpUrl(raw)` using `vscode.Uri.parse(raw, true)`, returning true only for `http`/`https` schemes and catching parse errors to return false
    - _Requirements: 2.2_

  - [x] 11.2 Add `openExternal` case to the `resolveWebviewView` switch
    - Validate `message.url` with `isHttpUrl` and call `vscode.env.openExternal(vscode.Uri.parse(url))`; silently reject non-http(s)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 11.3 Add `openExternal` case to the static `openPanel` switch
    - Mirror the `resolveWebviewView` case (using `data.url`) to keep the two handlers in parity
    - _Requirements: 2.1, 2.2, 2.3_

  - [ ]* 11.4 Write property test for host opening valid URLs
    - **Feature: clickable-chat-links, Property 6: The host opens valid URLs externally**
    - **Validates: Requirements 2.1**

  - [ ]* 11.5 Write property test for host rejecting non-http(s) URLs
    - **Feature: clickable-chat-links, Property 7: The host rejects non-http(s) URLs**
    - **Validates: Requirements 2.2**

  - [ ]* 11.6 Write integration/parity tests for both host switches
    - With a mocked `vscode.env.openExternal`, exercise each handler (resolveWebviewView and openPanel) with one allowed URL (expects a call) and one disallowed URL (expects no call)
    - _Requirements: 2.3_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP.
- Each task references specific requirements clauses for traceability; property test tasks reference their design property number.
- The extracted formatting module (Task 1.1) is the seam that lets the property/example tests run in jsdom without VS Code.
- Tasks 9 and 10 both touch webview rendering but write to different files (`chatView.ts` inline template vs `chatView.html`); 10 depends on 9's design being settled and is scheduled in a later wave.
- Host parity (Req 2.3) is enforced by implementing the case in both switches (11.2, 11.3) and verified by 11.6.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "11.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "3.1", "4.1", "11.2"] },
    { "id": 2, "tasks": ["2.2", "3.2", "4.2", "5.1", "6.1", "11.3"] },
    { "id": 3, "tasks": ["4.3", "4.4", "4.5", "5.2", "5.3", "6.2", "7.1", "11.4", "11.5"] },
    { "id": 4, "tasks": ["9.1", "11.6"] },
    { "id": 5, "tasks": ["9.2", "9.3", "9.4"] },
    { "id": 6, "tasks": ["9.5", "9.6", "9.7", "9.8", "9.9"] },
    { "id": 7, "tasks": ["10.1"] }
  ]
}
```
