import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as os from 'os';
import { getShaiWorkingDir, getWorkspaceFolderPath, shouldUseWSL, wslCommand, windowsToWSLPath } from '../platform/wsl';

// Re-exported for existing importers (views).
export { getShaiWorkingDir, windowsToWSLPath };

export interface StreamingResponse {
  id: string;
  type: 'progress' | 'complete' | 'error';
  data: string;
  timestamp: number;
  stage?: string;
}

/** Kinds of streaming/server failures that produce an actionable message. (Req 7.1-7.4) */
export type StreamErrorKind = 'spawn-failure' | 'timeout' | 'server-status' | 'fetch-failure';

/** Context used to build an actionable streaming error message. */
export interface StreamErrorContext {
  shaiCommand?: string;
  serverUrl?: string;
  status?: number;
}

/**
 * Pure formatter that turns a streaming/server failure into a human-readable,
 * actionable message. Uses safe `??` fallbacks so missing context never throws. (Req 7.1-7.4)
 */
export function describeStreamingError(kind: StreamErrorKind, ctx: StreamErrorContext): string {
  switch (kind) {
    case 'spawn-failure':
      return `Could not start shai. Check that the configured shai command "${ctx.shaiCommand ?? 'shai'}" is installed and on your PATH.`;
    case 'timeout':
      return `The request timed out. Try again; if it keeps timing out, the model or server may be busy.`;
    case 'server-status':
      return `The server returned an error (HTTP ${ctx.status ?? '?'}). Check the configured server URL "${ctx.serverUrl ?? ''}".`;
    case 'fetch-failure':
      return `Could not reach the server. Check that it is running and that the configured server URL "${ctx.serverUrl ?? ''}" is correct.`;
  }
}

/** Raised (as a rejection) when the user interrupts a running request with STOP. */
export class ShaiStoppedError extends Error {
  constructor() {
    super('Stopped by user');
    this.name = 'ShaiStoppedError';
  }
}

export class StreamingChatSession {
  private messages: any[] = [];
  private static serverProcess: import('child_process').ChildProcess | null = null;
  /** Handle on the in-flight request, used by stop(). */
  private current: {
    child?: import('child_process').ChildProcess;
    pidFile?: string;
    abort?: AbortController;
    stopped: boolean;
  } | null = null;

  /** True while a request is in flight for this tab. */
  isRunning(): boolean {
    return this.current !== null;
  }

