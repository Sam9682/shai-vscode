import * as vscode from 'vscode';
import * as os from 'os';
import { execFileSync } from 'child_process';
import {
  buildWslArgs,
  distroFromRemoteAuthority,
  distroFromUncPath,
  windowsToWSLPath,
  wslPathToWindows,
} from './wslPath';

export { windowsToWSLPath, escapeShellArg } from './wslPath';

/*
 * The extension declares `"extensionKind": ["workspace", "ui"]`, so it can run
 * either:
 *  - in the WSL / remote extension host (installed "in WSL: <distro>"):
 *    os.platform() is 'linux', shai is spawned natively;
 *  - in the local Windows extension host (installed locally, even while the
 *    window is connected to WSL): shai is spawned through `wsl.exe`, in the
 *    same distro as the remote workspace when there is one.
 */

/** Whether shai (and docker) must be run through `wsl.exe`. */
export function shouldUseWSL(): boolean {
  const config = vscode.workspace.getConfiguration('shai-vscode');
  const useWSLConfig = config.get<boolean | null>('useWSL');
  if (useWSLConfig !== null && useWSLConfig !== undefined) {
    return useWSLConfig;
  }
  return os.platform() === 'win32';
}

/** The first workspace folder's URI, if any. */
export function getWorkspaceUri(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** The first workspace folder as a path for the extension host (falls back to cwd). */
export function getWorkspaceFolderPath(): string {
  return getWorkspaceUri()?.fsPath || process.cwd();
}

/**
 * The WSL distro to run shai in: the one of the remote workspace
 * (`vscode-remote://wsl+<distro>/…`) or of a `\\wsl.localhost\<distro>\…`
 * folder. Undefined means the default WSL distro.
 */
export function getWSLDistro(): string | undefined {
  const explicit = vscode.workspace.getConfiguration('shai-vscode').get<string>('wslDistro');
  if (explicit) { return explicit; }
  const uri = getWorkspaceUri();
  if (!uri) { return undefined; }
  if (uri.scheme === 'vscode-remote') {
    return distroFromRemoteAuthority(uri.authority);
  }
  return distroFromUncPath(uri.fsPath);
}

/** The workspace folder as seen by shai (converted to a WSL path when needed). */
export function getShaiWorkingDir(): string {
  const folder = getWorkspaceFolderPath();
  return shouldUseWSL() && os.platform() === 'win32' ? windowsToWSLPath(folder) : folder;
}

/** command + argv to run `shellCommand` inside WSL. */
export function wslCommand(shellCommand: string): { command: string; args: string[] } {
  const distro = os.platform() === 'win32' ? getWSLDistro() : undefined;
  return { command: 'wsl.exe', args: buildWslArgs(shellCommand, distro) };
}

/**
 * Turns a path printed by shai into a URI the editor can open, whichever
 * side the extension runs on.
 */
export function shaiPathToUri(p: string): vscode.Uri {
  const ws = getWorkspaceUri();
  // Window connected to WSL/remote while running in the local host: reuse the
  // remote scheme/authority so VS Code opens the file on the remote side.
  if (ws && ws.scheme !== 'file') {
    return ws.with({ path: p.replace(/\\/g, '/') });
  }
  if (os.platform() === 'win32' && shouldUseWSL() && p.startsWith('/')) {
    const win = wslPathToWindows(p, getWSLDistro() ?? getDefaultWSLDistro());
    if (win) { return vscode.Uri.file(win); }
  }
  return vscode.Uri.file(p);
}

let defaultDistroCache: string | null | undefined;

/** Name of the default WSL distro (cached), as reported by `$WSL_DISTRO_NAME`. */
export function getDefaultWSLDistro(): string | undefined {
  if (defaultDistroCache === undefined) {
    try {
      defaultDistroCache = execFileSync('wsl.exe', ['-e', 'sh', '-c', 'printf %s "$WSL_DISTRO_NAME"'], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      }).trim() || null;
    } catch {
      defaultDistroCache = null;
    }
  }
  return defaultDistroCache ?? undefined;
}

const wslConfigDirCache = new Map<string, string | null>();

/**
 * Windows path (`\\wsl.localhost\<distro>\home\…\.config\shai`) of shai's
 * config directory inside WSL, so the auth wizard edits the file that shai
 * really reads. Undefined if WSL cannot be queried.
 */
export function getWSLShaiConfigDir(): string | undefined {
  const distro = getWSLDistro();
  const key = distro ?? '';
  if (!wslConfigDirCache.has(key)) {
    try {
      const out = execFileSync(
        'wsl.exe',
        buildWslArgs('wslpath -w "${XDG_CONFIG_HOME:-$HOME/.config}/shai"', distro),
        { encoding: 'utf8', timeout: 15000, windowsHide: true }
      ).trim().split(/\r?\n/).pop()?.trim();
      wslConfigDirCache.set(key, out || null);
    } catch {
      wslConfigDirCache.set(key, null);
    }
  }
  return wslConfigDirCache.get(key) ?? undefined;
}
