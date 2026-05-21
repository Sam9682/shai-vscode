import * as vscode from 'vscode';
import { ChatSession } from './session';
import { StreamingChatSession } from './streaming';
import { ContextManager } from '../context/contextManager';

export class ChatController {
    private sessions = new Map<string, ChatSession>();
    private streamingSessions = new Map<string, StreamingChatSession>();
    private contextManagers = new Map<string, ContextManager>();
    private _activeContextId: string;

    private readonly _onActiveContextChanged = new vscode.EventEmitter<string>();
    readonly onActiveContextChanged = this._onActiveContextChanged.event;

    constructor(private vsContext: vscode.ExtensionContext) {
        ContextManager.bootstrapPredefinedContexts(vsContext);
        this._activeContextId = ContextManager.getPersistedActiveId(vsContext);
    }

    // ------------------------------------------------------------------
    // Context ID management
    // ------------------------------------------------------------------

    getActiveContextId(): string {
        return this._activeContextId;
    }

    setActiveContextId(id: string): void {
        this._activeContextId = id;
        ContextManager.setPersistedActiveId(this.vsContext, id);
        this._onActiveContextChanged.fire(id);
    }

    getVscodeContext(): vscode.ExtensionContext {
        return this.vsContext;
    }

    // ------------------------------------------------------------------
    // Sessions
    // ------------------------------------------------------------------

    getSession(tabId: string): ChatSession {
        if (!this.sessions.has(tabId)) {
            this.sessions.set(tabId, new ChatSession(tabId, this.vsContext));
        }
        return this.sessions.get(tabId)!;
    }

    getStreamingSession(tabId: string): StreamingChatSession {
        if (!this.streamingSessions.has(tabId)) {
            this.streamingSessions.set(tabId, new StreamingChatSession(tabId, this.vsContext));
        }
        return this.streamingSessions.get(tabId)!;
    }

    getContextManager(tabId: string): ContextManager {
        if (!this.contextManagers.has(tabId)) {
            this.contextManagers.set(tabId, new ContextManager(tabId, this.vsContext));
        }
        return this.contextManagers.get(tabId)!;
    }

    deleteSession(tabId: string) {
        this.sessions.delete(tabId);
        this.streamingSessions.delete(tabId);
        this.contextManagers.delete(tabId);
    }

    // ------------------------------------------------------------------
    // Interaction mode
    // ------------------------------------------------------------------

    private interactionModes = new Map<string, string>();

    setInteractionMode(tabId: string, mode: string) {
        this.interactionModes.set(tabId, mode);
    }

    getInteractionMode(tabId: string): string {
        return this.interactionModes.get(tabId) || 'none';
    }

    dispose() {
        this.sessions.forEach(session => session.dispose());
        this.streamingSessions.forEach(session => session.dispose());
        this.sessions.clear();
        this.streamingSessions.clear();
        this.contextManagers.clear();
        this._onActiveContextChanged.dispose();
    }
}
