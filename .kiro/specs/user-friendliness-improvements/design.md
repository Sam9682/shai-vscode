# Design Document

## Overview

This feature makes the shai-vscode extension easier to use by enriching the three existing webviews (`Auth_Wizard`, `Context_Editor`, `Chat_View`) and the static metadata behind them. There is **no new architecture**: no new panels, no new providers, no changes to provider connection or streaming transport logic. Every change either (a) extends an existing data structure (`EnvField`, and read access to `PREDEFINED_CONTEXTS`), (b) enriches an existing webview's HTML/JS, or (c) improves the wording of an existing validation/error message.

The work touches these files:

| File | Change |
| --- | --- |
| `src/auth/authConfig.ts` | Extend `EnvField` with `help?`/`example?`; populate metadata; add a `describeRequiredFieldError` helper; keep `validateNewProvider` field-naming behavior. |
| `src/auth/authWizardPanel.ts` | Render `example` as placeholder, `help` as inline text; add per-provider model help; add expandable "how to get credentials" section; retain form values on error. |
| `src/context/contextManager.ts` | No structural change; `PREDEFINED_CONTEXTS` is read as the template source. A small pure `sanitizeContextId` export documents the sanitization rule already implemented client-side. |
| `src/views/contextEditorPanel.ts` | Pass predefined templates + prompts to the webview; add naming help, sanitization notice, template selector, system-prompt purpose help; keep duplicate-name handling. |
| `media/contextEditor.js` | Template population, sanitization preview notice, duplicate-name retention. |
| `src/views/chatView.ts` (+ inline webview script) | Add `Streaming_Status_Indicator`; wire send-control enable/disable to streaming state; keep `Context_Badge`/`Context_Selector` in sync. |
| `src/chat/streaming.ts` | Emit structured error kinds so the chat can render actionable messages; add a pure `describeStreamingError` formatter. |

The guiding principle is **minimal, inline, and reversible**: enrich what exists, keep pure logic in exported functions so it is testable, and mirror non-exportable inline webview logic in tests (the pattern already used across the `authWizardPanel.*.test.ts` suite).

## Architecture

```
                                 authConfig.ts
                       ┌──────────────────────────────────┐
                       │ EnvField { key,label,secret,      │
                       │   optional, placeholder,          │
                       │   help?, example? }               │  (Req 1.1)
                       │ PROVIDER_ENV_FIELDS (help+example) │  (Req 1.2, 1.3)
                       │ MODEL_HELP: Record<provider,string>│  (Req 2.1, 2.2)
                       │ validateNewProvider (field-named)  │  (Req 6.1, 6.2)
                       │ describeRequiredFieldError         │
                       └───────────────┬───────────────────┘
                                       │ init message (envFields, modelHelp)
                                       ▼
        authWizardPanel.ts  ───────────────────────────────►  Auth_Wizard webview
          renderEnvInputs: placeholder = example (Req 1.4,1.6)  + help text (Req 1.5)
          model help per provider (Req 2.1,2.2)
          expandable credential help (Req 8.1)
          on 'error' message: keep form values (Req 6.3)

        contextManager.ts (PREDEFINED_CONTEXTS, sanitizeContextId)
                                       │ init message (predefined templates+prompts)
                                       ▼
        contextEditorPanel.ts + media/contextEditor.js ─────►  Context_Editor webview
          naming help (Req 4.1) + sanitize notice (Req 4.2)
          template selector -> newCtxSystem (Req 4.3, 4.4)
          duplicate-name error + retain values (Req 4.5)
          active-context distinction (Req 3.4, 3.5)
          system-prompt purpose help (Req 8.2)

        chatView.ts (ChatViewProvider) ─────────────────────►  Chat_View webview
          Context_Badge / Context_Selector reflect active ctx (Req 3.1-3.3)
          Streaming_Status_Indicator state machine (Req 5.1-5.6)
                                       ▲
        streaming.ts (StreamingChatSession)                    error kinds
          describeStreamingError(kind, {shaiCommand,serverUrl}) (Req 7.1-7.4)
```

Data flows one way for each webview: the host (`*.ts`) posts an `init`/`activeContext`/`complete`/`error` message; the webview script renders. No connection logic changes; the only new host→webview payload fields are `modelHelp` (wizard) and `templates` (context editor), plus a `state` field on streaming status messages.

## Components and Interfaces

### 1. `EnvField` metadata (Req 1, 2)

