import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import {
  ComposeFileInfo,
  ComposeServiceInfo,
  DeploymentStatus,
  DeployOptions,
  DeployResult,
  StopResult,
  IDockerController,
} from './types';

const COMPOSE_FILE_PATTERNS = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
];

/** 10-minute timeout for deploy processes */
const DEPLOY_TIMEOUT = 600_000;

/**
 * Sanitize a service name to only allow alphanumeric, dash, and underscore characters.
 */
export function sanitizeServiceName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '');
}

export class DockerController implements IDockerController {
  private readonly context: vscode.ExtensionContext;
  private readonly statusMap = new Map<string, DeploymentStatus>();
  private readonly processes = new Map<string, ChildProcess>();

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Determine whether Docker commands should be routed through WSL.
   * Reads the `shai-vscode.useWSL` setting: when null/undefined, defaults
   * to true on Windows and false elsewhere. Users can explicitly set it
   * to false to run Docker natively on Windows.
   */
  private shouldUseWSL(): boolean {
    const config = vscode.workspace.getConfiguration('shai-vscode');
    const useWSLConfig = config.get<boolean | null>('useWSL');
    if (useWSLConfig !== null && useWSLConfig !== undefined) {
      return useWSLConfig;
    }
    return os.platform() === 'win32';
  }

  /**
   * Convert a Windows path to a WSL path.
   *
   * Handles two cases:
   * 1. WSL UNC paths (\\wsl.localhost\Distro\home\user\...) → /home/user/...
   *    These are already native Linux paths accessed via the UNC share.
   * 2. Standard Windows paths (C:\Users\foo) → /mnt/c/Users/foo
   */
  private windowsToWSLPath(windowsPath: string): string {
    let wslPath = windowsPath.replace(/\\/g, '/');

    // WSL UNC path: //wsl.localhost/<Distro>/rest/of/path → /rest/of/path
    // Also handles //wsl$/<Distro>/... (older WSL1 format)
    const wslUncMatch = wslPath.match(/^\/\/(wsl\.localhost|wsl\$)\/[^/]+(\/.*)$/);
    if (wslUncMatch) {
      return wslUncMatch[2];
    }

    // Standard drive letter path: C:/Users/foo → /mnt/c/Users/foo
    if (/^[A-Za-z]:/.test(wslPath)) {
      const drive = wslPath[0].toLowerCase();
      wslPath = `/mnt/${drive}${wslPath.substring(2)}`;
    }

    return wslPath;
  }

