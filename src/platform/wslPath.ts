/**
 * Pure helpers (no `vscode` import) for running shai through WSL from a
 * Windows extension host. Kept free of the vscode API so they can be unit
 * tested directly.
 */

/**
 * Converts a path as seen by the Windows extension host to the path WSL sees.
 *
 *  - `C:\Users\foo`                         → `/mnt/c/Users/foo`
 *  - `\\wsl.localhost\Ubuntu\home\me\proj`  → `/home/me/proj`
 *  - `\\wsl$\Ubuntu\home\me\proj`           → `/home/me/proj`
 *  - `\home\me\proj` (fsPath of a `vscode-remote://wsl+…` URI on Windows)
 *                                           → `/home/me/proj`
 *  - already-Linux paths are returned unchanged.
 */
export function windowsToWSLPath(windowsPath: string): string {
  let p = windowsPath.replace(/\\/g, '/');

  const unc = /^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/i.exec(p);
  if (unc) {
    return unc[1] || '/';
  }

  if (/^[A-Za-z]:/.test(p)) {
    p = `/mnt/${p[0].toLowerCase()}${p.substring(2)}`;
  }
  return p;
}

/** Extracts the distro name from a `\\wsl.localhost\<distro>\…` / `\\wsl$\<distro>\…` path. */
export function distroFromUncPath(p: string): string | undefined {
  const m = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)/i.exec(p);
  return m ? m[1] : undefined;
}

/** Extracts the distro name from a VS Code remote authority such as `wsl+Ubuntu-24.04`. */
export function distroFromRemoteAuthority(authority: string | undefined): string | undefined {
  if (!authority) { return undefined; }
  const m = /^wsl\+(.+)$/i.exec(decodeURIComponent(authority));
  return m ? m[1] : undefined;
}

/**
 * Builds the `wsl.exe` argv that runs `shellCommand` in a bash login shell
 * (so `~/.profile` puts `~/.local/bin`, `~/.cargo/bin`… on PATH, which is
 * where shai is usually installed).
 *
 * `-e` makes wsl.exe exec bash directly instead of re-parsing the command
 * line through the default shell, so the quoting done by the caller is the
 * only quoting layer.
 */
export function buildWslArgs(shellCommand: string, distro?: string): string[] {
  const args: string[] = [];
  if (distro) {
    args.push('-d', distro);
  }
  args.push('-e', 'bash', '-lc', shellCommand);
  return args;
}

/** Single-quotes an argument for bash. */
export function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Maps a Linux path printed by shai running in WSL back to a path the
 * Windows extension host can open:
 *  - `/mnt/c/foo`  → `C:\foo`
 *  - `/home/me/x`  → `\\wsl.localhost\<distro>\home\me\x` (when distro is known)
 * Returns undefined when it cannot be mapped.
 */
export function wslPathToWindows(linuxPath: string, distro?: string): string | undefined {
  const mnt = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(linuxPath);
  if (mnt) {
    return `${mnt[1].toUpperCase()}:${(mnt[2] || '/').replace(/\//g, '\\')}`;
  }
  if (linuxPath.startsWith('/') && distro) {
    return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`;
  }
  return undefined;
}
