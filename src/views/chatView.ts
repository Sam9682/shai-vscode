import * as vscode from 'vscode';
import { ChatController } from '../chat/controller';
import { ReasoningViewProvider } from './reasoningView';
import { buildPrompt } from '../context/promptBuilder';
import { PREDEFINED_CONTEXTS, ContextManager } from '../context/contextManager';

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
                switch (message.type) {
                    case 'chat-prompt': {
                        const text: string = message.message || '';
                        if (!text.trim()) return;
                        const tabId = message.tabId || this._displayedContextId;
                        webview.postMessage({ type: 'clearStreaming' });
                        this.handleChatPromptForTab(text, webview, tabId, message.noExtraContext || false, message.autopilot || false);
                        break;
                    }
                    case 'clear': {
                        const tabId = message.tabId || this._displayedContextId;
                        this.handleClearForTab(webview, tabId);
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
                        const url: string = message.url;
                        if (typeof url === 'string' && isHttpUrl(url)) {
                            await vscode.env.openExternal(vscode.Uri.parse(url));
                        }
                        // Non-http(s) schemes are silently rejected: no openExternal call.
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
            switch (data.type) {
                case 'chat-prompt':
                    await provider.handleChatPrompt(data.message, panel.webview, data.noExtraContext || false, data.autopilot || false);
                    break;
                case 'clear':
                    provider.handleClear(panel.webview);
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
                    const url: string = data.url;
                    if (typeof url === 'string' && isHttpUrl(url)) {
                        await vscode.env.openExternal(vscode.Uri.parse(url));
                    }
                    // Non-http(s) schemes are silently rejected: no openExternal call.
                    break;
                }
            }
        });
        return panel;
    }

    private async handleChatPrompt(message: string, webview: vscode.Webview, noExtraContext: boolean = false, autopilot: boolean = false) {
        const tabId = this._displayedContextId;
        const cleanMessage = message;

        // Build context-enriched prompt (includes systemPrompt if set)
        const contextManager = this.controller.getContextManager(tabId);
        const enrichedMessage = noExtraContext
            ? cleanMessage
            : buildPrompt(
                contextManager.getSummary(),
                contextManager.getRecentTurns(),
                cleanMessage,
                contextManager.getSystemPrompt()
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
            // Pass the context-enriched prompt to shai
            await this.controller.getStreamingSession(tabId).executeCommandWithStreaming(enrichedMessage, onProgress, this.controller.getInteractionMode(tabId), noExtraContext, autopilot);
            // The 'complete' callback above already sent the final answer to
            // the chat panel, so nothing else to do here.
        } catch (err: any) {
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

    private async handleChatPromptForTab(message: string, webview: vscode.Webview, tabId: string, noExtraContext: boolean = false, autopilot: boolean = false) {
        const cleanMessage = message;
        const contextManager = this.controller.getContextManager(tabId);
        const enrichedMessage = noExtraContext
            ? cleanMessage
            : buildPrompt(
                contextManager.getSummary(),
                contextManager.getRecentTurns(),
                cleanMessage,
                contextManager.getSystemPrompt()
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
            await this.controller.getStreamingSession(tabId).executeCommandWithStreaming(enrichedMessage, onProgress, this.controller.getInteractionMode(tabId), noExtraContext, autopilot);
        } catch (err: any) {
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
</style>
</head>
<body>
<div class="tab-bar" id="tab-bar"></div>
<div class="chat-body">
<div class="messages" id="messages"></div>
<div class="controls">
    <textarea id="prompt" placeholder="type your prompt..."></textarea>
    <div class="button-row">
        <button id="send">Send</button>
        <button id="clear" class="secondary">Clear</button>
        <label for="context-selector" style="margin-right: 8px;">Context:</label>
        <select id="context-selector" class="context-selector" title="Select active context">
            <option value="default">Default</option>
        </select>
    </div>
    <div class="status-row">
        <span id="streaming-status" class="streaming-status streaming-status-idle" role="status" aria-live="polite"></span>
    </div>
    <div class="option-row">
        <label class="checkbox-label"><input type="checkbox" id="no-extra-context" checked /> No extra context</label>
        <label class="checkbox-label"><input type="checkbox" id="autopilot" checked /> Autopilot</label>
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
        return /^https?:\\/\\//i.test(trimmed);
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
        out = out.replace(/https?:\\/\\/[^\\s<]+/gi, (match) => {
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

    function setProcessing(active) {
        if (sendBtn) {
            if (active) {
                sendBtn.disabled = true;
                sendBtn.textContent = 'Processing';
                sendBtn.classList.add('processing'); // Add processing class for red color
                let dotCount = 0;
                sendBtn._processingInterval = setInterval(() => {
                    dotCount = (dotCount + 1) % 4;
                    sendBtn.textContent = 'Processing' + '.'.repeat(dotCount);
                }, 400);
            } else {
                if (sendBtn._processingInterval) {
                    clearInterval(sendBtn._processingInterval);
                    sendBtn._processingInterval = null;
                }
                sendBtn.textContent = 'Send';
                sendBtn.disabled = false;
                sendBtn.classList.remove('processing'); // Remove processing class
            }
        }
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
        if (sendBtn) {
            sendBtn.disabled = !sendEnabled(streamState);
        }
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

    // Handle SEND button click
    sendBtn?.addEventListener('click', () => {
        const value = (prompt.value || '').trim();
        if (!value) return;
        appendMessage(value, 'user');
        vscode.postMessage({ type: 'chat-prompt', message: value, tabId: activeTabId, noExtraContext: noExtraContextCb?.checked || false, autopilot: autopilotCb?.checked || false });
        prompt.value = '';
        setProcessing(true);
        applyStreamEvent('submit');
        lastAssistantEl = null;
        lastReceivedMessage = '';
        isStreaming = true;
    });

    // Handle ENTER key press in textarea
    prompt?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault(); // Prevent default new line behavior
            const value = (prompt.value || '').trim();
            if (!value) return;
            appendMessage(value, 'user');
            vscode.postMessage({ type: 'chat-prompt', message: value, tabId: activeTabId, noExtraContext: noExtraContextCb?.checked || false, autopilot: autopilotCb?.checked || false });
            prompt.value = '';
            setProcessing(true);
            applyStreamEvent('submit');
            lastAssistantEl = null;
            lastReceivedMessage = '';
            isStreaming = true;
        }
    });

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
        }
    });

    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}