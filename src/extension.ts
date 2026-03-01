import * as vscode from 'vscode';
import { ChatController } from './chat/controller';
import { ChatViewProvider } from './views/chatView';
import { ReadmeViewProvider } from './views/readmeView';
import { registerCommands } from './commands/commands';

let chatController: ChatController;

export function activate(context: vscode.ExtensionContext) {
    chatController = new ChatController(context);
    
    const chatViewProvider = new ChatViewProvider(
        context.extensionUri,
        chatController
    );
    
    const readmeViewProvider = new ReadmeViewProvider(context.extensionUri);
    
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'shai-chat-view',
            chatViewProvider
        ),
        vscode.window.registerWebviewViewProvider(
            'shai-readme-view',
            readmeViewProvider
        )
    );
    
    registerCommands(context, chatController);
}

export function deactivate() {
    chatController?.dispose();
}
