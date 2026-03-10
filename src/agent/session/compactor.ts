/**
 * agent/session/compactor.ts — Session history compaction via summarization.
 *
 * GeminiCompactor accepts a SummarizeFn via DI so the session module
 * never imports runner.ts directly, breaking the circular dependency.
 */

import { randomUUID } from 'node:crypto';
import {
    type CompactedEntryDigest,
    formatEntryForSummary,
    type SessionCompactor,
    type SessionEntry,
    type SummarizeFn,
} from './types.js';

/**
 * GeminiCompactor uses a caller-provided summarization function to compress
 * session history. The actual Gemini CLI invocation is injected from run-turn.ts.
 */
export class GeminiCompactor implements SessionCompactor {
    constructor(
        private readonly summarize: SummarizeFn,
        private readonly model: string,
    ) {}

    async compact(entries: SessionEntry[]): Promise<SessionEntry> {
        const historyText = entries.map((e) => formatEntryForSummary(e, 300)).join('\n\n---\n\n');

        const prompt = [
            'Summarize the following agent session history into a concise paragraph.',
            'Preserve key facts, decisions, and outcomes. Omit routine tool calls.',
            'Output ONLY the summary text, no headers or labels.',
            '',
            historyText,
        ].join('\n');

        const summaryText = await this.summarize(prompt, this.model);
        const summary = summaryText.trim() || `[Compacted ${entries.length} session entries]`;

        const triggers = [...new Set(entries.map((e) => e.trigger).filter(Boolean))];
        const timestamps = entries
            .map((e) => e.timestamp)
            .filter(Boolean)
            .sort();
        const originalTokensTotal = entries.reduce((sum, e) => sum + (e.tokens?.total ?? 0), 0);

        const digests: CompactedEntryDigest[] = entries.map((e) => ({
            timestamp: e.timestamp,
            trigger: e.trigger,
            toolCount: e.toolCalls.length,
            toolNames: [...new Set(e.toolCalls.map((tc) => tc.name).filter(Boolean))],
            tokens: e.tokens?.total ?? 0,
            heartbeatOk: e.heartbeatOk,
            promptPreview: e.prompt ? e.prompt.substring(0, 120) : undefined,
            responsePreview: e.responseText ? e.responseText.substring(0, 120) : undefined,
            errorPreview: e.error ? e.error.substring(0, 120) : undefined,
        }));

        return {
            runId: randomUUID(),
            timestamp: new Date().toISOString(),
            trigger: 'compaction',
            prompt: undefined,
            responseText: `[Session summary covering ${entries.length} earlier entries]\n\n${summary}`,
            toolCalls: [],
            heartbeatOk: false,
            tokens: { total: 0, input: 0, output: 0, cached: 0 },
            compactionMeta: {
                compactedCount: entries.length,
                originalTriggers: triggers,
                rangeStart: timestamps[0] ?? '',
                rangeEnd: timestamps.at(-1) ?? '',
                originalTokensTotal,
                entries: digests,
            },
        };
    }
}
