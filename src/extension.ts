import * as vscode from 'vscode';
import { ChatController } from './chat/controller';
import { ChatViewProvider } from './views/chatView';
import { registerCommands } from './commands/commands';

let chatController: ChatController;

export function activate(context: vscode.ExtensionContext) {
    chatController = new ChatController(context);
    
    const chatViewProvider = new ChatViewProvider(
        context.extensionUri,
        chatController
    );
    
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'shai-chat-view',
            chatViewProvider
        )
    );
    
    registerCommands(context, chatController);
}

export function deactivate() {
    chatController?.dispose();
}
