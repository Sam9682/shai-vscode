# Implementation Plan: User-Friendliness Improvements

## Overview

This plan implements the six user-friendliness areas by enriching existing files only: `authConfig.ts`, `authWizardPanel.ts`, `contextManager.ts`, `contextEditorPanel.ts`, `media/contextEditor.js`, `chatView.ts`, and `streaming.ts`. Changes are minimal, inline, and reversible. Pure logic is added as exported functions so it is directly testable; non-exportable inline webview logic is verified with the established "mirror, not import" convention (Mocha + fast-check + jsdom), matching the existing `src/auth/authWizardPanel.*.test.ts` suite.

Work proceeds file-by-file, starting with the pure metadata/formatter layer (which the webviews consume), then the three webviews, and ending with a build/test verification pass. All 17 correctness properties are covered; type extension (1.1), English-only help (8.3), and no-new-files/onboarding (8.4) are SMOKE/manual and are not property-tested.

## Tasks

- [x] 1. Extend provider metadata and pure helpers in `authConfig.ts`
  - [x] 1.1 Extend `EnvField` type and populate metadata
    - Add optional `help?: string` and `example?: string` to the `EnvField` type
    - Add a non-empty `help` string to every field of every provider in `PROVIDER_ENV_FIELDS`
    - Add a non-empty `example` string to every field whose `key` ends with `_API_KEY` or `_BASE_URL` (example wins over any legacy `placeholder`)
    - Type extension is verified manually/SMOKE
    - _Requirements: 1.1, 1.2, 1.3_

  - [x]* 1.2 Write property test for provider help metadata
    - **Property 1: Every provider field has help text**
    - **Validates: Requirements 1.2**
    - New file `src/auth/authConfig.help.test.ts`; iterate all providers/fields, assert `help` is a non-empty string

  - [x]* 1.3 Write property test for API-key/base-URL examples
    - **Property 2: API-key and base-URL fields have an example**
    - **Validates: Requirements 1.3**
    - For every field whose `key` ends with `_API_KEY` or `_BASE_URL`, assert `example` is a non-empty string

  - [x] 1.4 Add `MODEL_HELP` map and `getModelHelp` accessor
    - Add `export const MODEL_HELP: Record<string, string>` with an entry per provider id
    - The `ovhcloud` entry must state a model can be chosen from the list or entered as a custom identifier
    - Add `export function getModelHelp(providerId: string): string` returning the map value or a safe non-empty fallback
    - _Requirements: 2.1, 2.2_

  - [x]* 1.5 Write property test and unit test for model help
    - **Property 5 (map half): Model help is defined for every provider** — `getModelHelp(providerId)` returns a non-empty string for every provider id (render half is covered in 4.x)
    - Unit: `getModelHelp('ovhcloud')` mentions custom-or-list wording
    - **Validates: Requirements 2.1, 2.2**

  - [x] 1.6 Sharpen required-field validation messages
    - Add `export function describeRequiredFieldError(label: string): string` naming the field and stating the action needed
    - Update `validateNewProvider` to return `describeRequiredFieldError(f.label)` for empty required fields and a clear model message describing the expected value for an empty model; keep the return-null-on-success contract unchanged
    - _Requirements: 6.1, 6.2_

  - [x]* 1.7 Write property tests for validation messages
    - **Property 13: Required-field validation names the empty field** — Validates Requirements 6.1
    - **Property 14: Empty model is rejected with a model message** — Validates Requirements 6.2
    - New file `src/auth/authConfig.validateMessages.test.ts`

