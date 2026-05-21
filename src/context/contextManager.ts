import * as vscode from 'vscode';

export interface ContextEntry {
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
}

export interface ContextState {
    turns: ContextEntry[];
    summary: string;
    systemPrompt?: string;
}

const MAX_TURNS = 20;
const TRIM_TO = MAX_TURNS / 2;
const CONTEXT_KEY_PREFIX = 'shai-context-';
const ACTIVE_CONTEXT_KEY = 'shai-active-context';

// ------------------------------------------------------------------
// Predefined contexts
// ------------------------------------------------------------------

export interface PredefinedContext {
    id: string;
    label: string;
    systemPrompt: string;
}

export const PREDEFINED_CONTEXTS: PredefinedContext[] = [
    {
        id: 'default',
        label: 'Default',
        systemPrompt: '',
    },
    {
        id: 'dev',
        label: 'Dev',
        systemPrompt: [
            'You are Shai, an expert software developer assistant.',
            'Your role is to help the user write, review, refactor, and debug code.',
            'Follow best practices for the language and framework in use.',
            'Provide clear, concise, and well-structured code.',
            'When suggesting changes, explain the reasoning behind them.',
            'Prefer idiomatic solutions and keep code maintainable.',
        ].join('\n'),
    },
    {
        id: 'devops',
        label: 'DevOps',
        systemPrompt: [
            'You are Shai, a DevOps and infrastructure expert assistant.',
            'Your role is to help the user with CI/CD pipelines, containerization, orchestration, cloud infrastructure, monitoring, and automation.',
            'Provide production-ready configurations and scripts.',
            'Follow security best practices and the principle of least privilege.',
            'When suggesting infrastructure changes, explain trade-offs regarding cost, reliability, and scalability.',
            'Prefer Infrastructure-as-Code approaches (Terraform, Ansible, CloudFormation, etc.).',
        ].join('\n'),
    },
    {
        id: 'spec',
        label: 'Spec',
        systemPrompt: [
            'You are Shai, a technical specification and documentation writer.',
            'Your role is to help the user write clear, structured, and comprehensive specifications.',
            'Produce well-organized documents with sections, acceptance criteria, and edge cases.',
            'Use precise language and avoid ambiguity.',
            'When appropriate, include diagrams descriptions, data models, API contracts, and sequence flows.',
            'Follow standard specification formats (RFC-style, user stories, or technical design docs) as appropriate.',
        ].join('\n'),
    },
    {
        id: 'docker-compose',
        label: 'Docker Compose',
        systemPrompt: [
            'You are Shai, a Docker Compose specialist.',
            'Your role is to help the user write, validate, execute, and manage services defined in docker-compose YAML files.',
            'Assist with starting, stopping, rebuilding, and debugging containers using docker compose commands.',
            'When generating or editing docker-compose.yml files, follow best practices: pin image versions, use named volumes, define health checks, and set resource limits.',
            'Explain service dependencies, networking, and volume mappings clearly.',
            'When troubleshooting, suggest relevant docker compose logs, ps, and exec commands.',
        ].join('\n'),
    },
];

export const PREDEFINED_CONTEXT_IDS = PREDEFINED_CONTEXTS.map(c => c.id);

export class ContextManager {
    private state: ContextState = { turns: [], summary: '', systemPrompt: '' };

    constructor(
        public readonly tabId: string,
        private vsContext: vscode.ExtensionContext
    ) {
        this.load();
    }

    /** Add a user or assistant turn, then trim if needed. */
    addTurn(role: 'user' | 'assistant', content: string): void {
        this.state.turns.push({ role, content, timestamp: Date.now() });
        if (this.state.turns.length > MAX_TURNS) {
            this.trimAndSummarize();
        }
        this.save();
    }

    getSummary(): string {
        return this.state.summary;
    }

    getRecentTurns(n: number = MAX_TURNS): ContextEntry[] {
        return this.state.turns.slice(-n);
    }

    getAllTurns(): ContextEntry[] {
        return [...this.state.turns];
    }

    getSystemPrompt(): string {
        return this.state.systemPrompt ?? '';
    }

