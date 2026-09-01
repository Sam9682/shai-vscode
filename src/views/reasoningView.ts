import * as vscode from 'vscode';

export class ReasoningViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    public static currentProvider?: ReasoningViewProvider;

    constructor(extensionUri: vscode.Uri) {
        this._extensionUri = extensionUri;
        ReasoningViewProvider.currentProvider = this;
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')]
        };

        webviewView.webview.html = this.getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(message => {
            // nothing to handle at the moment
        });
    }

    private getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Internal Reasoning</title>
    <style>
    body {
        margin: 0;
        padding: 20px;
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background-color: var(--vscode-editor-background);
        text-align: left;
    }
        .container {
            max-width: 800px;
            margin: 0 auto;
            max-height: 500px;
            overflow: auto;
            counter-reset: step-counter;
        }
    pre {
        white-space: pre-wrap;
        word-wrap: break-word;
        background: var(--vscode-editor-inactiveSelectionBackground);
        padding: 10px;
        border-radius: 4px;
    }
    .loading {
        color: var(--vscode-textPreformatForeground);
    }
    .step {
        margin-top: 8px;
        margin-bottom: 8px;
        padding: 8px;
-            background: var(--vscode-editor-inactiveSelectionBackground);
+            background: var(--vscode-editor-inactiveSelectionBackground);
        border-radius: 4px;
-            border: 1px solid var(--vscode-editorLineNumber-foreground);
+            border: 1px solid var(--vscode-editorLineNumber-foreground);
+            border-left: 4px solid var(--vscode-editorLineNumber-foreground);
+            position: relative;
+            overflow: hidden;
        counter-increment: step-counter;
    }
    .step::before {
        content: "Step " counter(step-counter) ": ";
        font-weight: bold;
        margin-right: 4px;
    }
    .resolution-step {
        background: var(--vscode-editorInfo-foreground);
    }
    .step::after {
-            content: '';
-            display: block;
-            height: 1px;
-            background: var(--vscode-editorLineNumber-foreground);
-            margin-top: 8px;
+            content: '';
+            display: block;
+            height: 1px;
+            background: var(--vscode-editorLineNumber-foreground);
+            margin-top: 8px;
    }
    </style>
</head>
<body>
    <div class="container">
        <div id="reasoning-content" class="loading">(no reasoning yet)</div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        window.addEventListener('message', event => {
            const data = event.data;
            const el = document.getElementById('reasoning-content');
            if (!el) return;
            if (data.type === 'showReasoning') {
                // Replace with a new step block
                el.innerHTML = '<div class="step reasoning-step">' + data.reasoning + '</div>';
            } else if (data.type === 'appendReasoning') {
                // Remove placeholder on first real chunk
                if (el.textContent === '(no reasoning yet)') {
                    el.innerHTML = '';
                }
                el.innerHTML += '<div class="step">' + data.chunk + '</div>';
                // Auto-scroll to bottom when new content is added
                el.parentElement.scrollTop = el.parentElement.scrollHeight;
            } else if (data.type === 'showResolution') {
                el.innerHTML = '<div class="step resolution-step">' + data.resolution + '</div>';
                // Auto-scroll to bottom when new content is added
                el.parentElement.scrollTop = el.parentElement.scrollHeight;
            } else if (data.type === 'clearReasoning') {
                el.innerHTML = '(no reasoning yet)';
            }
        });
    </script>
</body>
</html>`;
    }

    public showReasoning(reasoning: string) {
        if (this._view && this._view.webview) {
            this._view.webview.postMessage({ type: 'showReasoning', reasoning });
        }
    }

    public appendReasoning(chunk: string) {
        if (this._view && this._view.webview) {
            this._view.webview.postMessage({ type: 'appendReasoning', chunk });
        }
    }

    public clearReasoning() {
        if (this._view && this._view.webview) {
            this._view.webview.postMessage({ type: 'clearReasoning' });
        }
    }

    public showResolution(resolution: string) {
        if (this._view && this._view.webview) {
            this._view.webview.postMessage({ type: 'showResolution', resolution });
        }
    }

    public static openPanel(extensionUri: vscode.Uri) {
        const panel = vscode.window.createWebviewPanel(
            'shai-reasoning-panel',
            'Internal Reasoning',
            vscode.ViewColumn.Two,
            { enableScripts: true, localResourceRoots: [extensionUri] }
        );
        const provider = new ReasoningViewProvider(extensionUri);
        panel.webview.html = provider.getHtmlForWebview();
        panel.onDidDispose(() => {
            if (ReasoningViewProvider.currentProvider === provider) {
                ReasoningViewProvider.currentProvider = undefined;
            }
        });
        return panel;
    }
}
