/**
 * agent/session/continuation.ts — Session continuation context for date-rotated sessions.
 *
 * When a channel/DM session rotates to a new day, provides context from
 * the most recent previous session. Only injected on the first turn of
 * a new session (no existing JSONL entries for the current session ID).
 *
 * When a summary exists: TL;DR + Topics + recent conversation entries.
 * When no summary: recent JSONL entries only.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../logger.js';
import { SessionStore } from './store.js';
import { formatEntryForSummary, type SessionEntry } from './types.js';

const log = createLogger('session-continuation');

/** Topic-grouped digest entry. */
export interface TopicDigest {
    topic: string;
    summary: string;
}

/** Result of building session continuation context. */
export interface ContinuationResult {
    previousSessionId: string;
    date: string;
    /** TL;DR from summary (undefined when no summary available). */
    tldr: string | undefined;
    /** Topic digests from summary (empty when no summary available). */
    topics: TopicDigest[];
    /** Recent conversation entries from JSONL. */
    recentEntries: SessionEntry[];
}

/** Default max recent entries to include. */
const DEFAULT_MAX_RECENT_ENTRIES = 5;

/**
 * Build session continuation context for date-rotated sessions.
 *
 * Only returns data when the current session has no entries yet (first turn).
 * Finds the most recent previous session with the same channel prefix and
 * assembles TL;DR + topics (from summary) + recent entries (from JSONL).
 *
 * Args:
 *     sessionId: Current session ID (must have YYYYMMDD suffix).
 *     sessionsDir: Path to memory/sessions/ directory.
 *     summariesDir: Path to memory/summaries/ directory.
 *     maxRecentEntries: Max JSONL entries to include (default: 5).
 *
 * Returns:
 *     ContinuationResult, or undefined if not applicable.
 */
export function buildSessionContinuation(params: {
    sessionId: string;
    sessionsDir: string;
    summariesDir: string;
    maxRecentEntries?: number;
}): ContinuationResult | undefined {
    const { sessionId, sessionsDir, summariesDir } = params;
    const maxRecent = params.maxRecentEntries ?? DEFAULT_MAX_RECENT_ENTRIES;

    // Only applies to date-suffixed sessions (channels/DMs)
    const dateMatch = sessionId.match(/-(\d{8})$/);
    if (!dateMatch) return undefined;

    // Only on first turn — skip if current session already has entries
    const store = new SessionStore(sessionsDir);
    if (store.exists(sessionId) && store.getLastEntry(sessionId) != null) {
        return undefined;
    }

    const prefix = sessionId.replace(/-\d{8}$/, '');

    // Find the most recent previous session with the same prefix
    const prevSessionId = findPreviousSession(sessionsDir, prefix, sessionId);
    if (!prevSessionId) return undefined;

    const date = formatDateSuffix(prevSessionId);

    // Load summary data (TL;DR + Topics) if available
    const summaryData = readSummaryData(summariesDir, prevSessionId);

    // Load recent conversation entries from JSONL
    const allEntries = store.loadAll(prevSessionId);
    const recentEntries = allEntries.filter((e) => !e.heartbeatOk && e.responseText).slice(-maxRecent);

    // Nothing to inject
    if (!summaryData && recentEntries.length === 0) return undefined;

    log.info('continuation built', {
        prevSessionId,
        hasSummary: !!summaryData,
        topics: summaryData?.topics.length ?? 0,
        recentEntries: recentEntries.length,
    });

    return {
        previousSessionId: prevSessionId,
        date,
        tldr: summaryData?.tldr,
        topics: summaryData?.topics ?? [],
        recentEntries,
    };
}

/**
 * Render a ContinuationResult into a text block for -p injection.
 *
 * Args:
 *     result: The continuation data to render.
 *
 * Returns:
 *     Markdown text block for session context injection.
 */
