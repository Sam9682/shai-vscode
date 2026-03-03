import * as vscode from 'vscode';
import { ChatController } from '../chat/controller';
import { ChatViewProvider } from '../views/chatView';
import { ReasoningViewProvider } from '../views/reasoningView';

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
        
        vscode.commands.registerCommand('shai-vscode.showReasoning', () => {
            ReasoningViewProvider.openPanel(context.extensionUri);
        })
    );
}
