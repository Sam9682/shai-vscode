import * as vscode from 'vscode';
import { ChatController } from '../chat/controller';
import { ReasoningViewProvider } from './reasoningView';
import { buildPrompt } from '../context/promptBuilder';
import { getShaiWorkingDir, ShaiStoppedError } from '../chat/streaming';
import { shaiPathToUri } from '../platform/wsl';
import { PREDEFINED_CONTEXTS, ContextManager } from '../context/contextManager';
import { resolveAttachments, buildAttachmentNote, buildAttachmentBlock } from '../chat/attachments';

/** Keeps only string URIs from an untrusted webview payload. */
function asUriList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

/** Sends the picked files back to the webview as attachment chips. */
function postAttachments(webview: vscode.Webview, uris: vscode.Uri[]): void {
    if (uris.length === 0) { return; }
    webview.postMessage({
        type: 'attachmentsAdded',
        files: uris.map(u => ({ uri: u.toString(), name: u.path.split('/').pop() || u.path })),
    });
}

/**
 * Handles the attachment-related webview messages ("+" menu and drag & drop).
 * Returns true when the message was one of them.
 */
export async function handleAttachmentMessage(message: any, webview: vscode.Webview): Promise<boolean> {
    switch (message?.type) {
        case 'pickFiles': {
            const picked = await vscode.window.showOpenDialog({
                canSelectMany: true,
                canSelectFiles: true,
                canSelectFolders: false,
                openLabel: 'Attach',
                title: 'Attach files to your Shai request',
                defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
            });
            postAttachments(webview, picked ?? []);
            return true;
        }
        case 'addActiveFile': {
            const uri = vscode.window.activeTextEditor?.document.uri
                ?? vscode.window.visibleTextEditors[0]?.document.uri;
            if (uri && uri.scheme !== 'untitled') {
                postAttachments(webview, [uri]);
            } else {
                void vscode.window.showInformationMessage('No saved file is open in the editor.');
            }
            return true;
        }
        case 'addOpenEditors': {
            const uris: vscode.Uri[] = [];
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    const input = tab.input;
                    if (input instanceof vscode.TabInputText && input.uri.scheme !== 'untitled'
                        && !uris.some(u => u.toString() === input.uri.toString())) {
                        uris.push(input.uri);
                    }
                }
            }
            if (uris.length === 0) {
                void vscode.window.showInformationMessage('No open editors to attach.');
            }
            postAttachments(webview, uris);
            return true;
        }
        case 'dropUris': {
            const uris: vscode.Uri[] = [];
            for (const raw of asUriList(message.uris)) {
                try { uris.push(vscode.Uri.parse(raw, true)); } catch { /* ignore */ }
            }
            postAttachments(webview, uris);
            return true;
        }
    }
    return false;
}

/**
 * Host-side scheme validation for link-open requests, mirroring the webview gate.
 * Returns true only when the parsed URL scheme is `http` or `https` (case-insensitive).
 * Parse failures are caught and treated as invalid (returns false).
 */
export function isHttpUrl(raw: string): boolean {
    try {
        const scheme = vscode.Uri.parse(raw, true).scheme.toLowerCase();
        return scheme === 'http' || scheme === 'https';
    } catch {
        return false;
    }
}

/**
 * Extracts the filesystem path from a `vscode://file/<path>[:line[:col]]` URL.
 * Returns undefined for any other URL. Only the `file` authority is accepted.
 */
export function parseVscodeFileUrl(raw: string): { path: string; line?: number; column?: number } | undefined {
    const m = /^(?:vscode:\/\/file|file:\/\/)(\/[^?#]*)/i.exec(raw.trim());
    if (!m) { return undefined; }
    let p: string;
    try {
        p = decodeURIComponent(m[1]);
    } catch {
        return undefined;
    }
    let line: number | undefined;
    let column: number | undefined;
    const pos = /^(.*?):(\d+)(?::(\d+))?$/.exec(p);
    if (pos) {
        p = pos[1];
        line = parseInt(pos[2], 10);
        column = pos[3] ? parseInt(pos[3], 10) : undefined;
    }
    return { path: p, line, column };
}

/**
 * Opens a link clicked in the chat: http(s) in the browser, vscode://file/...
 * in the editor (files) or the Explorer / a new window (directories).
 * Other schemes are silently rejected.
 */
export async function openChatLink(url: unknown): Promise<void> {
    if (typeof url !== 'string') { return; }
    if (isHttpUrl(url)) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
    }
    const target = parseVscodeFileUrl(url);
    if (!target) { return; }
    const uri = shaiPathToUri(target.path);
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory) {
            if (vscode.workspace.getWorkspaceFolder(uri)) {
                await vscode.commands.executeCommand('revealInExplorer', uri);
            } else {
                await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
            }
            return;
        }
        const options: vscode.TextDocumentShowOptions = {};
        if (target.line !== undefined) {
            const pos = new vscode.Position(Math.max(0, target.line - 1), Math.max(0, (target.column ?? 1) - 1));
            options.selection = new vscode.Range(pos, pos);
        }
        await vscode.commands.executeCommand('vscode.open', uri, options);
    } catch {
        void vscode.window.showWarningMessage(`Cannot open: ${target.path}`);
    }
}

/**
 * Streaming status states for the Chat_View Streaming_Status_Indicator.
 * (Design §6)
 */
export type StreamState = 'idle' | 'sending' | 'receiving' | 'completed' | 'failed';

/**
 * Streaming events that drive the status indicator state machine.
 * (Design §6)
 */
export type StreamEvent = 'submit' | 'progress' | 'complete' | 'error';

/**
 * Pure reducer for the streaming status state machine. (Req 5.1-5.4)
 * Mirrored in the webview script.
 * - `submit`   -> sending
 * - `progress` -> receiving, only while already sending or receiving (otherwise unchanged)
 * - `complete` -> completed
 * - `error`    -> failed
 */
export function nextStreamState(state: StreamState, event: StreamEvent): StreamState {
    switch (event) {
        case 'submit':
            return 'sending';
        case 'progress':
            return (state === 'sending' || state === 'receiving') ? 'receiving' : state;
        case 'complete':
            return 'completed';
        case 'error':
            return 'failed';
    }
}

/**
 * Whether the send control should be enabled for the given streaming state. (Req 5.5, 5.6)
 * Enabled for terminal/idle states (`idle`, `completed`, `failed`);
 * disabled while a request is in progress (`sending`, `receiving`).
 */
