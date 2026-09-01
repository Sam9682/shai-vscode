# Requirements Document

## Introduction

The "Shai configuration" panel (a VS Code webview implemented in `src/auth/authWizardPanel.ts`) currently lets a user list existing provider profiles, activate one via a radio selection, delete profiles, and create a brand-new profile through an inline form. There is no way to view or modify the stored values of an existing profile; the create form is the only editing surface and it always produces a new entry.

This feature adds inline viewing and editing of existing profiles. When a user chooses to edit a profile (for example, "ovhcloud — Qwen3-Coder-30B-A3B-Instruct"), the existing new-profile form is reused in an "edit mode": pre-filled with that profile's provider, environment variables, and model, with a Save/Update action that writes the changes back into the same profile entry (`cfg.providers[idx]`) rather than appending a new one. The activation (radio select) behavior stays independent from editing. Persistence continues to use the existing config store at `~/.config/shai/auth.config` with `0600` permissions.

## Glossary

- **Configuration_Panel**: The "Shai configuration" VS Code webview rendered by `openAuthWizard` / `getWizardHtml` in `src/auth/authWizardPanel.ts`, including both its host-side message handler and its webview-side script.
- **Config_Backend**: The persistence and validation module `src/auth/authConfig.ts`, including `loadAuthConfig`, `saveAuthConfig`, and `validateNewProvider`.
- **Profile**: A single `ProviderConfig` entry (`provider`, `env_vars`, `model`, `tool_method`) stored in `ShaiAuthConfig.providers`.
- **Profile_Index**: The zero-based array position of a Profile within `ShaiAuthConfig.providers`.
- **Profile_Form**: The inline form in the Configuration_Panel (currently `#newProfileBody`) containing the provider select, environment-variable fields, and model controls.
- **Edit_Mode**: A state of the Profile_Form in which it is pre-filled with an existing Profile's values and its primary action updates that Profile.
- **Create_Mode**: The existing default state of the Profile_Form in which its primary action appends a new Profile.
- **Env_Field**: An environment-variable input defined by `PROVIDER_ENV_FIELDS` for a given provider, each with a key, label, and optional `secret`/`optional` attributes.
- **Secret_Field**: An Env_Field whose schema marks it with `secret: true`, rendered as a masked password input.
- **Active_Profile**: The Profile referenced by `ShaiAuthConfig.selected_provider`.
- **Update_Message**: The webview-to-host message that requests writing edited values back into an existing Profile.

## Requirements

### Requirement 1: Enter edit mode for an existing profile

**User Story:** As a Shai user, I want to click an existing profile and see its stored values in the same window, so that I can review the profile's configuration without creating a new one.

#### Acceptance Criteria

1. THE Configuration_Panel SHALL display an edit action for each listed Profile.
2. WHEN the user triggers the edit action for a Profile, THE Configuration_Panel SHALL open the Profile_Form in Edit_Mode.
3. WHEN the Profile_Form enters Edit_Mode for a Profile, THE Configuration_Panel SHALL store the Profile_Index of the Profile being edited.
4. WHEN the Profile_Form enters Edit_Mode, THE Configuration_Panel SHALL set the provider select to the edited Profile's `provider` value.
5. WHEN the Profile_Form enters Edit_Mode, THE Configuration_Panel SHALL render the Env_Field inputs that correspond to the edited Profile's `provider`.
6. WHEN the Profile_Form enters Edit_Mode, THE Configuration_Panel SHALL populate each rendered Env_Field with the stored value from the edited Profile's `env_vars`.
7. WHEN the Profile_Form enters Edit_Mode, THE Configuration_Panel SHALL set the model control to the edited Profile's `model` value.

### Requirement 2: Editable fields and provider-dependent rendering

**User Story:** As a Shai user, I want to change a profile's provider, credentials, and model inline, so that I can update the profile to match my current setup.

#### Acceptance Criteria

