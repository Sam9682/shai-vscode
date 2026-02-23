import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as os from 'os';

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
    ) {}

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
        
        return assistantMsg;
    }

    private async executeCommand(message: string): Promise<string> {
        return new Promise((resolve) => {
            const config = vscode.workspace.getConfiguration('shai-vscode');
            const shaiCommand = config.get<string>('shaiCommand') || 'shai';
            const useWSLConfig = config.get<boolean | null>('useWSL');
            const useWSL = useWSLConfig !== null ? useWSLConfig : os.platform() === 'win32';
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
            
            let command: string;
            let args: string[];
            let cwd: string;
            
            if (useWSL && os.platform() === 'win32') {
                cwd = this.windowsToWSLPath(workspaceFolder);
                command = 'wsl';
                args = ['bash', '-c', `cd "${cwd}" && ${shaiCommand} "${message.replace(/"/g, '\\"')}"`];
            } else {
                cwd = workspaceFolder;
                command = shaiCommand;
                args = [message];
            }
            
            const child = spawn(command, args, { 
                cwd: useWSL ? undefined : cwd,
                shell: !useWSL,
                env: { ...process.env },
                stdio: ['pipe', 'pipe', 'pipe']
            });
            child.stdin.end();
            
            let stdout = '';
            let stderr = '';
            
            const timeout = setTimeout(() => {
                child.kill();
                resolve('Command timed out after 30 seconds');
            }, 30000);
            
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
    }

    private windowsToWSLPath(windowsPath: string): string {
        let wslPath = windowsPath.replace(/\\/g, '/');
        if (/^[A-Za-z]:/.test(wslPath)) {
            const drive = wslPath[0].toLowerCase();
            wslPath = `/mnt/${drive}${wslPath.substring(2)}`;
        }
        return wslPath;
    }

    private stripAnsi(text: string): string {
        return text.replace(/\x1b\[[0-9;]*m/g, '');
    }

    private generateId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    dispose() {
        this.messages = [];
    }
}
