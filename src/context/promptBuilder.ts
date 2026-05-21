import type { ContextEntry } from './contextManager';

/**
 * Build the enriched prompt sent to shai.
 *
 * When there is no prior context (empty summary, no turns, no system prompt)
 * the raw userMessage is returned as-is so that first-time calls are not
 * wrapped in unnecessary boilerplate.
 *
 * Otherwise the prompt is structured as:
 *
 *   <system>
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
    systemPrompt: string = ''
): string {
    const hasSummary      = summary.trim().length > 0;
    const hasTurns        = recentTurns.length > 0;
    const hasSystemPrompt = systemPrompt.trim().length > 0;

    if (!hasSummary && !hasTurns && !hasSystemPrompt) {
        return userMessage;
    }

    const parts: string[] = [];

    if (hasSystemPrompt) {
        parts.push('<system>');
        parts.push(systemPrompt.trim());
        parts.push('</system>');
        parts.push('');
    }

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