Extend the existing type in `src/auth/authConfig.ts`. Both new fields are optional so nothing else breaks:

```typescript
export type EnvField = {
    key: string;
    label: string;
    secret?: boolean;
    optional?: boolean;
    placeholder?: string;
    /** One-line inline explanation of what this field expects. (Req 1.1, 1.2) */
    help?: string;
    /** Realistic sample value used as the input placeholder. (Req 1.1, 1.3) */
    example?: string;
};
```

Every field in `PROVIDER_ENV_FIELDS` gains a `help`; every API-key or base-URL field gains an `example`. A field is considered an API key or base URL when its `key` ends with `_API_KEY` or `_BASE_URL` (this classification is used by the test in Property 2). Example (abbreviated):

```typescript
anthropic: [
    {
        key: 'ANTHROPIC_API_KEY',
        label: 'ANTHROPIC_API_KEY',
        secret: true,
        help: 'Your Anthropic API key. Create one in the Anthropic Console.',
        example: 'sk-ant-api03-...',
    },
],
ollama: [
    {
        key: 'OLLAMA_BASE_URL',
        label: 'OLLAMA_BASE_URL',
        optional: true,
        placeholder: 'http://localhost:11434/v1', // legacy placeholder retained in data
        help: 'Base URL of your local Ollama server (OpenAI-compatible endpoint).',
        example: 'http://localhost:11434/v1',      // example wins as placeholder (Req 1.6)
    },
],
```

Model-field guidance is a separate pure map keyed by provider id:

```typescript
/** Per-provider guidance for the model field. (Req 2.1, 2.2) */
export const MODEL_HELP: Record<string, string> = {
    anthropic: 'Enter a Claude model id, e.g. claude-sonnet-4-20250514.',
    openai: 'Enter an OpenAI model id, e.g. gpt-4o.',
    // ...
    ovhcloud: 'Choose a model from the list, or select "Other…" to enter a custom model identifier.',
    // ...
};

/** Safe accessor: never returns undefined. */
export function getModelHelp(providerId: string): string {
    return MODEL_HELP[providerId] ?? 'Enter the model identifier expected by this provider.';
}
```

### 2. Auth_Wizard rendering (Req 1.4-1.6, 2.1-2.2, 6.3, 8.1)

Changes are confined to `getWizardHtml` in `src/auth/authWizardPanel.ts`.

**`renderEnvInputs(providerId)`** — for each field:
- Placeholder rule (Req 1.4, 1.6): `input.placeholder = f.example ?? f.placeholder ?? ''`. When both are present, `example` wins.
- Help rule (Req 1.5): when `f.help` is present, render a `<div class="hint" id="help_<key>">f.help</div>` after the input and set `input.setAttribute('aria-describedby', 'help_' + f.key)` so the help is programmatically associated with the control.

**Model help (Req 2.1, 2.2)** — the init payload adds `modelHelp` (the `MODEL_HELP` map). `renderModelControls(providerId)` writes `getModelHelp(providerId)` into a `<div class="hint" id="modelHelp">` under the model row, updated on every provider `change`. For `ovhcloud` the text explicitly covers "choose from list or custom id".

**Expandable credential help (Req 8.1)** — a static `<details>` block in the new-profile form:

```html
<details class="cred-help">
  <summary>How do I get these credentials?</summary>
  <div class="hint">Each provider issues an API key from its own console...</div>
</details>
```

**Retain values on error (Req 6.3)** — the `error` message handler only calls `showErr(...)`. It must **not** call `clearNewForm()` and must not touch env inputs, the provider select, or the model controls. This is already the current behavior; the design pins it with Property 8.

### 3. Validation messages (Req 6.1, 6.2)

`validateNewProvider` already names the field (`Field ${f.label} is required.`) and reports empty model (`Please enter a model name.`). The design keeps this contract and sharpens wording via a small exported helper so tests can assert the field name is present:

```typescript
export function describeRequiredFieldError(label: string): string {
    return `Field "${label}" is required. Enter a value for ${label} before saving.`;
}
```

`validateNewProvider` returns `describeRequiredFieldError(f.label)` for an empty required field, and a model message such as `'A model name is required. Enter the model identifier for the selected provider.'` for an empty model. The return-null-on-success contract is unchanged, so `updateProviderAt` (which delegates to `validateNewProvider`) is unaffected.