- [x] 2. Add the pure streaming-error formatter in `streaming.ts`
  - [x] 2.1 Implement `describeStreamingError`
    - Add `StreamErrorKind`, `StreamErrorContext`, and `export function describeStreamingError(kind, ctx)` per the design (spawn-failure/timeout/server-status/fetch-failure), with safe `??` fallbacks
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x]* 2.2 Write property/unit tests for `describeStreamingError`
    - **Property 16: Spawn-failure messages name the shai command** — Validates Requirements 7.1
    - **Property 17: Server error messages name the server URL** — Validates Requirements 7.3, 7.4
    - Unit: `describeStreamingError('timeout', {})` mentions timed out and retry (Req 7.2)
    - New file `src/chat/streaming.describeError.test.ts`

  - [x] 2.3 Wire the formatter into the streaming session
    - In `executeCommandWithStreaming`: `child.on('error', ...)` emits `describeStreamingError('spawn-failure', { shaiCommand })`; timeout branch emits `describeStreamingError('timeout', {})`
    - In `callServer`: `!res.ok` emits `describeStreamingError('server-status', { serverUrl, status })`; pre-response `catch` emits `describeStreamingError('fetch-failure', { serverUrl })`
    - Emit each as the `data` of the `error` `StreamingResponse`; leave reasoning-panel routing unchanged
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 3. Add the pure streaming state machine for the Chat_View
  - [x] 3.1 Implement `nextStreamState` and `sendEnabled` reducers
    - Add the pure reducer functions (exported for tests, and mirrored in the webview script) per the design: `submit`→sending, `progress`→receiving only while sending/receiving, `complete`→completed, `error`→failed; `sendEnabled` true for idle/completed/failed
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x]* 3.2 Write property test for the state machine
    - **Property 12: Streaming state machine and send-control invariant**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6**
    - New file `src/views/chatView.streamState.test.ts`; generate arbitrary event sequences and assert state + `sendEnabled` invariant

- [x] 4. Enrich the Auth_Wizard webview in `authWizardPanel.ts`
  - [x] 4.1 Render example as placeholder and help with `aria-describedby`
    - In `renderEnvInputs`, set `input.placeholder = f.example ?? f.placeholder ?? ''`
    - When `f.help` is present, render `<div class="hint" id="help_<key>">` and set the input's `aria-describedby` to `help_<key>`
    - _Requirements: 1.4, 1.5, 1.6_

  - [x] 4.2 Render per-provider model help
    - Add `modelHelp` (the `MODEL_HELP` map) to the init payload
    - In `renderModelControls`, write `getModelHelp(providerId)` into `<div class="hint" id="modelHelp">`, updated on every provider `change`
    - _Requirements: 2.1, 2.2_

  - [x] 4.3 Add expandable credential help and retain values on error
    - Add a static `<details class="cred-help">` block describing how to obtain provider credentials
    - Ensure the `error` message handler only calls `showErr(...)` and does not clear env inputs, provider select, or model controls
    - _Requirements: 8.1, 6.3_

  - [x]* 4.4 Write property/unit tests for wizard rendering (mirror, not import)
    - **Property 3: Example is rendered as the input placeholder** — Validates Requirements 1.4, 1.6
    - **Property 4: Help is rendered and associated with its input** — Validates Requirements 1.5
    - **Property 5 (render half): model-help element displays exactly `getModelHelp(providerId)`** — Validates Requirements 2.1
    - **Property 15: Validation errors retain the entered form values** — Validates Requirements 6.3
    - Unit: the credential help `<details>` block is present in wizard HTML (Req 8.1)
    - New files `src/auth/authWizardPanel.helpRender.test.ts` and `src/auth/authWizardPanel.retainOnError.test.ts`; mirror `renderEnvInputs`/`renderModelControls`/error-handler logic against jsdom, annotated as mirrors

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Export the context sanitizer in `contextManager.ts`
  - [x] 6.1 Add `sanitizeContextId`
    - Add `export function sanitizeContextId(raw: string): string` returning `raw.replace(/[^a-zA-Z0-9_-]/g, '_')` as the single source of truth
    - _Requirements: 4.2_

  - [x]* 6.2 Write property test for sanitization
    - **Property 10: Sanitization maps disallowed characters to underscore**
    - **Validates: Requirements 4.2**
    - New file `src/context/contextManager.sanitize.test.ts`; assert same length, allowed chars preserved, all others become `_`

