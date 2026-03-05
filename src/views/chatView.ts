import * as vscode from 'vscode';
import { ChatController } from '../chat/controller';
import { ReasoningViewProvider } from './reasoningView';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'shai.chatView';
    private _view?: vscode.WebviewView;
    private controller: ChatController;

    constructor(private readonly extensionUri: vscode.Uri, contextOrController: vscode.ExtensionContext | ChatController) {
        if ((contextOrController as ChatController).getSession !== undefined) {
            this.controller = contextOrController as ChatController;
        } else {
            this.controller = new ChatController(contextOrController as vscode.ExtensionContext);
        }
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
        };

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (message) => {
            try {
                if (!this._view) return;
                const webview = this._view.webview;
                switch (message.type) {
                    case 'chat-prompt': {
                        const text: string = message.message || '';
                        if (!text.trim()) return;
                        webview.postMessage({ type: 'clearStreaming' });
                        this.handleChatPrompt(text, webview);
                        break;
                    }
                    case 'clear': {
                        webview.postMessage({ type: 'clear' });
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
                    await provider.handleChatPrompt(data.message, panel.webview);
                    break;
                case 'clear':
                    provider.handleClear(panel.webview);
                    break;
            }
        });
        return panel;
    }

    private async handleChatPrompt(message: string, webview: vscode.Webview) {
        const tabId = 'default';
        
        // Create a clean message for shell execution that doesn't contain problematic content
        // The actual formatting context will be handled by Shai's prompt processing
        const cleanMessage = message;

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
                const text: string = progress.data || '';
                
                if (progress.type === 'progress') {
                    // Process this chunk for reasoning extraction and send to UI
                    const cleanedText = extractAndForwardReasoning(text);
                    if (cleanedText.trim()) {
                        webview.postMessage({ type: 'stream', data: cleanedText });
                    }
                } else if (progress.type === 'complete') {
                    // For complete, we process the final text
                    const cleanedAccumulated = extractAndForwardReasoning(text);
                    webview.postMessage({ type: 'complete', data: cleanedAccumulated });
                } else if (progress.type === 'error') {
                    webview.postMessage({ type: 'error', data: text });
                }
            } catch (err) {
                console.error('Error in onProgress handler', err);
            }
        };

        try {
            // Pass only the clean user message to the Shai command
            // The formatting context will be handled by Shai's internal prompting
            await this.controller.getStreamingSession(tabId).executeCommandWithStreaming(cleanMessage, onProgress, this.controller.getInteractionMode(tabId));
        } catch (err: any) {
            webview.postMessage({ type: 'error', data: err?.message || String(err) });
        }
    }

    private handleClear(webview: vscode.Webview) {
        const tabId = 'default';
        try {
            const session = this.controller.getSession(tabId);
            session.clear();
        } catch (err) {
            console.error('Error clearing session', err);
        }
        webview.postMessage({ type: 'clearChat' });
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
    .controls { display:flex; gap:8px; }
    textarea { flex:1; min-height:40px; }
</style>
</head>
<body>
<div class="messages" id="messages"></div>
<div class="controls">
    <textarea id="prompt" placeholder="Type your prompt..."></textarea>
    <button id="send">Send</button>
    <button id="clear">Clear</button>
</div>
<script>
(function(){
    const vscode = acquireVsCodeApi();
    const sendBtn = document.getElementById('send');
    const clearBtn = document.getElementById('clear');
    const prompt = document.getElementById('prompt');
    const messages = document.getElementById('messages');
    let lastAssistantEl = null;

    function appendMessage(text, cls) {
        const el = document.createElement('div');
        el.className = 'message ' + cls;
        el.textContent = text;
        messages.appendChild(el);
        messages.scrollTop = messages.scrollHeight;
        return el;
    }

    // Handle SEND button click
    sendBtn?.addEventListener('click', () => {
        const value = (prompt.value || '').trim();
        if (!value) return;
        appendMessage(value, 'user');
        vscode.postMessage({ type: 'chat-prompt', message: value });
        prompt.value = '';
        lastAssistantEl = appendMessage('(thinking...)', 'assistant');
    });

    // Handle ENTER key press in textarea
    prompt?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault(); // Prevent default new line behavior
            const value = (prompt.value || '').trim();
            if (!value) return;
            appendMessage(value, 'user');
            vscode.postMessage({ type: 'chat-prompt', message: value });
            prompt.value = '';
            lastAssistantEl = appendMessage('(thinking...)', 'assistant');
        }
    });

    clearBtn?.addEventListener('click', () => {
        messages.innerHTML = '';
        vscode.postMessage({ type: 'clear' });
    });

    window.addEventListener('message', event => {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === 'stream') {
            if (!lastAssistantEl) lastAssistantEl = appendMessage('', 'assistant');
            lastAssistantEl.textContent = (lastAssistantEl.textContent === '(thinking...)' ? '' : lastAssistantEl.textContent) + msg.data;
            messages.scrollTop = messages.scrollHeight;
        } else if (msg.type === 'complete') {
            if (!lastAssistantEl) lastAssistantEl = appendMessage(msg.data, 'assistant');
            else lastAssistantEl.textContent = msg.data;
            lastAssistantEl = null;
        } else if (msg.type === 'error') {
            appendMessage('Error: ' + msg.data, 'assistant');
            lastAssistantEl = null;
        } else if (msg.type === 'clear') {
            messages.innerHTML = '';
            lastAssistantEl = null;
        } else if (msg.type === 'clearStreaming') {
            lastAssistantEl = null;
        }
    });
})();
</script>
</body>
</html>`;
    }
}