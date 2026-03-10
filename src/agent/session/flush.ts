/**
 * agent/session/flush.ts — Silent memory flush before session context is lost.
 *
 * Spawns a Gemini CLI instance to let the LLM decide what to persist
 * to MEMORY.md before the current CLI session ends.
 */

import { createLogger } from '../../logger.js';
import { todayInTimezone } from './daily-summary.js';
import { formatEntryForSummary, type SessionEntry } from './types.js';

const log = createLogger('session');

export interface FlushDeps {
    /** Execute a flush prompt via ACP, returning responseText. */
    spawnFlush: (
        args: string[],
        opts: {
            cwd: string;
            trigger: string;
            maxToolIterations: number;
            model?: string;
        },
    ) => Promise<{ responseText: string; error?: string }>;
}

/**
 * OpenClaw-style silent step: spawn Gemini CLI to let the LLM decide
 * what to persist to MEMORY.md before the CLI session context is lost.
 * Fail-open: if the flush fails, warn and continue.
 */
export async function silentMemoryFlush(
    entries: SessionEntry[],
    workspaceRoot: string,
    model: string,
    deps: FlushDeps,
    timezone?: string,
): Promise<void> {
    if (entries.length === 0) return;

    const historyText = entries
        .slice(-20)
        .map((e) => formatEntryForSummary(e, 200))
        .join('\n\n---\n\n');

    const dateStr = todayInTimezone(timezone);

    const prompt = [
        'You are a memory archiving agent. The following session entries are from a',
        'Gemini CLI session that is about to end. Their details will be lost.',
        '',
        '<session_history>',
        historyText,
        '</session_history>',
        '',
        `Today: ${dateStr}`,
        '',
        'Instructions:',
        '1. READ MEMORY.md to understand existing knowledge.',
        '2. EDIT MEMORY.md — append NEW lasting facts only (decisions, preferences,',
        '   error solutions, architecture notes). Keep under 5KB. Surgical edits.',
        `3. APPEND activity summary to memory/logs/${dateStr}.md (create with frontmatter if new):`,
        '```',
        '---',
        `date: "${dateStr}"`,
        'type: daily-log',
        'tags:',
        '  - type/daily-log',
        '---',
        `# ${dateStr} Activity Log`,
        '```',
        '4. If nothing worth persisting, do nothing.',
        '',
        'IMPORTANT: Always READ files before editing. Never overwrite.',
    ].join('\n');

    try {
        const result = await deps.spawnFlush([prompt], {
            cwd: workspaceRoot,
            trigger: 'manual',
            maxToolIterations: 5,
            model,
        });
        if (result.error) {
            log.warn('Silent memory flush failed', {
                error: String(result.error).substring(0, 200),
            });
        }
    } catch (err) {
        log.warn('Silent memory flush threw', {
            error: String(err).substring(0, 200),
        });
    }
}
