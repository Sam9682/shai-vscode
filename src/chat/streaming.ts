import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as os from 'os';

export interface StreamingResponse {
  id: string;
  type: 'progress' | 'complete' | 'error';
  data: string;
  timestamp: number;
  stage?: string;
}

export class StreamingChatSession {
  private messages: any[] = [];
  
  constructor(
    public readonly tabId: string,
    private context: vscode.ExtensionContext
  ) {
    this.loadHistory();
  }

  async executeCommandWithStreaming(message: string, onProgress: (progress: StreamingResponse) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const config = vscode.workspace.getConfiguration('shai-vscode');
      const shaiCommand = config.get<string>('shaiCommand') || 'shai';
      const useWSLConfig = config.get<boolean | null>('useWSL');
      const platform = os.platform();
      const useWSL = useWSLConfig !== null ? useWSLConfig : platform === 'win32';
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
      
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
        env: env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      child.stdin.end();
      
      let stdout = '';
      let stderr = '';
      
      // Send progress updates for different stages of Shai's thinking process
      onProgress({
        id: this.generateId(),
        type: 'progress',
        data: 'Analyzing your request...',
        timestamp: Date.now(),
        stage: 'analyzing'
      });
      
      // Increased timeout from 30 seconds to 5 minutes (300 seconds)
      const timeout = setTimeout(() => {
        child.kill();
        onProgress({
          id: this.generateId(),
          type: 'error',
          data: 'Command timed out after 5 minutes',
          timestamp: Date.now(),
          stage: 'error'
        });
        reject(new Error('Command timed out after 5 minutes'));
      }, 300000);
      
      child.stdout.on('data', (data) => { 
        stdout += data.toString();
        // Send partial output as progress with stage information
        onProgress({
          id: this.generateId(),
          type: 'progress',
          data: data.toString(),
          timestamp: Date.now(),
          stage: 'processing'
        });
      });
      
      child.stderr.on('data', (data) => { 
        stderr += data.toString();
        // Send error output as progress with stage information
        onProgress({
          id: this.generateId(),
          type: 'progress',
          data: data.toString(),
          timestamp: Date.now(),
          stage: 'error'
        });
      });
      
      child.on('close', () => {
        clearTimeout(timeout);
        const output = stderr || stdout || 'No output';
        const cleanOutput = this.stripAnsi(output);
        
        // Send final completion message with stage information
        onProgress({
          id: this.generateId(),
          type: 'complete',
          data: cleanOutput,
          timestamp: Date.now(),
          stage: 'completed'
        });
        
        resolve(cleanOutput);
      });
      
      child.on('error', (error) => {
        clearTimeout(timeout);
        const errorMessage = `Error: ${error.message}`;
        onProgress({
          id: this.generateId(),
          type: 'error',
          data: errorMessage,
          timestamp: Date.now(),
          stage: 'error'
        });
        reject(new Error(errorMessage));
      });
    });
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

  private saveHistory() {
    // Save to global state
    this.context.globalState.update(`shai-chat-history-${this.tabId}`, this.messages);
  }

  private loadHistory() {
    // Load from global state
    const savedMessages = this.context.globalState.get<any[]>(`shai-chat-history-${this.tabId}`, []);
    this.messages = savedMessages;
  }

  dispose() {
    this.saveHistory();
    this.messages = [];
  }
}