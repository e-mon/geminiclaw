/**
 * agent/session/store.ts — JSONL session store.
 *
 * Saves RunResult records to append-only JSONL files per session.
 * Session history is managed by Gemini CLI's native conversation
 * state (always-resume) — this store is for audit trail, summary
 * generation, and usage tracking.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from '../../logger.js';
import type { RunResult } from '../runner.js';
import type { SessionEntry } from './types.js';

const log = createLogger('session');

// ── Session Store ────────────────────────────────────────────────

export class SessionStore {
    private readonly sessionsDir: string;

    constructor(sessionsDir: string) {
        this.sessionsDir = sessionsDir;
        if (!existsSync(sessionsDir)) {
            mkdirSync(sessionsDir, { recursive: true });
        }
    }

    /**
     * Convert a RunResult to a compact SessionEntry for storage.
     */
    static toEntry(result: RunResult): SessionEntry {
        return {
            runId: result.runId,
            timestamp: result.timestamp.toISOString(),
            trigger: result.trigger,
            ...(result.model ? { model: result.model } : {}),
            ...(result.title ? { title: result.title } : {}),
            prompt: result.prompt,
            responseText: result.responseText,
            toolCalls: result.toolCalls.map((tc) => ({
                name: tc.name,
                args: tc.args,
                result: tc.result,
                status: tc.status,
            })),
            heartbeatOk: result.heartbeatOk,
            ...(result.skillActivations?.length ? { skillActivations: result.skillActivations } : {}),
            tokens: {
                total: result.tokens.total,
                input: result.tokens.input,
                output: result.tokens.output,
                thinking: result.tokens.thinking,
                cached: result.tokens.cached,
            },
            error: result.error,
            ...(result.injectedContext ? { injectedContext: result.injectedContext } : {}),
            // Empty string sessionId is treated as absent (falsy → undefined).
            geminiSessionId: result.sessionId || undefined,
        };
    }

    /**
     * Append a RunResult to a session's JSONL file.
     */
    append(sessionId: string, result: RunResult): void {
        this.appendEntry(sessionId, SessionStore.toEntry(result));
    }

    /**
     * Append a raw SessionEntry directly to a session's JSONL file.
     *
     * Use this for synthetic entries (e.g. proactive posts) that don't
     * originate from a full agent turn / RunResult.
     */
    appendEntry(sessionId: string, entry: SessionEntry): void {
        const filePath = this.getFilePath(sessionId);
        const line = `${JSON.stringify(entry)}\n`;
        appendFileSync(filePath, line, 'utf-8');
    }

    /**
     * Load session entries from a JSONL file.
     */
    loadAll(sessionId: string): SessionEntry[] {
        const filePath = this.getFilePath(sessionId);
        if (!existsSync(filePath)) return [];

        const content = readFileSync(filePath, 'utf-8');
        const entries: SessionEntry[] = [];

        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                entries.push(JSON.parse(trimmed) as SessionEntry);
            } catch (err) {
                log.warn('Skipping invalid JSONL line', { error: String(err).substring(0, 100) });
            }
        }

        return entries;
    }

    /**
     * Return the most recent entry for a session, or undefined if none exists.
     */
    getLastEntry(sessionId: string): SessionEntry | undefined {
        return this.loadAll(sessionId).at(-1);
    }

    /**
     * Check if a session exists.
     */
    exists(sessionId: string): boolean {
        return existsSync(this.getFilePath(sessionId));
    }

    /**
     * Get the title for a session.
     *
     * Checks the dedicated titles file first, then falls back to scanning
     * JSONL entries for legacy compatibility.
     */
    getTitle(sessionId: string): string | undefined {
        // Primary: dedicated titles file (race-free, survives truncation)
        const title = readTitleFromFile(this.sessionsDir, sessionId);
        if (title) return title;

        // Fallback: legacy title embedded in JSONL entries
        const entries = this.loadAll(sessionId);
        for (const entry of entries) {
            if (entry.title) return entry.title;
        }
        return undefined;
    }

    /**
     * Persist a session title to the dedicated titles file.
     *
     * Atomic write — no read-modify-write race with JSONL appends.
     * Survives `truncateBefore` since titles live in a separate file.
     */
    setTitle(sessionId: string, title: string): void {
        writeTitleToFile(this.sessionsDir, sessionId, title);
    }

    /**
     * Find an existing session JSONL file that matches a channel/thread.
     *
     * Used to locate the right session for recording proactive posts.
     * Returns undefined if no matching session exists (i.e. never conversed
     * in that channel — no point recording since there's no session to resume).
     *
     * Matching strategy:
     * - If threadRef is provided, look for a file containing both channelId and threadRef
     * - Otherwise, look for channelId + today's date suffix (YYYYMMDD)
     */
    findSessionForChannel(channelId: string, threadRef?: string, timezone?: string): string | undefined {
        if (!existsSync(this.sessionsDir)) return undefined;

        const files = readdirSync(this.sessionsDir).filter((f) => f.endsWith('.jsonl'));

        // Use delimiter-bounded match to prevent partial ID collisions
        // (e.g. channelId "123" must not match "1234" in filenames like
        // "discord-guild-1234-20260309.jsonl"). Session filenames use "-"
        // as delimiter, so we match "-{id}-" or "-{id}." (end of basename).
        const idPattern = (id: string): string => `-${id}-`;
        const idEndPattern = (id: string): string => `-${id}.jsonl`;
        const hasId = (f: string, id: string): boolean => f.includes(idPattern(id)) || f.endsWith(idEndPattern(id));

        // Thread-specific match: find file containing both channelId and threadRef
        if (threadRef) {
            const match = files.find((f) => hasId(f, channelId) && hasId(f, threadRef));
            if (match) return match.replace('.jsonl', '');
        }

        // Channel-level match: channelId + today's date suffix
        const dateSuffix = todayDateString(timezone);
        const match = files.find((f) => hasId(f, channelId) && hasId(f, dateSuffix));
        if (match) return match.replace('.jsonl', '');

        return undefined;
    }

    // ── Private ──────────────────────────────────────────────────

    private getFilePath(sessionId: string): string {
        // Prevent path traversal — sessionId must be alphanumeric, dashes, dots, or colons only.
        if (!/^[\w][\w.:-]*$/.test(sessionId)) {
            throw new Error(`Invalid session ID: ${sessionId}`);
        }
        return join(this.sessionsDir, `${sessionId}.jsonl`);
    }

    /**
     * Truncate a session JSONL, keeping only entries from the given date onward.
     * Used after daily summary generation to prevent unbounded growth.
     */
    truncateBefore(sessionId: string, cutoffDate: string, timezone?: string): number {
        const filePath = this.getFilePath(sessionId);
        if (!existsSync(filePath)) return 0;

        const entries = this.loadAll(sessionId);
        const kept = entries.filter((e) => {
            const entryDate = new Intl.DateTimeFormat('sv-SE', {
                timeZone: timezone || undefined,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            }).format(new Date(e.timestamp));
            return entryDate >= cutoffDate;
        });

        const removed = entries.length - kept.length;
        if (removed > 0) {
            const content = kept.length > 0 ? `${kept.map((e) => JSON.stringify(e)).join('\n')}\n` : '';
            writeFileSync(filePath, content, 'utf-8');
            log.info('truncated session JSONL', { sessionId, removed, kept: kept.length });
        }
        return removed;
    }
}

// ── Helpers ──────────────────────────────────────────────────────

// ── Session titles file ──────────────────────────────────────────

const TITLES_FILENAME = 'session-titles.json';

function getTitlesPath(sessionsDir: string): string {
    return join(sessionsDir, TITLES_FILENAME);
}

function readTitles(sessionsDir: string): Record<string, string> {
    const filePath = getTitlesPath(sessionsDir);
    if (!existsSync(filePath)) return {};
    try {
        return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, string>;
    } catch {
        return {};
    }
}

function readTitleFromFile(sessionsDir: string, sessionId: string): string | undefined {
    return readTitles(sessionsDir)[sessionId] || undefined;
}

function writeTitleToFile(sessionsDir: string, sessionId: string, title: string): void {
    const dir = dirname(getTitlesPath(sessionsDir));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const titles = readTitles(sessionsDir);
    titles[sessionId] = title;
    writeFileSync(getTitlesPath(sessionsDir), JSON.stringify(titles, null, 2), 'utf-8');
}

/** Today's date as YYYYMMDD in the given IANA timezone. */
export function todayDateString(tz?: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz || undefined,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date());
    const get = (t: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === t)?.value ?? '00';
    return `${get('year')}${get('month')}${get('day')}`;
}
