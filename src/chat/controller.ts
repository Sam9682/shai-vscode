import * as vscode from 'vscode';
import { ChatSession } from './session';
import { StreamingChatSession } from './streaming';

export class ChatController {
    private sessions = new Map<string, ChatSession>();
    private streamingSessions = new Map<string, StreamingChatSession>();
    
    constructor(private context: vscode.ExtensionContext) {}

    getSession(tabId: string): ChatSession {
        if (!this.sessions.has(tabId)) {
            this.sessions.set(tabId, new ChatSession(tabId, this.context));
        }
        return this.sessions.get(tabId)!;
    }

    getStreamingSession(tabId: string): StreamingChatSession {
        if (!this.streamingSessions.has(tabId)) {
            this.streamingSessions.set(tabId, new StreamingChatSession(tabId, this.context));
        }
        return this.streamingSessions.get(tabId)!;
    }

    deleteSession(tabId: string) {
        this.sessions.delete(tabId);
        this.streamingSessions.delete(tabId);
    }

    dispose() {
        this.sessions.forEach(session => session.dispose());
        this.streamingSessions.forEach(session => session.dispose());
        this.sessions.clear();
        this.streamingSessions.clear();
    }
}
