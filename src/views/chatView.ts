import * as vscode from 'vscode';
import { ChatController } from '../chat/controller';
import { ReasoningViewProvider } from './reasoningView';
import { buildPrompt } from '../context/promptBuilder';
import { PREDEFINED_CONTEXTS } from '../context/contextManager';

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
        this._displayedContextId = this.controller.getActiveContextId();
    }

    /** Start a brand-new chat session (called from the title-bar + icon command). */
    public newChat(): void {
        const tabId = this._displayedContextId;
        try {
            const session = this.controller.getSession(tabId);
            session.clear();
            this.controller.getContextManager(tabId).clear();
            this.controller.deleteSession(tabId);
        } catch (err) {
            console.error('Error starting new chat', err);
        }
        if (this._view) {
            this._view.webview.postMessage({ type: 'clear' });
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
                        webview.postMessage({ type: 'clearStreaming' });
                        this.handleChatPrompt(text, webview, message.noExtraContext || false);
                        break;
                    }
                    case 'clear': {
                        this.handleClear(webview);
                        break;
                    }
                    case 'ready': {
                        this.restoreHistory(webview);
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
                            this.restoreHistory(webview);
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
                    await provider.handleChatPrompt(data.message, panel.webview, data.noExtraContext || false);
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
            }
        });
        return panel;
    }

    private async handleChatPrompt(message: string, webview: vscode.Webview, noExtraContext: boolean = false) {
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
            await this.controller.getStreamingSession(tabId).executeCommandWithStreaming(enrichedMessage, onProgress, this.controller.getInteractionMode(tabId), noExtraContext);
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
        const id = this.controller.getActiveContextId();
        this._displayedContextId = id;
        const preset = PREDEFINED_CONTEXTS.find(c => c.id === id);
        webview.postMessage({
            type: 'activeContext',
            id,
            label: preset ? preset.label : id,
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

    private getHtmlContent(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Shai Chat</title>
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: transparent; margin: 8px; }
    .messages { max-height: 60vh; overflow: auto; margin-bottom: 8px; }
    .message { padding: 8px; border-radius: 6px; margin-bottom: 6px; white-space: pre-wrap; word-wrap: break-word; }
    .user { background: var(--vscode-editor-selectionBackground); }
    .assistant { background: var(--vscode-editorWidget-background); }
    .controls { display:flex; flex-direction: column; gap:8px; }
    button.secondary { background: var(--vscode-button-secondaryBackground, #3c3c3c); color: var(--vscode-button-secondaryForeground, #fff); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #454545); }
    textarea { width: 100%; min-height:40px; box-sizing: border-box; }
    .button-row { display: flex; gap: 8px; }
    button { background: #007acc; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; min-width: 100px; }
    button:hover { background: #005a9e; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    button:disabled:hover { background: #007acc; }
    .action-button {
        display: inline-block;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        padding: 6px 12px;
        margin: 4px 4px 4px 0;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        transition: background 0.2s;
    }
    .action-button:hover {
        background: var(--vscode-button-hoverBackground);
    }
    .context-badge {
        display: inline-flex;
        align-items: center;
        margin-left: auto;
        padding: 4px 10px;
        font-size: 12px;
        border-radius: 4px;
        background: var(--vscode-badge-background, #4d4d4d);
        color: var(--vscode-badge-foreground, #fff);
        white-space: nowrap;
        user-select: none;
    }
    .context-selector {
        margin-left: auto;
        padding: 4px 8px;
        font-size: 12px;
        border-radius: 4px;
        background: var(--vscode-dropdown-background, #3c3c3c);
        color: var(--vscode-dropdown-foreground, #fff);
        border: 1px solid var(--vscode-dropdown-border, #555);
        cursor: pointer;
        outline: none;
    }
    .context-selector:focus {
        border-color: var(--vscode-focusBorder, #007acc);
    }
    .option-row {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 12px;
    }
    .checkbox-label {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        user-select: none;
    }
</style>
</head>
<body>
<div class="messages" id="messages"></div>
<div class="controls">
    <textarea id="prompt" placeholder="type your prompt..."></textarea>
    <div class="button-row">
        <button id="send">Send</button>
        <button id="clear" class="secondary">Clear</button>
        <select id="context-selector" class="context-selector" title="Select active context">
            <option value="default">Default</option>
        </select>
        <span id="active-context" class="context-badge" title="Active Shai context"></span>
    </div>
    <div class="option-row">
        <label class="checkbox-label"><input type="checkbox" id="no-extra-context" /> No extra context</label>
    </div>
</div>
<script>
(function(){
    const vscode = acquireVsCodeApi();
    const sendBtn = document.getElementById('send');
    const clearBtn = document.getElementById('clear');
    const contextBadge = document.getElementById('active-context');
    const contextSelector = document.getElementById('context-selector');
    const noExtraContextCb = document.getElementById('no-extra-context');
    const prompt = document.getElementById('prompt');
    const messages = document.getElementById('messages');
    let lastAssistantEl = null;
    let accumulatedText = ''; // Track raw text separately for streaming

    function appendMessage(text, cls) {
        const el = document.createElement('div');
        el.className = 'message ' + cls;
        el.innerHTML = formatMessage(text);
        messages.appendChild(el);
        messages.scrollTop = messages.scrollHeight;
        return el;
    }
    
    function formatMessage(text) {
        // Convert newlines to <br> and handle basic markdown
        let formatted = text.replace(/\\n/g, '<br>');
        
        // Handle ACTION buttons: [ACTION:commandId:label]
        formatted = formatted.replace(/\\[ACTION:([^:]+):([^\\]]+)\\]/g, (match, commandId, label) => {
            return \`<button class="action-button" data-command="\${commandId}">\${label}</button>\`;
        });
        
        // Handle custom BUTTON actions: [BUTTON:label:data]
        formatted = formatted.replace(/\\[BUTTON:([^:]+):([^\\]]+)\\]/g, (match, label, data) => {
            return \`<button class="action-button" data-action="\${label}" data-value="\${data}">\${label}</button>\`;
        });
        
        // Handle code blocks (\`\`\`code\`\`\`)
        formatted = formatted.replace(/\`{3}([^\`]+)\`{3}/g, '<pre style="background: #f4f4f4; padding: 8px; border-radius: 4px; overflow-x: auto;"><code>$1</code></pre>');
        
        // Handle inline code (\`code\`)
        formatted = formatted.replace(/\`([^\`]+)\`/g, '<code style="background: #f4f4f4; padding: 2px 4px; border-radius: 3px;">$1</code>');
        
        // Handle bold text (**bold**)
        formatted = formatted.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
        
        // Handle italic text (*italic*)
        formatted = formatted.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
        
        return formatted;
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
            }
        }
    }

    // Handle SEND button click
    sendBtn?.addEventListener('click', () => {
        const value = (prompt.value || '').trim();
        if (!value) return;
        appendMessage(value, 'user');
        vscode.postMessage({ type: 'chat-prompt', message: value, noExtraContext: noExtraContextCb?.checked || false });
        prompt.value = '';
        setProcessing(true);
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
            vscode.postMessage({ type: 'chat-prompt', message: value, noExtraContext: noExtraContextCb?.checked || false });
            prompt.value = '';
            setProcessing(true);
            lastAssistantEl = null;
            lastReceivedMessage = '';
            isStreaming = true;
        }
    });

    clearBtn?.addEventListener('click', () => {
        messages.innerHTML = '';
        vscode.postMessage({ type: 'clear' });
    });

    // Handle context selector change
    contextSelector?.addEventListener('change', (event) => {
        const selectedId = event.target.value;
        if (selectedId) {
            vscode.postMessage({ type: 'switchContext', id: selectedId });
        }
    });

    // Handle clicks on action buttons (event delegation)
    messages.addEventListener('click', (event) => {
        const target = event.target;
        if (target.classList.contains('action-button')) {
            if (target.dataset.command) {
                // Execute VS Code command
                vscode.postMessage({ type: 'executeCommand', commandId: target.dataset.command });
            } else if (target.dataset.action) {
                // Custom action
                vscode.postMessage({ type: 'customAction', label: target.dataset.action, data: target.dataset.value });
            }
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
            lastAssistantEl.innerHTML = formatMessage(accumulatedText);
            messages.scrollTop = messages.scrollHeight;
        } else if (msg.type === 'complete') {
            if (msg.data) {
                if (!lastAssistantEl) {
                    lastAssistantEl = appendMessage(msg.data, 'assistant');
                } else {
                    lastAssistantEl.innerHTML = formatMessage(msg.data || accumulatedText);
                }
            }
            lastAssistantEl = null;
            accumulatedText = '';
            setProcessing(false);
        } else if (msg.type === 'error') {
            appendMessage('Error: ' + msg.data, 'assistant');
            lastAssistantEl = null;
            accumulatedText = '';
            setProcessing(false);
        } else if (msg.type === 'clear') {
            messages.innerHTML = '';
            lastAssistantEl = null;
            accumulatedText = '';
            setProcessing(false);
        } else if (msg.type === 'clearStreaming') {
            lastAssistantEl = null;
            accumulatedText = '';
        } else if (msg.type === 'restoreHistory') {
            messages.innerHTML = '';
            msg.messages.forEach(m => {
                appendMessage(m.message, m.type);
            });
        } else if (msg.type === 'activeContext') {
            if (contextBadge) {
                contextBadge.textContent = '📌 ' + (msg.label || msg.id);
                contextBadge.title = 'Active context: ' + msg.id;
            }
            if (contextSelector) {
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
        }
    });

    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}