import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as os from 'os';
import { escapeShellArg, getShaiWorkingDir, getWorkspaceFolderPath, shouldUseWSL, wslCommand, windowsToWSLPath } from '../platform/wsl';

export interface ChatMessage {
    id: string;
    type: 'user' | 'assistant' | 'system';
    message: string;
    timestamp: number;
}

export class ChatSession {
    private messages: ChatMessage[] = [];
    
    constructor(
        public readonly tabId: string,
        private context: vscode.ExtensionContext
    ) {
        // Load saved history when session is created
        this.loadHistory();
    }

    async sendMessage(message: string): Promise<ChatMessage> {
        const userMsg: ChatMessage = {
            id: this.generateId(),
            type: 'user',
            message,
            timestamp: Date.now()
        };
        this.messages.push(userMsg);

        const response = await this.executeCommand(message);
        const assistantMsg: ChatMessage = {
            id: this.generateId(),
            type: 'assistant',
            message: response,
            timestamp: Date.now()
        };
        this.messages.push(assistantMsg);
        
        // Save history after each message
        this.saveHistory();
        
        return assistantMsg;
    }

    private async executeCommand(message: string): Promise<string> {
        return new Promise((resolve) => {
            const config = vscode.workspace.getConfiguration('shai-vscode');
            const shaiCommand = config.get<string>('shaiCommand') || 'shai';
            const platform = os.platform();
            const useWSL = shouldUseWSL();
            const workspaceFolder = getWorkspaceFolderPath();
            
            let command: string;
            let args: string[];
            let cwd: string;
            let env: NodeJS.ProcessEnv;
            
            // On macOS, we need to ensure proper PATH for finding shai command
            if (platform === 'darwin') {
                // Create a more complete environment with standard PATH locations
                env = { 
                    ...process.env,
                    PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin'
                };
            } else {
                env = { ...process.env };
            }
            
            if (useWSL && platform === 'win32') {
                cwd = getShaiWorkingDir();
                ({ command, args } = wslCommand(`cd ${escapeShellArg(cwd)} && ${shaiCommand} --prompt ${escapeShellArg(message)}`));
            } else {
                cwd = workspaceFolder;
                command = shaiCommand;
                args = ['--prompt', message];
            }
            
            // Never use shell mode to avoid special character interpretation
            const child = spawn(command, args, { 
                cwd: useWSL ? undefined : cwd,
                shell: false,
                env: env,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            child.stdin.end();
            
            let stdout = '';
            let stderr = '';
            
            // Increased timeout from 30 seconds to 5 minutes (300 seconds)
            const timeout = setTimeout(() => {
                child.kill();
                resolve('Command timed out after 5 minutes');
            }, 300000);
            
            child.stdout.on('data', (data) => { stdout += data.toString(); });
            child.stderr.on('data', (data) => { stderr += data.toString(); });
            
            child.on('close', () => {
                clearTimeout(timeout);
                const output = stderr || stdout || 'No output';
                resolve(this.stripAnsi(output));
            });
            
            child.on('error', (error) => {
                clearTimeout(timeout);
                resolve(`Error: ${error.message}`);
            });
        });
    }

    getMessages(): ChatMessage[] {
        return [...this.messages];
    }

    clear() {
        this.messages = [];
        this.saveHistory();
    }

    private windowsToWSLPath(windowsPath: string): string {
        return windowsToWSLPath(windowsPath);
    }

    private stripAnsi(text: string): string {
        return text.replace(/\x1b\[[0-9;]*m/g, '');
    }

    private generateId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private saveHistory() {
        // Save to global state
        this.context.globalState.update(`shai-chat-history-${this.tabId}`, this.messages);
    }

    private loadHistory() {
        // Load from global state
        const savedMessages = this.context.globalState.get<ChatMessage[]>(`shai-chat-history-${this.tabId}`, []);
        this.messages = savedMessages;
    }

    dispose() {
        this.saveHistory();
        this.messages = [];
    }
}
