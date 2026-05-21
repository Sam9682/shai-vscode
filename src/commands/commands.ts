import * as vscode from 'vscode';
import { ChatController } from '../chat/controller';
import { ChatViewProvider } from '../views/chatView';
import { ReasoningViewProvider } from '../views/reasoningView';
import { DeploymentsViewProvider } from '../views/deploymentsView';
import { DockerController } from '../docker/dockerController';
import { openAuthWizard } from '../auth/authWizardPanel';
import { openContextEditor } from '../views/contextEditorPanel';

export function registerCommands(
    context: vscode.ExtensionContext,
    chatController: ChatController,
    dockerController: DockerController
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('shai-vscode.openChat', () => {
            ChatViewProvider.openPanel(context.extensionUri, chatController);
        }),

        vscode.commands.registerCommand('shai-vscode.clearChat', () => {
            const tabId = chatController.getActiveContextId();
            const session = chatController.getSession(tabId);
            session.clear();
            chatController.getContextManager(tabId).clear();
            vscode.window.showInformationMessage('Chat cleared');
        }),

        vscode.commands.registerCommand('shai-vscode.showReasoning', () => {
            ReasoningViewProvider.openPanel(context.extensionUri);
        }),

        vscode.commands.registerCommand('shai-vscode.auth', () => {
            openAuthWizard(context);
        }),

        vscode.commands.registerCommand('shai-vscode.openDeployments', () => {
            DeploymentsViewProvider.openPanel(context.extensionUri, dockerController, chatController);
        }),

        vscode.commands.registerCommand('shai-vscode.openContextEditor', () => {
            openContextEditor(context.extensionUri, chatController);
        })
    );
}
