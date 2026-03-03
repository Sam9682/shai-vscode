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
            if (data.type === 'showReasoning') {
                const el = document.getElementById('reasoning-content');
                if (el) {
                    el.textContent = data.reasoning;
                }
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