  /**
   * Interrupt the running request, like pressing Ctrl+C in the shai CLI:
   * SIGINT first, then a hard kill if shai has not exited after 3 s.
   * In server mode the HTTP request is aborted instead.
   */
  stop(): boolean {
    const cur = this.current;
    if (!cur || cur.stopped) { return false; }
    cur.stopped = true;

    if (cur.abort) {
      cur.abort.abort();
      return true;
    }
    const child = cur.child;
    if (!child) { return true; }

    if (cur.pidFile) {
      // shai runs inside WSL: signalling wsl.exe from Windows would only kill
      // the bridge, so deliver SIGINT to the Linux process through its PID file.
      const f = StreamingChatSession.escapeShellArg(cur.pidFile);
      const { command, args } = wslCommand(`[ -f ${f} ] && kill -INT "$(cat ${f})" 2>/dev/null; true`);
      try { spawn(command, args, { shell: false, stdio: 'ignore' }); } catch { /* ignore */ }
    } else if (os.platform() !== 'win32') {
      child.kill('SIGINT');
    } else {
      // Windows has no SIGINT for child processes: terminate directly.
      child.kill();
    }

    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        if (cur.pidFile) {
          const f = StreamingChatSession.escapeShellArg(cur.pidFile);
          const { command, args } = wslCommand(`[ -f ${f} ] && kill -KILL "$(cat ${f})" 2>/dev/null; rm -f ${f}; true`);
          try { spawn(command, args, { shell: false, stdio: 'ignore' }); } catch { /* ignore */ }
        }
        child.kill('SIGKILL');
      }
    }, 3000);
    return true;
  }

  constructor(
    public readonly tabId: string,
    private context: vscode.ExtensionContext
  ) {
    this.loadHistory();
  }

  async executeCommandWithStreaming(
    message: string,
    onProgress: (progress: StreamingResponse) => void,
    interactionMode: string = 'none',
    noExtraContext: boolean = false,
    autopilot: boolean = false
  ): Promise<string> {
    console.log('executeCommandWithStreaming called with message:', message, 'mode:', interactionMode, 'noExtraContext:', noExtraContext, 'autopilot:', autopilot);
    const config = vscode.workspace.getConfiguration('shai-vscode');
    const shaiCommand = config.get<string>('shaiCommand') || 'shai';
    const useServer = config.get<boolean>('useServer') || false;
    const serverUrl = config.get<string>('serverUrl') || 'http://127.0.0.1:8000';
    const platform = os.platform();
    const useWSL = shouldUseWSL();
    const workspaceFolder = getWorkspaceFolderPath();
    
    // Add context to format response with actionable buttons (unless user opted out)
    const contextualMessage = noExtraContext ? message : `${message}

IMPORTANT: When suggesting VS Code actions or commands, format them using this syntax:
[ACTION:commandId:label] - for VS Code commands (e.g., [ACTION:workbench.action.files.save:Save File])
[BUTTON:label:data] - for custom actions (e.g., [BUTTON:Create File:path/to/file.ts])

This will be converted into clickable buttons in the UI.
Files and directories are NOT actions: always write them as markdown links with an absolute file:// target, e.g. [README.md](file:///absolute/path/README.md), never as buttons, bare names or inline code.`;

    let command: string;
    let args: string[];
    let cwd: string;
    let env: NodeJS.ProcessEnv;
    let pidFile: string | undefined;

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

      // Communicate autopilot mode via environment variable
      if (autopilot) {
        env.SHAI_AUTOPILOT = '1';
      }
      
      if (useWSL) {
        cwd = getShaiWorkingDir();
        // env vars set on the Windows side do not cross into WSL: export them in the shell
        const autopilotPrefix = autopilot ? 'export SHAI_AUTOPILOT=1; ' : '';
        // `exec` makes shai replace the shell, so $$ is shai's own PID: stop()
        // reads it back from this file to send SIGINT inside WSL.
        pidFile = `/tmp/shai-vscode-${this.generateId()}.pid`;
        const pf = StreamingChatSession.escapeShellArg(pidFile);
        ({ command, args } = wslCommand(`${autopilotPrefix}cd ${StreamingChatSession.escapeShellArg(cwd)} && echo $$ > ${pf} && exec ${StreamingChatSession.escapeShellArg(shaiCommand)} --prompt ${StreamingChatSession.escapeShellArg(contextualMessage)}`));
      } else {
        cwd = workspaceFolder;
        command = shaiCommand;
        // shai >= 0.2 treats a bare positional as a subcommand; use headless --prompt
        args = ['--prompt', contextualMessage];
      }
    // if the user has opted into server mode we bypass the shell call and
    // instead talk to the HTTP/SSE endpoint.  this keeps a single process
    // alive (``shai server``) rather than spawning two separate ones for the
    // fake "analyzing"/"error" stages.
    if (useServer) {
      // spawn the server once and wait briefly for it to bind
      await StreamingChatSession.ensureServerRunning(shaiCommand, useWSL, cwd, env);
      // perform the POST and stream response events
      const abort = new AbortController();
      const cur = { abort, stopped: false };
      this.current = cur;
      try {
        return await this.callServer(contextualMessage, serverUrl, onProgress, interactionMode, abort.signal);
      } catch (err) {
        if (cur.stopped) { throw new ShaiStoppedError(); }
        throw err;
      } finally {
        if (this.current === cur) { this.current = null; }
      }
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
      const cur = { child, pidFile, stopped: false };
      this.current = cur;
      const finish = () => {
        if (this.current === cur) { this.current = null; }
        if (pidFile) {
          const { command: c, args: a } = wslCommand(`rm -f ${StreamingChatSession.escapeShellArg(pidFile)}`);
          try { spawn(c, a, { shell: false, stdio: 'ignore' }); } catch { /* ignore */ }
        }
      };

      let stdout = '';
      let stderr = '';


      const timeout = setTimeout(() => {
        finish();
        child.kill();
        onProgress({
          id: this.generateId(),
          type: 'error',
          data: describeStreamingError('timeout', {}),
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
        finish();
        if (cur.stopped) {
          reject(new ShaiStoppedError());
          return;
        }
        // Use stdout for the final chat answer; stderr (which typically
        // contains thinking / model-info) was already streamed to the
        // reasoning panel.  Fall back to stderr only when stdout is empty.
        const output = stdout || stderr || 'No output';
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
        finish();
        if (cur.stopped) {
          reject(new ShaiStoppedError());
          return;
        }
        onProgress({
          id: this.generateId(),
          type: 'error',
          data: describeStreamingError('spawn-failure', { shaiCommand }),
          timestamp: Date.now()
        });
        reject(new Error(`Error: ${error.message}`));
      });
    });
  }

  private windowsToWSLPath(windowsPath: string): string {
    return windowsToWSLPath(windowsPath);
  }

  private stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, '');
  }

  private escapeShellArg(arg: string): string {
    return "'" + arg.replace(/'/g, "'\\''" ) + "'";
  }

  private static escapeShellArg(arg: string): string {
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
    interactionMode: string = 'none',
    signal?: AbortSignal
  ): Promise<string> {
    let stdout = '';
    let res: Response;
    try {
      res = await fetch(`${serverUrl}/ask`, {
        signal,
        method: 'POST',
        headers: { 
            'Content-Type': 'text/plain',
            'X-Shai-Interaction': interactionMode
        },
        body: message
      });
    } catch (err: any) {
      if (signal?.aborted) { throw err; }
      onProgress({
        id: this.generateId(),
        type: 'error',
        data: describeStreamingError('fetch-failure', { serverUrl }),
        timestamp: Date.now()
      });
      throw err;
    }
    if (!res.ok || !res.body) {
      onProgress({
        id: this.generateId(),
        type: 'error',
        data: describeStreamingError('server-status', { serverUrl, status: res.status }),
        timestamp: Date.now()
      });
      throw new Error(`server returned ${res.status}`);
    }
    try {
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
      // Emit a complete event with the full accumulated text so the caller
      // can send the final answer to the chat panel.
      onProgress({
        id: this.generateId(),
        type: 'complete',
        data: stdout,
        timestamp: Date.now()
      });
      return stdout;
    } catch (err: any) {
      if (signal?.aborted) { throw err; }
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
      let args: string[] = ['serve'];
      if (useWSL) {
        ({ command, args } = wslCommand(`cd ${StreamingChatSession.escapeShellArg(cwd)} && ${StreamingChatSession.escapeShellArg(shaiCommand)} serve`));
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