### 4. Context_Editor (Req 3.4-3.5, 4.1-4.5, 8.2)

**Sanitization rule (Req 4.2)** — the webview already sanitizes with `replace(/[^a-zA-Z0-9_-]/g, '_')` (host side) and an equivalent `sanitizeId` (client side). The design exports a single source of truth so the property test targets real logic:

```typescript
// contextManager.ts
export function sanitizeContextId(raw: string): string {
    return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
}
```

`contextEditorPanel.ts`'s `newContext` handler uses `sanitizeContextId` instead of the inline regex. The webview keeps its character-by-character `sanitizeId` (must stay behaviorally identical) and, on input, shows a notice when `sanitizeId(raw) !== raw`: "Spaces and special characters will be replaced with underscores → `<sanitized>`".

**Templates (Req 4.3, 4.4)** — the `init` payload gains `templates: {id,label,systemPrompt}[]` sourced from `PREDEFINED_CONTEXTS`. The new-context form gains a `<select id="newCtxTemplate">` populated from `templates`. On `change`, the webview sets `newCtxSystem.value = template.systemPrompt`.

**Naming help + system-prompt purpose help (Req 4.1, 8.2)** — static `.hint` elements: one under the name input describing allowed characters, one near the system-prompt textarea explaining that the system prompt is injected at the top of every request for that context.

**Duplicate-name handling (Req 4.5)** — the webview's create handler already checks `knownIds`/`predefinedIds` and shows `#newCtxError` without posting `newContext`. The design keeps this and additionally guarantees the entered values in `#newCtxId` and `#newCtxSystem` are **not cleared** when the duplicate is detected (Property 10).

**Active-context distinction (Req 3.4, 3.5)** — `activeName` shows the active label/id (Req 3.4). In the selector, exactly the active option is `selected` and carries the `*` marker (Req 3.5). This is current behavior, pinned by Property 6.

### 5. Chat_View context indicators (Req 3.1-3.3)

Current code already:
- sets `contextBadge.textContent = '📌 ' + label` on `activeContext` (Req 3.1, 3.2);
- sets `contextSelector.value = id` on `activeContext` (Req 3.3).

The design keeps these mappings and pins them with Property 5. The host re-sends `activeContext` on visibility change and on `onActiveContextChanged`, so the badge and selector stay consistent when the context switches from the editor.

### 6. Chat_View streaming status (Req 5.1-5.6)

Introduce a `Streaming_Status_Indicator` element (`#streaming-status`) and a small client-side state machine. States: `idle`, `sending`, `receiving`, `completed`, `failed`.

Transitions (driven by messages already flowing to the webview):

| Event | New state | Send control |
| --- | --- | --- |
| user submits prompt | `sending` | disabled |
| first `progress`/`stream` chunk | `receiving` | disabled |
| `complete` | `completed` | enabled |
| `error` | `failed` | enabled |

The state machine is expressed as a pure reducer so it is unit/property testable:

```typescript
// Mirrored in the webview script; also extractable as a pure function for tests.
type StreamState = 'idle' | 'sending' | 'receiving' | 'completed' | 'failed';
type StreamEvent = 'submit' | 'progress' | 'complete' | 'error';

function nextStreamState(state: StreamState, event: StreamEvent): StreamState {
    switch (event) {
        case 'submit':   return 'sending';
        case 'progress': return (state === 'sending' || state === 'receiving') ? 'receiving' : state;
        case 'complete': return 'completed';
        case 'error':    return 'failed';
    }
}

function sendEnabled(state: StreamState): boolean {
    return state === 'completed' || state === 'failed' || state === 'idle';
}
```

`setProcessing`/status rendering derive the button's `disabled` from `sendEnabled(state)` and update the indicator label/class from `state`. The existing `setProcessing(true/false)` behavior is preserved; the indicator is layered on top.

Note: today the host forwards streaming `progress` events to the *reasoning* panel and only posts `complete`/`error` to the chat webview. To keep a `receiving` state visible (Req 5.2), the host will also post a lightweight `{ type: 'streamingState', state: 'receiving' }` message when it forwards progress chunks (no chat content is added — the reasoning routing is unchanged). `submit` is derived in the webview on send; `complete`/`error` map to `completed`/`failed`.

### 7. Actionable streaming/server errors (Req 7.1-7.4)

Add a pure formatter in `streaming.ts` and use it wherever an `error` `StreamingResponse` is produced, so the chat webview receives an actionable, human-readable message.

