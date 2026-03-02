import * as vscode from 'vscode';
import { ChatController } from '../chat/controller';
import { ChatViewProvider } from '../views/chatView';
import { ReadmeViewProvider } from '../views/readmeView';

export function registerCommands(
    context: vscode.ExtensionContext,
    chatController: ChatController
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('shai-vscode.openChat', () => {
            // open chat in standalone panel
            ChatViewProvider.openPanel(context.extensionUri, chatController);
        }),
        
        vscode.commands.registerCommand('shai-vscode.clearChat', () => {
            const session = chatController.getSession('default');
            session.clear();
            vscode.window.showInformationMessage('Chat cleared');
        }),
        
        vscode.commands.registerCommand('shai-vscode.showReadme', () => {
            ReadmeViewProvider.openPanel(context.extensionUri);
        })
    );
}
