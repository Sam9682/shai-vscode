import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class ReadmeViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;

    constructor(extensionUri: vscode.Uri) {
        this._extensionUri = extensionUri;
    }

    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken): void | Thenable<void> {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media')
            ]
        };

        webviewView.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'ready':
                    this.showReadme();
                    break;
            }
        });

        webviewView.webview.html = this.getHtmlForWebview();
    }

    private getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Shai Setup Guide</title>
    <style>
        body {
            margin: 0;
            padding: 20px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
            line-height: 1.6;
            color: #333;
            background-color: #f8f9fa;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #2c3e50;
            border-bottom: 2px solid #3498db;
            padding-bottom: 10px;
        }
        h2 {
            color: #34495e;
        }
        code {
            background-color: #f1f1f1;
            padding: 2px 4px;
            border-radius: 3px;
            font-family: monospace;
        }
        pre {
            background-color: #f8f9fa;
            padding: 15px;
            border-radius: 5px;
            overflow-x: auto;
            border: 1px solid #eee;
        }
        ul, ol {
            padding-left: 20px;
        }
        a {
            color: #3498db;
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
        .header {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 20px;
        }
        .logo {
            width: 50px;
            height: 50px;
        }
        .loading {
            text-align: center;
            padding: 20px;
            color: #666;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MCIgaGVpZ2h0PSI1MCIgdmlld0JveD0iMCAwIDI0IDI0Ij48cGF0aCBmaWxsPSIjMzQ5OGRiIiBkPSJNMTEuNSAyLjVjLTIuNzYgMC01IDIuMjQtNSA1czIuMjQgNSA1IDUgNS0yLjI0IDUtNS0yLjI0LTUtNS01em0wIDguNWMtMS42NiAwLTMtMS4zNC0zLTMgMC0xLjY2IDEuMzQtMyAzLTMgMS42NiAwIDMgMS4zNCAzIDMgMCAxLjY2LTEuMzQgMy0zIDN6Ii8+PC9zdmc+" alt="Shai Logo" class="logo">
            <h1>Shai VS Code Setup Guide</h1>
        </div>
        <div id="readme-content" class="loading">Loading setup guide...</div>
    </div>
    <script>
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'showReadme':
                    document.getElementById('readme-content').innerHTML = message.content;
                    break;
            }
        });
        
        // Notify that we're ready to receive content
        window.vscode.postMessage({command: 'ready'});
    </script>
</body>
</html>`;
    }

    private async showReadme() {
        if (!this._view) return;

        try {
            // Get the path to the README file
            const readmePath = vscode.Uri.joinPath(this._extensionUri, 'README.md');
            
            // Read the README file content
            const readmeContent = await vscode.workspace.fs.readFile(readmePath);
            const content = Buffer.from(readmeContent).toString('utf-8');
            
            // Convert markdown to HTML (basic conversion)
            const htmlContent = this.convertMarkdownToHtml(content);
            
            // Send content to webview
            this._view.webview.postMessage({
                command: 'showReadme',
                content: htmlContent
            });
        } catch (error) {
            console.error('Failed to load README:', error);
            this._view.webview.postMessage({
                command: 'showReadme',
                content: '<p>Error loading setup guide: ' + (error as Error).message + '</p>'
            });
        }
    }

    private convertMarkdownToHtml(markdown: string): string {
        // Simple markdown to HTML converter
        let html = markdown
            .replace(/^# (.+)$/gm, '<h1>$1</h1>')
            .replace(/^## (.+)$/gm, '<h2>$1</h2>')
            .replace(/^### (.+)$/gm, '<h3>$1</h3>')
            .replace(/^\*\*([^*]+)\*\*$/gm, '<strong>$1</strong>')
            .replace(/^\*([^*]+)\*$/gm, '<em>$1</em>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^*]+)\*/g, '<em>$1</em>')
            .replace(/^- (.+)$/gm, '<li>$1</li>')
            .replace(/^(.+)$/gm, '<p>$1</p>')
            .replace(/<li>(.+)<\/li>/g, '<ul><li>$1</li></ul>')
            .replace(/\n\n/g, '</p><p>');

        // Handle code blocks
        html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
        
        // Handle links
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
        
        // Clean up extra paragraphs
        html = html.replace(/<p><\/p>/g, '');
        
        return html;
    }
}