import * as vscode from 'vscode';
import { ContextManager, PREDEFINED_CONTEXT_IDS, PREDEFINED_CONTEXTS, sanitizeContextId } from '../context/contextManager';
import { ChatController } from '../chat/controller';
import { buildPrompt } from '../context/promptBuilder';

export function openContextEditor(
    extensionUri: vscode.Uri,
    controller: ChatController
): void {
    ContextEditorPanel.createOrShow(extensionUri, controller);
}


function getNonce(): string {
    let t = '';
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) { t += c.charAt(Math.floor(Math.random() * c.length)); }
    return t;
}

class ContextEditorPanel {
    private static current: ContextEditorPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        private extensionUri: vscode.Uri,
        private controller: ChatController
    ) {
        this.panel = panel;
        this.panel.webview.html = this.buildHtml();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(m => this.onMessage(m), null, this.disposables);
    }

    static createOrShow(extensionUri: vscode.Uri, controller: ChatController): void {
        const column = vscode.ViewColumn.Beside;
        // Toujours détruire l'ancien panel et en créer un nouveau propre
        if (ContextEditorPanel.current) {
            ContextEditorPanel.current.panel.dispose();
        }
        const panel = vscode.window.createWebviewPanel(
            'shaiContextEditor',
            'Shai — Context editor',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );
        ContextEditorPanel.current = new ContextEditorPanel(panel, extensionUri, controller);
    }

    // ------------------------------------------------------------------

    private sendInit(): void {
        const ctx = this.controller.getVscodeContext();
        const allIds = ContextManager.listContextIds(ctx);
        const active = this.controller.getActiveContextId();

        // Ensure the active id always appears in the list
        const idSet = new Set(allIds);
        if (!idSet.has(active)) { idSet.add(active); }

        // Predefined contexts first (in their canonical order), then user contexts sorted
        const predefined = PREDEFINED_CONTEXT_IDS.filter(id => idSet.has(id));
        const userIds = [...idSet].filter(id => !PREDEFINED_CONTEXT_IDS.includes(id)).sort();
        const ids = [...predefined, ...userIds];

        const manager = this.controller.getContextManager(active);
        const state   = manager.getState();

        const templates = PREDEFINED_CONTEXTS.map(c => ({
            id: c.id,
            label: c.label,
            systemPrompt: c.systemPrompt,
        }));

        this.panel.webview.postMessage({
            type: 'init',
            contextIds: ids,
            activeId: active,
            predefinedIds: PREDEFINED_CONTEXT_IDS,
            templates,
            state,
        });
    }

    private onMessage(message: { type: string; [key: string]: unknown }): void {
        const ctx = this.controller.getVscodeContext();

        switch (message.type) {
            // ---- Webview ready ----
            case 'getInit': {
                this.sendInit();
                break;
            }

            // ---- Context selection ----
            case 'switchContext': {
                const id = message.id as string;
                this.controller.setActiveContextId(id);
                this.sendInit();
                break;
            }

            // ---- Create a new context ----
            case 'newContext': {
                const rawId = (message.id as string ?? '').trim();
                if (!rawId) { break; }
                const safe = sanitizeContextId(rawId);
                const mgr = this.controller.getContextManager(safe);
                if (message.systemPrompt) {
                    mgr.setSystemPrompt(message.systemPrompt as string);
                }
                // Force persistence so the context appears in listContextIds immediately
                mgr.touch();
                this.controller.setActiveContextId(safe);
                this.sendInit();
                break;
            }

            // ---- Delete a context ----
            case 'deleteContext': {
                const id = message.id as string;
                // Never delete predefined contexts
                if (PREDEFINED_CONTEXT_IDS.includes(id)) { break; }
                ContextManager.deleteContext(ctx, id);
                this.controller.deleteSession(id);
                // Pick next context; fall back to 'default'
                const remaining = ContextManager.listContextIds(ctx);
                const next = remaining.length > 0 ? remaining[0] : 'default';
                // Touch so 'default' (or next) is persisted and visible in the list
                this.controller.getContextManager(next).touch();
                this.controller.setActiveContextId(next);
                this.sendInit();
                break;
            }

            // ---- System prompt ----
            case 'saveSystemPrompt': {
                const id = this.controller.getActiveContextId();
                this.controller.getContextManager(id).setSystemPrompt(message.value as string);
                break;
            }

            // ---- Preview enriched prompt ----
            case 'previewPrompt': {
                const id  = this.controller.getActiveContextId();
                const mgr = this.controller.getContextManager(id);
                const preview = buildPrompt(
                    mgr.getSummary(),
                    mgr.getRecentTurns(),
                    (message.userMessage as string) || '(your message here)',
                    mgr.getSystemPrompt()
                );
                this.panel.webview.postMessage({ type: 'previewResult', text: preview });
                break;
            }
        }
    }

    private dispose(): void {
        ContextEditorPanel.current = undefined;
        this.panel.dispose();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }

    // ------------------------------------------------------------------
    // HTML
    // ------------------------------------------------------------------

    private buildHtml(): string {
        const nonce = getNonce();
        const cspSource = this.panel.webview.cspSource;
        const scriptUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'contextEditor.js')
        );
        return getContextEditorHtml(nonce, cspSource, scriptUri.toString());
    }
}

