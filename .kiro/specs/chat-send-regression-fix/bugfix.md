# Bugfix Requirements Document

## Introduction

In the shai VS Code extension's CHAT panel, submitting a prompt is completely broken. When the user presses ENTER (without Shift) in the prompt textarea, or clicks the "Send" button, nothing happens: no message is appended, no `chat-prompt` message is posted to the extension host, and no request is dispatched to shai for execution.

This is a regression. In the previous version the Send button click handler and the ENTER key handler both dispatched the prompt correctly. The most recent modification to the chat webview added a completion-sound feature whose code contains TypeScript-only syntax (`(window as any).webkitAudioContext`) inside the webview's plain-JavaScript script string. The webview cannot parse this syntax, so the whole inline script (an IIFE) throws a parse/`SyntaxError` before any event listeners are attached. As a result, every interactive control in the CHAT webview stops working, including Send and ENTER submission.

The fix must restore prompt submission (ENTER and Send) without breaking the other webview behaviors that were introduced alongside the regression (streaming status indicator, tabs, context selector, link/copy handling, and the completion sound where the environment supports it).

## Bug Analysis

### Current Behavior (Defect)

When the CHAT webview loads, the inline script contains invalid JavaScript syntax, which prevents the entire script from executing and therefore prevents any event handlers from being registered.

1.1 WHEN the CHAT webview is resolved and its inline script is parsed THEN the system encounters TypeScript-only syntax (`(window as any).webkitAudioContext`) that is invalid JavaScript and the script throws a SyntaxError, aborting execution of the whole IIFE
1.2 WHEN the user presses ENTER (without Shift) in the prompt textarea THEN the system does nothing: no user message is appended, no `chat-prompt` message is posted to the host, and no request is dispatched to shai
1.3 WHEN the user clicks the "Send" button THEN the system does nothing: no user message is appended, no `chat-prompt` message is posted to the host, and no request is dispatched to shai
1.4 WHEN the inline script fails to execute THEN the system leaves all other webview controls (Clear button, context selector, streaming status, tab bar, link/copy handlers) non-functional because none of their listeners were attached

### Expected Behavior (Correct)

2.1 WHEN the CHAT webview is resolved and its inline script is parsed THEN the system SHALL execute the script successfully with no syntax errors so that all event listeners are registered
2.2 WHEN the user presses ENTER (without Shift) in the prompt textarea with non-empty trimmed text THEN the system SHALL append the user message, post a `chat-prompt` message to the host with the current text and tab/context options, clear the input, and dispatch the request to shai for execution
2.3 WHEN the user clicks the "Send" button with non-empty trimmed text THEN the system SHALL append the user message, post a `chat-prompt` message to the host with the current text and tab/context options, clear the input, and dispatch the request to shai for execution
2.4 WHEN the inline script executes successfully THEN the system SHALL register all other webview control listeners (Clear button, context selector, streaming status, tab bar, link/copy handlers) so they function as intended

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the user presses ENTER with the Shift key held THEN the system SHALL CONTINUE TO insert a newline in the prompt textarea instead of submitting
3.2 WHEN the user presses ENTER or clicks Send while the prompt is empty or whitespace-only THEN the system SHALL CONTINUE TO do nothing (no message posted)
3.3 WHEN a request completes or errors in an environment where the Web Audio API is available THEN the system SHALL CONTINUE TO play the completion sound
3.4 WHEN the Web Audio API is unavailable or sound playback fails THEN the system SHALL CONTINUE TO fail silently without interrupting chat submission or response handling
3.5 WHEN the streaming status indicator, tab management, context selector, Clear action, and link/copy-code handlers are used THEN the system SHALL CONTINUE TO behave as designed
3.6 WHEN a prompt is submitted and a response streams back THEN the system SHALL CONTINUE TO append, format, and display the assistant response as before

## Bug Condition and Properties

### Bug Condition

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type WebviewScriptExecution
  OUTPUT: boolean

  // The bug triggers whenever the CHAT webview inline script is parsed,
  // because it contains TypeScript-only syntax that is invalid JavaScript.
  RETURN X.scriptContainsInvalidJsSyntax = true
END FUNCTION
```

Concretely, the invalid construct is `(window as any).webkitAudioContext` inside the `playCompletionSound` helper of the webview script string in `src/views/chatView.ts`.

### Fix Checking Property

```pascal
// Property: Fix Checking - Webview script parses and submission works
FOR ALL X WHERE isBugCondition(X) DO
  result <- F'(X)
  ASSERT script_parses_without_error(result)
     AND enter_key_dispatches_chat_prompt(result)
     AND send_click_dispatches_chat_prompt(result)
END FOR
```

### Preservation Checking Property

```pascal
// Property: Preservation Checking - unchanged behavior preserved
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT F(X) = F'(X)
END FOR
```

Where **F** is the current (broken) webview script and **F'** is the fixed script. The fix should be limited to correcting the invalid syntax (e.g., replacing `(window as any).webkitAudioContext` with valid JavaScript such as `window.webkitAudioContext`) so that all previously intended behavior, including the completion sound, is preserved.