  private static escapeShellArg(arg: string): string {
    return "'" + arg.replace(/'/g, "'\\''") + "'";
  }

  /**
   * Spawn a docker compose command, routing through WSL on Windows by default.
   * Returns the spawned ChildProcess.
   *
   * When using WSL the command becomes:
   *   wsl bash -c 'cd <wslCwd> && docker compose -f <wslFile> <subcommand> [flags...]'
   *
   * When running natively:
   *   docker compose -f <file> <subcommand> [flags...]
   */
  private spawnDockerCommand(
    dockerArgs: string[],
    workspaceRoot: string,
    resolvedFilePath: string
  ): ChildProcess {
    const useWSL = this.shouldUseWSL();

    if (useWSL) {
      const wslCwd = os.platform() === 'win32'
        ? this.windowsToWSLPath(workspaceRoot)
        : workspaceRoot;
      const wslFile = os.platform() === 'win32'
        ? this.windowsToWSLPath(resolvedFilePath)
        : resolvedFilePath;

      // Rebuild args with the WSL file path
      const wslDockerArgs = dockerArgs.map(a => a === resolvedFilePath ? wslFile : a);
      const fullCmd = `cd ${DockerController.escapeShellArg(wslCwd)} && docker ${wslDockerArgs.join(' ')}`;

      return spawn('wsl', ['bash', '-c', fullCmd], {
        shell: false,
      });
    }

    // Native: spawn docker directly
    return spawn('docker', dockerArgs, {
      cwd: workspaceRoot,
      shell: false,
    });
  }

  private getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }
    return folders[0].uri.fsPath;
  }

  async discoverComposeFiles(): Promise<ComposeFileInfo[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return [];
    }

    const rootUri = workspaceFolders[0].uri;
    const results: ComposeFileInfo[] = [];

    for (const pattern of COMPOSE_FILE_PATTERNS) {
      const fileUri = vscode.Uri.joinPath(rootUri, pattern);
      try {
        await vscode.workspace.fs.stat(fileUri);
        results.push({
          filePath: fileUri.fsPath,
          fileName: pattern,
          relativePath: pattern,
        });
      } catch {
        // File does not exist, skip
      }
    }

    return results;
  }

  /**
   * Parse a docker-compose YAML file and extract service names and their port mappings.
   * Uses a simple line-based parser to avoid adding a YAML dependency.
   */
  async parseComposeServices(filePath: string): Promise<ComposeServiceInfo[]> {
    try {
      const fileUri = vscode.Uri.file(filePath);
      const content = (await vscode.workspace.fs.readFile(fileUri)).toString();
      return DockerController.extractServices(content);
    } catch {
      return [];
    }
  }

  /**
   * Extract services and their ports from docker-compose YAML content.
   * Handles both short syntax ("8080:80") and long syntax (target/published).
   */
  static extractServices(content: string): ComposeServiceInfo[] {
    const lines = content.split('\n');
    const services: ComposeServiceInfo[] = [];

    // Find the top-level "services:" key
    let servicesLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^services\s*:/.test(lines[i])) {
        servicesLineIdx = i;
        break;
      }
    }
    if (servicesLineIdx === -1) {
      return [];
    }

    // Parse service blocks under "services:"
    let currentService: ComposeServiceInfo | null = null;
    let inPorts = false;
    let inLongPort = false;
    let longPortTarget = '';
    let longPortPublished = '';
    const serviceIndent = DockerController.indentLevel(lines[servicesLineIdx]);

    for (let i = servicesLineIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Skip blank lines and comments
      if (trimmed === '' || /^\s*#/.test(trimmed)) {
        continue;
      }

      const indent = DockerController.indentLevel(line);

      // If we're back at or before the services indent, we've left the services block
      if (indent <= serviceIndent) {
        break;
      }

      const expectedServiceIndent = serviceIndent + 2;

      // Service-level key (indent == serviceIndent + 2)
      if (indent === expectedServiceIndent && /^\s+[\w][\w.-]*\s*:/.test(line)) {
        // Flush any pending long-form port
        if (inLongPort && currentService && longPortTarget) {
          const portStr = longPortPublished ? `${longPortPublished}:${longPortTarget}` : longPortTarget;
          currentService.ports.push(portStr);
        }
        inLongPort = false;
        inPorts = false;

        const match = trimmed.match(/^([\w][\w.-]*)\s*:/);
        if (match) {
          currentService = { name: match[1], ports: [] };
          services.push(currentService);
        }
        continue;
      }

      if (!currentService) {
        continue;
      }

      // Detect "ports:" key under a service
      if (indent === expectedServiceIndent + 2 && /^\s+ports\s*:/.test(line)) {
        inPorts = true;
        inLongPort = false;
        continue;
      }

      // Any other service-level property resets ports context
      if (indent === expectedServiceIndent + 2 && /^\s+[\w][\w.-]*\s*:/.test(line) && !/^\s+ports\s*:/.test(line)) {
        // Flush pending long-form port
        if (inLongPort && longPortTarget) {
          const portStr = longPortPublished ? `${longPortPublished}:${longPortTarget}` : longPortTarget;
          currentService.ports.push(portStr);
        }
        inPorts = false;
        inLongPort = false;
        continue;
      }

      // Parse port entries
      if (inPorts && indent >= expectedServiceIndent + 4) {
        // Long syntax: - target: <port> (list item starting a long-form entry)
        const longTargetMatch = trimmed.match(/^-\s*target\s*:\s*(\S+)/);
        if (longTargetMatch) {
          // Flush any previous pending long-form port
          if (inLongPort && longPortTarget) {
            const portStr = longPortPublished ? `${longPortPublished}:${longPortTarget}` : longPortTarget;
            currentService.ports.push(portStr);
          }
          inLongPort = true;
          longPortTarget = longTargetMatch[1].replace(/["']/g, '');
          longPortPublished = '';
          continue;
        }

        // Long syntax continuation: published: <port>
        const publishedMatch = trimmed.match(/^published\s*:\s*(\S+)/);
        if (publishedMatch && inLongPort) {
          longPortPublished = publishedMatch[1].replace(/["']/g, '');
          continue;
        }

        // Short syntax: - "8080:80" or - 8080:80
        const shortMatch = trimmed.match(/^-\s*"?([^"]+)"?\s*$/);
        if (shortMatch) {
          // Flush any pending long-form port first
          if (inLongPort && longPortTarget) {
            const portStr = longPortPublished ? `${longPortPublished}:${longPortTarget}` : longPortTarget;
            currentService.ports.push(portStr);
            inLongPort = false;
          }
          currentService.ports.push(shortMatch[1].trim());
          continue;
        }

        // Long syntax: target: <port> (without leading dash, for alternate formatting)
        const targetMatch = trimmed.match(/^target\s*:\s*(\S+)/);
        if (targetMatch) {
          if (inLongPort && longPortTarget) {
            const portStr = longPortPublished ? `${longPortPublished}:${longPortTarget}` : longPortTarget;
            currentService.ports.push(portStr);
          }
          inLongPort = true;
          longPortTarget = targetMatch[1].replace(/["']/g, '');
          longPortPublished = '';
          continue;
        }
      }
    }

    // Flush last pending long-form port
    if (inLongPort && currentService && longPortTarget) {
      const portStr = longPortPublished ? `${longPortPublished}:${longPortTarget}` : longPortTarget;
      currentService.ports.push(portStr);
    }

    return services;
  }

  private static indentLevel(line: string): number {
    const match = line.match(/^(\s*)/);
    return match ? match[1].length : 0;
  }

  async deploy(
    filePath: string,
    options?: DeployOptions,
    onOutput?: (chunk: string) => void
  ): Promise<DeployResult> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return { success: false, exitCode: -1, output: 'No workspace folder is open.' };
    }

    // Path traversal prevention: resolve and verify within workspace root
    const resolvedPath = path.resolve(workspaceRoot, filePath);
    const normalizedRoot = path.resolve(workspaceRoot);
    if (!resolvedPath.startsWith(normalizedRoot + path.sep) && resolvedPath !== normalizedRoot) {
      return {
        success: false,
        exitCode: -1,
        output: 'File path is outside the workspace root.',
      };
    }

    // Concurrent deploy prevention
    if (this.statusMap.get(filePath) === 'deploying') {
      return {
        success: false,
        exitCode: -1,
        output: 'A deployment is already in progress for this file.',
      };
    }

    // Transition to deploying
    this.statusMap.set(filePath, 'deploying');

    // Build command arguments
    const args = ['compose', '-f', resolvedPath, 'up'];

    const detached = options?.detached !== false; // default true
    if (detached) {
      args.push('-d');
    }

    const build = options?.build !== false; // default true
    if (build) {
      args.push('--build');
    }

    // Sanitize and append service names
    if (options?.services && options.services.length > 0) {
      for (const service of options.services) {
        const sanitized = sanitizeServiceName(service);
        if (sanitized.length > 0) {
          args.push(sanitized);
        }
      }
    }

    return new Promise<DeployResult>((resolve) => {
      let output = '';
      let settled = false;
      let timeoutId: NodeJS.Timeout | undefined;

      const settle = (result: DeployResult) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        this.processes.delete(filePath);
        resolve(result);
      };

      let child: ChildProcess;
      try {
        child = this.spawnDockerCommand(args, workspaceRoot, resolvedPath);
      } catch (err: unknown) {
        this.statusMap.set(filePath, 'error');
        const message = err instanceof Error ? err.message : String(err);
        settle({ success: false, exitCode: -1, output: message });
        return;
      }

      this.processes.set(filePath, child);

      // Handle ENOENT (docker/wsl not found)
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          this.statusMap.set(filePath, 'error');
          const useWSL = this.shouldUseWSL();
          const hint = useWSL
            ? 'WSL is not installed or not found on the system PATH. Please install WSL or set shai-vscode.useWSL to false to use Docker natively.'
            : 'Docker is not installed or not found on the system PATH. Please install Docker and ensure it is available.';
          settle({ success: false, exitCode: -1, output: hint });
        } else {
          this.statusMap.set(filePath, 'error');
          settle({ success: false, exitCode: -1, output: err.message });
        }
      });

      // Stream stdout
      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        onOutput?.(chunk);
      });

      // Stream stderr
      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        onOutput?.(chunk);
      });

      // Handle process exit
      child.on('close', (exitCode: number | null) => {
        const code = exitCode ?? -1;
        if (code === 0) {
          this.statusMap.set(filePath, 'running');
          settle({ success: true, exitCode: 0, output });
        } else {
          this.statusMap.set(filePath, 'error');
          settle({ success: false, exitCode: code, output });
        }
      });

      // 10-minute timeout
      timeoutId = setTimeout(() => {
        if (!settled) {
          try {
            child.kill('SIGTERM');
          } catch {
            // Process may have already exited
          }
          this.statusMap.set(filePath, 'error');
          settle({
            success: false,
            exitCode: -1,
            output: output + '\nDeployment timed out after 10 minutes.',
          });
        }
      }, DEPLOY_TIMEOUT);
    });
  }

  async stop(filePath: string): Promise<StopResult> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return { success: false, exitCode: -1 };
    }

    // Path traversal prevention
    const resolvedPath = path.resolve(workspaceRoot, filePath);
    const normalizedRoot = path.resolve(workspaceRoot);
    if (!resolvedPath.startsWith(normalizedRoot + path.sep) && resolvedPath !== normalizedRoot) {
      return { success: false, exitCode: -1 };
    }

    // Kill any running child process for this file path
    const existingProcess = this.processes.get(filePath);
    if (existingProcess) {
      try {
        existingProcess.kill('SIGTERM');
      } catch {
        // Process may have already exited
      }
      this.processes.delete(filePath);
    }

    // Transition to stopping
    this.statusMap.set(filePath, 'stopping');

    const args = ['compose', '-f', resolvedPath, 'down'];

    return new Promise<StopResult>((resolve) => {
      let settled = false;

      const settle = (result: StopResult) => {
        if (settled) {
          return;
        }
        settled = true;
        this.processes.delete(filePath);
        resolve(result);
      };

      let child: ChildProcess;
      try {
        child = this.spawnDockerCommand(args, workspaceRoot, resolvedPath);
      } catch (err: unknown) {
        this.statusMap.set(filePath, 'error');
        settle({ success: false, exitCode: -1 });
        return;
      }

      this.processes.set(filePath, child);

      // Handle ENOENT (docker/wsl not found)
      child.on('error', (err: NodeJS.ErrnoException) => {
        this.statusMap.set(filePath, 'error');
        settle({ success: false, exitCode: -1 });
      });

      // Handle process exit
      child.on('close', (exitCode: number | null) => {
        const code = exitCode ?? -1;
        if (code === 0) {
          this.statusMap.set(filePath, 'idle');
          settle({ success: true, exitCode: 0 });
        } else {
          this.statusMap.set(filePath, 'error');
          settle({ success: false, exitCode: code });
        }
      });
    });
  }

  getStatus(filePath: string): DeploymentStatus {
    return this.statusMap.get(filePath) ?? 'idle';
  }

  dispose(): void {
    for (const [, child] of this.processes) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Process may have already exited
      }
    }
    this.processes.clear();
    this.statusMap.clear();
  }
}