    setSystemPrompt(text: string): void {
        this.state.systemPrompt = text;
        this.save();
    }

    updateSummary(text: string): void {
        this.state.summary = text;
        this.save();
    }

    removeTurnAt(index: number): void {
        if (index >= 0 && index < this.state.turns.length) {
            this.state.turns.splice(index, 1);
            this.save();
        }
    }

    updateTurnAt(index: number, content: string): void {
        if (index >= 0 && index < this.state.turns.length) {
            this.state.turns[index] = {
                ...this.state.turns[index],
                content,
            };
            this.save();
        }
    }

    clear(): void {
        this.state = { turns: [], summary: '', systemPrompt: this.state.systemPrompt ?? '' };
        this.save();
    }

    /** Persist immediately even if the context is still empty (ensures it shows up in listContextIds). */
    touch(): void {
        this.save();
    }

    /** Expose full state snapshot for the editor panel. */
    getState(): Readonly<ContextState> {
        return { ...this.state, turns: [...this.state.turns] };
    }

    /** Expose the VS Code extension context (needed by static helpers). */
    getExtensionContext(): vscode.ExtensionContext {
        return this.vsContext;
    }

    // ------------------------------------------------------------------
    // Static helpers (operate on globalState directly)
    // ------------------------------------------------------------------

    /** List all context IDs currently stored in globalState. */
    static listContextIds(ctx: vscode.ExtensionContext): string[] {
        const keys = ctx.globalState.keys();
        return keys
            .filter(k => k.startsWith(CONTEXT_KEY_PREFIX))
            .map(k => k.slice(CONTEXT_KEY_PREFIX.length));
    }

    /** Delete a named context from globalState. */
    static deleteContext(ctx: vscode.ExtensionContext, tabId: string): void {
        ctx.globalState.update(`${CONTEXT_KEY_PREFIX}${tabId}`, undefined);
    }

    /** Read or write the persisted active context ID. */
    static getPersistedActiveId(ctx: vscode.ExtensionContext): string {
        return ctx.globalState.get<string>(ACTIVE_CONTEXT_KEY, 'default');
    }

    static setPersistedActiveId(ctx: vscode.ExtensionContext, tabId: string): void {
        ctx.globalState.update(ACTIVE_CONTEXT_KEY, tabId);
    }

    /** Returns true if the given id is one of the predefined contexts. */
    static isPredefined(id: string): boolean {
        return PREDEFINED_CONTEXT_IDS.includes(id);
    }

    /**
     * Ensure every predefined context exists in globalState.
     * If a predefined context is missing it is created with its default system prompt.
     * Existing predefined contexts are NOT overwritten so user edits are preserved.
     */
    static bootstrapPredefinedContexts(ctx: vscode.ExtensionContext): void {
        const existing = ContextManager.listContextIds(ctx);
        for (const preset of PREDEFINED_CONTEXTS) {
            if (!existing.includes(preset.id)) {
                const state: ContextState = {
                    turns: [],
                    summary: '',
                    systemPrompt: preset.systemPrompt,
                };
                ctx.globalState.update(`${CONTEXT_KEY_PREFIX}${preset.id}`, state);
            }
        }
    }

    // ------------------------------------------------------------------
    // Private
    // ------------------------------------------------------------------

    private trimAndSummarize(): void {
        const overflow = this.state.turns.splice(0, this.state.turns.length - TRIM_TO);
        if (overflow.length === 0) {
            return;
        }
        const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
        const condensed = overflow
            .map(e => `${e.role === 'user' ? 'User' : 'Assistant'}: ${e.content}`)
            .join('\n');
        const block = `[Auto-summary — ${date}]\n${condensed}`;
        this.state.summary = this.state.summary
            ? `${this.state.summary}\n\n${block}`
            : block;
    }

    private save(): void {
        this.vsContext.globalState.update(`${CONTEXT_KEY_PREFIX}${this.tabId}`, this.state);
    }

    private load(): void {
        const saved = this.vsContext.globalState.get<ContextState>(`${CONTEXT_KEY_PREFIX}${this.tabId}`);
        if (saved && Array.isArray(saved.turns)) {
            this.state = { systemPrompt: '', ...saved };
        }
    }
}
