/**
 * agent/session/types.ts — Shared types for the session module.
 */

export interface SessionEntry {
    runId: string;
    timestamp: string;
    trigger: string;
    /** Resolved model name used for this run (e.g. "gemini-3-flash-preview"). */
    model?: string;
    /** Short session title generated from the first turn — used for thread naming and display. */
    title?: string;
    /** The user's original prompt for this run — required to reconstruct conversation context. */
    prompt?: string;
    responseText: string;
    toolCalls: Array<{
        name: string;
        args: unknown;
        result?: string;
        status?: string;
    }>;
    heartbeatOk: boolean;
    /** Skill names activated via <activated_skill> tags during this run. */
    skillActivations?: string[];
    tokens: { total: number; input: number; output: number; thinking?: number; cached?: number };
    error?: string;
    /** Gemini CLI session_id from InitEvent — used to resume the same CLI session via --resume. */
    geminiSessionId?: string;
    /** Full prompt text injected via `-p` (context prefix + user prompt). Debug-only field for dashboard inspection. */
    injectedContext?: string;
    /** @deprecated Legacy compaction metadata — no longer generated but kept for reading old JSONL files. */
    compactionMeta?: {
        compactedCount: number;
        originalTriggers: string[];
        rangeStart: string;
        rangeEnd: string;
        originalTokensTotal: number;
        entries: CompactedEntryDigest[];
    };
}

/** @deprecated Legacy digest type — kept for reading old JSONL files with compaction entries. */
export interface CompactedEntryDigest {
    timestamp: string;
    trigger: string;
    toolCount: number;
    toolNames: string[];
    tokens: number;
    heartbeatOk: boolean;
    promptPreview?: string;
    responsePreview?: string;
    errorPreview?: string;
}

/**
 * Format a session entry as a concise text block for summarization prompts.
 *
 * Args:
 *     entry: The session entry to format.
 *     maxResponseChars: Maximum characters to keep from responseText.
 */
export function formatEntryForSummary(entry: SessionEntry, maxResponseChars: number = 300): string {
    const lines: string[] = [`[${entry.timestamp}] ${entry.trigger}`];
    if (entry.prompt) lines.push(`User: ${entry.prompt}`);
    if (entry.toolCalls.length > 0) {
        lines.push(`Tools: ${entry.toolCalls.map((tc) => tc.name).join(', ')}`);
    }
    if (entry.responseText) {
        lines.push(`Agent: ${entry.responseText.substring(0, maxResponseChars)}`);
    }
    if (entry.error) {
        lines.push(`Error: ${entry.error.substring(0, 120)}`);
    }
    return lines.join('\n');
}
