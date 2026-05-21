import * as vscode from 'vscode';
import { ChatController } from './chat/controller';
import { ChatViewProvider } from './views/chatView';
import { ReasoningViewProvider } from './views/reasoningView';
import { DockerController } from './docker/dockerController';
import { DeploymentsViewProvider } from './views/deploymentsView';
import { registerCommands } from './commands/commands';

let chatController: ChatController;
let dockerController: DockerController;

export function activate(context: vscode.ExtensionContext) {
    if (context.extensionMode === vscode.ExtensionMode.Development) {
        const dev = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        dev.text = '$(beaker) Shai DEV';
        dev.tooltip =
            'This window loaded shai-vscode from extensionDevelopmentPath (your local out/ folder).';
        dev.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        dev.show();
        context.subscriptions.push(dev);
    }

    chatController = new ChatController(context);
    dockerController = new DockerController(context);

    // Status bar — shows the active context name, click to open editor
    const ctxBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    ctxBar.command = 'shai-vscode.openContextEditor';
    const updateCtxBar = (id: string) => {
        ctxBar.text = `$(comment-discussion) Shai: ${id}`;
        ctxBar.tooltip = `Active Shai context: "${id}" — click to open context editor`;
    };
    updateCtxBar(chatController.getActiveContextId());
    ctxBar.show();
    context.subscriptions.push(
        ctxBar,
        chatController.onActiveContextChanged(updateCtxBar)
    );

    const chatViewProvider = new ChatViewProvider(
        context.extensionUri,
        chatController
    );
    
    const reasoningViewProvider = new ReasoningViewProvider(context.extensionUri);

    const deploymentsViewProvider = new DeploymentsViewProvider(
        context.extensionUri,
        dockerController,
        chatController
    );
    
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'shai-chat-view',
            chatViewProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        ),
        vscode.window.registerWebviewViewProvider(
            'shai-reasoning-view',
            reasoningViewProvider
        ),
        vscode.window.registerWebviewViewProvider(
            'shai-deployments-view',
            deploymentsViewProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );
    
    registerCommands(context, chatController, dockerController);

    // Register newChat command here since it needs the chatViewProvider instance
    context.subscriptions.push(
        vscode.commands.registerCommand('shai-vscode.newChat', () => {
            chatViewProvider.newChat();
        })
    );
}

export function deactivate() {
    chatController?.dispose();
    dockerController?.dispose();
}