1. WHILE the Profile_Form is in Edit_Mode, THE Configuration_Panel SHALL allow the user to change the `provider` value.
2. WHILE the Profile_Form is in Edit_Mode, THE Configuration_Panel SHALL allow the user to change each rendered Env_Field value.
3. WHILE the Profile_Form is in Edit_Mode, THE Configuration_Panel SHALL allow the user to change the `model` value.
4. WHEN the user changes the provider select in Edit_Mode, THE Configuration_Panel SHALL re-render the Env_Field inputs to match the newly selected provider.
5. WHERE the selected provider is `ovhcloud`, THE Configuration_Panel SHALL present the model as a dropdown populated from `OVHCLOUD_MODEL_OPTIONS` plus an "Other…" custom option.
6. WHERE the selected provider is `ovhcloud` AND the edited Profile's `model` matches an entry in `OVHCLOUD_MODEL_OPTIONS`, THE Configuration_Panel SHALL preselect that matching model in the dropdown.
7. WHERE the selected provider is `ovhcloud` AND the edited Profile's `model` is not present in `OVHCLOUD_MODEL_OPTIONS`, THE Configuration_Panel SHALL select the "Other…" option and place the model value in the custom model input.
8. THE Configuration_Panel SHALL keep the edited Profile's `tool_method` at its stored value without exposing a `tool_method` control.

### Requirement 3: Secret field pre-fill

**User Story:** As a Shai user, I want a profile's stored secret values shown in the masked fields when editing, so that I can keep them as-is or overwrite them without retyping.

#### Acceptance Criteria

1. WHEN the Profile_Form enters Edit_Mode, THE Configuration_Panel SHALL pre-fill each Secret_Field with the corresponding stored value from the edited Profile's `env_vars`.
2. THE Configuration_Panel SHALL render each Secret_Field as a masked input in Edit_Mode.
3. WHERE the user leaves a pre-filled Secret_Field unchanged, THE Update_Message SHALL carry the original stored secret value.
4. WHERE the user overwrites a Secret_Field, THE Update_Message SHALL carry the newly entered value.

### Requirement 4: Persisting updates to the existing profile

**User Story:** As a Shai user, I want my edits saved back into the same profile, so that the profile list reflects my changes instead of gaining a duplicate entry.

#### Acceptance Criteria

1. THE Configuration_Panel SHALL provide a primary action labeled for updating while the Profile_Form is in Edit_Mode.
2. WHEN the user triggers the update action, THE Configuration_Panel SHALL send an Update_Message containing the edited Profile_Index, provider, environment variables, and model.
3. WHEN the Config_Backend receives an Update_Message, THE Config_Backend SHALL validate the submitted provider, environment variables, and model using `validateNewProvider`.
4. IF `validateNewProvider` returns a validation error for an Update_Message, THEN THE Configuration_Panel SHALL display the returned error message and SHALL leave the stored Profile unchanged.
5. WHEN an Update_Message passes validation, THE Config_Backend SHALL write the submitted provider, environment variables, and model into `cfg.providers[Profile_Index]`.
6. WHEN the Config_Backend writes an updated Profile, THE Config_Backend SHALL persist the configuration to the auth config file with `0600` permissions.
7. IF the Update_Message carries a Profile_Index that is not a valid position in `cfg.providers`, THEN THE Config_Backend SHALL return an error message and SHALL leave the stored configuration unchanged.
8. WHEN an update is persisted, THE Configuration_Panel SHALL refresh the displayed Profile list to reflect the updated Profile values.

### Requirement 5: Separation of edit from activation and creation

**User Story:** As a Shai user, I want editing to be distinct from activating and from creating, so that I can update a profile without accidentally changing which profile is active or adding a new one.

#### Acceptance Criteria

1. WHEN the user triggers the update action in Edit_Mode, THE Config_Backend SHALL leave `selected_provider` unchanged.
2. THE Configuration_Panel SHALL retain the radio-based activation action as a separate control from the edit action.
3. WHEN the Profile_Form is in Create_Mode, THE Configuration_Panel SHALL append a new Profile on the primary action.
4. WHEN the Profile_Form is in Edit_Mode, THE Configuration_Panel SHALL update the existing Profile on the primary action rather than appending a new Profile.
5. WHEN an update is persisted, THE Configuration_Panel SHALL return the Profile_Form to Create_Mode.
