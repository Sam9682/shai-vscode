import * as vscode from 'vscode';
import { DockerController } from '../docker/dockerController';
import { ChatController } from '../chat/controller';
import { PREDEFINED_CONTEXTS } from '../context/contextManager';
import { buildPrompt } from '../context/promptBuilder';

export class DeploymentsViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'shai-deployments-view';
    private _view?: vscode.WebviewView;
    private readonly _extensionUri: vscode.Uri;
    private readonly _dockerController: DockerController;
    private _chatController?: ChatController;

    constructor(extensionUri: vscode.Uri, dockerController: DockerController, chatController?: ChatController) {
        this._extensionUri = extensionUri;
        this._dockerController = dockerController;
        this._chatController = chatController;
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (!this._view) {
                return;
            }
            const webview = this._view.webview;

            switch (message.type) {
                case 'ready': {
                    await this.handleReady(webview);
                    break;
                }
                case 'deploy': {
                    await this.handleDeploy(message.file, webview);
                    break;
                }
                case 'stop': {
                    await this.handleStop(message.file, webview);
                    break;
                }
                case 'refresh': {
                    await this.handleReady(webview);
                    break;
                }
            }
        });
    }

    private async handleReady(webview: vscode.Webview): Promise<void> {
        const files = await this._dockerController.discoverComposeFiles();
        // Enrich each file with its parsed services and ports
        for (const file of files) {
            file.services = await this._dockerController.parseComposeServices(file.filePath);
        }
        webview.postMessage({ type: 'composeFiles', files });
    }

    private async handleDeploy(filePath: string, webview: vscode.Webview): Promise<void> {
        if (!filePath) {
            return;
        }

        // Check for concurrent deploy — Req 6.2
        const currentStatus = this._dockerController.getStatus(filePath);
        if (currentStatus === 'deploying') {
            webview.postMessage({
                type: 'warning',
                message: 'A deployment is already in progress for this file.',
            });
            return;
        }

        // Ask Shai to deploy the docker application
        const folder = this.extractFolder(filePath);
        await this.askShaiWithDockerComposeContext(
            `Start the application that is defined by the current docker-compose yaml file located in the folder ${folder}`,
            webview
        );

        const onOutput = (chunk: string) => {
            webview.postMessage({ type: 'log', data: chunk });
        };

        const result = await this._dockerController.deploy(filePath, { detached: true, build: true }, onOutput);

        // Docker/WSL not found — Req 7.3
        if (!result.success && (result.output.includes('not installed or not found') || result.output.includes('WSL is not installed'))) {
            webview.postMessage({
                type: 'error',
                message: result.output,
            });
        }

        // Timeout notification — Req 9.3
        if (!result.success && result.output.includes('timed out after')) {
            webview.postMessage({
                type: 'warning',
                message: 'Deployment timed out after 10 minutes.',
            });
        }

        webview.postMessage({
            type: 'deployResult',
            success: result.success,
            exitCode: result.exitCode,
        });
    }

    /**
     * Send a message to Shai using the "docker-compose" predefined context.
     * The user message is: the predefined docker-compose context systemPrompt
     * (from PREDEFINED_CONTEXTS in contextManager.ts) + the actionMessage.
     * The prompt is built using the docker-compose context conversation history.
     */
    private async askShaiWithDockerComposeContext(actionMessage: string, webview: vscode.Webview): Promise<void> {
        if (!this._chatController) {
            return;
        }

        const dockerComposeCtx = this._chatController.getContextManager('docker-compose');

        // Always use the predefined context value from contextManager.ts
        const predefined = PREDEFINED_CONTEXTS.find(c => c.id === 'docker-compose');
        const contextValue = predefined?.systemPrompt || '';

        // The message sent to Shai is the predefined context value + the action message
        const message = contextValue ? `${contextValue} ${actionMessage}` : actionMessage;

        // The system prompt used in the prompt envelope is the one persisted
        // in the docker-compose context (which the user may have customised)
        const systemPrompt = dockerComposeCtx.getSystemPrompt();

        try {
            const enrichedMessage = buildPrompt(
                dockerComposeCtx.getSummary(),
                dockerComposeCtx.getRecentTurns(),
                message,
                systemPrompt
            );

            const onProgress = (progress: any) => {
                if (progress.type === 'complete') {
                    const answer = (progress.data || '').trim();
                    dockerComposeCtx.addTurn('user', actionMessage);
                    dockerComposeCtx.addTurn('assistant', answer);
                    webview.postMessage({ type: 'log', data: `[Shai] ${answer}\n` });
                } else if (progress.type === 'progress') {
                    webview.postMessage({ type: 'log', data: progress.data || '' });
                }
            };

            await this._chatController
                .getStreamingSession('docker-compose')
                .executeCommandWithStreaming(enrichedMessage, onProgress, this._chatController.getInteractionMode('docker-compose'));
        } catch (err: any) {
            webview.postMessage({
                type: 'log',
                data: `[Shai Error] ${err?.message || String(err)}\n`,
            });
        }
    }

    /** Extract the parent folder from a file path for display. */
    private extractFolder(filePath: string): string {
        const parts = filePath.replace(/\\/g, '/').split('/');
        parts.pop(); // remove filename
        return parts.join('/') || '.';
    }

    private async handleStop(filePath: string, webview: vscode.Webview): Promise<void> {
        if (!filePath) {
            return;
        }

        // Ask Shai to stop the docker application
        const folder = this.extractFolder(filePath);
        await this.askShaiWithDockerComposeContext(
            `Stop the application that is defined by the current docker-compose yaml file located in the folder ${folder}`,
            webview
        );

        const result = await this._dockerController.stop(filePath);

        webview.postMessage({
            type: 'stopResult',
            success: result.success,
        });
    }

    public static openPanel(extensionUri: vscode.Uri, dockerController: DockerController, chatController?: ChatController) {
        const panel = vscode.window.createWebviewPanel(
            DeploymentsViewProvider.viewType,
            'Docker Deployments',
            vscode.ViewColumn.One,
            { enableScripts: true, localResourceRoots: [extensionUri] }
        );
        const provider = new DeploymentsViewProvider(extensionUri, dockerController, chatController);
        panel.webview.html = provider.getHtmlContent(panel.webview);
        panel.webview.onDidReceiveMessage(async (message) => {
            const webview = panel.webview;
            switch (message.type) {
                case 'ready': {
                    await provider.handleReady(webview);
                    break;
                }
                case 'deploy': {
                    await provider.handleDeploy(message.file, webview);
                    break;
                }
                case 'stop': {
                    await provider.handleStop(message.file, webview);
                    break;
                }
                case 'refresh': {
                    await provider.handleReady(webview);
                    break;
                }
            }
        });
        return panel;
    }

    private getHtmlContent(_webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Docker Deployments</title>
    <style>
        body {
            margin: 0;
            padding: 8px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }

        .toolbar {
            display: flex;
            justify-content: flex-end;
            margin-bottom: 8px;
        }

        .toolbar button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 4px 10px;
            cursor: pointer;
            border-radius: 2px;
            font-size: var(--vscode-font-size);
        }

        .toolbar button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .placeholder {
            opacity: 0.7;
            text-align: center;
            margin-top: 40px;
        }

        .file-list {
            list-style: none;
            margin: 0;
            padding: 0;
        }

        .file-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 4px;
            border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
        }

        .file-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .status-badge {
            font-size: 0.85em;
            padding: 1px 6px;
            border-radius: 3px;
            white-space: nowrap;
        }

        .status-idle       { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
        .status-deploying   { background: var(--vscode-progressBar-background); color: #fff; }
        .status-running     { background: var(--vscode-testing-iconPassed, #388a34); color: #fff; }
        .status-stopping    { background: var(--vscode-editorWarning-foreground, #cca700); color: #000; }
        .status-error       { background: var(--vscode-errorForeground, #f44747); color: #fff; }

        .file-actions button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 3px 8px;
            cursor: pointer;
            border-radius: 2px;
            font-size: var(--vscode-font-size);
        }

        .file-actions button:hover:not(:disabled) {
            background: var(--vscode-button-hoverBackground);
        }

        .file-actions button:disabled {
            opacity: 0.5;
            cursor: default;
        }

        .file-actions {
            display: flex;
            gap: 4px;
        }

        .services-list {
            list-style: none;
            margin: 2px 0 0 16px;
            padding: 0;
            width: 100%;
        }

        .service-item {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 2px 4px;
            font-size: 0.9em;
            opacity: 0.85;
        }

        .service-name {
            font-weight: 600;
        }

        .service-ports {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground, rgba(200,200,200,0.7));
        }

        #messages {
            margin-top: 8px;
        }

        .msg {
            padding: 6px 8px;
            margin-bottom: 4px;
            border-radius: 3px;
            font-size: 0.9em;
        }

        .msg-warning {
            background: var(--vscode-inputValidation-warningBackground, rgba(204,167,0,0.15));
            border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
        }

        .msg-error {
            background: var(--vscode-inputValidation-errorBackground, rgba(244,71,71,0.15));
            border: 1px solid var(--vscode-errorForeground, #f44747);
        }

        #log-area {
            margin-top: 8px;
        }

        #log-area summary {
            cursor: pointer;
            user-select: none;
            font-weight: 600;
            margin-bottom: 4px;
        }

        #log-output {
            background: var(--vscode-terminal-background, var(--vscode-editor-background));
            color: var(--vscode-terminal-foreground, var(--vscode-foreground));
            border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
            border-radius: 3px;
            padding: 6px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.85em;
            max-height: 300px;
            overflow-y: auto;
            white-space: pre-wrap;
            word-break: break-all;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <button id="refresh-btn" title="Refresh compose file list">Refresh</button>
    </div>
    <div id="file-list-container">
        <div class="placeholder" id="placeholder">Loading deployments\u2026</div>
        <ul class="file-list" id="file-list" style="display:none;"></ul>
    </div>
    <div id="messages"></div>
    <details id="log-area" open>
        <summary>Logs <button id="clean-log-btn" title="Clear logs" style="margin-left:8px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;padding:2px 8px;cursor:pointer;border-radius:2px;font-size:var(--vscode-font-size);">Clean</button></summary>
        <pre id="log-output"></pre>
    </details>
    <script>
    (function() {
        const vscode = acquireVsCodeApi();
        const fileListEl = document.getElementById('file-list');
        const placeholderEl = document.getElementById('placeholder');
        const messagesEl = document.getElementById('messages');
        const logOutput = document.getElementById('log-output');
        const refreshBtn = document.getElementById('refresh-btn');
        const cleanLogBtn = document.getElementById('clean-log-btn');

        let currentFiles = [];
        let fileStatuses = {};

        function escapeHtml(text) {
            const d = document.createElement('div');
            d.textContent = text;
            return d.innerHTML;
        }

        function renderFiles(files) {
            currentFiles = files || [];
            if (currentFiles.length === 0) {
                placeholderEl.textContent = 'No docker-compose.yml found in workspace root.';
                placeholderEl.style.display = '';
                fileListEl.style.display = 'none';
                return;
            }
            placeholderEl.style.display = 'none';
            fileListEl.style.display = '';
            fileListEl.innerHTML = '';

            currentFiles.forEach(function(f) {
                var status = fileStatuses[f.filePath] || 'idle';
                var li = document.createElement('li');
                li.className = 'file-item';
                li.setAttribute('data-filepath', f.filePath);
                li.style.flexWrap = 'wrap';

                var nameSpan = document.createElement('span');
                nameSpan.className = 'file-name';
                nameSpan.textContent = f.fileName;
                nameSpan.title = f.relativePath;

                var badge = document.createElement('span');
                badge.className = 'status-badge status-' + status;
                badge.textContent = status;

                var actions = document.createElement('span');
                actions.className = 'file-actions';

                var deployBtn = document.createElement('button');
                deployBtn.textContent = 'Deploy';
                deployBtn.disabled = (status === 'deploying' || status === 'stopping');
                deployBtn.addEventListener('click', function() {
                    vscode.postMessage({ type: 'deploy', file: f.filePath });
                    setStatus(f.filePath, 'deploying');
                });

                var stopBtn = document.createElement('button');
                stopBtn.textContent = 'Stop';
                stopBtn.disabled = !(status === 'running' || status === 'deploying');
                stopBtn.addEventListener('click', function() {
                    vscode.postMessage({ type: 'stop', file: f.filePath });
                    setStatus(f.filePath, 'stopping');
                });

                actions.appendChild(deployBtn);
                actions.appendChild(stopBtn);

                li.appendChild(nameSpan);
                li.appendChild(badge);
                li.appendChild(actions);

                // Render services and ports
                if (f.services && f.services.length > 0) {
                    var svcList = document.createElement('ul');
                    svcList.className = 'services-list';
                    f.services.forEach(function(svc) {
                        var svcItem = document.createElement('li');
                        svcItem.className = 'service-item';

                        var svcName = document.createElement('span');
                        svcName.className = 'service-name';
                        svcName.textContent = svc.name;
                        svcItem.appendChild(svcName);

                        if (svc.ports && svc.ports.length > 0) {
                            var svcPorts = document.createElement('span');
                            svcPorts.className = 'service-ports';
                            svcPorts.textContent = svc.ports.join(', ');
                            svcItem.appendChild(svcPorts);
                        } else {
                            var noPorts = document.createElement('span');
                            noPorts.className = 'service-ports';
                            noPorts.textContent = '(no ports)';
                            svcItem.appendChild(noPorts);
                        }

                        svcList.appendChild(svcItem);
                    });
                    li.appendChild(svcList);
                }

                fileListEl.appendChild(li);
            });
        }

        function setStatus(filePath, status) {
            fileStatuses[filePath] = status;
            renderFiles(currentFiles);
        }

        function appendLog(text) {
            logOutput.textContent += text;
            logOutput.scrollTop = logOutput.scrollHeight;
        }

        function showMessage(text, type) {
            var div = document.createElement('div');
            div.className = 'msg msg-' + type;
            div.textContent = text;
            messagesEl.appendChild(div);
            // Auto-remove after 10 seconds
            setTimeout(function() {
                if (div.parentNode) { div.parentNode.removeChild(div); }
            }, 10000);
        }

        refreshBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'refresh' });
        });

        cleanLogBtn.addEventListener('click', function(e) {
            e.stopPropagation(); // prevent toggling the <details> element
            logOutput.textContent = '';
        });

        window.addEventListener('message', function(event) {
            var msg = event.data;
            if (!msg) { return; }

            switch (msg.type) {
                case 'composeFiles':
                    renderFiles(msg.files);
                    break;
                case 'log':
                    appendLog(msg.data || '');
                    break;
                case 'deployResult':
                    // Find which file this result is for based on current deploying status
                    for (var fp in fileStatuses) {
                        if (fileStatuses[fp] === 'deploying') {
                            setStatus(fp, msg.success ? 'running' : 'error');
                            break;
                        }
                    }
                    break;
                case 'stopResult':
                    for (var sp in fileStatuses) {
                        if (fileStatuses[sp] === 'stopping') {
                            setStatus(sp, msg.success ? 'idle' : 'error');
                            break;
                        }
                    }
                    break;
                case 'warning':
                    showMessage(msg.message || 'Warning', 'warning');
                    break;
                case 'error':
                    showMessage(msg.message || 'An error occurred.', 'error');
                    break;
            }
        });

        // Signal ready
        vscode.postMessage({ type: 'ready' });
    })();
    </script>
</body>
</html>`;
    }
}
