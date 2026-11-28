/*
 * Pure (vscode-free) helpers that format file attachments for shai.
 * See attachments.ts for how they are delivered.
 */

export const MAX_INLINE_BYTES = 200 * 1024;
export const MAX_TOTAL_INLINE_BYTES = 1024 * 1024;

/** An attachment as resolved by the extension host. */
export interface ResolvedAttachment {
    /** File name shown to the user. */
    name: string;
    /** Path as seen by shai (WSL path when shai runs in WSL). */
    shaiPath: string;
    /** Size in bytes. */
    size: number;
    /** Text content when the file is inlined, undefined when referenced by path. */
    content?: string;
    /** Why the file is not inlined (binary, too large…). */
    reason?: string;
}

/** Heuristic binary detection: NUL byte or many control chars in the first 8 KB. */
export function isProbablyBinary(bytes: Uint8Array): boolean {
    const n = Math.min(bytes.length, 8192);
    if (n === 0) { return false; }
    let suspicious = 0;
    for (let i = 0; i < n; i++) {
        const b = bytes[i];
        if (b === 0) { return true; }
        if (b < 7 || (b > 13 && b < 32 && b !== 27)) { suspicious++; }
    }
    return suspicious / n > 0.1;
}

/** A code fence longer than any backtick run in `text`. */
export function fenceFor(text: string): string {
    let longest = 0;
    const re = /`+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        longest = Math.max(longest, m[0].length);
    }
    return '`'.repeat(Math.max(3, longest + 1));
}

/** Language hint for the code fence, from the file extension. */
function langFor(name: string): string {
    const m = /\.([A-Za-z0-9_+-]+)$/.exec(name);
    return m ? m[1].toLowerCase() : '';
}

/**
 * Short note appended to the prompt so the model knows files are attached
 * (and where to find the ones that are only referenced by path).
 */
export function buildAttachmentNote(attachments: ResolvedAttachment[]): string {
    if (attachments.length === 0) { return ''; }
    const lines = attachments.map(a => a.content !== undefined
        ? `- ${a.shaiPath} (content included in the next message)`
        : `- ${a.shaiPath} (${a.reason ?? 'not inlined'}: open it with your read tool if needed)`);
    return `\n\nThe user attached the following file(s) to this request:\n${lines.join('\n')}`;
}

/** Block containing the inlined content of the attached text files. */
export function buildAttachmentBlock(attachments: ResolvedAttachment[]): string {
    const inlined = attachments.filter(a => a.content !== undefined);
    if (inlined.length === 0) { return ''; }
    const parts = inlined.map(a => {
        const fence = fenceFor(a.content!);
        return `File: ${a.shaiPath}\n${fence}${langFor(a.name)}\n${a.content!.replace(/\r?\n$/, '')}\n${fence}`;
    });
    return `Attached files:\n\n${parts.join('\n\n')}\n`;
}
