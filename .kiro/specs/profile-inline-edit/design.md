# Design Document

## Overview

This feature adds inline viewing and editing of existing provider profiles to the "Shai configuration" webview (`src/auth/authWizardPanel.ts`). Today the panel can list profiles, activate one via a radio, delete profiles, and create a brand-new profile through the inline `#newProfileBody` form. Editing an existing profile is not possible.

The design reuses the existing new-profile form (`Profile_Form`) and gives it two modes:

- **Create_Mode** (existing behavior): the primary action appends a new profile and activates it (`saveNew`).
- **Edit_Mode** (new): the form is pre-filled from an existing profile, the primary action label changes to an update label, and the action writes edited values back into `cfg.providers[idx]` via a new `updateExisting` message.

The change is intentionally small and localized:

- Webview side (`getWizardHtml`): a per-row **Edit** control, an `editingIndex` state variable, a prefill routine, mode-aware button labeling, mode-aware submit dispatch, and reset to Create_Mode after a successful update.
- Host side (`onDidReceiveMessage`): a new `updateExisting` handler.
- Config backend (`src/auth/authConfig.ts`): a new `updateProviderAt(cfg, index, provider, envVars, model)` mutation that validates with `validateNewProvider`, writes into the target index preserving `tool_method` and `selected_provider`, and returns an error string (or `null`) exactly like `removeProviderAt`.

