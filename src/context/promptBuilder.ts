import type { ContextEntry } from './contextManager';

/**
 * Pre-context injected at the top of every enriched prompt, for every context
 * (predefined or user-defined), before the context's own system prompt.
 * The chat view renders `[name](file:///abs/path)` as a clickable link that
 * opens the file in VS Code.
 */
export const ALWAYS_PRE_CONTEXT = [
    'MANDATORY OUTPUT RULE - FILE LINKS:',
    'Your answer is rendered in a chat panel inside VS Code. That panel turns markdown links whose target starts with file:// into clickable links that open the file or folder in VS Code.',
    'Therefore, EVERY time your answer mentions a file or directory that exists on the local disk (in a listing, a table, a sentence, search results, a list of modified files, etc.), you MUST write it as a markdown link:',
    '  [display name](file:///absolute/path/to/item)',
    'Rules:',
    '1. The link target MUST be the ABSOLUTE path, prefixed with file:// (three slashes before the path, e.g. file:///home/user/project/README.md).',
    '2. Relative names (README.md, src/, ./build.sh) MUST be resolved against the current working directory given below before building the link.',
    '3. Encode spaces in the link target as %20. Keep the visible display name short (file or folder name, or a relative path).',
    '4. NEVER put these links inside code blocks (```) or inline code (`...`): links there are not clickable. Do not use [BUTTON:...] or [ACTION:...] for files.',
    '5. Directories follow the same rule; you may keep a trailing slash in the display name.',
    'Example: for the working directory /home/user/project, listing its content must look like:',
    '- [README.md](file:///home/user/project/README.md)',
    '- [package.json](file:///home/user/project/package.json)',
    '- [src/](file:///home/user/project/src)',
    'Never output a bare file name such as README.md or a bare path such as /home/user/project/README.md without the link.',
].join('\n');

/** Pre-context including the current working directory, when known. */
export function buildPreContext(workingDir?: string): string {
    const dir = (workingDir ?? '').trim();
    return dir
        ? `${ALWAYS_PRE_CONTEXT}\nCurrent working directory (resolve relative paths against it): ${dir}`
        : ALWAYS_PRE_CONTEXT;
}

/**
 * Build the enriched prompt sent to shai.
 *
 * The prompt is structured as follows (the <context> block is omitted when
 * there is no summary and no recent turns):
 *
 *   <system>
 *   {ALWAYS_PRE_CONTEXT}
 *
 *   {systemPrompt}
 *   </system>
 *
 *   <context>
 *   [PREVIOUS CONTEXT SUMMARY]
 *   {summary}
 *
 *   [RECENT CONVERSATION]
 *   User: ...
 *   Assistant: ...
 *   </context>
 *
 *   {userMessage}
 */
export function buildPrompt(
    summary: string,
    recentTurns: ContextEntry[],
    userMessage: string,
    systemPrompt: string = '',
    workingDir?: string
): string {
    const hasSummary      = summary.trim().length > 0;
    const hasTurns        = recentTurns.length > 0;
    const hasSystemPrompt = systemPrompt.trim().length > 0;

    const parts: string[] = [];

    // The pre-context is always present, so the <system> block is always emitted.
    parts.push('<system>');
    parts.push(buildPreContext(workingDir));
    if (hasSystemPrompt) {
        parts.push('');
        parts.push(systemPrompt.trim());
    }
    parts.push('</system>');
    parts.push('');

    if (hasSummary || hasTurns) {
        parts.push('<context>');

        if (hasSummary) {
            parts.push('[PREVIOUS CONTEXT SUMMARY]');
            parts.push(summary.trim());
        }

        if (hasTurns) {
            if (hasSummary) {
                parts.push('');
            }
            parts.push('[RECENT CONVERSATION]');
            for (const turn of recentTurns) {
                const label = turn.role === 'user' ? 'User' : 'Assistant';
                parts.push(`${label}: ${turn.content}`);
            }
        }

        parts.push('</context>');
        parts.push('');
    }

    parts.push(userMessage);

    return parts.join('\n');
}
