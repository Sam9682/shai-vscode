import * as vscode from 'vscode';
import {
    loadAuthConfig,
    saveAuthConfig,
    validateNewProvider,
    removeProviderAt,
    PROVIDER_LABELS,
    PROVIDER_ENV_FIELDS,
    OVHCLOUD_MODEL_OPTIONS,
    type ProviderConfig,
} from './authConfig';

function getNonce(): string {
    let t = '';
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        t += c.charAt(Math.floor(Math.random() * c.length));
    }
    return t;
}

export function openAuthWizard(_context: vscode.ExtensionContext): void {
    const panel = vscode.window.createWebviewPanel(
        'shaiAuthWizard',
        'Shai configuration',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    const nonce = getNonce();
    const { cspSource } = panel.webview;
    panel.webview.html = getWizardHtml(nonce, cspSource);

    panel.webview.onDidReceiveMessage(
        (msg: {
            type: string;
            selectedIndex?: number;
            index?: number;
            provider?: string;
            env_vars?: Record<string, string>;
            model?: string;
        }) => {
            try {
                if (msg.type === 'getInit') {
                    try {
                        panel.webview.postMessage({
                            type: 'init',
                            config: loadAuthConfig(),
                            providerOptions: PROVIDER_LABELS,
                            envFields: PROVIDER_ENV_FIELDS,
                            ovhcloudModels: OVHCLOUD_MODEL_OPTIONS,
                        });
                    } catch (e: unknown) {
                        const m = e instanceof Error ? e.message : String(e);
                        panel.webview.postMessage({ type: 'error', message: m });
                    }
                    return;
                }
                if (msg.type === 'saveExisting') {
                    const idx = msg.selectedIndex;
                    if (typeof idx !== 'number' || idx < 0) {
                        panel.webview.postMessage({ type: 'error', message: 'Invalid selection.' });
                        return;
                    }
                    const cfg = loadAuthConfig();
                    if (idx >= cfg.providers.length) {
                        panel.webview.postMessage({ type: 'error', message: 'Profile not found.' });
                        return;
                    }
                    cfg.selected_provider = idx;
                    saveAuthConfig(cfg);
                    panel.webview.postMessage({ type: 'saved', config: cfg, clearNew: false });
                    vscode.window.showInformationMessage(
                        `Active profile: ${cfg.providers[idx].provider} / ${cfg.providers[idx].model}`
                    );
                    return;
                }
                if (msg.type === 'deleteProfile') {
                    const idx = typeof msg.index === 'number' ? msg.index : msg.selectedIndex;
                    if (typeof idx !== 'number' || idx < 0) {
                        panel.webview.postMessage({ type: 'error', message: 'Invalid selection.' });
                        return;
                    }
                    const cfg = loadAuthConfig();
                    const delErr = removeProviderAt(cfg, idx);
                    if (delErr) {
                        panel.webview.postMessage({ type: 'error', message: delErr });
                        return;
                    }
                    saveAuthConfig(cfg);
                    panel.webview.postMessage({ type: 'saved', config: cfg, clearNew: false });
                    vscode.window.showInformationMessage('Profile removed.');
                    return;
                }
                if (msg.type === 'saveNew') {
                    const providerId = (msg.provider || '').trim();
                    const model = (msg.model || '').trim();
                    const envVars = msg.env_vars || {};
                    const err = validateNewProvider(providerId, envVars, model);
                    if (err) {
                        panel.webview.postMessage({ type: 'error', message: err });
                        return;
                    }
                    const cfg = loadAuthConfig();
                    const newEntry: ProviderConfig = {
                        provider: providerId,
                        env_vars: { ...envVars },
                        model,
                        tool_method: 'FunctionCall',
                    };
                    cfg.providers.push(newEntry);
                    cfg.selected_provider = cfg.providers.length - 1;
                    saveAuthConfig(cfg);
                    panel.webview.postMessage({ type: 'saved', config: cfg, clearNew: true });
                    vscode.window.showInformationMessage(`Profile created and active: ${providerId} / ${model}`);
                    return;
                }
            } catch (e: unknown) {
                const m = e instanceof Error ? e.message : String(e);
                panel.webview.postMessage({ type: 'error', message: m });
            }
        },
        undefined,
        []
    );
}

function getWizardHtml(nonce: string, cspSource: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>Shai configuration</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 16px 20px 24px;
      line-height: 1.45;
      font-size: 13px;
    }
    h1 { font-size: 15px; font-weight: 600; margin: 0 0 4px 0; }
    fieldset {
      border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.35));
      border-radius: 6px;
      padding: 12px 14px;
      margin: 0 0 14px 0;
    }
    legend { padding: 0 6px; font-weight: 600; }
    label { display: block; margin: 8px 0 4px; }
    label.inline { display: flex; align-items: center; gap: 8px; margin: 6px 0; cursor: pointer; }
    input[type="text"], input[type="password"], select {
      width: 100%;
      max-width: 420px;
      box-sizing: border-box;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
    }
    .row { margin-bottom: 10px; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 0 14px;
      border-radius: 4px;
      cursor: pointer;
      margin: 0;
      box-sizing: border-box;
      min-height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .hint { font-size: 11px; opacity: 0.8; margin-top: 4px; }
    .err { color: var(--vscode-errorForeground); margin-top: 8px; }
    .hidden { display: none !important; }
    /* Spacing between label text and action buttons (profile rows + Activate row) */
    :root {
      --profile-inline-gap: 8px;
    }
    .list-profiles { margin: 8px 0 0 0; padding: 0; list-style: none; }
    .profile-trailing {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      align-self: center;
      box-sizing: border-box;
    }
    .list-profiles li.profile-row {
      margin: 0;
      padding: 6px 0;
      list-style: none;
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: flex-start;
      flex-wrap: nowrap;
      gap: var(--profile-inline-gap);
      min-height: 30px;
    }
    .profile-line {
      display: inline-flex;
      flex-direction: row;
      align-items: center;
      justify-content: flex-start;
      gap: 8px;
      flex-wrap: nowrap;
      min-width: 0;
      flex: 0 1 auto;
      max-width: 100%;
    }
    /* Radio + text on one line, vertically centered with the row */
    .list-profiles .profile-line label.inline {
      display: inline-flex;
      flex-direction: row;
      align-items: center;
      gap: 8px;
      margin: 0;
      padding: 0;
      cursor: pointer;
      line-height: 1.45;
    }
    .list-profiles .profile-line label.inline input[type="radio"] {
      margin: 0;
      flex-shrink: 0;
      align-self: center;
    }
    .list-profiles .profile-line label.inline span {
      display: inline-block;
      vertical-align: middle;
    }
    .list-profiles .btn-del {
      margin: 0;
      padding: 0 8px;
      font-size: 12px;
      line-height: 1.2;
      min-height: 28px;
      height: 28px;
      max-width: 100%;
      align-self: center;
    }
    .profile-actions {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: flex-start;
      flex-wrap: nowrap;
      gap: var(--profile-inline-gap);
      margin-top: 4px;
      padding-top: 14px;
      border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,.35));
    }
    .profile-actions-left {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      align-self: center;
    }
    .profile-actions #btnExisting {
      min-height: 28px;
      height: 28px;
      padding: 0 14px;
      line-height: 1.2;
    }
    button.icon-btn {
      min-width: 28px;
      width: 28px;
      height: 28px;
      min-height: 28px;
      padding: 0;
      font-size: 16px;
      line-height: 1;
      align-self: center;
    }
    #newProfileBody {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,.25));
    }
    #btnNew {
      margin-top: 12px;
      min-height: 28px;
      height: 28px;
    }
    #modelOvh { max-width: 420px; }
    #modelOvhCustom { max-width: 420px; }
    #envFields .row:first-child label { margin-top: 0; }
  </style>
