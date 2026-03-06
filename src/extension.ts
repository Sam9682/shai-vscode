import * as vscode from 'vscode';
import { ChatController } from './chat/controller';
import { ChatViewProvider } from './views/chatView';
import { ReasoningViewProvider } from './views/reasoningView';
import { registerCommands } from './commands/commands';

let chatController: ChatController;

export function activate(context: vscode.ExtensionContext) {
    chatController = new ChatController(context);
    
    const chatViewProvider = new ChatViewProvider(
        context.extensionUri,
        chatController
    );
    
    const reasoningViewProvider = new ReasoningViewProvider(context.extensionUri);
    
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'shai-chat-view',
            chatViewProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        ),
        vscode.window.registerWebviewViewProvider(
            'shai-reasoning-view',
            reasoningViewProvider
        )
    );
    
    registerCommands(context, chatController);
}

export function deactivate() {
    chatController?.dispose();
}
