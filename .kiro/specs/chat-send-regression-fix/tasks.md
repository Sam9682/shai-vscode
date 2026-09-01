# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Webview Script Parses and Submission Works
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists (the inline script fails to parse, so no listeners register and neither ENTER nor Send posts a `chat-prompt`)
  - **Scoped PBT Approach**: This is a deterministic parse-time defect. Scope the property to the concrete failing artifact - the single inline script string produced by `getHtmlContent`/the webview HTML builder in `src/views/chatView.ts`. Over the input domain, vary non-empty prompt text and tab/context selections (tabId, noExtraContext, autopilot) for the dispatch assertions.
  - Extract the generated inline webview script string from `src/views/chatView.ts` (the IIFE injected into the webview HTML).
  - Test case A - Script parse: assert the extracted script parses as valid JavaScript (e.g. via `new Function(scriptSource)` or a JS parser). Bug Condition: `input.scriptContainsInvalidJsSyntax = true` with `input.invalidConstruct = "(window as any).webkitAudioContext"` at ~line 986.
  - Test case B - ENTER dispatch: in a DOM/webview simulation, load the script, type non-empty text, fire an ENTER `keydown` without Shift, and assert a `chat-prompt` message is posted to the host with the current text and tab/context options (tabId, noExtraContext, autopilot).
  - Test case C - Send dispatch: load the script, type non-empty text, click Send, and assert a `chat-prompt` message is posted with the same fields.
  - Test case D - No invalid syntax remaining: scan the inline script string for TypeScript-only tokens (` as `, `as any`, type annotations, `<T>` casts, `interface`) and assert none remain.
  - The test assertions match the Expected Behavior Properties from design: `script_parses_without_error AND enter_key_dispatches_chat_prompt AND send_click_dispatches_chat_prompt`.
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists). Expect a `SyntaxError` near `(window as any).webkitAudioContext`; because the IIFE never runs, ENTER/Send post nothing.
  - Document counterexamples found (e.g., "inline script throws SyntaxError at `(window as any).webkitAudioContext`; ENTER keydown posts no `chat-prompt`; Send click posts no `chat-prompt`").
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-Syntax Behavior Unchanged
  - **IMPORTANT**: Follow observation-first methodology. Because the unfixed script cannot execute at all, capture the intended behavior from the corrected/isolated handler bodies and assert it matches the documented pre-regression contract for non-syntax behaviors.
  - Observe/record the intended behavior for cases where `isBugCondition` is false (behavior that does not depend on parsing the invalid syntax):
    - Shift+ENTER (`shiftKey = true`) inserts a newline in the prompt textarea and does NOT post a `chat-prompt`.
    - ENTER and Send with empty or whitespace-only text post nothing (no-op).
    - `playCompletionSound` with a mocked Web Audio API available creates two oscillators with the documented frequencies (e.g. 800 Hz high tone), gain ramps, and timing.
    - `playCompletionSound` with `AudioContext`/`webkitAudioContext` undefined neither throws nor interrupts submission (the existing try/catch swallows the error).
    - Clear button, context selector change, tab activation/close, and messages-container click delegation (action buttons, link/copy-code handlers) behave as designed.
    - Assistant responses are appended, formatted, and displayed as before.
  - Write property-based tests capturing these observed behavior patterns from the Preservation Requirements in design:
    - Generate random modifier-key combinations; assert only ENTER-without-Shift submits and all others (including Shift+ENTER) do not.
    - Generate random empty/whitespace-only strings; assert both ENTER and Send are no-ops.
    - Generate random Web Audio API availability states; assert `playCompletionSound` plays when available and fails silently otherwise, never throwing.
  - Property-based testing generates many test cases for stronger guarantees across the input domain.
  - Run tests on UNFIXED code (against the isolated/intended handler bodies and `playCompletionSound` semantics)
  - **EXPECTED OUTCOME**: Tests PASS (this confirms the baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 3. Fix for invalid TypeScript cast in the webview inline script breaking prompt submission

  - [x] 3.1 Implement the fix
    - In `src/views/chatView.ts`, inside the `playCompletionSound` helper of the webview inline script string (~line 986), replace `new (window.AudioContext || (window as any).webkitAudioContext)()` with valid JavaScript `new (window.AudioContext || window.webkitAudioContext)()`.
    - Make no other changes: do not modify any handler bodies, listener registrations, oscillator frequencies, gain ramps, timing, or the surrounding try/catch.
    - Scope confinement: confirm no other TypeScript-only constructs (` as `, `as any`, type annotations, `<T>` casts, `interface`) exist within the inline script string; correct exactly the single `(window as any)` fragment and nothing else.
    - _Bug_Condition: isBugCondition(input) where input.scriptContainsInvalidJsSyntax = true AND input.invalidConstruct = "(window as any).webkitAudioContext" AND scriptFailsToParseAsJavaScript(input)_
    - _Expected_Behavior: expectedBehavior(result) from design - script parses without error, all listeners register, and ENTER (no Shift)/Send with non-empty trimmed text append the user message, post a `chat-prompt` to the host with text and tab/context options, clear the input, and dispatch to shai_
    - _Preservation: Preservation Requirements from design - Shift+ENTER newline, empty/whitespace no-op, completion-sound playback where supported, silent audio failure, streaming status, tabs, context selector, Clear, link/copy handlers, and response rendering all unchanged_
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.2 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Webview Script Parses and Submission Works
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior; when it passes, it confirms the expected behavior is satisfied
    - Run the bug condition exploration test from step 1 (script parse, ENTER dispatch, Send dispatch, no-invalid-syntax scan)
    - **EXPECTED OUTCOME**: Test PASSES (confirms the script parses, listeners register, and both ENTER and Send dispatch a `chat-prompt`)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Non-Syntax Behavior Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run the preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions in Shift+ENTER, empty no-op, completion sound, silent audio failure, and other controls)
    - Confirm all tests still pass after the fix (no regressions)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure the full suite passes: bug condition exploration test (now passing), preservation tests (still passing), and the project's existing tests.
  - Confirm the TypeScript build/compile of `src/views/chatView.ts` succeeds and the generated inline script parses as valid JavaScript.
  - Ensure all tests pass, ask the user if questions arise.
