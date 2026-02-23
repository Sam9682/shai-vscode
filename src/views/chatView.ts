import * as vscode from 'vscode';
import { ChatController } from '../chat/controller';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private currentTabId = 'default';

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly chatController: ChatController
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this.view = webviewView;
        
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);
        
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

    private async handleChatPrompt(message: string) {
        if (!this.view) return;

        this.view.webview.postMessage({
            type: 'chatMessage',
            message: { type: 'user', message }
        });

        const session = this.chatController.getSession(this.currentTabId);
        const response = await session.sendMessage(message);

        this.view.webview.postMessage({
            type: 'chatMessage',
            message: { type: 'assistant', message: response.message }
        });
    }

    private handleClear() {
        const session = this.chatController.getSession(this.currentTabId);
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
        }
        .assistant { 
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-left: 3px solid var(--vscode-textLink-foreground);
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
            <input type="text" id="input" placeholder="Ask Shai AI...">
            <button id="send">Send</button>
            <button id="clear">Clear</button>
        </div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const messages = document.getElementById('messages');
        const input = document.getElementById('input');
        
        function addMessage(type, text) {
            const div = document.createElement('div');
            div.className = 'message ' + type;
            div.innerText = text;
            messages.appendChild(div);
            messages.scrollTop = messages.scrollHeight;
        }
        
        function sendMessage() {
            const msg = input.value.trim();
            if (msg) {
                vscode.postMessage({ type: 'chat-prompt', message: msg });
                input.value = '';
            }
        }
        
        document.getElementById('send').onclick = sendMessage;
        document.getElementById('clear').onclick = () => {
            vscode.postMessage({ type: 'clear' });
        };
        input.onkeypress = (e) => { if (e.key === 'Enter') sendMessage(); };
        
        window.addEventListener('message', event => {
            const data = event.data;
            if (data.type === 'chatMessage') {
                addMessage(data.message.type, data.message.message);
            } else if (data.type === 'clearChat') {
                messages.innerHTML = '';
            }
        });
    </script>
</body>
</html>`;
    }
}