export function sendEnabled(state: StreamState): boolean {
    return state === 'idle' || state === 'completed' || state === 'failed';
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'shai.chatView';
    private _view?: vscode.WebviewView;
    private controller: ChatController;
    /** The context ID currently shown in the chat panel badge. */
    private _displayedContextId: string;

    constructor(private readonly extensionUri: vscode.Uri, contextOrController: vscode.ExtensionContext | ChatController) {
        if ((contextOrController as ChatController).getSession !== undefined) {
            this.controller = contextOrController as ChatController;
        } else {
            this.controller = new ChatController(contextOrController as vscode.ExtensionContext);
        }
        const activeId = this.controller.getActiveContextId();
        const isValid = PREDEFINED_CONTEXTS.some(c => c.id === activeId);
        this._displayedContextId = isValid ? activeId : 'default';
        if (!isValid) {
            this.controller.setActiveContextId('default');
        }
    }

    /** Start a brand-new chat tab in the sidebar CHAT panel. */
    public newChat(): void {
        if (this._view) {
            this._view.webview.postMessage({ type: 'addTab' });
        }
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
        };

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.restoreHistory(webviewView.webview);
                this.sendActiveContext(webviewView.webview);
            }
        });

        // Push context changes to the webview whenever the active context switches
        const contextSub = this.controller.onActiveContextChanged(() => {
            if (this._view) {
                this.sendActiveContext(this._view.webview);
            }
        });

        webviewView.onDidDispose(() => { contextSub.dispose(); });

        webviewView.webview.onDidReceiveMessage(async (message) => {
            try {
                if (!this._view) return;
                const webview = this._view.webview;
                if (await handleAttachmentMessage(message, webview)) return;
                switch (message.type) {
                    case 'chat-prompt': {
                        const text: string = message.message || '';
                        const attachments = asUriList(message.attachments);
                        if (!text.trim() && attachments.length === 0) return;
                        const tabId = message.tabId || this._displayedContextId;
                        webview.postMessage({ type: 'clearStreaming' });
                        this.handleChatPromptForTab(text, webview, tabId, message.noExtraContext || false, message.autopilot || false, attachments);
                        break;
                    }
                    case 'clear': {
                        const tabId = message.tabId || this._displayedContextId;
                        this.handleClearForTab(webview, tabId);
                        break;
                    }
                    case 'stop': {
                        const tabId = message.tabId || this._displayedContextId;
                        if (!this.controller.getStreamingSession(tabId).stop()) {
                            // Nothing running any more: just reset the button.
                            webview.postMessage({ type: 'stopped' });
                        }
                        break;
                    }
                    case 'switchTab': {
                        const tabId = message.tabId;
                        if (tabId) {
                            const session = this.controller.getSession(tabId);
                            const messages = session.getMessages();
                            if (messages.length > 0) {
                                webview.postMessage({ type: 'restoreHistory', messages, tabId });
                            }
                        }
                        break;
                    }
                    case 'ready': {
                        this.sendActiveContext(webview);
                        this.sendContextList(webview);
                        break;
                    }
                    case 'shai-auth': {
                        void vscode.commands.executeCommand('shai-vscode.auth');
                        break;
                    }
                    case 'switchContext': {
                        const newId: string = message.id;
                        if (newId) {
                            this.controller.setActiveContextId(newId);
                            this._displayedContextId = newId;
                        }
                        break;
                    }
                    case 'executeCommand': {
                        // Execute VS Code command from button click
                        const commandId = message.commandId;
                        if (commandId) {
                            await vscode.commands.executeCommand(commandId);
                            vscode.window.showInformationMessage(`Executed: ${commandId}`);
                        }
                        break;
                    }
                    case 'customAction': {
                        // Handle custom action buttons
                        const label = message.label;
                        const data = message.data;
                        vscode.window.showInformationMessage(`Action: ${label} - Data: ${data}`);
                        // You can add more custom logic here based on label/data
                        break;
                    }
                    case 'openExternal': {
                        await openChatLink(message.url);
                        break;
                    }
                }
            } catch (err) {
                console.error('Error handling webview message', err);
            }
        });
    }

    public static openPanel(extensionUri: vscode.Uri, chatController: ChatController) {
        const panel = vscode.window.createWebviewPanel(
            'shai-chat-panel',
            'Shai Chat',
            vscode.ViewColumn.One,
            { enableScripts: true, localResourceRoots: [extensionUri] }
        );
        const provider = new ChatViewProvider(extensionUri, chatController);
        panel.webview.html = provider.getHtmlContent(panel.webview);
        panel.webview.onDidReceiveMessage(async (data) => {
            if (await handleAttachmentMessage(data, panel.webview)) { return; }
            switch (data.type) {
                case 'chat-prompt':
                    await provider.handleChatPrompt(data.message || '', panel.webview, data.noExtraContext || false, data.autopilot || false, asUriList(data.attachments));
                    break;
                case 'clear':
                    provider.handleClear(panel.webview);
                    break;
                case 'stop':
                    if (!chatController.getStreamingSession(provider._displayedContextId).stop()) {
                        panel.webview.postMessage({ type: 'stopped' });
                    }
                    break;
                case 'ready':
                    provider.restoreHistory(panel.webview);
                    provider.sendActiveContext(panel.webview);
                    provider.sendContextList(panel.webview);
                    break;
                case 'switchContext':
                    if (data.id) {
                        chatController.setActiveContextId(data.id);
                        provider._displayedContextId = data.id;
                        provider.restoreHistory(panel.webview);
                    }
                    break;
                case 'shai-auth':
                    void vscode.commands.executeCommand('shai-vscode.auth');
                    break;
                case 'executeCommand':
                    if (data.commandId) {
                        await vscode.commands.executeCommand(data.commandId);
                        vscode.window.showInformationMessage(`Executed: ${data.commandId}`);
                    }
                    break;
                case 'customAction':
                    vscode.window.showInformationMessage(`Action: ${data.label} - Data: ${data.data}`);
                    break;
                case 'openExternal': {
                    await openChatLink(data.url);
                    break;
                }
            }
        });
        return panel;
    }

    private async handleChatPrompt(message: string, webview: vscode.Webview, noExtraContext: boolean = false, autopilot: boolean = false, attachmentUris: string[] = []) {
        const tabId = this._displayedContextId;
        const attachments = await resolveAttachments(attachmentUris);
        const attachmentBlock = buildAttachmentBlock(attachments);
        const cleanMessage = (message.trim() || 'Please look at the attached file(s).') + buildAttachmentNote(attachments);

        // Build context-enriched prompt (includes systemPrompt if set)
        const contextManager = this.controller.getContextManager(tabId);
        const enrichedMessage = noExtraContext
            ? cleanMessage
            : buildPrompt(
                contextManager.getSummary(),
                contextManager.getRecentTurns(),
                cleanMessage,
                contextManager.getSystemPrompt(),
                getShaiWorkingDir()
            );

        const extractAndForwardReasoning = (text: string): string => {
            // Extract <reasoning>...</reasoning> blocks
            const reasoningRegex = /<reasoning>([\s\S]*?)<\/reasoning>/g;
            let match: RegExpExecArray | null;
            let cleaned = text;
            while ((match = reasoningRegex.exec(text)) !== null) {
                if (ReasoningViewProvider.currentProvider) {
                    ReasoningViewProvider.currentProvider.showReasoning(match[1]);
                }
                cleaned = cleaned.replace(match[0], '');
            }
            
            // Extract <resolution>...</resolution> blocks and display them in the reasoning panel
            const resolutionRegex = /<resolution>([\s\S]*?)<\/resolution>/g;
            let resMatch: RegExpExecArray | null;
            while ((resMatch = resolutionRegex.exec(text)) !== null) {
                if (ReasoningViewProvider.currentProvider) {
                    ReasoningViewProvider.currentProvider.showResolution(resMatch[1]);
                }
                cleaned = cleaned.replace(resMatch[0], '');
            }
            
            // Extract thinking blocks marked with ░...● patterns
            const thinkingRegex = /░[^●]*●/g;
            let thinkMatch: RegExpExecArray | null;
            while ((thinkMatch = thinkingRegex.exec(text)) !== null) {
                if (ReasoningViewProvider.currentProvider) {
                    ReasoningViewProvider.currentProvider.showReasoning(thinkMatch[0]);
                }
                cleaned = cleaned.replace(thinkMatch[0], '');
            }
            
            // Extract internal SHAI messages like "░ Qwen3-Coder-30B-A3B-Instruct on ovhcloud..."
            const internalMessageRegex = /░\s*[A-Za-z0-9\-_]+\s*[A-Za-z0-9\-_]+\s*on\s+[A-Za-z0-9\-_]+/g;
            let internalMatch: RegExpExecArray | null;
            while ((internalMatch = internalMessageRegex.exec(text)) !== null) {
                if (ReasoningViewProvider.currentProvider) {
                    ReasoningViewProvider.currentProvider.showReasoning(internalMatch[0]);
                }
                cleaned = cleaned.replace(internalMatch[0], '');
            }
            
            return cleaned;
        };

        const onProgress = (progress: any) => {
            try {
                let text: string = progress.data || '';
                
                if (progress.type === 'progress') {
                    // ALL progress chunks go to the Internal Reasoning panel only.
                    // Nothing is streamed to the chat bubble during generation.
                    if (ReasoningViewProvider.currentProvider) {
                        ReasoningViewProvider.currentProvider.appendReasoning(text);
                    }
                    // Surface the 'receiving' state on the chat indicator without
                    // adding chat content (reasoning routing unchanged). (Req 5.2)
                    webview.postMessage({ type: 'streamingState', state: 'receiving' });
                } else if (progress.type === 'complete') {
                    // The final accumulated output arrives here.
                    // Strip thinking / reasoning blocks and send the clean
                    // answer to the chat panel.
                    const cleanedAnswer = extractAndForwardReasoning(text);
                    const finalAnswer = cleanedAnswer.trim();
                    // Persist this exchange in the context manager
                    contextManager.addTurn('user', cleanMessage);
                    contextManager.addTurn('assistant', finalAnswer);
                    webview.postMessage({ type: 'complete', data: finalAnswer });
                } else if (progress.type === 'error') {
                    if (ReasoningViewProvider.currentProvider) {
                        ReasoningViewProvider.currentProvider.appendReasoning(text);
                    }
                }
            } catch (err) {
                console.error('Error in onProgress handler', err);
            }
        };

        try {
            // Clear the reasoning panel before a new request
            if (ReasoningViewProvider.currentProvider) {
                ReasoningViewProvider.currentProvider.clearReasoning();
            }
            // Pass the context-enriched prompt (and attached files) to shai
            await this.controller.getStreamingSession(tabId).executeCommandWithStreaming(enrichedMessage, onProgress, this.controller.getInteractionMode(tabId), noExtraContext, autopilot, attachmentBlock);
            // The 'complete' callback above already sent the final answer to
            // the chat panel, so nothing else to do here.
        } catch (err: any) {
            if (err instanceof ShaiStoppedError) {
                webview.postMessage({ type: 'stopped' });
                return;
            }
            webview.postMessage({ type: 'error', data: err?.message || String(err) });
        }
    }

    private handleClear(webview: vscode.Webview) {
        const tabId = this._displayedContextId;
        try {
            const session = this.controller.getSession(tabId);
            session.clear();
            this.controller.getContextManager(tabId).clear();
        } catch (err) {
            console.error('Error clearing session', err);
        }
        webview.postMessage({ type: 'clearChat' });
    }

    private restoreHistory(webview: vscode.Webview) {
        const tabId = this._displayedContextId;
        const session = this.controller.getSession(tabId);
        const messages = session.getMessages();
        if (messages.length > 0) {
            webview.postMessage({ type: 'restoreHistory', messages });
        }
    }

    private sendActiveContext(webview: vscode.Webview) {
        let id = this.controller.getActiveContextId();
        // Ensure the active context is always a predefined one
        const preset = PREDEFINED_CONTEXTS.find(c => c.id === id);
        if (!preset) {
            id = 'default';
            this.controller.setActiveContextId(id);
        }
        this._displayedContextId = id;
        const ctx = PREDEFINED_CONTEXTS.find(c => c.id === id)!;
        webview.postMessage({
            type: 'activeContext',
            id,
            label: ctx.label,
        });
    }

    private sendContextList(webview: vscode.Webview) {
        const contexts = PREDEFINED_CONTEXTS.map(c => ({ id: c.id, label: c.label }));
        webview.postMessage({
            type: 'contextList',
            contexts,
            activeId: this._displayedContextId,
        });
    }

    // ------------------------------------------------------------------
    // Tab-specific helpers (used by standalone panels with their own tabId)
    // ------------------------------------------------------------------

    private async handleChatPromptForTab(message: string, webview: vscode.Webview, tabId: string, noExtraContext: boolean = false, autopilot: boolean = false, attachmentUris: string[] = []) {
        const attachments = await resolveAttachments(attachmentUris);
        const attachmentBlock = buildAttachmentBlock(attachments);
        const cleanMessage = (message.trim() || 'Please look at the attached file(s).') + buildAttachmentNote(attachments);
        const contextManager = this.controller.getContextManager(tabId);
        const enrichedMessage = noExtraContext
            ? cleanMessage
            : buildPrompt(
                contextManager.getSummary(),
                contextManager.getRecentTurns(),
                cleanMessage,
                contextManager.getSystemPrompt(),
                getShaiWorkingDir()
            );

        const extractAndForwardReasoning = (text: string): string => {
            const reasoningRegex = /<reasoning>([\s\S]*?)<\/reasoning>/g;
            let match: RegExpExecArray | null;
            let cleaned = text;
            while ((match = reasoningRegex.exec(text)) !== null) {
                if (ReasoningViewProvider.currentProvider) {
                    ReasoningViewProvider.currentProvider.showReasoning(match[1]);
                }
                cleaned = cleaned.replace(match[0], '');
            }
            const resolutionRegex = /<resolution>([\s\S]*?)<\/resolution>/g;
            let resMatch: RegExpExecArray | null;
            while ((resMatch = resolutionRegex.exec(text)) !== null) {
                if (ReasoningViewProvider.currentProvider) {
                    ReasoningViewProvider.currentProvider.showResolution(resMatch[1]);
                }
                cleaned = cleaned.replace(resMatch[0], '');
            }
            const thinkingRegex = /░[^●]*●/g;
            let thinkMatch: RegExpExecArray | null;
            while ((thinkMatch = thinkingRegex.exec(text)) !== null) {
                if (ReasoningViewProvider.currentProvider) {
                    ReasoningViewProvider.currentProvider.showReasoning(thinkMatch[0]);
                }
                cleaned = cleaned.replace(thinkMatch[0], '');
            }
            const internalMessageRegex = /░\s*[A-Za-z0-9\-_]+\s*[A-Za-z0-9\-_]+\s*on\s+[A-Za-z0-9\-_]+/g;
            let internalMatch: RegExpExecArray | null;
            while ((internalMatch = internalMessageRegex.exec(text)) !== null) {
                if (ReasoningViewProvider.currentProvider) {
                    ReasoningViewProvider.currentProvider.showReasoning(internalMatch[0]);
                }
                cleaned = cleaned.replace(internalMatch[0], '');
            }
            return cleaned;
        };

        const onProgress = (progress: any) => {
            try {
                let text: string = progress.data || '';
                if (progress.type === 'progress') {
                    if (ReasoningViewProvider.currentProvider) {
                        ReasoningViewProvider.currentProvider.appendReasoning(text);
                    }
                    // Surface the 'receiving' state on the chat indicator without
                    // adding chat content (reasoning routing unchanged). (Req 5.2)
                    webview.postMessage({ type: 'streamingState', state: 'receiving' });
                } else if (progress.type === 'complete') {
                    const cleanedAnswer = extractAndForwardReasoning(text);
                    const finalAnswer = cleanedAnswer.trim();
                    contextManager.addTurn('user', cleanMessage);
                    contextManager.addTurn('assistant', finalAnswer);
                    webview.postMessage({ type: 'complete', data: finalAnswer });
                } else if (progress.type === 'error') {
                    if (ReasoningViewProvider.currentProvider) {
                        ReasoningViewProvider.currentProvider.appendReasoning(text);
                    }
                }
            } catch (err) {
                console.error('Error in onProgress handler', err);
            }
        };

        try {
            if (ReasoningViewProvider.currentProvider) {
                ReasoningViewProvider.currentProvider.clearReasoning();
            }
            await this.controller.getStreamingSession(tabId).executeCommandWithStreaming(enrichedMessage, onProgress, this.controller.getInteractionMode(tabId), noExtraContext, autopilot, attachmentBlock);
        } catch (err: any) {
            if (err instanceof ShaiStoppedError) {
                webview.postMessage({ type: 'stopped' });
                return;
            }
            webview.postMessage({ type: 'error', data: err?.message || String(err) });
        }
    }

    private handleClearForTab(webview: vscode.Webview, tabId: string) {
        try {
            const session = this.controller.getSession(tabId);
            session.clear();
            this.controller.getContextManager(tabId).clear();
        } catch (err) {
            console.error('Error clearing session', err);
        }
        webview.postMessage({ type: 'clearChat' });
    }

    private sendActiveContextForTab(webview: vscode.Webview, tabId: string) {
        const preset = PREDEFINED_CONTEXTS.find(c => c.id === tabId);
        webview.postMessage({
            type: 'activeContext',
            id: tabId,
            label: preset ? preset.label : tabId,
        });
    }

    private getHtmlContent(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Shai Chat</title>
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: transparent; margin: 0; display: flex; flex-direction: column; height: 100vh; }
    .tab-bar { display: flex; background: var(--vscode-editorGroupHeader-tabsBackground, #252526); border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, #444); overflow-x: auto; flex-shrink: 0; }
    .tab { display: inline-flex; align-items: center; gap: 4px; padding: 6px 10px; font-size: 12px; cursor: pointer; background: transparent; color: var(--vscode-tab-inactiveForeground, #999); border: none; border-bottom: 2px solid transparent; white-space: nowrap; }
    .tab:hover { background: var(--vscode-tab-hoverBackground, #2a2d2e); }
    .tab.active { color: var(--vscode-tab-activeForeground, #fff); border-bottom-color: var(--vscode-tab-activeBorderTop, #007acc); background: var(--vscode-tab-activeBackground, #1e1e1e); }
    .tab .close-tab { font-size: 14px; margin-left: 4px; opacity: 0.4; cursor: pointer; }
    .tab .close-tab:hover { opacity: 1; }
    .chat-body { flex: 1; display: flex; flex-direction: column; padding: 8px; overflow: hidden; }
    .messages { flex: 1; overflow: auto; margin-bottom: 8px; }
    .message { padding: 8px; border-radius: 6px; margin-bottom: 6px; white-space: pre-wrap; word-wrap: break-word; }
    .user { background: var(--vscode-editor-selectionBackground); }
    .assistant { background: var(--vscode-editorWidget-background); }
    .controls { display:flex; flex-direction: column; gap:8px; }
    button.secondary { background: var(--vscode-button-secondaryBackground, #3c3c3c); color: var(--vscode-button-secondaryForeground, #fff); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #454545); }
    textarea { width: 100%; min-height: 5lh; max-height: 40vh; box-sizing: border-box; resize: vertical; padding: 8px; font-family: inherit; font-size: inherit; }
    .button-row { display: flex; gap: 8px; }
    button { background: #007acc; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; min-width: 100px; }
    button:hover { background: #005a9e; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    button:disabled:hover { background: #007acc; }
    button.processing { background: #d14545; } /* Red color for processing state */
    button.processing:hover { background: #a03838; } /* Darker red on hover */
    .action-button { display: inline-block; background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 6px 12px; margin: 4px 4px 4px 0; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
    .action-button:hover { background: var(--vscode-button-hoverBackground); }
    .chat-link { color: var(--vscode-textLink-foreground, #3794ff); text-decoration: underline; cursor: pointer; }
    .chat-link:hover { color: var(--vscode-textLink-activeForeground, #3794ff); }
    .code-block { background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background, #1e1e1e)); border: 1px solid var(--vscode-editorWidget-border, #454545); border-radius: 4px; margin: 6px 0; overflow: hidden; }
    .code-block .code-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; background: var(--vscode-editorGroupHeader-tabsBackground, #252526); border-bottom: 1px solid var(--vscode-editorWidget-border, #454545); }
    .code-block .code-lang { font-size: 11px; text-transform: uppercase; opacity: 0.7; color: var(--vscode-descriptionForeground, #999); }
    .code-block .copy-code-btn { min-width: auto; margin: 0; margin-left: auto; padding: 2px 8px; font-size: 11px; border-radius: 3px; background: var(--vscode-button-secondaryBackground, #3c3c3c); color: var(--vscode-button-secondaryForeground, #fff); border: none; cursor: pointer; }
    .code-block .copy-code-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #454545); }
    .code-block code { display: block; padding: 8px; overflow-x: auto; white-space: pre; font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); }
    code.inline-code { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.2)); padding: 2px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); }
    .message-timestamp { display: block; margin-top: 4px; font-size: 10px; opacity: 0.6; color: var(--vscode-descriptionForeground, #999); }
    .context-badge { display: inline-flex; align-items: center; margin-left: auto; padding: 4px 10px; font-size: 12px; border-radius: 4px; background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); white-space: nowrap; }
    .context-selector { margin-left: auto; padding: 4px 8px; font-size: 12px; border-radius: 4px; background: var(--vscode-dropdown-background, #3c3c3c); color: var(--vscode-dropdown-foreground, #fff); border: 1px solid var(--vscode-dropdown-border, #555); cursor: pointer; }
    .context-selector:focus { border-color: var(--vscode-focusBorder, #007acc); }
    .status-row { display: flex; align-items: center; min-height: 16px; }
    .streaming-status { font-size: 12px; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
    .streaming-status:empty { display: none; }
    .streaming-status-idle { color: var(--vscode-descriptionForeground, #999); }
    .streaming-status-sending { color: var(--vscode-charts-blue, #3794ff); }
    .streaming-status-receiving { color: var(--vscode-charts-blue, #3794ff); }
    .streaming-status-completed { color: var(--vscode-charts-green, #89d185); }
    .streaming-status-failed { color: var(--vscode-errorForeground, #f48771); }
    .option-row { display: flex; align-items: center; gap: 12px; font-size: 12px; }
    .checkbox-label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }

    /* ---- Composer: the bordered prompt area ---- */
    .composer { --accent: var(--vscode-focusBorder, #007acc); --stop: #d14545;
        display: flex; flex-direction: column; border: 1.5px solid var(--accent); border-radius: 8px;
        background: var(--vscode-input-background, #1e1e1e); position: relative; transition: border-color .2s, box-shadow .2s; }
    .composer:focus-within { box-shadow: 0 0 0 1px var(--accent); }
    .composer.drag-over { border-style: dashed; box-shadow: 0 0 0 2px var(--accent); }

    /* ---- Attachments: "+" menu and file chips ---- */
    .attach-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px 0; }
    .attach-chips:empty { display: none; }
    .attach-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 2px 4px 2px 8px; font-size: 12px;
        border-radius: 4px; background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); }
    .attach-chip .chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
    .attach-chip button.chip-remove { min-width: 0; width: 18px; height: 18px; padding: 0; border-radius: 3px; background: transparent;
        color: inherit; opacity: .7; font-size: 14px; line-height: 1; }
    .attach-chip button.chip-remove:hover { opacity: 1; background: rgba(128,128,128,.3); }
    .attach-wrap { position: relative; display: inline-flex; }
    .attach-menu { position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 20; min-width: 220px; padding: 4px;
        border-radius: 8px; border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, #454545));
        background: var(--vscode-menu-background, #252526); color: var(--vscode-menu-foreground, inherit);
        box-shadow: 0 4px 16px rgba(0,0,0,.35); }
    .attach-menu button.menu-item { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; padding: 7px 10px;
        border-radius: 5px; background: transparent; color: inherit; text-align: left; font-size: 13px; }
    .attach-menu button.menu-item:hover, .attach-menu button.menu-item:focus { outline: none;
        background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground, rgba(128,128,128,.2)));
        color: var(--vscode-menu-selectionForeground, inherit); }
    .attach-menu .menu-hint { padding: 6px 10px 4px; font-size: 11px; opacity: .65; border-top: 1px solid var(--vscode-menu-separatorBackground, rgba(128,128,128,.35)); margin-top: 4px; }
    .message .msg-attachments { margin-top: 6px; font-size: 12px; opacity: .85; }
    .composer textarea { border: none; outline: none; background: transparent; color: var(--vscode-input-foreground, inherit);
        min-height: 4lh; resize: none; padding: 10px 12px; }
    .composer textarea::placeholder { color: var(--vscode-input-placeholderForeground, #888); }
    .composer-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 6px 8px;
        border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); }
    .composer-toolbar .spacer { flex: 1; }
    .composer-toolbar .context-selector { margin-left: 0; }
    .composer button.icon-btn { min-width: 0; width: 30px; height: 30px; padding: 0; display: inline-flex; align-items: center;
        justify-content: center; border-radius: 6px; background: transparent; color: var(--vscode-foreground); }
    .composer button.icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
    .composer svg { width: 16px; height: 16px; display: block; }
    /* Send / Stop button */
    .composer button.send-btn { position: relative; min-width: 0; width: 32px; height: 32px; padding: 0; border-radius: 8px;
        display: inline-flex; align-items: center; justify-content: center;
        background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #fff); }
    .composer button.send-btn:hover { background: var(--vscode-button-hoverBackground, #005a9e); }
    .composer button.send-btn.empty { opacity: .45; }
    .send-btn .icon-stop { display: none; }
    .send-btn.running .icon-send { display: none; }
    .send-btn.running .icon-stop { display: block; }
    .composer button.send-btn.running { background: var(--stop); opacity: 1; }
    .composer button.send-btn.running:hover { background: #a03838; }
    /* Spinning ring around the STOP button: something is in progress */
    .send-btn.running::after { content: ''; position: absolute; inset: -4px; border-radius: 11px;
        border: 2px solid transparent; border-top-color: var(--stop); border-right-color: var(--stop);
        animation: shai-spin .9s linear infinite; pointer-events: none; }
    .composer.busy { --accent: var(--stop); animation: shai-pulse 1.6s ease-in-out infinite; }
    .busy-label { display: none; align-items: center; gap: 6px; font-size: 12px; color: var(--vscode-descriptionForeground, #999); }
    .composer.busy .busy-label { display: inline-flex; }
    .busy-label .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--stop); animation: shai-blink 1s ease-in-out infinite; }
    @keyframes shai-spin { to { transform: rotate(360deg); } }
    @keyframes shai-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(209,69,69,.0); } 50% { box-shadow: 0 0 0 3px rgba(209,69,69,.35); } }
    @keyframes shai-blink { 0%,100% { opacity: .25; } 50% { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) {
        .send-btn.running::after, .composer.busy, .busy-label .dot { animation: none; }
    }
</style>
</head>
<body>
<div class="tab-bar" id="tab-bar"></div>
<div class="chat-body">
<div class="messages" id="messages"></div>
<div class="controls">
    <div class="composer" id="composer">
        <div class="attach-chips" id="attach-chips"></div>
        <textarea id="prompt" placeholder="Ask shai… (Enter to send, Shift+Enter for a new line)"></textarea>
        <div class="composer-toolbar">
            <span class="attach-wrap">
                <button id="attach" class="icon-btn" title="Add files" aria-label="Add files" aria-haspopup="menu" aria-expanded="false">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>
                </button>
                <div class="attach-menu" id="attach-menu" role="menu" hidden>
                    <button class="menu-item" role="menuitem" data-attach="pickFiles">
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 4.5 5.4 9.6a1.4 1.4 0 0 0 2 2l5.3-5.3a2.8 2.8 0 0 0-4-4L3.4 7.6a4.2 4.2 0 0 0 6 6l4.1-4.1"/></svg>
                        <span>Upload or add files</span>
                    </button>
                    <button class="menu-item" role="menuitem" data-attach="addActiveFile">
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M4 1.5h5.5L12.5 4.5v10h-8.5z"/><path d="M9.5 1.5v3h3"/></svg>
                        <span>Add current file</span>
                    </button>
                    <button class="menu-item" role="menuitem" data-attach="addOpenEditors">
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2.5 3.5h8v9h-8z"/><path d="M5.5 1.5h8v9"/></svg>
                        <span>Add all open editors</span>
                    </button>
                    <div class="menu-hint">Tip: hold Shift and drop files from the Explorer here.</div>
                </div>
            </span>
            <button id="clear" class="icon-btn" title="Clear conversation" aria-label="Clear conversation">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5"/></svg>
            </button>
            <select id="context-selector" class="context-selector" title="Select active context">
                <option value="default">Default</option>
            </select>
            <span class="spacer"></span>
            <span class="busy-label" title="Press Esc or the STOP button to interrupt"><span class="dot"></span><span id="busy-text">shai is working…</span></span>
            <button id="send" class="send-btn empty" title="Send (Enter)" aria-label="Send">
                <svg class="icon-send" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>
                <svg class="icon-stop" viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor"/></svg>
            </button>
        </div>
    </div>
    <div class="option-row">
        <label class="checkbox-label"><input type="checkbox" id="no-extra-context" checked /> No extra context</label>
        <label class="checkbox-label"><input type="checkbox" id="autopilot" checked /> Autopilot</label>
        <span class="spacer" style="flex:1"></span>
        <span id="streaming-status" class="streaming-status streaming-status-idle" role="status" aria-live="polite"></span>
    </div>
</div>
</div>
<script>
(function(){
    const vscode = acquireVsCodeApi();
    const tabBar = document.getElementById('tab-bar');
    const sendBtn = document.getElementById('send');
    const clearBtn = document.getElementById('clear');
    const contextBadge = document.getElementById('active-context');
    const contextSelector = document.getElementById('context-selector');
    const noExtraContextCb = document.getElementById('no-extra-context');
    const autopilotCb = document.getElementById('autopilot');
    const prompt = document.getElementById('prompt');
    const messages = document.getElementById('messages');
    const streamingStatus = document.getElementById('streaming-status');
    let lastAssistantEl = null;
    let accumulatedText = ''; // Track raw text separately for streaming

    // --- Tab management ---
    let tabs = [];
    let activeTabId = null;
    let tabCounter = 0;

    function addTab() {
        tabCounter++;
        const id = 'tab-' + Date.now() + '-' + tabCounter;
        tabs.push({ id: id, label: 'Chat ' + tabCounter, html: '' });
        activateTab(id);
    }

    function activateTab(id) {
        if (activeTabId) {
            const cur = tabs.find(t => t.id === activeTabId);
            if (cur) cur.html = messages.innerHTML;
        }
        activeTabId = id;
        const tab = tabs.find(t => t.id === id);
        messages.innerHTML = tab ? tab.html : '';
        lastAssistantEl = null;
        accumulatedText = '';
        renderTabs();
    }

    function closeTab(id) {
        if (tabs.length <= 1) return;
        const idx = tabs.findIndex(t => t.id === id);
        if (idx === -1) return;
        tabs.splice(idx, 1);
        if (activeTabId === id) {
            activateTab(tabs[Math.min(idx, tabs.length - 1)].id);
        } else { renderTabs(); }
    }

    function renderTabs() {
        tabBar.innerHTML = '';
        tabs.forEach(tab => {
            const el = document.createElement('div');
            el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
            const lbl = document.createElement('span');
            lbl.textContent = tab.label;
            el.appendChild(lbl);
            if (tabs.length > 1) {
                const x = document.createElement('span');
                x.className = 'close-tab';
                x.textContent = '\\u00d7';
                x.addEventListener('click', e => { e.stopPropagation(); closeTab(tab.id); });
                el.appendChild(x);
            }
            el.addEventListener('click', () => activateTab(tab.id));
            tabBar.appendChild(el);
        });
    }

    addTab(); // Start with one tab

    function appendMessage(text, cls) {
        const el = document.createElement('div');
        el.className = 'message ' + cls;
        const content = document.createElement('div');
        content.className = 'message-content';
        content.innerHTML = formatMessage(text);
        el.appendChild(content);
        const ts = document.createElement('span');
        ts.className = 'message-timestamp';
        ts.textContent = new Date().toLocaleTimeString();
        el.appendChild(ts);
        messages.appendChild(el);
        // Auto-scroll to bottom when new message is added
        messages.scrollTop = messages.scrollHeight;
        return el;
    }

    // Update a message's formatted body without disturbing its timestamp.
    function setMessageContent(el, html) {
        if (!el) { return; }
        let content = el.querySelector('.message-content');
        if (!content) {
            content = document.createElement('div');
            content.className = 'message-content';
            el.insertBefore(content, el.firstChild);
        }
        content.innerHTML = html;
        // Auto-scroll when message content is updated
        messages.scrollTop = messages.scrollHeight;
    }
    
    // -----------------------------------------------------------------
    // Chat message formatting pipeline (ported from src/views/chatFormat.ts).
    // Fixed order: escape -> extract fenced code -> inline transforms ->
    // linkify (markdown links then bare URLs) -> nested lists ->
    // restore code blocks. Kept behaviorally identical to chatFormat.ts.
    // -----------------------------------------------------------------
    const CHAT_LINK_CLASS = 'chat-link';

    function escapeHtml(text) {
        return text
            .replace(/\\u0000/g, '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function isAllowedUrl(url) {
        if (typeof url !== 'string') { return false; }
        const trimmed = url.trim();
        if (trimmed.length === 0) { return false; }
        if (/[\\s\\u0000-\\u001f\\u007f]/.test(trimmed)) { return false; }
        return /^(?:https?|vscode|file):\\/\\//i.test(trimmed);
    }

    function makeCodeToken(index) {
        return '\\u0000CODEBLOCK_' + index + '\\u0000';
    }

    function makeLinkToken(index) {
        return '\\u0000CHATLINK_' + index + '\\u0000';
    }

    function extractFencedCode(escapedText) {
        const blocks = [];
        const fenceRe = /\`\`\`([^\\n\`]*)\\r?\\n?([\\s\\S]*?)\`\`\`/g;
        const text = escapedText.replace(fenceRe, (_match, langLabel, body) => {
            const token = makeCodeToken(blocks.length);
            blocks.push({
                lang: (langLabel || '').trim(),
                content: body.replace(/\\r?\\n$/, ''),
                token: token
            });
            return token;
        });
        return { text: text, blocks: blocks };
    }

    function escapeAttribute(escapedContent) {
        return escapedContent.replace(/"/g, '&quot;');
    }

    function renderCodeBlock(block) {
        const lang = block.lang || '';
        const langSpan = lang ? '<span class="code-lang">' + lang + '</span>' : '';
        const dataCode = escapeAttribute(block.content);
        return '<pre class="code-block" data-lang="' + lang + '">' +
            '<div class="code-header">' +
            langSpan +
            '<button class="copy-code-btn" type="button" data-code="' + dataCode + '">Copy</button>' +
            '</div>' +
            '<code>' + block.content + '</code>' +
            '</pre>';
    }

    function restoreCodeBlocks(text, blocks) {
        let restored = text;
        for (const block of blocks) {
            const html = renderCodeBlock(block);
            const idx = restored.indexOf(block.token);
            if (idx === -1) { continue; }
            restored = restored.slice(0, idx) + html + restored.slice(idx + block.token.length);
        }
        return restored;
    }

    function applyInlineTransforms(escapedCodeFreeText) {
        let out = escapedCodeFreeText;
        out = out.replace(/^(#{1,6})[ \\t]+(.*)$/gm, (_m, hashes, body) => {
            const level = hashes.length;
            return '<h' + level + '>' + body + '</h' + level + '>';
        });
        out = out.replace(/\\[ACTION:([^:]+):([^\\]]+)\\]/g, (_m, commandId, label) => {
            return '<button class="action-button" data-command="' + commandId + '">' + label + '</button>';
        });
        out = out.replace(/\\[BUTTON:([^:]+):([^\\]]+)\\]/g, (_m, label, data) => {
            return '<button class="action-button" data-action="' + label + '" data-value="' + data + '">' + label + '</button>';
        });
        out = out.replace(/\`([^\`]+)\`/g, '<code class="inline-code">$1</code>');
        out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
        out = out.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
        return out;
    }

    function renderAnchor(url, visibleText) {
        return '<a class="' + CHAT_LINK_CLASS + '" data-href="' + url + '">' + visibleText + '</a>';
    }

    function countChar(s, ch) {
        let n = 0;
        for (let i = 0; i < s.length; i++) {
            if (s[i] === ch) { n++; }
        }
        return n;
    }

    function splitTrailingPunctuation(match) {
        let end = match.length;
        while (end > 0) {
            const ch = match[end - 1];
            if (ch === ')') {
                const opens = countChar(match.slice(0, end), '(');
                const closes = countChar(match.slice(0, end), ')');
                if (closes > opens) { end--; continue; }
                break;
            }
            if ('.,;:!?]}\\'"'.indexOf(ch) !== -1) { end--; continue; }
            break;
        }
        return { url: match.slice(0, end), trailing: match.slice(end) };
    }

    function linkify(text) {
        const mdAnchors = [];
        let out = text.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, (match, label, url) => {
            if (!isAllowedUrl(url)) { return match; }
            const token = makeLinkToken(mdAnchors.length);
            mdAnchors.push(renderAnchor(url, label));
            return token;
        });
        out = out.replace(/(?:https?|vscode|file):\\/\\/[^\\s<]+/gi, (match) => {
            const parts = splitTrailingPunctuation(match);
            if (!isAllowedUrl(parts.url)) { return match; }
            return renderAnchor(parts.url, parts.url) + parts.trailing;
        });
        for (let i = 0; i < mdAnchors.length; i++) {
            const token = makeLinkToken(i);
            const idx = out.indexOf(token);
            if (idx === -1) { continue; }
            out = out.slice(0, idx) + mdAnchors[i] + out.slice(idx + token.length);
        }
        return out;
    }

    const LIST_ITEM_RE = /^([ \\t]*)(?:[-*]|\\d+\\.)[ \\t]+(.*)$/;

    function indentDepth(indent) {
        let depth = 0;
        let spaceRun = 0;
        for (const ch of indent) {
            if (ch === '\\t') {
                depth += Math.floor(spaceRun / 2);
                spaceRun = 0;
                depth += 1;
            } else {
                spaceRun += 1;
            }
        }
        depth += Math.floor(spaceRun / 2);
        return depth;
    }

    function renderList(items, cursor) {
        const levelDepth = items[cursor.i].depth;
        const tag = items[cursor.i].ordered ? 'ol' : 'ul';
        let html = '<' + tag + '>';
        while (cursor.i < items.length && items[cursor.i].depth >= levelDepth) {
            if (items[cursor.i].depth > levelDepth) {
                html += '<li>' + renderList(items, cursor) + '</li>';
                continue;
            }
            let liInner = items[cursor.i].content;
            cursor.i++;
            if (cursor.i < items.length && items[cursor.i].depth > levelDepth) {
                liInner += renderList(items, cursor);
            }
            html += '<li>' + liInner + '</li>';
        }
        html += '</' + tag + '>';
        return html;
    }

    function buildNestedLists(text) {
        const lines = text.split('\\n');
        const outParts = [];
        let run = [];
        const flush = () => {
            if (run.length > 0) {
                outParts.push(renderList(run, { i: 0 }));
                run = [];
            }
        };
        for (const line of lines) {
            const m = LIST_ITEM_RE.exec(line);
            if (m) {
                const indent = m[1];
                const body = m[2];
                const ordered = /^\\s*\\d+\\./.test(line);
                run.push({ depth: indentDepth(indent), ordered: ordered, content: body });
            } else {
                flush();
                outParts.push(line);
            }
        }
        flush();
        return outParts.join('\\n');
    }

    function formatMessage(text) {
        const escaped = escapeHtml(text);
        const extracted = extractFencedCode(escaped);
        let out = applyInlineTransforms(extracted.text);
        out = linkify(out);
        out = buildNestedLists(out);
        out = restoreCodeBlocks(out, extracted.blocks);
        return out;
    }

    // Track last received message to prevent duplication
    let lastReceivedMessage = '';
    // Track whether we're currently streaming a message to prevent duplicates
    let isStreaming = false;

    const composer = document.getElementById('composer');
    const busyText = document.getElementById('busy-text');
    let isRunning = false;
    let runStartedAt = 0;
    let runTimer = null;

    // Toggle the composer between "send" (arrow) and "running" (STOP square +
    // spinning ring + pulsing border + elapsed time).
    function setProcessing(active) {
        isRunning = !!active;
        if (runTimer) { clearInterval(runTimer); runTimer = null; }
        if (composer) { composer.classList.toggle('busy', isRunning); }
        if (sendBtn) {
            sendBtn.classList.toggle('running', isRunning);
            sendBtn.title = isRunning ? 'Stop (Esc) – interrupt shai like Ctrl+C' : 'Send (Enter)';
            sendBtn.setAttribute('aria-label', isRunning ? 'Stop' : 'Send');
        }
        if (isRunning) {
            runStartedAt = Date.now();
            const tick = () => {
                if (busyText) {
                    busyText.textContent = 'shai is working… ' + Math.floor((Date.now() - runStartedAt) / 1000) + 's';
                }
            };
            tick();
            runTimer = setInterval(tick, 1000);
        }
        updateEmptyState();
    }

    function updateEmptyState() {
        if (sendBtn) {
            sendBtn.classList.toggle('empty', !isRunning && !(prompt.value || '').trim() && attachments.length === 0);
        }
    }

    // --- Attachments ("+" menu, chips, drag & drop) ---
    const attachBtn = document.getElementById('attach');
    const attachMenu = document.getElementById('attach-menu');
    const attachChips = document.getElementById('attach-chips');
    let attachments = []; // [{ uri, name }]

    function renderAttachments() {
        if (!attachChips) { return; }
        attachChips.innerHTML = '';
        attachments.forEach((a, idx) => {
            const chip = document.createElement('span');
            chip.className = 'attach-chip';
            chip.title = a.uri;
            const name = document.createElement('span');
            name.className = 'chip-name';
            name.textContent = '📎 ' + a.name;
            chip.appendChild(name);
            const rm = document.createElement('button');
            rm.className = 'chip-remove';
            rm.type = 'button';
            rm.title = 'Remove ' + a.name;
            rm.setAttribute('aria-label', 'Remove ' + a.name);
            rm.textContent = '\\u00d7';
            rm.addEventListener('click', () => {
                attachments.splice(idx, 1);
                renderAttachments();
            });
            chip.appendChild(rm);
            attachChips.appendChild(chip);
        });
        updateEmptyState();
    }

    function addAttachments(files) {
        (files || []).forEach(f => {
            if (f && f.uri && !attachments.some(a => a.uri === f.uri)) {
                attachments.push({ uri: f.uri, name: f.name || f.uri });
            }
        });
        renderAttachments();
    }

    function setMenuOpen(open) {
        if (!attachMenu || !attachBtn) { return; }
        attachMenu.hidden = !open;
        attachBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
            const first = attachMenu.querySelector('.menu-item');
            if (first) { first.focus(); }
        }
    }

    attachBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        setMenuOpen(attachMenu ? attachMenu.hidden : false);
    });
    attachMenu?.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = e.target.closest('.menu-item');
        if (!item) { return; }
        setMenuOpen(false);
        vscode.postMessage({ type: item.getAttribute('data-attach') });
    });
    attachMenu?.addEventListener('keydown', (e) => {
        const items = Array.prototype.slice.call(attachMenu.querySelectorAll('.menu-item'));
        const i = items.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); setMenuOpen(false); attachBtn?.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    document.addEventListener('click', () => setMenuOpen(false));

    // Drag & drop from the VS Code Explorer (hold Shift) or the OS.
    function droppedUris(dt) {
        const raw = dt.getData('application/vnd.code.uri-list') || dt.getData('text/uri-list') || '';
        return raw.split(/\\r?\\n/).map(s => s.trim()).filter(s => s && s.charAt(0) !== '#');
    }
    if (composer) {
        composer.addEventListener('dragover', (e) => {
            e.preventDefault();
            composer.classList.add('drag-over');
        });
        composer.addEventListener('dragleave', () => composer.classList.remove('drag-over'));
        composer.addEventListener('drop', (e) => {
            e.preventDefault();
            composer.classList.remove('drag-over');
            const uris = e.dataTransfer ? droppedUris(e.dataTransfer) : [];
            if (uris.length > 0) {
                vscode.postMessage({ type: 'dropUris', uris: uris });
            }
        });
    }

    function requestStop() {
        if (!isRunning) { return; }
        if (busyText) { busyText.textContent = 'Stopping…'; }
        vscode.postMessage({ type: 'stop', tabId: activeTabId });
    }

    // --- Streaming status indicator (Req 5.1-5.6) ---
    // Mirror of the exported pure reducers nextStreamState/sendEnabled in
    // chatView.ts (the webview cannot import). Keep behaviorally identical.
    function nextStreamState(state, event) {
        switch (event) {
            case 'submit':   return 'sending';
            case 'progress': return (state === 'sending' || state === 'receiving') ? 'receiving' : state;
            case 'complete': return 'completed';
            case 'error':    return 'failed';
            default:         return state;
        }
    }
    function sendEnabled(state) {
        return state === 'idle' || state === 'completed' || state === 'failed';
    }
    const STREAM_LABELS = {
        idle: '',
        sending: 'Sending…',
        receiving: 'Receiving…',
        completed: 'Completed',
        failed: 'Failed',
    };
    let streamState = 'idle';

    function renderStreamingStatus() {
        if (streamingStatus) {
            streamingStatus.textContent = STREAM_LABELS[streamState] || '';
            streamingStatus.className = 'streaming-status streaming-status-' + streamState;
        }
        // The button stays clickable while running: it acts as STOP then.
    }

    // Apply a streaming event: advance the state machine, then layer the
    // indicator on top of the existing setProcessing behavior.
    function applyStreamEvent(event) {
        streamState = nextStreamState(streamState, event);
        renderStreamingStatus();
    }

    // Play a completion sound (two tones: high then low)
    function playCompletionSound() {
        try {
            // Create audio context
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            
            // Create first tone (high)
            const oscillator1 = audioContext.createOscillator();
            const gainNode1 = audioContext.createGain();
            oscillator1.connect(gainNode1);
            gainNode1.connect(audioContext.destination);
            
            oscillator1.type = 'sine';
            oscillator1.frequency.setValueAtTime(800, audioContext.currentTime); // High frequency
            gainNode1.gain.setValueAtTime(0.3, audioContext.currentTime);
            gainNode1.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
            
            // Create second tone (low)
            const oscillator2 = audioContext.createOscillator();
            const gainNode2 = audioContext.createGain();
            oscillator2.connect(gainNode2);
            gainNode2.connect(audioContext.destination);
            
            oscillator2.type = 'sine';
            oscillator2.frequency.setValueAtTime(400, audioContext.currentTime + 0.1); // Low frequency
            gainNode2.gain.setValueAtTime(0.3, audioContext.currentTime + 0.1);
            gainNode2.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
            
            // Play both tones
            oscillator1.start(audioContext.currentTime);
            oscillator1.stop(audioContext.currentTime + 0.2);
            oscillator2.start(audioContext.currentTime + 0.1);
            oscillator2.stop(audioContext.currentTime + 0.3);
        } catch (e) {
            // Silently fail if audio context is not available
            console.log("Could not play completion sound:", e);
        }
    }

    function submitPrompt() {
        if (isRunning || !sendEnabled(streamState)) return;
        const value = (prompt.value || '').trim();
        if (!value && attachments.length === 0) return;
        const sent = attachments.slice();
        const userEl = appendMessage(value, 'user');
        if (sent.length > 0) {
            const list = document.createElement('div');
            list.className = 'msg-attachments';
            list.textContent = sent.map(a => '📎 ' + a.name).join('   ');
            userEl.insertBefore(list, userEl.querySelector('.message-timestamp'));
        }
        vscode.postMessage({ type: 'chat-prompt', message: value, attachments: sent.map(a => a.uri), tabId: activeTabId, noExtraContext: noExtraContextCb?.checked || false, autopilot: autopilotCb?.checked || false });
        prompt.value = '';
        attachments = [];
        renderAttachments();
        setProcessing(true);
        applyStreamEvent('submit');
        lastAssistantEl = null;
        lastReceivedMessage = '';
        isStreaming = true;
    }

    // SEND button doubles as STOP while shai is running
    sendBtn?.addEventListener('click', () => {
        if (isRunning) { requestStop(); } else { submitPrompt(); }
    });

    // ENTER sends, ESC interrupts a running request
    prompt?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault(); // Prevent default new line behavior
            submitPrompt();
        } else if (event.key === 'Escape' && isRunning) {
            event.preventDefault();
            requestStop();
        }
    });
    prompt?.addEventListener('input', updateEmptyState);

    clearBtn?.addEventListener('click', () => {
        messages.innerHTML = '';
        lastAssistantEl = null;
        accumulatedText = '';
        const tab = tabs.find(t => t.id === activeTabId);
        if (tab) tab.html = '';
        vscode.postMessage({ type: 'clear', tabId: activeTabId });
    });

    // Handle context selector change
    contextSelector?.addEventListener('change', (event) => {
        const selectedId = event.target.value;
        if (selectedId) {
            vscode.postMessage({ type: 'switchContext', id: selectedId });
        }
    });

    // Decode HTML entities produced by escapeHtml/escapeAttribute back to the
    // original literal characters, so copied code matches the source exactly.
    function decodeHtmlEntities(s) {
        return s
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
    }

    // Handle clicks in the messages container (event delegation).
    messages.addEventListener('click', (event) => {
        // 1. Action buttons (existing behavior, unchanged).
        const actionBtn = event.target.closest('.action-button');
        if (actionBtn) {
            if (actionBtn.dataset.command) {
                vscode.postMessage({ type: 'executeCommand', commandId: actionBtn.dataset.command });
            } else if (actionBtn.dataset.action) {
                vscode.postMessage({ type: 'customAction', label: actionBtn.dataset.action, data: actionBtn.dataset.value });
            }
            return;
        }

        // 2. Chat links -> relay to host to open in the system browser.
        const link = event.target.closest('a.chat-link');
        if (link) {
            event.preventDefault();
            const url = link.getAttribute('data-href');
            if (url) {
                vscode.postMessage({ type: 'openExternal', url: url });
            }
            return;
        }

        // 3. Copy-code buttons -> copy decoded code to the clipboard.
        const copyBtn = event.target.closest('.copy-code-btn');
        if (copyBtn) {
            const raw = copyBtn.getAttribute('data-code') || '';
            const code = decodeHtmlEntities(raw);
            const original = copyBtn.textContent;
            try {
                navigator.clipboard.writeText(code).then(() => {
                    copyBtn.textContent = 'Copied';
                    setTimeout(() => { copyBtn.textContent = original; }, 1500);
                }).catch(() => { /* ignore clipboard write failures */ });
            } catch (e) {
                /* ignore clipboard write failures */
            }
            return;
        }
    });

    window.addEventListener('message', event => {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === 'stream') {
            // Accumulate raw text and format it
            if (!lastAssistantEl) {
                lastAssistantEl = appendMessage('', 'assistant');
                accumulatedText = '';
            }
            accumulatedText += msg.data;
            setMessageContent(lastAssistantEl, formatMessage(accumulatedText));
            messages.scrollTop = messages.scrollHeight;
        } else if (msg.type === 'complete') {
            if (msg.data) {
                if (!lastAssistantEl) {
                    lastAssistantEl = appendMessage(msg.data, 'assistant');
                } else {
                    setMessageContent(lastAssistantEl, formatMessage(msg.data || accumulatedText));
                }
            }
            lastAssistantEl = null;
            accumulatedText = '';
            setProcessing(false);
            applyStreamEvent('complete');
            
            // Play completion sound
            playCompletionSound();
        } else if (msg.type === 'streamingState') {
            // Host forwards a 'receiving' state while progress chunks stream. (Req 5.2)
            if (msg.state === 'receiving') {
                applyStreamEvent('progress');
            }
        } else if (msg.type === 'error') {
            // Error text is run through formatMessage (escaping applied first).
            const errEl = appendMessage('', 'assistant');
            setMessageContent(errEl, 'Error: ' + formatMessage(String(msg.data)));
            lastAssistantEl = null;
            accumulatedText = '';
            setProcessing(false);
            applyStreamEvent('error');
            
            // Play completion sound even on error
            playCompletionSound();
        } else if (msg.type === 'stopped') {
            if (isRunning) {
                const el = appendMessage('', 'assistant');
                setMessageContent(el, '<em>⏹ Interrupted by user.</em>');
            }
            lastAssistantEl = null;
            accumulatedText = '';
            setProcessing(false);
            streamState = 'idle';
            renderStreamingStatus();
            if (streamingStatus) {
                streamingStatus.textContent = 'Stopped';
                streamingStatus.className = 'streaming-status streaming-status-failed';
            }
        } else if (msg.type === 'clear') {
            messages.innerHTML = '';
            lastAssistantEl = null;
            accumulatedText = '';
            setProcessing(false);
            // Scroll to bottom after clearing (should be at top)
            messages.scrollTop = 0;
        } else if (msg.type === 'clearStreaming') {
            lastAssistantEl = null;
            accumulatedText = '';
        } else if (msg.type === 'restoreHistory') {
            messages.innerHTML = '';
            msg.messages.forEach(m => {
                appendMessage(m.message, m.type);
            });
            // Scroll to bottom after restoring history
            messages.scrollTop = messages.scrollHeight;
        } else if (msg.type === 'activeContext') {
            if (contextBadge) {
                contextBadge.textContent = '📌 ' + (msg.label || msg.id);
                contextBadge.title = 'Active context: ' + msg.id;
            }
            if (contextSelector) {
                // Ensure an option for the active id exists before selecting it;
                // otherwise setting .value silently fails and the selector desyncs
                // from the badge (e.g. when activeContext arrives before contextList).
                const hasOption = Array.prototype.some.call(
                    contextSelector.options,
                    (opt) => opt.value === msg.id
                );
                if (!hasOption) {
                    const opt = document.createElement('option');
                    opt.value = msg.id;
                    opt.textContent = msg.label || msg.id;
                    contextSelector.appendChild(opt);
                }
                contextSelector.value = msg.id;
            }
        } else if (msg.type === 'contextList') {
            if (contextSelector) {
                contextSelector.innerHTML = '';
                (msg.contexts || []).forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c.id;
                    opt.textContent = c.label;
                    contextSelector.appendChild(opt);
                });
                if (msg.activeId) {
                    contextSelector.value = msg.activeId;
                }
            }
        } else if (msg.type === 'addTab') {
            addTab();
        } else if (msg.type === 'attachmentsAdded') {
            addAttachments(msg.files);
            prompt?.focus();
        }
    });

    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}