Activation (radio) and creation remain untouched and independent from editing.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Configuration_Panel (webview)  — getWizardHtml script          │
│                                                                │
│  Profile list ── per row: [radio activate] [Edit] [Delete]     │
│                                    │                           │
│                                    ▼  enterEditMode(i)          │
│  Profile_Form (#newProfileBody)                                │
│    state: mode = 'create' | 'edit', editingIndex: number|null  │
│    prefillForm(profile)  → provider / env inputs / model       │
│    primary button label depends on mode                        │
│    submit ─┬─ create → postMessage {saveNew,...}               │
│            └─ edit   → postMessage {updateExisting, index,...}  │
└───────────────────────────┬────────────────────────────────────┘
                            │ webview → host messages
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ Host message handler (openAuthWizard.onDidReceiveMessage)      │
│   getInit / saveExisting / deleteProfile / saveNew (existing)  │
│   updateExisting (NEW):                                        │
│     cfg = loadAuthConfig()                                     │
│     err = updateProviderAt(cfg, index, provider, env, model)   │
│     if err → postMessage {error}                               │
│     else   → saveAuthConfig(cfg); postMessage {saved,...}      │
└───────────────────────────┬────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ Config_Backend (src/auth/authConfig.ts)                        │
│   loadAuthConfig / saveAuthConfig (0600) (existing)            │
│   validateNewProvider (existing, reused)                       │
│   updateProviderAt (NEW): validate → write into providers[idx] │
│                            preserve tool_method + selected_prov │
└──────────────────────────────────────────────────────────────┘
```

### Message flow (edit → persist → refresh)

1. User clicks **Edit** on row `i`. Webview calls `enterEditMode(i)`: sets `editingIndex = i`, `mode = 'edit'`, opens `#newProfileBody`, calls `prefillForm(cfg.providers[i])`, and relabels the primary button.
2. User adjusts fields and clicks the primary (now "Update profile") button. Webview posts `{ type: 'updateExisting', index, provider, env_vars, model }`.
3. Host loads config, calls `updateProviderAt`. On error → `{ type: 'error', message }`. On success → `saveAuthConfig(cfg)` then `{ type: 'saved', config: cfg, clearNew: true }`.
4. Webview receives `saved`, re-renders the profile list (reflecting the edited row), and resets the form to Create_Mode (`clearNew: true`).

## Components and Interfaces

### Config_Backend: `updateProviderAt` (new)

Mirrors the shape and error-return convention of the existing `removeProviderAt`. It performs validation (reusing `validateNewProvider`), writes into the target index, and preserves both the existing `tool_method` of that entry and the global `selected_provider`.

```typescript
/**
 * Write edited values into an existing provider entry.
 * Validation mirrors saveNew (validateNewProvider). The entry's tool_method
 * and the config's selected_provider are preserved. Returns an error string
 * on failure (config left untouched), or null on success.
 */
export function updateProviderAt(
    config: ShaiAuthConfig,
    index: number,
    providerId: string,
    envVars: Record<string, string>,
    model: string
): string | null {
    if (!Number.isInteger(index) || index < 0 || index >= config.providers.length) {
        return 'Invalid profile index.';
    }
    const provider = (providerId || '').trim();
    const m = (model || '').trim();
    const err = validateNewProvider(provider, envVars, m);
    if (err) {
        return err;
    }
    const existing = config.providers[index];
    config.providers[index] = {
        provider,
        env_vars: { ...envVars },
        model: m,
        tool_method: existing.tool_method, // preserved; no UI control (Req 2.8)
    };
    // selected_provider intentionally left unchanged (Req 5.1)
    return null;
}
```

Design notes:

- The invalid-index check runs **before** any mutation, so an out-of-range index leaves the config unchanged (Req 4.7).
- Validation runs **before** the write, so a validation failure leaves the target entry unchanged (Req 4.4).
- `tool_method` is copied from the current entry rather than defaulted, so an entry that used a non-default method keeps it (Req 2.8).
- `selected_provider` is never assigned here (Req 5.1), which distinguishes update from both `saveNew` (which sets it to the new entry) and `saveExisting` (which sets activation).

### Host handler: `updateExisting` (new branch in `onDidReceiveMessage`)

Added alongside the existing branches. The incoming message type is extended to carry an `index` for updates (the handler signature already includes `index`, `provider`, `env_vars`, `model`).

```typescript
if (msg.type === 'updateExisting') {
    const idx = msg.index;
    if (typeof idx !== 'number' || idx < 0) {
        panel.webview.postMessage({ type: 'error', message: 'Invalid selection.' });
        return;
    }
    const providerId = (msg.provider || '').trim();
    const model = (msg.model || '').trim();
    const envVars = msg.env_vars || {};
    const cfg = loadAuthConfig();
    const err = updateProviderAt(cfg, idx, providerId, envVars, model);
    if (err) {
        panel.webview.postMessage({ type: 'error', message: err });
        return;
    }
    saveAuthConfig(cfg);
    panel.webview.postMessage({ type: 'saved', config: cfg, clearNew: true });
    vscode.window.showInformationMessage(`Profile updated: ${providerId} / ${model}`);
    return;
}
```

The reply reuses the existing `saved` message shape. `clearNew: true` triggers the webview to reset the form to Create_Mode after a persisted update (Req 5.5), and `renderExisting` runs on every `saved` reply, so the list reflects the updated values (Req 4.8).

### Configuration_Panel (webview script) changes

New/changed pieces inside the `getWizardHtml` IIFE:

1. **Per-row Edit control** — in `renderExisting`, each profile row gets an `Edit` button (in the trailing area next to `Delete`) carrying `dataset.index`. This coexists with the existing radio and Delete controls (Req 1.1, 5.2).

2. **Edit state** — module-level `let editingIndex = null;` (Create_Mode when `null`, Edit_Mode otherwise). A small helper `isEditing()` returns `editingIndex !== null`.

3. **Delegated click handler** — the existing `existingList` click listener is extended to also match `.btn-edit` and call `enterEditMode(idx)`.

4. **`enterEditMode(idx)`**:
   - Set `editingIndex = idx`.
   - Reveal `#newProfileBody` (remove `hidden`), update toggle button.
   - Call `prefillForm(state.config.providers[idx])`.
   - Call `updatePrimaryButton()` to relabel `#btnNew` (e.g. "Update profile").

5. **`prefillForm(profile)`**:
   - Set `newProvider.value = profile.provider` (Req 1.4).
   - Call `renderEnvInputs(profile.provider)` then set each `#env_<key>` input's value from `profile.env_vars[key]` (Req 1.5, 1.6, 3.1). Secret fields are already rendered as `type=password` by `renderEnvInputs` (Req 3.2), so pre-filling them masks the stored value.
   - Call `renderModelControls(profile.provider)` then set the model control:
     - Non-OVH: `model.value = profile.model` (Req 1.7).
     - OVH: if `profile.model` is in `state.ovhcloudModels`, set `modelOvh.value = profile.model`; else set `modelOvh.value = OVH_CUSTOM` and `modelOvhCustom.value = profile.model`, then `syncOvhCustom()` (Req 2.6, 2.7).

6. **`updatePrimaryButton()`** — sets `btnNew.textContent` to "Update profile" in Edit_Mode and "Create and activate" in Create_Mode (Req 4.1).

7. **Mode-aware submit** — the `btnNew` click handler branches on `isEditing()`:
   - Edit_Mode: `postMessage({ type: 'updateExisting', index: editingIndex, provider, env_vars, model })` (Req 4.2, 5.4).
   - Create_Mode: existing `saveNew` (Req 5.3).
   - The payload uses the existing `newProvider.value`, `collectEnvVars(...)`, and `getModelValue()` helpers, so unchanged pre-filled secrets carry their original values and overwritten ones carry the new values (Req 3.3, 3.4), and OVH custom/preset selection round-trips through `getModelValue()`.

8. **Reset to Create_Mode** — the `saved` message branch already handles `clearNew`. Extend `clearNewForm()` (or the `saved` handler) to also set `editingIndex = null` and call `updatePrimaryButton()`, returning the form to Create_Mode after a persisted update (Req 5.5). The `+`/toggle interaction and provider `change` handler continue to operate on Create_Mode defaults.

Editability requirements (Req 2.1, 2.2, 2.3) require no code: the reused inputs are never disabled, so provider, env fields, and model remain editable in Edit_Mode. Changing the provider in Edit_Mode reuses the existing `newProvider` `change` handler, which re-renders env inputs and model controls for the newly selected provider (Req 2.4, 2.5).

## Data Models

No new persisted data model. The stored shapes are unchanged:

```typescript
interface ProviderConfig {
    provider: string;
    env_vars: Record<string, string>;
    model: string;
    tool_method: 'FunctionCall' | 'Auto' | 'FunctionCallRequired' | 'StructuredOutput' | 'Parsing';
}

interface ShaiAuthConfig {
    providers: ProviderConfig[];
    selected_provider: number;
    mcp_configs?: Record<string, unknown>;
}
```

Transient webview state added:

```typescript
// Create_Mode when null; Edit_Mode holds the Profile_Index under edit.
editingIndex: number | null
```

Message contract additions (webview → host):

```typescript
// Update_Message
{ type: 'updateExisting', index: number, provider: string, env_vars: Record<string,string>, model: string }
```

Host → webview replies reuse the existing `init` / `saved` / `error` messages. Update success returns `{ type: 'saved', config, clearNew: true }`.

## Error Handling

| Condition | Detection | Response | Requirement |
|-----------|-----------|----------|-------------|
| `index` missing / negative in message | Host `updateExisting` guard | `error: 'Invalid selection.'`; no mutation | 4.7 |
| `index` out of range | `updateProviderAt` bounds check (before write) | `error: 'Invalid profile index.'`; config unchanged | 4.7 |
| Empty model | `validateNewProvider` | `error: 'Please enter a model name.'`; entry unchanged | 4.3, 4.4 |
| Unknown provider | `validateNewProvider` | `error: 'Unknown provider.'`; entry unchanged | 4.3, 4.4 |
| Missing required (non-optional) env field | `validateNewProvider` | `error: 'Field <label> is required.'`; entry unchanged | 4.3, 4.4 |
| `loadAuthConfig` / JSON parse failure | try/catch in host handler | `error` with message | existing behavior |
| `chmod` unsupported (Windows) | `saveAuthConfig` swallows chmod error | persist proceeds; permissions best-effort | 4.6 |

All errors are surfaced through the existing `error` message → `showErr(...)` path in the webview. Because validation and the bounds check run before any array write, a rejected update leaves `cfg.providers` and `selected_provider` exactly as loaded.

## Testing Strategy

Two complementary layers:

- **Property-based tests** target the pure logic that varies with input: `updateProviderAt` (backend mutation/validation/invariants) and the webview pure helpers (`renderEnvInputs`, `renderModelControls`, `collectEnvVars`, `getModelValue`, prefill mapping). The webview helpers are tested by extracting/exercising them against a DOM (e.g. jsdom) or by testing their pure mapping equivalents. Each property test runs a minimum of 100 iterations and is tagged with its design property.
- **Example & integration tests** cover single state transitions and side effects: entering Edit_Mode sets the mode/label, the form resets to Create_Mode after save, control coexistence (radio + edit), and the `0600` file-permission behavior of `saveAuthConfig` on a POSIX runner (integration, 1 example).

Property test configuration:

- Minimum 100 iterations per property.
- Each property test references its design property via a tag: **Feature: profile-inline-edit, Property {number}: {property_text}**.

Generators: random `ShaiAuthConfig` with 1..N `ProviderConfig` entries whose `provider` is drawn from the known provider ids and whose `env_vars` include the schema keys for that provider (with non-empty required fields), plus a model drawn either from `OVHCLOUD_MODEL_OPTIONS` or arbitrary strings for OVH cases.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Edit action rendered per profile

*For any* configuration with a list of profiles, rendering the profile list produces exactly one edit control per profile, each carrying its own Profile_Index.

**Validates: Requirements 1.1**

### Property 2: Edit_Mode prefill mirrors the stored profile

*For any* profile in the configuration, entering Edit_Mode for that profile stores its Profile_Index, sets the provider select to the profile's `provider`, renders exactly the Env_Field inputs defined by that provider's schema, populates each rendered Env_Field (including secret fields) with the corresponding stored `env_vars` value, and sets the effective model control value to the profile's `model`.

**Validates: Requirements 1.3, 1.4, 1.5, 1.6, 1.7, 3.1**

### Property 3: Rendered env inputs always match the selected provider

*For any* provider selected in Edit_Mode, the set of rendered Env_Field input keys equals exactly the schema keys of `PROVIDER_ENV_FIELDS` for that provider, including after changing the provider selection.

**Validates: Requirements 2.4**

### Property 4: OVHcloud model dropdown options

*For any* rendering where the selected provider is `ovhcloud`, the model dropdown's option values equal `OVHCLOUD_MODEL_OPTIONS` followed by a single "Other…" custom option.

**Validates: Requirements 2.5**

### Property 5: OVHcloud model prefill round-trips

*For any* profile whose provider is `ovhcloud`: if its `model` is present in `OVHCLOUD_MODEL_OPTIONS` then Edit_Mode prefill preselects that model in the dropdown; otherwise prefill selects the "Other…" option and places the model in the custom input. In both cases the model read back from the controls equals the profile's original `model`.

**Validates: Requirements 2.6, 2.7**

### Property 6: Secret fields are masked

*For any* profile, entering Edit_Mode renders every Env_Field whose schema marks it `secret: true` as a masked (password) input.

**Validates: Requirements 3.2**

### Property 7: Collected env values reflect edits or preserved originals

*For any* profile prefilled in Edit_Mode, collecting the Env_Field values yields, for each field, the newly entered value where the field was overwritten and the original stored value where the field was left unchanged.

**Validates: Requirements 3.3, 3.4**

### Property 8: Update_Message assembly

*For any* Profile_Form state in Edit_Mode, triggering the update action produces an Update_Message whose `index` equals the stored Profile_Index and whose `provider`, `env_vars`, and `model` equal the form's current provider, collected env values, and effective model value.

**Validates: Requirements 4.2**

### Property 9: A valid update replaces only the target entry and preserves invariants

*For any* configuration and any valid Update_Message targeting a valid Profile_Index, applying the update leaves `providers.length` unchanged, writes the submitted provider, env vars, and model into `cfg.providers[index]`, preserves that entry's original `tool_method`, and leaves `selected_provider` unchanged.

**Validates: Requirements 2.8, 4.5, 5.1, 5.4, 4.8**

### Property 10: An invalid update is rejected without mutation

*For any* configuration and any Update_Message whose provider, env vars, or model fail `validateNewProvider`, applying the update returns the validation error and leaves the entire configuration unchanged.

**Validates: Requirements 4.3, 4.4**

### Property 11: An out-of-range index is rejected without mutation

*For any* configuration and any Update_Message whose Profile_Index is not a valid position in `cfg.providers`, applying the update returns an error and leaves the entire configuration unchanged.

**Validates: Requirements 4.7**

### Property 12: Refreshed list reflects updated values

*For any* configuration and any valid update, re-rendering the profile list after the update shows the target row's provider and model text equal to the submitted provider and model.

**Validates: Requirements 4.8**

### Property 13: Create_Mode appends a new profile

*For any* configuration in Create_Mode, submitting a valid new profile increases `providers.length` by one and the appended entry equals the submitted provider, env vars, and model.

**Validates: Requirements 5.3**