</head>
<body>
  <h1>Shai configuration</h1>

  <fieldset>
    <legend>Profiles</legend>
    <p class="hint">Select a profile in <code>auth.config</code>, activate it, or delete (keep at least one). Use <strong>+</strong> to add a profile.</p>
    <ul class="list-profiles" id="existingList"></ul>
    <div class="profile-actions">
      <div class="profile-actions-left">
        <button type="button" id="btnExisting">Activate selected</button>
      </div>
      <div class="profile-trailing">
        <button type="button" class="secondary icon-btn" id="btnToggleNew" title="Show new profile form" aria-expanded="false">+</button>
      </div>
    </div>
    <div id="newProfileBody" class="hidden">
      <p class="hint">Pick a provider, set API keys (e.g. <code>ANTHROPIC_API_KEY</code>), then the model.</p>
      <div class="row">
        <label for="newProvider">AI provider</label>
        <select id="newProvider"></select>
      </div>
      <div id="envFields"></div>
      <div class="row" id="modelRow">
        <label for="model" id="modelLabel">Model</label>
        <input type="text" id="model" placeholder="e.g. claude-sonnet-4-20250514" autocomplete="off" />
        <select id="modelOvh" class="hidden"></select>
        <input type="text" id="modelOvhCustom" class="hidden" placeholder="Custom model ID" autocomplete="off" />
      </div>
      <button type="button" id="btnNew">Create and activate</button>
    </div>
  </fieldset>

  <div class="err hidden" id="msgErr"></div>

  <script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const existingList = document.getElementById('existingList');
  const btnExisting = document.getElementById('btnExisting');
  const newProvider = document.getElementById('newProvider');
  const envFields = document.getElementById('envFields');
  const model = document.getElementById('model');
  const modelLabel = document.getElementById('modelLabel');
  const modelOvh = document.getElementById('modelOvh');
  const modelOvhCustom = document.getElementById('modelOvhCustom');
  const btnNew = document.getElementById('btnNew');
  const msgErr = document.getElementById('msgErr');
  const newProfileBody = document.getElementById('newProfileBody');
  const btnToggleNew = document.getElementById('btnToggleNew');

  var OVH_CUSTOM = '__custom__';
  let state = { config: null, envFieldSchema: {}, providerOptions: [], ovhcloudModels: [] };

  function showErr(t) {
    if (!t) { msgErr.classList.add('hidden'); msgErr.textContent = ''; return; }
    msgErr.textContent = t;
    msgErr.classList.remove('hidden');
  }

  function updateToggleBtn() {
    var open = newProfileBody && !newProfileBody.classList.contains('hidden');
    if (btnToggleNew) {
      btnToggleNew.textContent = open ? '−' : '+';
      btnToggleNew.title = open ? 'Hide new profile form' : 'Show new profile form';
      btnToggleNew.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  }

  function syncOvhCustom() {
    if (!modelOvh || !modelOvhCustom) return;
    var show = modelOvh.value === OVH_CUSTOM;
    modelOvhCustom.classList.toggle('hidden', !show);
    if (modelLabel) modelLabel.setAttribute('for', show ? 'modelOvhCustom' : 'modelOvh');
  }

  function renderModelControls(providerId) {
    var isOvh = providerId === 'ovhcloud';
    if (model) model.classList.toggle('hidden', isOvh);
    if (modelOvh) {
      modelOvh.classList.toggle('hidden', !isOvh);
      if (isOvh) {
        modelOvh.innerHTML = '';
        (state.ovhcloudModels || []).forEach(function (mid) {
          var o = document.createElement('option');
          o.value = mid;
          o.textContent = mid;
          modelOvh.appendChild(o);
        });
        var oth = document.createElement('option');
        oth.value = OVH_CUSTOM;
        oth.textContent = 'Other…';
        modelOvh.appendChild(oth);
        modelOvh.selectedIndex = 0;
      }
    }
    if (modelOvhCustom) {
      if (!isOvh) {
        modelOvhCustom.classList.add('hidden');
        modelOvhCustom.value = '';
      } else {
        syncOvhCustom();
      }
    }
    if (modelLabel) modelLabel.setAttribute('for', isOvh ? 'modelOvh' : 'model');
  }

  function getModelValue() {
    var pid = newProvider.value;
    if (pid === 'ovhcloud') {
      if (modelOvh.value === OVH_CUSTOM) return (modelOvhCustom.value || '').trim();
      return (modelOvh.value || '').trim();
    }
    return (model.value || '').trim();
  }

  function clearNewForm() {
    if (model) model.value = '';
    if (modelOvhCustom) modelOvhCustom.value = '';
    if (newProvider) newProvider.selectedIndex = 0;
    var pid = newProvider ? newProvider.value : 'anthropic';
    renderEnvInputs(pid);
    renderModelControls(pid);
    applyDefaults(pid);
  }

  function renderExisting() {
    existingList.innerHTML = '';
    const provs = (state.config && state.config.providers) || [];
    if (provs.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No profiles yet — use + to add one.';
      existingList.appendChild(li);
      btnExisting.disabled = true;
      return;
    }
    btnExisting.disabled = false;
    const canDelete = provs.length > 1;
    const sel = typeof state.config.selected_provider === 'number' ? state.config.selected_provider : 0;
    const selectedIdx = Math.min(sel, provs.length - 1);
    provs.forEach(function (p, i) {
      const li = document.createElement('li');
      li.className = 'profile-row';
      const line = document.createElement('div');
      line.className = 'profile-line';
      const id = 'ep_' + i;
      const lab = document.createElement('label');
      lab.className = 'inline';
      lab.innerHTML = '<input type="radio" name="which" value="' + i + '" id="' + id + '" ' + (i === selectedIdx ? 'checked' : '') + ' />';
      const span = document.createElement('span');
      span.textContent = p.provider + ' — ' + p.model;
      lab.appendChild(span);
      line.appendChild(lab);
      const trail = document.createElement('div');
      trail.className = 'profile-trailing';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'secondary btn-del';
      del.textContent = 'Delete';
      del.title = 'Remove this profile';
      del.disabled = !canDelete;
      del.dataset.index = String(i);
      trail.appendChild(del);
      li.appendChild(line);
      li.appendChild(trail);
      existingList.appendChild(li);
    });
  }

  existingList.addEventListener('click', function (ev) {
    const t = ev.target;
    const btn = t && t.closest ? t.closest('.btn-del') : null;
    if (!btn) return;
    if (btn.disabled) return;
    const idx = parseInt(btn.dataset.index, 10);
    if (isNaN(idx)) return;
    showErr('');
    vscode.postMessage({ type: 'deleteProfile', index: idx });
  });

  function renderProviderSelect() {
    newProvider.innerHTML = '';
    state.providerOptions.forEach(function (opt) {
      const o = document.createElement('option');
      o.value = opt.id;
      o.textContent = opt.label;
      newProvider.appendChild(o);
    });
  }

  function renderEnvInputs(providerId) {
    envFields.innerHTML = '';
    const fields = state.envFieldSchema[providerId] || [];
    fields.forEach(function (f) {
      const wrap = document.createElement('div');
      wrap.className = 'row';
      const lab = document.createElement('label');
      lab.setAttribute('for', 'env_' + f.key);
      lab.textContent = f.label + (f.optional ? ' (optional)' : '');
      const inp = document.createElement('input');
      inp.id = 'env_' + f.key;
      inp.dataset.key = f.key;
      inp.type = f.secret ? 'password' : 'text';
      inp.autocomplete = 'off';
      if (f.placeholder) inp.placeholder = f.placeholder;
      wrap.appendChild(lab);
      wrap.appendChild(inp);
      envFields.appendChild(wrap);
    });
  }

  function collectEnvVars(providerId) {
    const out = {};
    const fields = state.envFieldSchema[providerId] || [];
    fields.forEach(function (f) {
      const el = document.getElementById('env_' + f.key);
      if (el) out[f.key] = (el.value || '').trim();
    });
    return out;
  }

  function applyDefaults(providerId) {
    if (providerId === 'ollama') {
      const el = document.getElementById('env_OLLAMA_BASE_URL');
      if (el && !el.value) el.value = 'http://localhost:11434/v1';
    }
    if (providerId === 'anthropic' && model && !model.value) {
      model.placeholder = 'e.g. claude-sonnet-4-20250514';
    }
  }

  if (modelOvh) {
    modelOvh.addEventListener('change', syncOvhCustom);
  }

  btnToggleNew.addEventListener('click', function () {
    newProfileBody.classList.toggle('hidden');
    updateToggleBtn();
    if (!newProfileBody.classList.contains('hidden')) {
      const pid = newProvider.value;
      renderEnvInputs(pid);
      renderModelControls(pid);
      applyDefaults(pid);
    }
  });

  window.addEventListener('message', function (ev) {
    const m = ev.data;
    if (m.type === 'init') {
      state.config = m.config;
      state.envFieldSchema = m.envFields || {};
      state.providerOptions = m.providerOptions || [];
      state.ovhcloudModels = m.ovhcloudModels || [];
      renderProviderSelect();
      renderExisting();
      newProfileBody.classList.add('hidden');
      updateToggleBtn();
      clearNewForm();
    }
    if (m.type === 'saved') {
      state.config = m.config;
      showErr('');
      renderExisting();
      if (m.clearNew) {
        clearNewForm();
        newProfileBody.classList.add('hidden');
        updateToggleBtn();
      }
    }
    if (m.type === 'error') {
      showErr(m.message || 'Error');
    }
  });

  newProvider.addEventListener('change', function () {
    renderEnvInputs(newProvider.value);
    renderModelControls(newProvider.value);
    applyDefaults(newProvider.value);
  });

  btnExisting.addEventListener('click', function () {
    showErr('');
    const r = existingList.querySelector('input[name="which"]:checked');
    const idx = r ? parseInt(r.value, 10) : 0;
    vscode.postMessage({ type: 'saveExisting', selectedIndex: idx });
  });

  btnNew.addEventListener('click', function () {
    showErr('');
    vscode.postMessage({
      type: 'saveNew',
      provider: newProvider.value,
      env_vars: collectEnvVars(newProvider.value),
      model: getModelValue(),
    });
  });

  vscode.postMessage({ type: 'getInit' });
})();
  </script>
</body>
</html>`;
}
