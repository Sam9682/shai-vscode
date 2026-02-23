import * as vscode from 'vscode';
import { ChatSession } from './session';

export class ChatController {
    private sessions = new Map<string, ChatSession>();
    
    constructor(private context: vscode.ExtensionContext) {}

    getSession(tabId: string): ChatSession {
        if (!this.sessions.has(tabId)) {
            this.sessions.set(tabId, new ChatSession(tabId, this.context));
        }
        return this.sessions.get(tabId)!;
    }

    deleteSession(tabId: string) {
        this.sessions.delete(tabId);
    }

    dispose() {
        this.sessions.forEach(session => session.dispose());
        this.sessions.clear();
    }
}