function getContextEditorHtml(nonce: string, cspSource: string, scriptUri: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>Shai - Context editor</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px; display: flex; flex-direction: column; gap: 12px; font-size: 13px; line-height: 1.45; }
    h2 { font-size: 15px; font-weight: 600; margin: 0 0 8px 0; }
    h3 { font-size: 13px; font-weight: 600; margin: 0 0 6px 0; }
    fieldset { border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.35)); border-radius: 6px; padding: 12px 14px; margin: 0; }
    legend { padding: 0 6px; font-weight: 600; font-size: 13px; }
    label { display: block; margin: 6px 0 3px; font-size: 12px; opacity: 0.8; }
    select, input[type="text"], textarea {
      width: 100%; box-sizing: border-box; padding: 5px 8px;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px;
      font-family: inherit; font-size: 13px;
    }
    textarea { resize: vertical; }
    button {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; padding: 0 14px; border-radius: 4px; cursor: pointer;
      min-height: 28px; display: inline-flex; align-items: center; justify-content: center;
      font-family: inherit; font-size: 13px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #3a3d41); }
    button.danger { background: transparent; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-errorForeground); }
    .row { margin-bottom: 8px; }
    .row-end { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
    .selector-row { display: flex; gap: 8px; align-items: center; }
    .selector-row select { flex: 1; }
    .hint { font-size: 11px; opacity: 0.75; margin: 4px 0; }
    .err { color: var(--vscode-errorForeground); font-size: 12px; margin-top: 4px; }
    .hidden { display: none !important; }
    #newCtxSection { border-color: var(--vscode-focusBorder, #007fd4); }
    .confirm-bar { display: flex; align-items: center; gap: 8px; margin-top: 6px; padding: 6px 10px; background: var(--vscode-inputValidation-warningBackground, rgba(200,150,0,.15)); border: 1px solid var(--vscode-inputValidation-warningBorder, #c89600); border-radius: 4px; font-size: 12px; }
    .confirm-bar span { flex: 1; }
    .confirm-bar.hidden { display: none !important; }
  </style>
</head>
<body>
  <h2>Context editor</h2>

  <fieldset>
    <legend>Active context</legend>
    <div class="selector-row">
      <select id="ctxSelect"></select>
      <button type="button" class="danger" id="btnDeleteCtx">Delete</button>
    </div>
    <div class="confirm-bar hidden" id="confirmDeleteCtx">
      <span>Delete this context?</span>
      <button type="button" class="danger" id="confirmDeleteCtxYes">Yes, delete</button>
      <button type="button" class="secondary" id="confirmDeleteCtxNo">Cancel</button>
    </div>
    <p class="hint">Active: <strong id="activeName">-</strong></p>
  </fieldset>

  <fieldset>
    <legend>System prompt</legend>
    <p class="hint" id="systemPromptHint">The system prompt is injected at the top of every request for this context, guiding how the AI responds.</p>
    <textarea id="systemPrompt" rows="4" placeholder="Instructions always injected at the top of every prompt..." aria-describedby="systemPromptHint"></textarea>
    <div class="row-end">
      <button type="button" id="btnSaveSystem">Save</button>
    </div>
  </fieldset>

  <div>
    <button type="button" class="secondary" id="btnToggleNew" style="width:100%;min-height:32px">+ New context</button>
  </div>

  <fieldset id="newCtxSection" class="hidden">
    <legend>New context</legend>
    <div class="row">
      <label for="newCtxId">Name</label>
      <input type="text" id="newCtxId" placeholder="mon-contexte" autocomplete="off" aria-describedby="newCtxIdHint" />
      <div class="hint" id="newCtxIdHint">Use only letters, digits, hyphens, and underscores. Other characters are replaced with underscores.</div>
      <div class="hint hidden" id="newCtxSanitizeNotice"></div>
      <div class="err hidden" id="newCtxError">This name already exists.</div>
    </div>
    <div class="row">
      <label for="newCtxTemplate">Template</label>
      <select id="newCtxTemplate"></select>
    </div>
    <div class="row">
      <label for="newCtxSystem">System prompt (optionnel)</label>
      <textarea id="newCtxSystem" rows="4" placeholder="Instructions pour ce contexte..."></textarea>
    </div>
    <div class="row-end">
      <button type="button" class="secondary" id="btnCancelCreate">Annuler</button>
      <button type="button" id="btnCreateCtx">Save</button>
    </div>
  </fieldset>

  <fieldset>
    <legend>Preview prompt</legend>
    <p class="hint">Tapez un message test pour voir le prompt complet envoy&eacute; &agrave; l&#39;IA avec le system prompt actif.</p>
    <div style="display:flex;gap:8px;align-items:flex-start">
      <textarea id="previewInput" rows="2" style="flex:1" placeholder="Votre message de test..."></textarea>
      <button type="button" class="secondary" id="btnPreview" style="align-self:flex-start">Preview</button>
    </div>
    <pre id="previewOutput" class="hidden" style="margin-top:8px;padding:10px;background:var(--vscode-textBlockQuote-background,rgba(128,128,128,.1));border-left:3px solid var(--vscode-textBlockQuote-border,#888);font-size:12px;white-space:pre-wrap;word-break:break-word;border-radius:4px;overflow-x:auto"></pre>
  </fieldset>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
