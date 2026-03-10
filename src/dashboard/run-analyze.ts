/**
 * dashboard/run-analyze.ts — Data access layer for the Run Viewer.
 *
 * Scans session JSONL files to provide paginated run listings,
 * session overviews, and individual run detail lookups.
 * Uses a 10-second TTL cache (same pattern as analyze.ts).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEntry } from '../agent/session/types.js';

// ── Public types ────────────────────────────────────────────────

export interface RunListItem {
    runId: string;
    sessionId: string;
    timestamp: string;
    trigger: string;
    model: string | undefined;
    heartbeatOk: boolean;
    toolCallCount: number;
    toolNames: string[];
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    hasError: boolean;
    errorPreview: string | undefined;
}

export interface RunListResponse {
    runs: RunListItem[];
    total: number;
    hasMore: boolean;
}

export interface SessionListItem {
    sessionId: string;
    runCount: number;
    lastTimestamp: string;
}

export interface ListRunsOptions {
    since?: string;
    limit?: number;
    offset?: number;
    trigger?: string;
    session?: string;
}

// ── Internal cache ──────────────────────────────────────────────

interface CachedRunList {
    key: string;
    items: RunListItem[];
    ts: number;
}

let cachedRuns: CachedRunList | undefined;
const CACHE_TTL_MS = 10_000;

/** Scan all JSONL files and extract every run as a RunListItem. */
function scanAllRuns(sessionsDir: string): RunListItem[] {
    let files: string[];
    try {
        files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
        return [];
    }

    // Sort files by mtime descending for recent-first ordering
    const filesWithMtime = files.map((f) => {
        try {
            return { name: f, mtime: statSync(join(sessionsDir, f)).mtimeMs };
        } catch {
            return { name: f, mtime: 0 };
        }
    });
    filesWithMtime.sort((a, b) => b.mtime - a.mtime);

    const items: RunListItem[] = [];

    for (const { name: file } of filesWithMtime) {
        const sessionId = file.replace(/\.jsonl$/, '');
        const content = readFileSync(join(sessionsDir, file), 'utf-8');

        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            let entry: SessionEntry;
            try {
                entry = JSON.parse(line) as SessionEntry;
            } catch {
                continue;
            }

            const toolNames = [...new Set(entry.toolCalls.map((tc) => tc.name).filter(Boolean))];

            items.push({
                runId: entry.runId,
                sessionId,
                timestamp: entry.timestamp,
                trigger: entry.trigger,
                model: entry.model,
                heartbeatOk: entry.heartbeatOk,
                toolCallCount: entry.toolCalls.length,
                toolNames,
                tokens: entry.tokens?.total ?? 0,
                inputTokens: entry.tokens?.input ?? 0,
                outputTokens: entry.tokens?.output ?? 0,
                thinkingTokens: entry.tokens?.thinking ?? 0,
                hasError: !!entry.error,
                errorPreview: entry.error ? entry.error.substring(0, 120) : undefined,
            });
        }
    }

    // Sort by timestamp descending (most recent first)
    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return items;
}

function getCachedRuns(sessionsDir: string): RunListItem[] {
    const key = sessionsDir;
    if (cachedRuns && cachedRuns.key === key && Date.now() - cachedRuns.ts < CACHE_TTL_MS) {
        return cachedRuns.items;
    }
    const items = scanAllRuns(sessionsDir);
    cachedRuns = { key, items, ts: Date.now() };
    return items;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * List runs with pagination and optional filters.
 *
 * Args:
 *     sessionsDir: Path to the sessions JSONL directory.
 *     opts: Pagination and filter options.
 *
 * Returns:
 *     Paginated list of runs with total count and hasMore flag.
 */
export function listRuns(sessionsDir: string, opts: ListRunsOptions = {}): RunListResponse {
    const { since, limit = 50, offset = 0, trigger, session } = opts;
    let items = getCachedRuns(sessionsDir);

    // Apply filters
    if (since) {
        const sinceMs = new Date(since).getTime();
        items = items.filter((r) => new Date(r.timestamp).getTime() >= sinceMs);
    }
    if (trigger) {
        items = items.filter((r) => r.trigger === trigger);
    }
    if (session) {
        items = items.filter((r) => r.sessionId === session);
    }

    const total = items.length;
    const paged = items.slice(offset, offset + limit);

    return {
        runs: paged,
        total,
        hasMore: offset + limit < total,
    };
}

/**
 * Get the full SessionEntry for a specific run.
 *
 * Args:
 *     sessionsDir: Path to the sessions JSONL directory.
 *     sessionId: The session file name (without .jsonl).
 *     runId: The runId to find within the session.
 *
 * Returns:
 *     The matching SessionEntry or undefined if not found.
 */
export function getRunDetail(sessionsDir: string, sessionId: string, runId: string): SessionEntry | undefined {
    const filePath = join(sessionsDir, `${sessionId}.jsonl`);
    let content: string;
    try {
        content = readFileSync(filePath, 'utf-8');
    } catch {
        return undefined;
    }

    for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line) as SessionEntry;
            if (entry.runId === runId) return entry;
        } catch {}
    }
    return undefined;
}

/**
 * List all sessions with run counts and last timestamps.
 *
 * Args:
 *     sessionsDir: Path to the sessions JSONL directory.
 *
 * Returns:
 *     Array of session summaries sorted by last timestamp descending.
 */
export function listSessions(sessionsDir: string): SessionListItem[] {
    let files: string[];
    try {
        files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
        return [];
    }

    const sessions: SessionListItem[] = [];

    for (const file of files) {
        const sessionId = file.replace(/\.jsonl$/, '');
        const content = readFileSync(join(sessionsDir, file), 'utf-8');
        const lines = content.split('\n').filter((l) => l.trim());

        let runCount = 0;
        let lastTimestamp = '';

        for (const line of lines) {
            try {
                const entry = JSON.parse(line) as { timestamp: string };
                runCount++;
                if (!lastTimestamp || entry.timestamp > lastTimestamp) {
                    lastTimestamp = entry.timestamp;
                }
            } catch {}
        }

        if (runCount > 0) {
            sessions.push({ sessionId, runCount, lastTimestamp });
        }
    }

    sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime());
    return sessions;
}
