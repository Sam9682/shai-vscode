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
  private static serverProcess: import('child_process').ChildProcess | null = null;
  
  constructor(
    public readonly tabId: string,
    private context: vscode.ExtensionContext
  ) {
    this.loadHistory();
  }

  async executeCommandWithStreaming(
    message: string,
    onProgress: (progress: StreamingResponse) => void,
    interactionMode: string = 'none'
  ): Promise<string> {
    console.log('executeCommandWithStreaming called with message:', message, 'mode:', interactionMode);
    const config = vscode.workspace.getConfiguration('shai-vscode');
    const shaiCommand = config.get<string>('shaiCommand') || 'shai';
    const useServer = config.get<boolean>('useServer') || false;
    const serverUrl = config.get<string>('serverUrl') || 'http://127.0.0.1:8000';
    const useWSLConfig = config.get<boolean | null>('useWSL');
    const platform = os.platform();
      const useWSL: boolean = useWSLConfig !== null && useWSLConfig !== undefined
        ? useWSLConfig
        : platform === 'win32';
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
        args = ['bash', '-c', `cd ${this.escapeShellArg(cwd)} && ${this.escapeShellArg(shaiCommand)} ${this.escapeShellArg(message)}`];
      } else {
        cwd = workspaceFolder;
        command = shaiCommand;
        args = [message];
      }
    // if the user has opted into server mode we bypass the shell call and
    // instead talk to the HTTP/SSE endpoint.  this keeps a single process
    // alive (``shai server``) rather than spawning two separate ones for the
    // fake "analyzing"/"error" stages.
    if (useServer) {
      // spawn the server once and wait briefly for it to bind
      await StreamingChatSession.ensureServerRunning(shaiCommand, useWSL, cwd, env);
      // perform the POST and stream response events
      return this.callServer(message, serverUrl, onProgress, interactionMode);
    }

    // --- original CLI path ------------------------------------------------
    return new Promise((resolve, reject) => {
      console.log('Spawning CLI child', command, args, 'cwd', cwd);
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


      const timeout = setTimeout(() => {
        child.kill();
        onProgress({
          id: this.generateId(),
          type: 'error',
          data: 'Command timed out after 5 minutes',
          timestamp: Date.now()
        });
        reject(new Error('Command timed out after 5 minutes'));
      }, 300000);

      child.stdout.on('data', (data) => {
        // strip any ANSI escapes from the chunk before sending it along
        const text = this.stripAnsi(data.toString());
        stdout += text;
        onProgress({
          id: this.generateId(),
          type: 'progress',
          data: text,
          timestamp: Date.now()
        });
      });

      // treat stderr output as normal progress chunks rather than an "error"
      // stage; showing an error indicator every time `shai` prints to stderr
      // created a second thinking bubble and made it look like two processes
      // were running.  forwarding it as a regular progress event keeps the
      // UI in a single flow.
      child.stderr.on('data', (data) => {
        const text = this.stripAnsi(data.toString());
        stderr += text;
        onProgress({
          id: this.generateId(),
          type: 'progress',
          data: text,
          timestamp: Date.now()
        });
      });

      child.on('close', () => {
        clearTimeout(timeout);
        const output = stderr || stdout || 'No output';
        const cleanOutput = this.stripAnsi(output);
        onProgress({
          id: this.generateId(),
          type: 'complete',
          data: cleanOutput,
          timestamp: Date.now()
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
          timestamp: Date.now()
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

  private escapeShellArg(arg: string): string {
    return "'" + arg.replace(/'/g, "'\\''" ) + "'";
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * post the user message to the running server and stream back SSE events.
   * resolves with the final accumulated response text.
   */
  private async callServer(
    message: string,
    serverUrl: string,
    onProgress: (progress: StreamingResponse) => void,
    interactionMode: string = 'none'
  ): Promise<string> {
    let stdout = '';
    try {
      const res = await fetch(`${serverUrl}/ask`, {
        method: 'POST',
        headers: { 
            'Content-Type': 'text/plain',
            'X-Shai-Interaction': interactionMode
        },
        body: message
      });
      if (!res.ok || !res.body) {
        throw new Error(`server returned ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const m = part.match(/^data:\s*(.*)$/m);
            if (m) {
                // strip ANSI escapes from server-sent chunks as well
                const text = this.stripAnsi(m[1]);
                stdout += text;
                onProgress({
                  id: this.generateId(),
                  type: 'progress',
                  data: text,
                  timestamp: Date.now()
                });
              }
        }
      }
      // we do not emit a final event here; the caller already accumulates
      // the chunks and will be notified when the promise resolves.  emitting
      // a `complete` event would cause the UI to duplicate the result.
      return stdout;
    } catch (err: any) {
      const msg = err.message || String(err);
      onProgress({
        id: this.generateId(),
        type: 'error',
        data: msg,
        timestamp: Date.now()
      });
      throw err;
    }
  }

  /**
   * spawn ``shai server`` once; this is a long‑lived child that speaks SSE.
   */
  private static ensureServerRunning(
    shaiCommand: string,
    useWSL: boolean,
    cwd: string,
    env: NodeJS.ProcessEnv
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (StreamingChatSession.serverProcess) {
        return resolve();
      }
      let command = shaiCommand;
      let args: string[] = ['server'];
      if (useWSL && os.platform() === 'win32') {
        command = 'wsl';
        args = ['bash', '-c', `cd ${this.escapeShellArg(cwd)} && ${this.escapeShellArg(shaiCommand)} server`];
      }
      // Never use shell mode to avoid special character interpretation
      const proc = spawn(command, args, {
        cwd: useWSL ? undefined : cwd,
        shell: false,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      StreamingChatSession.serverProcess = proc;
      const cleanup = () => {
        StreamingChatSession.serverProcess = null;
      };
      proc.on('exit', cleanup);
      proc.on('error', (e) => {
        cleanup();
        reject(e);
      });
      proc.stdout?.on('data', (d) => {
        const text = d.toString();
        if (/listening|ready/i.test(text)) {
          resolve();
        }
      });
      proc.stderr?.on('data', (d) => {
        console.error('[shai server]', d.toString());
      });
      // in case the server doesn't emit a message quickly, just resolve
      setTimeout(() => resolve(), 5000);
    });
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