- [x] 7. Enrich the Context_Editor (`contextEditorPanel.ts` + `media/contextEditor.js`)
  - [x] 7.1 Pass predefined templates to the webview and use `sanitizeContextId`
    - Add `templates: {id,label,systemPrompt}[]` (from `PREDEFINED_CONTEXTS`) to the `init` payload
    - Replace the host-side inline sanitization regex in the `newContext` handler with `sanitizeContextId`
    - _Requirements: 4.3_

  - [x] 7.2 Add naming help, sanitize preview notice, and template selector
    - Add a static `.hint` under the name input describing allowed characters (Req 4.1)
    - On input, show a notice when `sanitizeId(raw) !== raw` (keep client `sanitizeId` behaviorally identical to `sanitizeContextId`) (Req 4.2)
    - Add `<select id="newCtxTemplate">` populated from `templates`; on `change`, set `newCtxSystem.value = template.systemPrompt` (Req 4.3, 4.4)
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 7.3 Add system-prompt purpose help and active-context distinction
    - Add a static `.hint` near the system-prompt textarea explaining its purpose (Req 8.2)
    - Show the active context id/label in `activeName` and mark exactly the active option as `selected` with the `*` marker (Req 3.4, 3.5)
    - _Requirements: 8.2, 3.4, 3.5_

  - [x] 7.4 Keep duplicate-name handling with value retention
    - Ensure the create handler shows `#newCtxError` for a duplicate sanitized id, retains `#newCtxId` and `#newCtxSystem` values, and posts no `newContext`
    - _Requirements: 4.5_

  - [x]* 7.5 Write property/unit tests for the context editor (mirror, not import)
    - **Property 7: Context editor marks exactly the active context** — Validates Requirements 3.4, 3.5
    - **Property 8: Every predefined context is offered as a template** — Validates Requirements 4.3
    - **Property 9: Selecting a template populates the system prompt** — Validates Requirements 4.4
    - **Property 11: Duplicate context names are rejected with values retained** — Validates Requirements 4.5
    - Unit: naming help and system-prompt purpose help are present in editor HTML (Req 4.1, 8.2); sanitize preview notice appears for a name with disallowed characters (Req 4.2 example half)
    - New file `src/views/contextEditorPanel.help.test.ts`; mirror the webview render/create/selector logic against jsdom, annotated as mirrors

- [x] 8. Wire Chat_View context indicators and streaming status
  - [x] 8.1 Keep Context_Badge and Context_Selector in sync
    - On `activeContext`, set the badge text to include the label and set the selector's `value` to the active id; ensure the host re-sends `activeContext` on visibility change and `onActiveContextChanged`
    - _Requirements: 3.1, 3.2, 3.3_

  - [x] 8.2 Add the Streaming_Status_Indicator and send-control wiring
    - Add a `#streaming-status` element; drive its label/class from the mirrored `nextStreamState` and the send button's `disabled` from `sendEnabled(state)`; derive `submit` on send and map `complete`/`error` to completed/failed while preserving existing `setProcessing`
    - Post `{ type: 'streamingState', state: 'receiving' }` from the host when forwarding progress chunks so the receiving state is visible (reasoning routing unchanged)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x]* 8.3 Write property test for chat indicators (mirror, not import)
    - **Property 6: Chat indicators reflect the active context**
    - **Validates: Requirements 3.1, 3.2, 3.3**
    - New file `src/views/chatView.contextIndicators.test.ts`; mirror the `activeContext` handler against jsdom over arbitrary message sequences

- [x] 9. Final checkpoint - Build and test verification
  - Run the TypeScript compile/build and the full test suite; fix any failures
  - Confirm all Help_Text is inline (no new documentation files or onboarding view) and in English (SMOKE/manual for Req 8.3, 8.4)
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirements/sub-requirements for traceability, and each property test explicitly names the design property it validates.
- Property tests use Mocha + fast-check (min 100 iterations), with jsdom for DOM-level checks, following the "mirror, not import" convention for non-exportable inline webview logic.
- Type extension (1.1), English-only help (8.3), and no-new-files/onboarding (8.4) are SMOKE/manual and are not property-tested.
- Checkpoints (tasks 5 and 9) provide incremental validation; the final checkpoint is the build/test verification pass.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "6.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "2.2", "3.2", "6.2"] },
    { "id": 2, "tasks": ["1.5", "1.6", "2.3", "4.1", "7.1"] },
    { "id": 3, "tasks": ["1.7", "4.2", "4.3", "7.2", "7.3", "7.4"] },
    { "id": 4, "tasks": ["4.4", "7.5", "8.1"] },
    { "id": 5, "tasks": ["8.2"] },
    { "id": 6, "tasks": ["8.3"] }
  ]
}
```
