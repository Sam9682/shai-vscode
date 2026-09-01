# Requirements Document

## Introduction

This feature improves the user-friendliness of the shai-vscode VS Code extension across six areas: the authentication (provider) wizard, context management, the chat interface, error handling, inline help, and configuration entry. The improvements are inline and incremental: they extend existing data structures (for example the `EnvField` metadata in `authConfig.ts` and `PREDEFINED_CONTEXTS` in `contextManager.ts`) and enrich existing webviews (`authWizardPanel.ts`, `contextEditorPanel.ts`, `chatView.ts`) rather than introducing new panels, provider logic, guided assistants, separate onboarding views, or external documentation files. No new AI providers are added and no provider connection logic is changed.

## Glossary

- **Extension**: The shai-vscode VS Code extension as a whole.
- **Auth_Wizard**: The provider configuration webview implemented in `src/auth/authWizardPanel.ts` (titled "Shai configuration").
- **Env_Field**: An entry in `PROVIDER_ENV_FIELDS` in `src/auth/authConfig.ts` describing one environment variable input for a provider, defined by the `EnvField` type.
- **Provider**: One of the supported AI providers: `anthropic`, `openai`, `mistral`, `openrouter`, `ollama`, `ovhcloud`, `openai_compatible`.
- **Provider_Validator**: The `validateNewProvider` function in `src/auth/authConfig.ts` that checks required fields before a profile is saved.
- **Context_Editor**: The context management webview implemented in `src/views/contextEditorPanel.ts` (titled "Shai — Context editor").
- **Predefined_Context**: An entry in `PREDEFINED_CONTEXTS` in `src/context/contextManager.ts`, each with an `id`, `label`, and `systemPrompt`.
- **Chat_View**: The chat interface webview implemented in `src/views/chatView.ts`.
- **Context_Badge**: The active-context indicator element (`#active-context`) shown in the Chat_View.
- **Context_Selector**: The active-context dropdown element (`#context-selector`) shown in the Chat_View.
- **Streaming_Session**: The `StreamingChatSession` class in `src/chat/streaming.ts` that runs shai and emits `StreamingResponse` events of type `progress`, `complete`, or `error`.
- **Streaming_Status_Indicator**: A visible Chat_View element that communicates the state of an in-progress request (for example: sending, receiving, completed, failed).
- **Help_Text**: Inline explanatory text rendered inside a webview (tooltip, placeholder, or expandable section) that describes a field or feature.

## Requirements

### Requirement 1: Per-field help metadata for provider fields

**User Story:** As a user configuring a provider, I want each authentication field to describe what value it expects and show a realistic example, so that I can enter correct credentials without leaving the wizard.

#### Acceptance Criteria

1. THE Extension SHALL extend the `EnvField` type in `src/auth/authConfig.ts` with an optional `help` string property and an optional `example` string property.
2. THE Extension SHALL define a `help` value for every Env_Field of every Provider in `PROVIDER_ENV_FIELDS`.
3. THE Extension SHALL define an `example` value for every Env_Field that accepts an API key or a base URL in `PROVIDER_ENV_FIELDS`.
4. WHERE an Env_Field defines an `example` value, THE Auth_Wizard SHALL render that value as the placeholder text of the corresponding input control.
5. WHERE an Env_Field defines a `help` value, THE Auth_Wizard SHALL render that value as inline Help_Text associated with the corresponding input control.
6. WHERE an Env_Field defines both a `placeholder` value and an `example` value, THE Auth_Wizard SHALL render the `example` value as the input placeholder.

### Requirement 2: Model field guidance in the Auth Wizard

**User Story:** As a user configuring a provider, I want guidance on the model field, so that I know what a valid model identifier looks like for the selected Provider.

#### Acceptance Criteria

1. WHEN a Provider is selected in the Auth_Wizard, THE Auth_Wizard SHALL display Help_Text describing the model field for the selected Provider.
2. WHERE the selected Provider is `ovhcloud`, THE Auth_Wizard SHALL display Help_Text explaining that a model can be chosen from the list or entered as a custom identifier.

### Requirement 3: Context switching visual indicators

**User Story:** As a user working with multiple contexts, I want clear visual indication of which context is active, so that I always know which system prompt is applied to my chat.

#### Acceptance Criteria