```typescript
export type StreamErrorKind = 'spawn-failure' | 'timeout' | 'server-status' | 'fetch-failure';

export interface StreamErrorContext {
    shaiCommand?: string;
    serverUrl?: string;
    status?: number;
}

export function describeStreamingError(kind: StreamErrorKind, ctx: StreamErrorContext): string {
    switch (kind) {
        case 'spawn-failure':
            return `Could not start shai. Check that the configured shai command "${ctx.shaiCommand ?? 'shai'}" is installed and on your PATH.`;
        case 'timeout':
            return `The request timed out. Try again; if it keeps timing out, the model or server may be busy.`;
        case 'server-status':
            return `The server returned an error (HTTP ${ctx.status ?? '?'}). Check the configured server URL "${ctx.serverUrl ?? ''}".`;
        case 'fetch-failure':
            return `Could not reach the server. Check that it is running and that the configured server URL "${ctx.serverUrl ?? ''}" is correct.`;
    }
}
```

Wiring in `StreamingChatSession.executeCommandWithStreaming` / `callServer`:
- `child.on('error', ...)` → `describeStreamingError('spawn-failure', { shaiCommand })` (Req 7.1).
- timeout branch → `describeStreamingError('timeout', {})` (Req 7.2).
- `callServer` non-OK (`!res.ok`) → `describeStreamingError('server-status', { serverUrl, status: res.status })` (Req 7.3).
- `callServer` `catch` before a response → `describeStreamingError('fetch-failure', { serverUrl })` (Req 7.4).

These strings are emitted as the `data` of the `error` `StreamingResponse`, which the chat webview then displays (and, per Req 5.4, sets the indicator to `failed`).

## Data Models

No persisted data model changes.

- `EnvField` gains optional `help`/`example` (in-memory schema only).
- `MODEL_HELP: Record<string,string>` — new static map, no persistence.
- Context editor `init` message gains `templates: {id,label,systemPrompt}[]` (derived from `PREDEFINED_CONTEXTS`, not stored).
- Chat webview gains an in-memory `StreamState`; not persisted.
- Auth config (`auth.config`) format is unchanged; contexts in `globalState` are unchanged.

## Error Handling

- **Validation errors (Auth_Wizard):** `validateNewProvider` returns a non-null, field-named string; the host posts `{ type: 'error', message }`; the webview shows it and retains form values (does not clear).
- **Streaming/server errors:** normalized through `describeStreamingError`; raw error text is no longer surfaced verbatim to the user. The reasoning panel may still receive raw diagnostics (unchanged), but the chat bubble shows the actionable message.
- **Unknown provider / invalid index:** existing guards (`'Unknown provider.'`, `'Invalid profile index.'`) are unchanged.
- **Duplicate context name:** handled entirely in the webview (no host round-trip); shows `#newCtxError` and retains input.
- **Missing metadata:** `getModelHelp` and the placeholder rule fall back gracefully (`??`), so a provider or field without metadata still renders without throwing.

## Testing Strategy

Tests use **Mocha + fast-check** (and `jsdom` for DOM-level checks), matching the existing `src/auth/authWizardPanel.*.test.ts` suite.

**Approach for non-exported webview logic (mirror, not import):** the inline webview scripts in `authWizardPanel.ts`, `chatView.ts`, and `media/contextEditor.js` cannot be imported. Following the established convention, tests either (a) exercise the exported pure functions directly (`validateNewProvider`, `describeRequiredFieldError`, `getModelHelp`, `sanitizeContextId`, `describeStreamingError`, `nextStreamState`/`sendEnabled`), or (b) run a faithful **mirror** of the render/handler logic against a jsdom document. Mirrors must be kept in sync with production and are annotated as such.

**Unit tests** cover specific examples and edge cases:
- ovhcloud model help mentions custom-or-list (Req 2.2).
- Presence of the expandable credential help block in wizard HTML (Req 8.1).
- Presence of naming help and system-prompt purpose help in editor HTML (Req 4.1, 8.2).
- `describeStreamingError('timeout')` mentions timed out and retry (Req 7.2).
- A sanitization preview notice appears when the raw name contains disallowed characters (Req 4.2, example half).

**Property tests** (minimum 100 iterations each, tagged `Feature: user-friendliness-improvements, Property N: ...`) cover the universal properties below.