export function renderContinuation(result: ContinuationResult): string {
    const lines: string[] = [`## Previous Session (${result.date})`, `Session: \`${result.previousSessionId}\``, ''];

    // TL;DR
    if (result.tldr) {
        lines.push(result.tldr, '');
    }

    // Topics
    if (result.topics.length > 0) {
        lines.push('**Topics:**');
        for (const t of result.topics) {
            lines.push(`- **${t.topic}**: ${t.summary}`);
        }
        lines.push('');
    }

    // Recent conversation
    if (result.recentEntries.length > 0) {
        lines.push('**Recent conversation:**');
        for (const entry of result.recentEntries) {
            lines.push(formatEntryForSummary(entry, 150));
            lines.push('');
        }
    }

    return lines.join('\n');
}

// ── Internal helpers ─────────────────────────────────────────────

/**
 * Find the most recent previous session JSONL for the same channel prefix.
 *
 * Scans sessionsDir for files matching `{prefix}-YYYYMMDD.jsonl` and returns
 * the most recent one that isn't the current session.
 */
function findPreviousSession(sessionsDir: string, prefix: string, currentSessionId: string): string | undefined {
    if (!existsSync(sessionsDir)) return undefined;

    try {
        const candidates: string[] = [];
        const files = readdirSync(sessionsDir);
        const pattern = new RegExp(`^${escapeRegex(prefix)}-(\\d{8})\\.jsonl$`);

        for (const file of files) {
            if (pattern.test(file)) {
                const sid = file.replace('.jsonl', '');
                if (sid !== currentSessionId) {
                    candidates.push(sid);
                }
            }
        }

        if (candidates.length === 0) return undefined;

        // Sort descending by date suffix → most recent first
        candidates.sort((a, b) => b.localeCompare(a));
        return candidates[0];
    } catch (err) {
        log.warn('failed to scan previous sessions', { error: String(err).substring(0, 200) });
        return undefined;
    }
}

/** Parsed summary data from a session summary file. */
interface SummaryData {
    tldr: string;
    topics: TopicDigest[];
}

/**
 * Read TL;DR and topic digests from a session summary file.
 *
 * Returns both TL;DR text and parsed topic bullets.
 * Returns undefined if no summary file found for the session.
 */
function readSummaryData(summariesDir: string, sessionId: string): SummaryData | undefined {
    if (!existsSync(summariesDir)) return undefined;

    try {
        const files = readdirSync(summariesDir).filter((f) => f.endsWith('.md'));
        for (const file of files) {
            const content = readFileSync(join(summariesDir, file), 'utf-8');
            if (!content.includes(`session: "${sessionId}"`)) continue;

            // Extract TL;DR
            const tldrMatch = content.match(/## TL;DR\n([\s\S]*?)(?=\n## |$)/);
            const tldr = tldrMatch?.[1]?.trim() ?? '';

            // Extract Topics
            const topics: TopicDigest[] = [];
            const topicsMatch = content.match(/## Topics\n([\s\S]*?)(?=\n## |$)/);
            if (topicsMatch?.[1]) {
                for (const m of topicsMatch[1].matchAll(/^- \*\*(.+?)\*\*:\s*(.+)$/gm)) {
                    if (m[1] && m[2]) {
                        topics.push({ topic: m[1], summary: m[2] });
                    }
                }
            }

            if (!tldr && topics.length === 0) return undefined;
            return { tldr, topics };
        }
    } catch (err) {
        log.warn('failed to read summary data', { error: String(err).substring(0, 200) });
    }
    return undefined;
}

/** Extract and format date from a session ID's YYYYMMDD suffix → YYYY-MM-DD. */
function formatDateSuffix(sessionId: string): string {
    const match = sessionId.match(/-(\d{4})(\d{2})(\d{2})$/);
    if (!match || !match[1] || !match[2] || !match[3]) return 'unknown';
    return `${match[1]}-${match[2]}-${match[3]}`;
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