1. THE Chat_View SHALL display the label of the active context in the Context_Badge.
2. WHEN the active context changes, THE Chat_View SHALL update the Context_Badge to show the label of the newly active context.
3. WHEN the active context changes, THE Chat_View SHALL update the Context_Selector to show the newly active context as its selected option.
4. THE Context_Editor SHALL display the identifier of the active context.
5. WHEN a context is selected in the Context_Editor, THE Context_Editor SHALL visually distinguish the active context from the other listed contexts.

### Requirement 4: Intuitive context creation

**User Story:** As a user creating a new context, I want naming guidance and reusable system prompt templates, so that I can set up a useful context quickly.

#### Acceptance Criteria

1. THE Context_Editor SHALL display Help_Text describing the naming rules for a new context identifier.
2. WHEN a user enters a new context name containing characters outside the set of letters, digits, hyphen, and underscore, THE Context_Editor SHALL indicate that those characters are replaced with underscores before the context is created.
3. THE Context_Editor SHALL offer the system prompts of the Predefined_Contexts as selectable templates when creating a new context.
4. WHEN a user selects a system prompt template during context creation, THE Context_Editor SHALL populate the new-context system prompt field with the selected template text.
5. IF a user attempts to create a context whose identifier matches an existing context identifier, THEN THE Context_Editor SHALL display a message stating that the name already exists and SHALL retain the entered values.

### Requirement 5: Streaming visual feedback in the chat

**User Story:** As a user who has sent a chat message, I want visible feedback while the response is being generated, so that I know the Extension is working and can tell when it is finished.

#### Acceptance Criteria

1. WHEN a chat message is submitted, THE Chat_View SHALL display the Streaming_Status_Indicator in a sending state.
2. WHILE the Streaming_Session emits `progress` events for the current request, THE Chat_View SHALL display the Streaming_Status_Indicator in a receiving state.
3. WHEN the Streaming_Session emits a `complete` event for the current request, THE Chat_View SHALL display the Streaming_Status_Indicator in a completed state.
4. IF the Streaming_Session emits an `error` event for the current request, THEN THE Chat_View SHALL display the Streaming_Status_Indicator in a failed state.
5. WHILE a request is in progress, THE Chat_View SHALL disable the send control.
6. WHEN a request reaches a completed or failed state, THE Chat_View SHALL enable the send control.

### Requirement 6: Actionable authentication error messages

**User Story:** As a user configuring a provider, I want validation errors that tell me exactly which field to fix and how, so that I can correct my input without guessing.

#### Acceptance Criteria

1. WHEN the Provider_Validator rejects a save because a required Env_Field is empty, THE Auth_Wizard SHALL display a message that names the field and states the action needed to fix it.
2. WHEN the Provider_Validator rejects a save because the model name is empty, THE Auth_Wizard SHALL display a message that states a model name is required and describes the expected value.
3. WHEN the Auth_Wizard displays a validation error, THE Auth_Wizard SHALL retain the values already entered in the profile form.

### Requirement 7: Actionable streaming and server error messages

**User Story:** As a user waiting on a chat response that fails, I want a clear explanation of what went wrong and what to try, so that I can recover without reading raw error output.

#### Acceptance Criteria

1. IF the Streaming_Session fails to start the shai process, THEN THE Chat_View SHALL display a message stating that shai could not be started and identifying the configured shai command as the item to check.
2. IF the current request exceeds the Streaming_Session timeout, THEN THE Chat_View SHALL display a message stating that the request timed out and suggesting the user retry.
3. IF a server-mode request returns a non-success HTTP status, THEN THE Chat_View SHALL display a message stating that the server returned an error and identifying the configured server URL as the item to check.
4. IF a server-mode request fails before a response is received, THEN THE Chat_View SHALL display a message stating that the Extension could not reach the server and identifying the configured server URL as the item to check.

### Requirement 8: Inline help in webviews

**User Story:** As a user, I want inline help available where I make configuration decisions, so that I can understand each control without opening external documentation.

#### Acceptance Criteria

1. THE Auth_Wizard SHALL provide an expandable Help_Text section describing how to obtain provider credentials.
2. THE Context_Editor SHALL provide Help_Text describing the purpose of the system prompt.
3. THE Extension SHALL render all Help_Text in English.
4. THE Extension SHALL implement all Help_Text as inline webview content and SHALL NOT create separate documentation files or a separate onboarding view for this feature.
