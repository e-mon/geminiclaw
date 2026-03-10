/**
 * agent/session/heartbeat-digest.ts — Incremental digest for heartbeat consumption.
 *
 * Generates a compact markdown summary of recent session activity so that
 * the heartbeat agent doesn't need to read raw JSONL files every run.
 * Writes to `memory/heartbeat-digest.md`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../logger.js';
import { toLocalTime } from './daily-summary.js';
import type { SessionEntry } from './types.js';

const log = createLogger('heartbeat-digest');

/** Every N runs, extend lookback to 24h to catch missed entries. */
const DEEP_SCAN_INTERVAL = 6;

/** Max characters per entry line (prompt + response). */
const MAX_ENTRY_CHARS = 200;

/** Max total characters for the entire digest. */
const MAX_DIGEST_CHARS = 3000;

interface HeartbeatState {
    lastRunTimestamp: string;
    runCount: number;
}

function readState(workspacePath: string): HeartbeatState {
    const statePath = join(workspacePath, 'memory', 'heartbeat-state.json');
    try {
        const raw = readFileSync(statePath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return {
            lastRunTimestamp: typeof parsed.lastRunTimestamp === 'string' ? parsed.lastRunTimestamp : '',
            runCount: typeof parsed.runCount === 'number' ? parsed.runCount : 0,
        };
    } catch {
        return { lastRunTimestamp: '', runCount: 0 };
    }
}

function writeState(workspacePath: string, state: HeartbeatState): void {
    const memoryDir = join(workspacePath, 'memory');
    if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
    const statePath = join(memoryDir, 'heartbeat-state.json');

    // Preserve existing fields (e.g. per-check lastRun) and merge digest state
    let existing: Record<string, unknown> = {};
    try {
        existing = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    } catch {
        // fresh state
    }
    existing.lastRunTimestamp = state.lastRunTimestamp;
    existing.runCount = state.runCount;
    writeFileSync(statePath, JSON.stringify(existing, null, 2), 'utf-8');
}

function truncate(text: string, max: number): string {
    // Collapse newlines to spaces to keep each digest entry on a single line
    const flat = text.replace(/\n+/g, ' ').trim();
    if (flat.length <= max) return flat;
    return `${flat.substring(0, max - 3)}...`;
}

/**
 * Extract the session/channel name from the JSONL filename.
 * e.g. "discord-123456.jsonl" → "discord-123456"
 */
function sessionNameFromFile(filename: string): string {
    return filename.replace(/\.jsonl$/, '');
}

/**
 * Generate a digest of recent session activity for heartbeat consumption.
 * Only includes entries since the last heartbeat run (incremental).
 *
 * Every DEEP_SCAN_INTERVAL runs, extends the lookback window to 24h
 * to catch anything that might have been missed.
 */
export function generateHeartbeatDigest(opts: { sessionsDir: string; workspacePath: string; timezone?: string }): void {
    const { sessionsDir, workspacePath, timezone } = opts;
    const state = readState(workspacePath);
    const now = new Date();
    const isDeepScan = state.runCount > 0 && state.runCount % DEEP_SCAN_INTERVAL === 0;

    // Determine cutoff timestamp
    let cutoffMs: number;
    if (!state.lastRunTimestamp) {
        // First run — look back 1 hour
        cutoffMs = now.getTime() - 60 * 60 * 1000;
    } else if (isDeepScan) {
        // Deep scan — look back 24 hours
        cutoffMs = now.getTime() - 24 * 60 * 60 * 1000;
    } else {
        cutoffMs = new Date(state.lastRunTimestamp).getTime();
    }

    if (!existsSync(sessionsDir)) {
        writeDigest(workspacePath, '*(No session data found)*');
        writeState(workspacePath, { lastRunTimestamp: now.toISOString(), runCount: state.runCount + 1 });
        return;
    }

    // Find JSONL files modified since cutoff
    const files = readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .filter((f) => {
            try {
                const mtime = statSync(join(sessionsDir, f)).mtimeMs;
                return mtime > cutoffMs;
            } catch {
                return false;
            }
        });

    interface DigestLine {
        sortKey: string;
        text: string;
    }
    const entries: DigestLine[] = [];

    for (const file of files) {
        const sessionName = sessionNameFromFile(file);
        // Skip heartbeat's own session
        if (sessionName === 'cron:heartbeat') continue;

        try {
            const content = readFileSync(join(sessionsDir, file), 'utf-8');
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const entry = JSON.parse(trimmed) as SessionEntry;
                    const entryMs = new Date(entry.timestamp).getTime();
                    if (entryMs <= cutoffMs) continue;

                    const time = toLocalTime(entry.timestamp, timezone);
                    const prompt = entry.prompt ? truncate(entry.prompt, MAX_ENTRY_CHARS / 2) : '(no prompt)';
                    const response = truncate(entry.responseText, MAX_ENTRY_CHARS / 2);
                    entries.push({
                        sortKey: entry.timestamp,
                        text: `[${time}] ${sessionName}: ${prompt} → ${response}`,
                    });
                } catch {
                    // skip malformed line
                }
            }
        } catch {
            log.warn('failed to read session file for digest', { file });
        }
    }

    // Sort by ISO timestamp (handles midnight crossing correctly)
    entries.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    // Trim to max digest size, keeping newest entries (O(n) single pass)
    let totalLen = entries.reduce((sum, e) => sum + e.text.length + 1, -1);
    let startIdx = 0;
    while (totalLen > MAX_DIGEST_CHARS && startIdx < entries.length - 1) {
        totalLen -= (entries[startIdx] as DigestLine).text.length + 1;
        startIdx++;
    }
    const lines = entries.slice(startIdx).map((e) => e.text);

    const header = isDeepScan ? '*(deep scan — 24h lookback)*\n\n' : '';
    const body = lines.length > 0 ? `${header}${lines.join('\n')}` : '*(No new activity since last heartbeat)*';
    writeDigest(workspacePath, body);

    writeState(workspacePath, { lastRunTimestamp: now.toISOString(), runCount: state.runCount + 1 });
    log.info('heartbeat digest generated', { entries: lines.length, deepScan: isDeepScan });
}

function writeDigest(workspacePath: string, content: string): void {
    const memoryDir = join(workspacePath, 'memory');
    if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'heartbeat-digest.md'), `# Heartbeat Digest\n\n${content}\n`, 'utf-8');
}
