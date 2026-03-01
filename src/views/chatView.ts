import * as vscode from 'vscode';
import { ChatController } from '../chat/controller';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private currentTabId = 'default';
    private tabIdMap = new Map<vscode.WebviewView, string>();

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly chatController: ChatController
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this.view = webviewView;
        
        // Track which webview corresponds to which tab ID
        this.tabIdMap.set(webviewView, this.currentTabId);
        
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);
        
        // Send existing chat history to the webview when it's ready
        this.initializeChat();
        
        // Handle visibility changes to restore history when window is reopened
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                // Delay initialization slightly to ensure webview is fully ready
                setTimeout(() => {
                    this.initializeChat();
                }, 100);
            }
        });
        
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'chat-prompt':
                    await this.handleChatPrompt(data.message);
                    break;
                case 'clear':
                    this.handleClear();
                    break;
            }
        });
    }

    private initializeChat() {
        if (!this.view || !this.view.webview) return;
        
        // Get the correct tab ID for this webview
        const tabId = this.tabIdMap.get(this.view) || this.currentTabId;
        
        try {
            // Send existing chat history to the webview when it's ready
            const session = this.chatController.getSession(tabId);
            const messages = session.getMessages();
            if (messages.length > 0) {
                // Ensure the webview is ready before sending messages
                if (this.view.webview) {
                    this.view.webview.postMessage({
                        type: 'initChat',
                        messages: messages
                    });
                }
            }
        } catch (error) {
            console.error('Error initializing chat:', error);
        }
    }

    private async handleChatPrompt(message: string) {
        if (!this.view) return;

        this.view.webview.postMessage({
            type: 'chatMessage',
            message: { type: 'user', message }
        });

        // Show loading indicator immediately
        this.view.webview.postMessage({
            type: 'showLoading'
        });

        // Get the correct tab ID for this webview
        const tabId = this.tabIdMap.get(this.view) || this.currentTabId;
        const session = this.chatController.getSession(tabId);
        const response = await session.sendMessage(message);

        // Hide loading indicator and show response
        this.view.webview.postMessage({
            type: 'hideLoading'
        });
        
        this.view.webview.postMessage({
            type: 'chatMessage',
            message: { type: 'assistant', message: response.message }
        });
    }

    private handleClear() {
        if (!this.view) return;
        
        // Get the correct tab ID for this webview
        const tabId = this.tabIdMap.get(this.view) || this.currentTabId;
        const session = this.chatController.getSession(tabId);
        session.clear();
        this.view?.webview.postMessage({ type: 'clearChat' });
    }

    private getHtmlContent(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
        body { 
            margin: 0; 
            padding: 10px; 
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        #chat-container { 
            display: flex; 
            flex-direction: column; 
            height: 100vh; 
        }
        #messages { 
            flex: 1; 
            overflow-y: auto; 
            padding: 10px; 
            margin-bottom: 10px;
        }
        .message { 
            margin-bottom: 15px; 
            padding: 8px; 
            border-radius: 4px;
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .user { 
            background: var(--vscode-input-background);
            border-left: 3px solid var(--vscode-button-background);
            font-style: italic;
        }
        .assistant { 
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-left: 3px solid var(--vscode-textLink-foreground);
        }
        .loading { 
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
            margin: 5px 0;
        }
        .spinner {
            width: 20px;
            height: 20px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            border-top-color: var(--vscode-textLink-foreground);
            animation: spin 1s ease-in-out infinite;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .input-container { 
            display: flex; 
            gap: 5px; 
        }
        #input { 
            flex: 1; 
            padding: 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            resize: none;
            overflow: hidden;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            line-height: 1.4;
            min-height: 30px;
            max-height: 200px;
            box-sizing: border-box;
        }
        button { 
            padding: 8px 15px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
        }
        button:hover { 
            background: var(--vscode-button-hoverBackground);
        }
    </style>
</head>
<body>
    <div id="chat-container">
        <div id="messages"></div>
        <div class="input-container">
            <textarea id="input" placeholder="Ask Shai AI..." style="height: 30px;"></textarea>
            <button id="send">Send</button>
            <button id="clear">Clear</button>
        </div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const messages = document.getElementById('messages');
        const input = document.getElementById('input');
        
        // Auto-resize textarea function
        function autoResize() {
            this.style.height = 'auto';
            // Set height to scrollHeight to allow vertical growth
            const newHeight = Math.min(this.scrollHeight, 200);
            this.style.height = newHeight + 'px';
            
            // Ensure we don't go below minimum height
            if (this.scrollHeight < 30) {
                this.style.height = '30px';
            }
        }
        
        // Set up auto-resize for textarea
        input.addEventListener('input', autoResize);
        input.addEventListener('paste', function() {
            setTimeout(autoResize.bind(this), 0);
        });
        
        // Also trigger resize on focus to handle initial state
        input.addEventListener('focus', autoResize);
        
        // Handle window resize to maintain proper sizing
        window.addEventListener('resize', function() {
            if (document.activeElement === input) {
                autoResize.call(input);
            }
        });
        
        function addMessage(type, text) {
            const div = document.createElement('div');
            div.className = 'message ' + type;
            div.innerText = text;
            messages.appendChild(div);
            messages.scrollTop = messages.scrollHeight;
        }
        
        function addLoadingIndicator() {
            const div = document.createElement('div');
            div.className = 'message assistant loading';
            div.id = 'loading-indicator';
            div.innerHTML = '<div class="spinner"></div> Shai is thinking...';
            messages.appendChild(div);
            messages.scrollTop = messages.scrollHeight;
        }
        
        function removeLoadingIndicator() {
            const loadingElement = document.getElementById('loading-indicator');
            if (loadingElement) {
                loadingElement.remove();
            }
        }
        
        function sendMessage() {
            const msg = input.value.trim();
            if (msg) {
                addLoadingIndicator();
                vscode.postMessage({ type: 'chat-prompt', message: msg });
                input.value = '';
            }
        }
        
        document.getElementById('send').onclick = sendMessage;
        document.getElementById('clear').onclick = () => {
            vscode.postMessage({ type: 'clear' });
        };
        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                if (e.shiftKey) {
                    // Allow Shift+Enter for new line
                    return true;
                } else {
                    // Prevent default and send message
                    e.preventDefault();
                    sendMessage();
                    return false;
                }
            }
        };
        
        window.addEventListener('message', event => {
            const data = event.data;
            if (data.type === 'chatMessage') {
                removeLoadingIndicator();
                addMessage(data.message.type, data.message.message);
            } else if (data.type === 'clearChat') {
                removeLoadingIndicator();
                messages.innerHTML = '';
            } else if (data.type === 'initChat') {
                // Initialize chat with existing messages
                data.messages.forEach(msg => {
                    addMessage(msg.type, msg.message);
                });
            } else if (data.type === 'showLoading') {
                addLoadingIndicator();
            } else if (data.type === 'hideLoading') {
                removeLoadingIndicator();
            }
        });
    </script>
</body>
</html>`;
    }
}