**Not property-tested (SMOKE / manual):** the type extension itself (1.1), English-only help text (8.3), and the "no new files/onboarding view" structural constraint (8.4).

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Every provider field has help text

For all providers in `PROVIDER_ENV_FIELDS` and for all env fields of that provider, the field's `help` value is defined and is a non-empty string.

**Validates: Requirements 1.2**

### Property 2: API-key and base-URL fields have an example

For all providers in `PROVIDER_ENV_FIELDS` and for all env fields whose `key` ends with `_API_KEY` or `_BASE_URL`, the field's `example` value is defined and is a non-empty string.

**Validates: Requirements 1.3**

### Property 3: Example is rendered as the input placeholder

For any provider, after rendering its env inputs, every field that defines an `example` produces an input whose `placeholder` attribute equals that `example` value (even when the field also defines a legacy `placeholder`).

**Validates: Requirements 1.4, 1.6**

### Property 4: Help is rendered and associated with its input

For any provider, after rendering its env inputs, every field that defines a `help` value produces an inline help element containing that text, and the corresponding input references it via `aria-describedby`.

**Validates: Requirements 1.5**

### Property 5: Model help is defined and rendered for every provider

For any provider, `getModelHelp(providerId)` returns a non-empty string, and after rendering the model controls for that provider the model-help element displays exactly that string.

**Validates: Requirements 2.1**

### Property 6: Chat indicators reflect the active context

For any sequence of `activeContext` messages, after the last message the Context_Badge text contains the last context's label and the Context_Selector's selected value equals the last context's id.

**Validates: Requirements 3.1, 3.2, 3.3**

### Property 7: Context editor marks exactly the active context

For any set of context ids with a designated active id, after the editor renders its selector exactly one option is selected — the active one — and only that option carries the active marker, and the active name element shows the active id (or its label).

**Validates: Requirements 3.4, 3.5**

### Property 8: Every predefined context is offered as a template

For all predefined contexts in `PREDEFINED_CONTEXTS`, the new-context template selector renders a selectable option for that context.

**Validates: Requirements 4.3**

### Property 9: Selecting a template populates the system prompt

For any predefined context, selecting its template in the new-context form sets the new-context system-prompt field's value equal to that context's `systemPrompt`.

**Validates: Requirements 4.4**

### Property 10: Sanitization maps disallowed characters to underscore

For any input string, `sanitizeContextId` returns a string of the same length in which every position holding a letter, digit, hyphen, or underscore is preserved unchanged, and every other position is replaced with an underscore (so the output contains only characters from the set letters, digits, hyphen, underscore).

**Validates: Requirements 4.2**

### Property 11: Duplicate context names are rejected with values retained

For any existing set of context ids and any raw name whose sanitized form already exists in that set, attempting to create the context shows the duplicate-name error, retains the entered name and system-prompt values, and posts no `newContext` message.

**Validates: Requirements 4.5**

### Property 12: Streaming state machine and send-control invariant

For any sequence of streaming events (`submit`, `progress`, `complete`, `error`), the resulting indicator state matches the transition rules (`submit`→sending, `progress`→receiving while in sending/receiving, `complete`→completed, `error`→failed), and the send control is disabled exactly when the state is `sending` or `receiving` and enabled exactly when the state is `idle`, `completed`, or `failed`.

**Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6**

### Property 13: Required-field validation names the empty field

For any provider and any env-var map in which at least one required (non-optional) field is empty or whitespace, `validateNewProvider` returns a non-null message that includes the label of an empty required field.

**Validates: Requirements 6.1**

### Property 14: Empty model is rejected with a model message

For any provider and any model string consisting only of whitespace, `validateNewProvider` returns a non-null message that mentions the model.

**Validates: Requirements 6.2**

### Property 15: Validation errors retain the entered form values

For any populated wizard form, dispatching an `error` message leaves every env input value and the model value unchanged (the form is not cleared).

**Validates: Requirements 6.3**

### Property 16: Spawn-failure messages name the shai command

For any configured shai command string, `describeStreamingError('spawn-failure', { shaiCommand })` returns a message that contains that command string and indicates that shai could not be started.

**Validates: Requirements 7.1**

### Property 17: Server error messages name the server URL

For any configured server URL string, `describeStreamingError('server-status', { serverUrl, status })` and `describeStreamingError('fetch-failure', { serverUrl })` each return a message that contains that server URL, indicating a server error and an unreachable server respectively.

**Validates: Requirements 7.3, 7.4**
