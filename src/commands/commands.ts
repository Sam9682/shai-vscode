import * as vscode from 'vscode';
import { ChatController } from '../chat/controller';

export function registerCommands(
    context: vscode.ExtensionContext,
    chatController: ChatController
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('shai-vscode.openChat', () => {
            vscode.commands.executeCommand('shai-chat-view.focus');
        }),
        
        vscode.commands.registerCommand('shai-vscode.clearChat', () => {
            const session = chatController.getSession('default');
            session.clear();
            vscode.window.showInformationMessage('Chat cleared');
        })
    );
}
