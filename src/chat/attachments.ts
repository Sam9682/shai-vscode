import * as vscode from 'vscode';
import * as os from 'os';
import { shouldUseWSL, windowsToWSLPath } from '../platform/wsl';
import {
    MAX_INLINE_BYTES,
    MAX_TOTAL_INLINE_BYTES,
    ResolvedAttachment,
    isProbablyBinary,
} from './attachmentFormat';

export * from './attachmentFormat';

/*
 * File attachments for chat requests.
 *
 * shai (https://github.com/ovh/shai) has no attachment flag and only sends
 * text content to the model (`ChatMessageContent::Text`). Its headless mode
 * however accepts `--prompt` AND piped stdin at the same time, turning each of
 * them into a separate user message (prompt first, then stdin). Attachments are
 * therefore delivered as follows:
 *  - text files (up to MAX_INLINE_BYTES each, MAX_TOTAL_INLINE_BYTES overall)
 *    are inlined in a block written to shai's stdin (or appended to the body
 *    in server mode), which avoids any command-line length limit;
 *  - binary files (images, PDFs, archives…) and files over the limits are
 *    passed by path only: shai can open them with its `read` tool.
 */

/** Path of `uri` as seen by the shai process. */
export function uriToShaiPath(uri: vscode.Uri): string {
    if (uri.scheme === 'file') {
        return shouldUseWSL() && os.platform() === 'win32' ? windowsToWSLPath(uri.fsPath) : uri.fsPath;
    }
    // vscode-remote://wsl+distro/home/... and other remote schemes: the path is
    // already the one on the remote side, where shai runs.
    return uri.path;
}

/** Read the attachments, deciding which ones are inlined and which are referenced. */
export async function resolveAttachments(uris: string[]): Promise<ResolvedAttachment[]> {
    const result: ResolvedAttachment[] = [];
    let total = 0;
    for (const raw of uris) {
        let uri: vscode.Uri;
        try {
            uri = vscode.Uri.parse(raw, true);
        } catch {
            continue;
        }
        const name = uri.path.split('/').pop() || uri.path;
        const shaiPath = uriToShaiPath(uri);
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type & vscode.FileType.Directory) {
                result.push({ name, shaiPath, size: 0, reason: 'directory' });
                continue;
            }
            if (stat.size > MAX_INLINE_BYTES) {
                result.push({ name, shaiPath, size: stat.size, reason: 'file too large to inline' });
                continue;
            }
            if (total + stat.size > MAX_TOTAL_INLINE_BYTES) {
                result.push({ name, shaiPath, size: stat.size, reason: 'attachment size limit reached' });
                continue;
            }
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (isProbablyBinary(bytes)) {
                result.push({ name, shaiPath, size: stat.size, reason: 'binary file' });
                continue;
            }
            total += bytes.length;
            result.push({ name, shaiPath, size: stat.size, content: new TextDecoder('utf-8').decode(bytes) });
        } catch {
            result.push({ name, shaiPath, size: 0, reason: 'file could not be read' });
        }
    }
    return result;
}
