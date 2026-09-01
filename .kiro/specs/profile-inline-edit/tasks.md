# Implementation Plan: profile-inline-edit

## Overview

Implement inline viewing and editing of existing provider profiles in the "Shai configuration" webview. The work spans three localized areas that build on each other: a new `updateProviderAt` mutation in the config backend, a new `updateExisting` message branch in the host handler, and mode-aware webview script changes (per-row Edit control, `editingIndex` state, prefill routine, mode-aware button label and submit dispatch, reset to Create_Mode after save).

Language: TypeScript (matches the existing codebase). No test framework is currently configured, so the first task establishes one (a runner plus `fast-check` for property-based tests and `jsdom` for exercising the webview pure helpers). Tasks are ordered so that backend logic and its tests land before the host branch, which lands before the webview wiring.

## Tasks

- [x] 1. Establish test tooling for backend and webview helpers
  - [x] 1.1 Add test runner and dependencies, wire up the `test` script
    - Add a test runner and dependencies (`fast-check` for property-based tests, `jsdom` for DOM-based webview helper tests) as devDependencies
    - Add a `test` script to `package.json` and a minimal config so TypeScript test files can run
    - Verify the harness runs with a trivial passing test
    - _Requirements: 4.3, 4.5_

- [x] 2. Implement `updateProviderAt` in the config backend
  - [x] 2.1 Add `updateProviderAt(config, index, providerId, envVars, model)` to `src/auth/authConfig.ts`
    - Perform the integer/bounds check on `index` before any mutation; return `'Invalid profile index.'` when out of range
    - Trim `providerId` and `model`, then call `validateNewProvider(provider, envVars, model)` before writing; return its error string on failure
    - On success, write `{ provider, env_vars: { ...envVars }, model }` into `config.providers[index]`, preserving the existing entry's `tool_method`
    - Leave `config.selected_provider` unchanged; return `null` on success
    - _Requirements: 2.8, 4.3, 4.4, 4.5, 4.7, 5.1_

  - [x]* 2.2 Write property test for valid update behavior
    - **Feature: profile-inline-edit, Property 9: A valid update replaces only the target entry and preserves invariants**
    - Assert `providers.length` unchanged, target entry holds submitted provider/env/model, original `tool_method` preserved, `selected_provider` unchanged (min 100 iterations)
    - **Validates: Requirements 2.8, 4.5, 5.1, 5.4, 4.8**

  - [x]* 2.3 Write property test for invalid update rejection
    - **Feature: profile-inline-edit, Property 10: An invalid update is rejected without mutation**
    - For updates whose provider/env/model fail `validateNewProvider`, assert the validation error is returned and the whole config is unchanged (min 100 iterations)
    - **Validates: Requirements 4.3, 4.4**

  - [x]* 2.4 Write property test for out-of-range index rejection
    - **Feature: profile-inline-edit, Property 11: An out-of-range index is rejected without mutation**
    - For any index outside `0..providers.length-1` (including non-integers/negatives), assert an error is returned and the config is unchanged (min 100 iterations)
    - **Validates: Requirements 4.7**

  - [x]* 2.5 Write property test for Create_Mode append (regression guard)
    - **Feature: profile-inline-edit, Property 13: Create_Mode appends a new profile**
    - For a valid new profile via the existing create path, assert `providers.length` increases by one and the appended entry matches the submitted values (min 100 iterations)
    - **Validates: Requirements 5.3**

- [x] 3. Checkpoint - backend logic
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Add the `updateExisting` host message branch
  - [x] 4.1 Implement the `updateExisting` branch in `openAuthWizard.onDidReceiveMessage` in `src/auth/authWizardPanel.ts`
    - Guard: if `index` is not a number or is negative, post `{ type: 'error', message: 'Invalid selection.' }` and return
    - Trim `provider`/`model`, default `env_vars` to `{}`, call `loadAuthConfig()` then `updateProviderAt(cfg, idx, provider, envVars, model)`
    - On error, post `{ type: 'error', message: err }` and return; on success, call `saveAuthConfig(cfg)` (0600) then post `{ type: 'saved', config: cfg, clearNew: true }`
    - Show the confirmation information message; leave the `saveNew`/`saveExisting`/`deleteProfile` branches untouched
    - _Requirements: 4.2, 4.5, 4.6, 4.8, 5.1_

  - [x]* 4.2 Write integration test for 0600 persistence after update
    - On a POSIX runner, apply an update through `updateProviderAt` + `saveAuthConfig` and assert the auth config file mode is `0600` (1 example)
    - _Requirements: 4.6_

- [x] 5. Add webview Edit control and edit state
  - [x] 5.1 Render a per-row Edit control and extend the delegated click handler in `getWizardHtml`
    - In `renderExisting`, add an `Edit` button (with `dataset.index`) next to the existing radio and Delete controls for each profile row
    - Extend the `existingList` click listener to match `.btn-edit` and call `enterEditMode(idx)`; keep radio activation and Delete as separate controls
    - Add module-level `let editingIndex = null;` and an `isEditing()` helper
    - _Requirements: 1.1, 5.2_

  - [x]* 5.2 Write property test for per-profile edit control rendering
    - **Feature: profile-inline-edit, Property 1: Edit action rendered per profile**
    - Render the list against generated configs (jsdom) and assert exactly one edit control per profile, each carrying its own index (min 100 iterations)
    - **Validates: Requirements 1.1**

