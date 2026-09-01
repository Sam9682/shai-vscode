# Requirements Document

## Introduction

This feature enhances the CHAT section of the shai-vscode extension so that web HTTP links appearing in chat answers render as clickable anchors that open in the user's default web browser. It also adds display improvements to how chat request results are rendered: HTML escaping of raw text before formatting, a copy-code button on code blocks, a per-message timestamp, and improved markdown rendering (multiline fenced code with language labels, nested lists, and markdown links).

Chat message rendering happens inside the webview via a `formatMessage(text)` function that assigns the result to `el.innerHTML`. Clicks are handled through event delegation on the messages container. Because opening a URL in the system browser requires the VS Code extension host, link clicks are relayed from the webview to the host via `vscode.postMessage`, and the host opens the URL with `vscode.env.openExternal`. The host receives webview messages in two parallel `onDidReceiveMessage` switch statements (one in `resolveWebviewView`, one in the static `openPanel` handler), both of which must be kept in sync.

## Glossary

- **Chat_Webview**: The webview UI that renders chat messages, defined by `formatMessage(text)` and the messages container click handler.
- **Chat_Host**: The VS Code extension host code in `chatView.ts` that receives messages from the Chat_Webview through `onDidReceiveMessage`.
- **Message_Formatter**: The `formatMessage(text)` function in the Chat_Webview that transforms raw chat text into rendered HTML.
- **Chat_Message**: A single rendered message element in the messages container (user or assistant).
- **Web_Link**: An `http://` or `https://` URL, provided either as bare text or as a markdown link `[text](url)`.
- **Link_Anchor**: A clickable HTML anchor element rendered in a Chat_Message that represents a Web_Link.
- **Code_Block**: A fenced code section rendered from triple-backtick markdown.
- **Copy_Code_Button**: A clickable control rendered on a Code_Block that copies the code content to the clipboard.
- **Streaming_Path**: The message flow where the Message_Formatter re-runs on accumulated text for `stream`, `complete`, and `error` message types.

## Requirements

### Requirement 1: Clickable web links in chat answers

**User Story:** As a chat user, I want HTTP and HTTPS links in chat answers to be clickable, so that I can open referenced pages without copying URLs manually.

#### Acceptance Criteria

1. WHEN the Message_Formatter processes text containing a bare `http://` or `https://` URL, THE Chat_Webview SHALL render that URL as a Link_Anchor whose visible text and target both equal the URL.
2. WHEN the Message_Formatter processes text containing a markdown link of the form `[text](url)`, THE Chat_Webview SHALL render a Link_Anchor whose visible text equals `text` and whose target equals `url`.
3. WHEN the Message_Formatter evaluates a candidate link target, IF the target scheme is neither `http` nor `https`, THEN THE Chat_Webview SHALL render the candidate as plain escaped text without a Link_Anchor.
4. WHEN a user clicks a Link_Anchor, THE Chat_Webview SHALL send a message to the Chat_Host containing the link target URL rather than navigating within the webview.

### Requirement 2: Opening links in the system default browser

**User Story:** As a chat user, I want clicked links to open in my default browser, so that I can view pages in my preferred environment.

#### Acceptance Criteria

1. WHEN the Chat_Host receives a link-open message from the Chat_Webview, THE Chat_Host SHALL open the provided URL using `vscode.env.openExternal`.
2. IF the URL received in a link-open message has a scheme other than `http` or `https`, THEN THE Chat_Host SHALL reject the request without calling `vscode.env.openExternal`.
3. THE Chat_Host SHALL handle the link-open message type in both the `resolveWebviewView` `onDidReceiveMessage` switch and the static `openPanel` `onDidReceiveMessage` switch.

### Requirement 3: HTML escaping before formatting

**User Story:** As a chat user, I want raw message text to be safely escaped, so that message content cannot inject unintended HTML into the chat view.

#### Acceptance Criteria

1. WHEN the Message_Formatter receives raw text, THE Message_Formatter SHALL escape the characters `<`, `>`, and `&` before applying any markdown or link transforms.
2. WHEN the Message_Formatter applies markdown and link transforms, THE Message_Formatter SHALL operate on the escaped text so that intended formatting elements are produced from escaped input.

### Requirement 4: Copy-code button on code blocks

**User Story:** As a chat user, I want a copy button on code blocks, so that I can copy code snippets in one action.

#### Acceptance Criteria

1. WHEN the Message_Formatter renders a Code_Block, THE Chat_Webview SHALL render a Copy_Code_Button associated with that Code_Block.
2. WHEN a user clicks a Copy_Code_Button, THE Chat_Webview SHALL copy the text content of the associated Code_Block to the clipboard.
3. WHEN a Copy_Code_Button copy action completes, THE Chat_Webview SHALL display a confirmation indication on that Copy_Code_Button.

### Requirement 5: Per-message timestamp

**User Story:** As a chat user, I want each message to show a timestamp, so that I can tell when each message was produced.

#### Acceptance Criteria

1. WHEN a Chat_Message is added to the messages container, THE Chat_Webview SHALL render a timestamp on that Chat_Message.
2. THE Chat_Webview SHALL format each Chat_Message timestamp as the local time at which the Chat_Message was rendered.

### Requirement 6: Improved markdown rendering

**User Story:** As a chat user, I want richer markdown rendering, so that structured answers are easier to read.

#### Acceptance Criteria

1. WHEN the Message_Formatter processes a fenced code block that spans multiple lines, THE Chat_Webview SHALL render the enclosed content as a single Code_Block preserving line breaks.
2. WHERE a fenced code block specifies a language label after the opening fence, THE Chat_Webview SHALL render the Code_Block with that language label displayed.
3. WHEN the Message_Formatter processes markdown list items that are indented under a parent list item, THE Chat_Webview SHALL render the indented items as a nested list within the parent item.
4. WHEN the Message_Formatter processes markdown links within otherwise formatted text, THE Chat_Webview SHALL render the links as Link_Anchors as specified in Requirement 1.

### Requirement 7: Consistent rendering across the streaming path

**User Story:** As a chat user, I want links and formatting to work while answers stream in and after they complete, so that the display is consistent throughout a response.

#### Acceptance Criteria

1. WHEN the Streaming_Path re-runs the Message_Formatter on accumulated text for a `stream` message, THE Chat_Webview SHALL apply escaping, link, and markdown transforms to the accumulated text.
2. WHEN the Streaming_Path renders a `complete` message, THE Chat_Webview SHALL apply escaping, link, and markdown transforms to the final text.
3. WHEN the Streaming_Path renders an `error` message, THE Chat_Webview SHALL apply escaping to the error text before display.