- [x] 6. Implement Edit_Mode entry and prefill
  - [x] 6.1 Implement `enterEditMode(idx)` and `prefillForm(profile)` in `getWizardHtml`
    - `enterEditMode(idx)`: set `editingIndex = idx`, reveal `#newProfileBody`, call `prefillForm(state.config.providers[idx])`, then `updatePrimaryButton()`
    - `prefillForm`: set `newProvider.value`, call `renderEnvInputs(provider)` and populate each `#env_<key>` from `profile.env_vars[key]` (including secret fields), call `renderModelControls(provider)` and set the model control
    - OVH handling: preselect matching `OVHCLOUD_MODEL_OPTIONS` entry, else select `OVH_CUSTOM`, set `modelOvhCustom.value`, and call `syncOvhCustom()`
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.5, 2.6, 2.7, 3.1, 3.2_

  - [x]* 6.2 Write property test for Edit_Mode prefill fidelity
    - **Feature: profile-inline-edit, Property 2: Edit_Mode prefill mirrors the stored profile**
    - Assert stored index, provider value, exact env inputs for the schema, each env value populated, and effective model value equal the profile (min 100 iterations)
    - **Validates: Requirements 1.3, 1.4, 1.5, 1.6, 1.7, 3.1**

  - [x]* 6.3 Write property test for OVHcloud model dropdown options
    - **Feature: profile-inline-edit, Property 4: OVHcloud model dropdown options**
    - Assert the dropdown option values equal `OVHCLOUD_MODEL_OPTIONS` followed by a single "Other…" option (min 100 iterations)
    - **Validates: Requirements 2.5**

  - [x]* 6.4 Write property test for OVHcloud model prefill round-trip
    - **Feature: profile-inline-edit, Property 5: OVHcloud model prefill round-trips**
    - For OVH profiles, assert preset preselection vs custom-input fallback and that the read-back model equals the original (min 100 iterations)
    - **Validates: Requirements 2.6, 2.7**

  - [x]* 6.5 Write property test for masked secret fields
    - **Feature: profile-inline-edit, Property 6: Secret fields are masked**
    - Assert every `secret: true` Env_Field renders as a password input in Edit_Mode (min 100 iterations)
    - **Validates: Requirements 3.2**

- [x] 7. Checkpoint - webview prefill
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement mode-aware button label and submit dispatch
  - [x] 8.1 Implement `updatePrimaryButton()` and mode-aware submit in the `btnNew` handler
    - `updatePrimaryButton()`: set `btnNew.textContent` to "Update profile" in Edit_Mode and the create label in Create_Mode
    - Branch the `btnNew` click handler on `isEditing()`: Edit_Mode posts `{ type: 'updateExisting', index: editingIndex, provider, env_vars: collectEnvVars(...), model: getModelValue() }`; Create_Mode keeps the existing `saveNew` path
    - Ensure provider `change` in Edit_Mode re-renders env inputs and model controls via the existing handler
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 4.1, 4.2, 5.3, 5.4_

  - [x]* 8.2 Write property test for env value collection (edits vs preserved)
    - **Feature: profile-inline-edit, Property 7: Collected env values reflect edits or preserved originals**
    - Assert collected values equal new entries where overwritten and original stored values where unchanged (min 100 iterations)
    - **Validates: Requirements 3.3, 3.4**

  - [x]* 8.3 Write property test for rendered env inputs matching provider
    - **Feature: profile-inline-edit, Property 3: Rendered env inputs always match the selected provider**
    - Assert the rendered env input keys equal exactly the `PROVIDER_ENV_FIELDS` schema keys, including after a provider change (min 100 iterations)
    - **Validates: Requirements 2.4**

  - [x]* 8.4 Write property test for Update_Message assembly
    - **Feature: profile-inline-edit, Property 8: Update_Message assembly**
    - Assert the emitted message's `index` equals `editingIndex` and its provider/env_vars/model equal the form's current values (min 100 iterations)
    - **Validates: Requirements 4.2**

- [x] 9. Wire reset to Create_Mode after a persisted update
  - [x] 9.1 Reset the form to Create_Mode on the `saved` reply in `getWizardHtml`
    - Extend `clearNewForm()` (or the `saved`/`clearNew` handler) to set `editingIndex = null` and call `updatePrimaryButton()`
    - Ensure `renderExisting` runs on every `saved` reply so the edited row reflects the updated provider and model
    - _Requirements: 4.8, 5.5_

  - [x]* 9.2 Write property test for refreshed list reflecting updates
    - **Feature: profile-inline-edit, Property 12: Refreshed list reflects updated values**
    - After a valid update, assert the target row's provider and model text equal the submitted values (min 100 iterations)
    - **Validates: Requirements 4.8**

  - [x]* 9.3 Write example tests for mode transitions
    - Assert entering Edit_Mode sets the mode/label and stored index, and that the form returns to Create_Mode (label + `editingIndex = null`) after a `saved` reply (example tests)
    - _Requirements: 1.2, 4.1, 5.5_

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP.
- Each task references specific requirements for traceability.
- Checkpoints ensure incremental validation at backend, prefill, and integration boundaries.
- Property tests validate the universal correctness properties from the design (min 100 iterations each, tagged with their property number); example and integration tests cover single state transitions and the `0600` permission side effect.
- Editability (Req 2.1, 2.2, 2.3) needs no dedicated implementation: the reused inputs are never disabled; the mode-aware submit task references these requirements to confirm the behavior.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "4.1"] },
    { "id": 3, "tasks": ["4.2", "5.1"] },
    { "id": 4, "tasks": ["5.2", "6.1"] },
    { "id": 5, "tasks": ["6.2", "6.3", "6.4", "6.5", "8.1"] },
    { "id": 6, "tasks": ["8.2", "8.3", "8.4", "9.1"] },
    { "id": 7, "tasks": ["9.2", "9.3"] }
  ]
}
```
