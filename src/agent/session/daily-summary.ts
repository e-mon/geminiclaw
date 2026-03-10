/**
 * agent/session/daily-summary.ts — Automated daily summary and heartbeat activity log generation.
 *
 * Generates two types of Obsidian-optimized Markdown files:
 * 1. Heartbeat Activity Log — summarizes heartbeatOk=false entries for the day
 * 2. Daily Summary — aggregates sessions + heartbeat + cron into a single daily report
 *
 * All date filtering uses the configured IANA timezone (config.timezone)
 * so that a "day" aligns with the user's local calendar.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../logger.js';
import { spawnGeminiAcp } from '../acp/runner.js';
import { SessionStore } from './store.js';
import type { SessionEntry } from './types.js';

const log = createLogger('daily-summary');

/** Max characters of responseText per heartbeat entry for LLM input. */
const MAX_RESPONSE_CHARS = 1500;

// ─── Timezone helpers ────────────────────────────────────────────────────────

/**
 * Convert a UTC ISO timestamp to a local date string (YYYY-MM-DD) in the given IANA timezone.
 * Falls back to system timezone when tz is empty/undefined.
 */
export function toLocalDate(isoTimestamp: string, tz?: string): string {
    const date = new Date(isoTimestamp);
    // Intl.DateTimeFormat with 'sv-SE' locale outputs YYYY-MM-DD natively.
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: tz || undefined,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);
}

/**
 * Convert a UTC ISO timestamp to a local time string (HH:MM) in the given IANA timezone.
 */
export function toLocalTime(isoTimestamp: string, tz?: string): string {
    const date = new Date(isoTimestamp);
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: tz || undefined,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(date);
}

/**
 * Convert a UTC ISO timestamp to "YYYY-MM-DD HH:MM" in the given IANA timezone.
 */
export function toLocalDateTime(isoTimestamp: string, tz?: string): string {
    return `${toLocalDate(isoTimestamp, tz)} ${toLocalTime(isoTimestamp, tz)}`;
}

/**
 * Convert a UTC ISO timestamp to "YYYY-MM-DD HH:MM:SS" in the given IANA timezone.
 */
export function toLocalDateTimeSec(isoTimestamp: string, tz?: string): string {
    const date = new Date(isoTimestamp);
    const sec = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz || undefined,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(date);
    return `${toLocalDate(isoTimestamp, tz)} ${sec}`;
}

/**
 * Get today's date string (YYYY-MM-DD) in the given IANA timezone.
 */
export function todayInTimezone(tz?: string): string {
    return toLocalDate(new Date().toISOString(), tz);
}

// ─── Common params ───────────────────────────────────────────────────────────

interface CommonParams {
    dateStr: string;
    sessionsDir: string;
    summariesDir: string;
    workspacePath: string;
    model?: string;
    /** IANA timezone for date filtering. Empty/undefined = system default. */
    timezone?: string;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a heartbeat activity log for a given date.
 *
 * Reads the `cron:heartbeat` session JSONL, groups entries by heartbeatOk status,
 * and calls LLM to summarize action entries. Only generated when there are
 * heartbeatOk=false entries for the date.
 *
 * Returns the output file path, or undefined if no actions or already exists.
 */
export async function generateHeartbeatActivityLog(
    params: CommonParams & {
        /** Pre-loaded heartbeat entries to avoid redundant JSONL reads. */
        preloadedEntries?: SessionEntry[];
    },
): Promise<string | undefined> {
    const { dateStr, sessionsDir, summariesDir, workspacePath, model, timezone, preloadedEntries } = params;
    const outputPath = join(summariesDir, `${dateStr}-heartbeat-activity.md`);

    if (summaryExistsForDate(outputPath)) {
        log.info('heartbeat activity log already exists', { dateStr });
        return undefined;
    }

    const allEntries = preloadedEntries ?? loadHeartbeatEntriesForDate(sessionsDir, dateStr, timezone);
    const grouped = groupHeartbeatEntries(allEntries);

    if (grouped.actions.length === 0) {
        log.info('no heartbeat actions for date', { dateStr });
        return undefined;
    }

    // Build activity detail via LLM
    let activityDetail = '';
    try {
        activityDetail = await summarizeHeartbeatActions(grouped.actions, workspacePath, model, timezone);
    } catch (err) {
        log.warn('LLM summarization of heartbeat actions failed (fail-open)', {
            error: String(err).substring(0, 200),
        });
    }

    // Build markdown
    const lines: string[] = [
        '---',
        `date: "${dateStr}"`,
        'type: heartbeat-activity',
        `ok_count: ${grouped.okCount}`,
        `action_count: ${grouped.actions.length}`,
        'tags:',
        '  - type/heartbeat',
        '---',
        '',
        `# Heartbeat Activity — ${dateStr}`,
        '',
        '## Summary',
        `- ${grouped.okCount}回 HEARTBEAT_OK`,
        `- ${grouped.actions.length}回 アクション実行`,
        '',
        '## Activity Log',
        '',
    ];

    if (activityDetail) {
        lines.push(activityDetail);
    } else {
        // Fallback: mechanical listing without LLM
        for (const action of grouped.actions) {
            const time = toLocalTime(action.timestamp, timezone);
            const tools = [...new Set(action.toolCalls.map((tc) => tc.name))].join(', ');
            lines.push(`### ${time} — ${tools || 'action'}`);
            lines.push(action.responseText.substring(0, 300));
            lines.push('');
        }
    }

    mkdirSync(summariesDir, { recursive: true });
    writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf-8');
    log.info('heartbeat activity log generated', { dateStr, outputPath, actions: grouped.actions.length });
    return outputPath;
}

/**
 * Generate a daily summary for a given date.
 *
 * Aggregates session summaries, heartbeat stats, and cron job stats.
 * Calls LLM for a "Today's Highlights" section (fail-open: omitted on failure).
 *
 * Session summaries are collected up to the current time — if new session summaries
 * are generated after a previous daily run, delete the old daily file and re-run,
 * or wait for the next scheduled daily cron which regenerates from scratch.
 *
 * Returns the output file path, or undefined if already exists.
 */
export async function generateDailySummary(
    params: CommonParams & {
        /** Pre-loaded heartbeat entries to avoid redundant JSONL reads. */
        preloadedEntries?: SessionEntry[];
    },
): Promise<string | undefined> {
    const { dateStr, sessionsDir, summariesDir, workspacePath, model, timezone, preloadedEntries } = params;
    const outputPath = join(summariesDir, `${dateStr}-daily.md`);

    if (summaryExistsForDate(outputPath)) {
        log.info('daily summary already exists', { dateStr });
        return undefined;
    }

    // Collect data — heartbeat entries are loaded once and shared
    const heartbeatEntries = preloadedEntries ?? loadHeartbeatEntriesForDate(sessionsDir, dateStr, timezone);
    const sessions = collectSessionSummaries(summariesDir, dateStr);
    const heartbeat = groupHeartbeatEntries(heartbeatEntries);
    const cronStats = collectCronStats(sessionsDir, dateStr, timezone);
    const dailyLogContent = loadDailyLog(workspacePath, dateStr);

    // Skip if no activity at all
    if (
        sessions.length === 0 &&
        heartbeat.okCount === 0 &&
        heartbeat.actions.length === 0 &&
        cronStats.totalRuns === 0 &&
        !dailyLogContent
    ) {
        log.info('no activity for date, skipping daily summary', { dateStr });
        return undefined;
    }

    // Generate highlights via LLM (fail-open)
    let highlights = '';
    try {
        highlights = await generateHighlights(sessions, heartbeat, cronStats, dailyLogContent, workspacePath, model);
    } catch (err) {
        log.warn('LLM highlights generation failed (fail-open)', {
            error: String(err).substring(0, 200),
        });
    }

    // Build frontmatter
    const lines: string[] = [
        '---',
        `date: "${dateStr}"`,
        'type: daily-summary',
        `session_count: ${sessions.length}`,
        `cron_runs: ${cronStats.totalRuns}`,
        `heartbeat_ok: ${heartbeat.okCount}`,
        `heartbeat_actions: ${heartbeat.actions.length}`,
        'tags:',
        '  - type/daily',
        '---',
        '',
        `# ${dateStr} Daily Summary`,
        '',
    ];

    // Today's Highlights (LLM-generated, optional)
    if (highlights) {
        lines.push("## Today's Highlights", highlights, '');
    }

    // Sessions section
    lines.push('## Sessions');
    if (sessions.length === 0) {
        lines.push('（セッションなし）', '');
    } else {
        for (const s of sessions) {
            lines.push(`- ${s.trigger}: ${s.title}（${s.durationMin}分, ${s.tokens}トークン）`);
        }
        lines.push('');
    }

    // Heartbeat section
    lines.push('## Heartbeat');
    lines.push(`- ${heartbeat.okCount}回 HEARTBEAT_OK`);
    if (heartbeat.actions.length > 0) {
        lines.push(`- ${heartbeat.actions.length}回 アクション実行:`);
        for (const action of heartbeat.actions) {
            const time = toLocalTime(action.timestamp, timezone);
            const tools = [...new Set(action.toolCalls.map((tc) => tc.name))].join(', ');
            const preview = action.responseText.substring(0, 80).replace(/\n/g, ' ');
            lines.push(`  - ${time} ${tools || 'action'} — ${preview}`);
        }
    }
    lines.push('');

    // Daily Log section (agent-written notes from memory/logs/)
    if (dailyLogContent) {
        lines.push('## Daily Log');
        lines.push(dailyLogContent);
        lines.push('');
    }

    // Cron Jobs section
    lines.push('## Cron Jobs');
    if (cronStats.jobs.length === 0) {
        lines.push('（cronジョブなし）', '');
    } else {
        for (const job of cronStats.jobs) {
            const status = job.errors > 0 ? `${job.runs - job.errors}/${job.runs} ✓` : `${job.runs}回実行 ✓`;
            lines.push(`- ${job.jobId}: ${status}`);
        }
        lines.push('');
    }

    mkdirSync(summariesDir, { recursive: true });
    writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf-8');
    log.info('daily summary generated', { dateStr, outputPath });
    return outputPath;
}

/**
 * Backfill daily summaries for recent dates that are missing.
 *
 * Called at server startup. Generates summaries for the past N days
 * (default 7) that don't already have a daily summary file.
 * Uses timezone-aware date calculation so "yesterday" means the user's local yesterday.
 */
export async function backfillMissingDailySummaries(params: {
    sessionsDir: string;
    summariesDir: string;
    workspacePath: string;
    model?: string;
    timezone?: string;
    daysBack?: number;
}): Promise<number> {
    const { sessionsDir, summariesDir, workspacePath, model, timezone, daysBack = 7 } = params;

    if (!existsSync(sessionsDir)) return 0;

    const today = todayInTimezone(timezone);
    let generated = 0;

    // Skip today (it's not finished yet) — start from yesterday
    for (let i = 1; i <= daysBack; i++) {
        const date = new Date(`${today}T12:00:00`); // noon to avoid DST edge cases
        date.setDate(date.getDate() - i);
        const dateStr = toLocalDate(date.toISOString(), timezone);

        const dailyPath = join(summariesDir, `${dateStr}-daily.md`);
        if (summaryExistsForDate(dailyPath)) continue;

        try {
            // Load heartbeat entries once, pass to both generators to avoid redundant reads.
            const heartbeatEntries = loadHeartbeatEntriesForDate(sessionsDir, dateStr, timezone);

            await generateHeartbeatActivityLog({
                dateStr,
                sessionsDir,
                summariesDir,
                workspacePath,
                model,
                timezone,
                preloadedEntries: heartbeatEntries,
            });
            // generateDailySummary has an internal "no activity" guard — safe to call unconditionally.
            const result = await generateDailySummary({
                dateStr,
                sessionsDir,
                summariesDir,
                workspacePath,
                model,
                timezone,
                preloadedEntries: heartbeatEntries,
            });
            if (result) generated++;
        } catch (err) {
            log.warn('backfill daily summary failed', { dateStr, error: String(err).substring(0, 200) });
        }
    }

    if (generated > 0) {
        log.info('backfilled missing daily summaries', { count: generated });
    }
    return generated;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Idempotency guard — check if file already exists. */
function summaryExistsForDate(filePath: string): boolean {
    return existsSync(filePath);
}

/**
 * Load the agent-written daily log for a given date.
 *
 * Checks `memory/logs/YYYY-MM-DD.md` relative to the workspace root.
 * Returns the file content (stripped of YAML frontmatter) or undefined if not found.
 */
function loadDailyLog(workspacePath: string, dateStr: string): string | undefined {
    const logPath = join(workspacePath, 'memory', 'logs', `${dateStr}.md`);
    if (!existsSync(logPath)) return undefined;

    try {
        let content = readFileSync(logPath, 'utf-8').trim();
        if (!content) return undefined;

        // Strip YAML frontmatter if present
        if (content.startsWith('---')) {
            const endIdx = content.indexOf('---', 3);
            if (endIdx !== -1) {
                content = content.substring(endIdx + 3).trim();
            }
        }

        return content || undefined;
    } catch {
        return undefined;
    }
}

/** Load heartbeat session entries for a given local date. */
function loadHeartbeatEntriesForDate(sessionsDir: string, dateStr: string, timezone?: string): SessionEntry[] {
    const store = new SessionStore(sessionsDir);
    if (!store.exists('cron:heartbeat')) return [];

    const allEntries = store.loadAll('cron:heartbeat');
    return allEntries.filter((e) => toLocalDate(e.timestamp, timezone) === dateStr);
}

interface GroupedHeartbeat {
    okCount: number;
    actions: SessionEntry[];
}

/**
 * Group heartbeat entries into OK count and action entries.
 * Consecutive heartbeatOk=true entries are compressed into a count.
 */
function groupHeartbeatEntries(entries: SessionEntry[]): GroupedHeartbeat {
    let okCount = 0;
    const actions: SessionEntry[] = [];

    for (const entry of entries) {
        if (entry.heartbeatOk) {
            okCount++;
        } else {
            actions.push(entry);
        }
    }

    return { okCount, actions };
}

interface SessionSummaryInfo {
    trigger: string;
    title: string;
    durationMin: number;
    tokens: number;
}

/**
 * Collect existing session summary Markdown files for a date.
 * Parses YAML frontmatter for metadata.
 */
function collectSessionSummaries(summariesDir: string, dateStr: string): SessionSummaryInfo[] {
    if (!existsSync(summariesDir)) return [];

    const results: SessionSummaryInfo[] = [];

    try {
        const files = readdirSync(summariesDir).filter(
            (f) => f.startsWith(dateStr) && f.endsWith('.md') && !f.includes('heartbeat') && !f.includes('daily'),
        );

        for (const file of files) {
            const content = readFileSync(join(summariesDir, file), 'utf-8');
            const info = parseSessionFrontmatter(content);
            if (info) results.push(info);
        }
    } catch {
        // Non-critical
    }

    return results;
}

/** Parse YAML frontmatter from a session summary file. */
function parseSessionFrontmatter(content: string): SessionSummaryInfo | undefined {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match?.[1]) return undefined;

    const fm = match[1];

    const triggerMatch = fm.match(/trigger:\s*"?(\S+?)"?$/m);
    const tokensMatch = fm.match(/tokens:\s*(\d+)/);
    const durationMatch = fm.match(/duration_min:\s*(\d+)/);

    // Extract title from first H1 heading
    const titleMatch = content.match(/^# .+?\n\n(?:> (.+))?/m);
    const title = titleMatch?.[1] ?? content.match(/^# (.+)/m)?.[1] ?? 'untitled';

    return {
        trigger: triggerMatch?.[1] ?? 'unknown',
        title: title.substring(0, 60),
        durationMin: durationMatch?.[1] ? Number(durationMatch[1]) : 0,
        tokens: tokensMatch?.[1] ? Number(tokensMatch[1]) : 0,
    };
}

interface CronJobStats {
    jobId: string;
    runs: number;
    errors: number;
}

interface CronStats {
    totalRuns: number;
    jobs: CronJobStats[];
}

/**
 * Collect cron job statistics for a given date.
 * Reads from cron:*.jsonl session files (excluding cron:heartbeat).
 * Uses timezone-aware date filtering.
 */
function collectCronStats(sessionsDir: string, dateStr: string, timezone?: string): CronStats {
    if (!existsSync(sessionsDir)) return { totalRuns: 0, jobs: [] };

    const store = new SessionStore(sessionsDir);
    const jobMap = new Map<string, CronJobStats>();

    try {
        const files = readdirSync(sessionsDir).filter(
            (f) => f.startsWith('cron:') && f.endsWith('.jsonl') && f !== 'cron:heartbeat.jsonl',
        );

        for (const file of files) {
            const sessionId = file.replace('.jsonl', '');
            const jobId = sessionId.replace('cron:', '');
            const entries = store.loadAll(sessionId);
            const dateEntries = entries.filter((e) => toLocalDate(e.timestamp, timezone) === dateStr);

            if (dateEntries.length === 0) continue;

            const errors = dateEntries.filter((e) => e.error).length;
            jobMap.set(jobId, {
                jobId,
                runs: dateEntries.length,
                errors,
            });
        }
    } catch {
        // Non-critical
    }

    const jobs = [...jobMap.values()];
    const totalRuns = jobs.reduce((sum, j) => sum + j.runs, 0);
    return { totalRuns, jobs };
}

/**
 * Call LLM to summarize heartbeat action entries into readable activity log sections.
 */
async function summarizeHeartbeatActions(
    actions: SessionEntry[],
    workspacePath: string,
    model?: string,
    timezone?: string,
): Promise<string> {
    const entriesText = actions
        .map((a) => {
            const time = toLocalTime(a.timestamp, timezone);
            const tools = [...new Set(a.toolCalls.map((tc) => tc.name))].join(', ');
            const response = a.responseText.substring(0, MAX_RESPONSE_CHARS);
            return `### ${time}\nTools: ${tools}\nResponse: ${response}`;
        })
        .join('\n\n');

    const prompt = [
        '以下のハートビートアクション実行ログを、各エントリごとに「### HH:MM — カテゴリ」形式で要約してください。',
        '各エントリは2-3文で、何を検知し何をしたかを簡潔に記述。',
        'Markdown以外のメタ情報は出力しないでください。',
        '',
        entriesText,
    ].join('\n');

    const result = await spawnGeminiAcp({
        cwd: workspacePath,
        trigger: 'manual',
        prompt,
        model,
        poolPriority: 'background',
    });

    return result.responseText.trim();
}

/**
 * Call LLM to generate "Today's Highlights" from collected daily data.
 */
async function generateHighlights(
    sessions: SessionSummaryInfo[],
    heartbeat: GroupedHeartbeat,
    cronStats: CronStats,
    dailyLogContent: string | undefined,
    workspacePath: string,
    model?: string,
): Promise<string> {
    const dataParts: string[] = [];

    if (sessions.length > 0) {
        dataParts.push('セッション:');
        for (const s of sessions) {
            dataParts.push(`- ${s.trigger}: ${s.title}（${s.durationMin}分）`);
        }
    }

    if (heartbeat.actions.length > 0) {
        dataParts.push('ハートビートアクション:');
        for (const a of heartbeat.actions) {
            const time = a.timestamp.substring(11, 16);
            dataParts.push(`- ${time}: ${a.responseText.substring(0, 200)}`);
        }
    }

    if (cronStats.jobs.length > 0) {
        dataParts.push('Cronジョブ:');
        for (const j of cronStats.jobs) {
            dataParts.push(`- ${j.jobId}: ${j.runs}回実行`);
        }
    }

    if (dailyLogContent) {
        dataParts.push('エージェントメモ（Daily Log）:');
        dataParts.push(dailyLogContent.substring(0, 2000));
    }

    // No data worth highlighting
    if (dataParts.length === 0) return '';

    const prompt = [
        '以下の1日のアクティビティデータから、1-3文の簡潔な日本語ハイライトを生成してください。',
        '重要なイベントや成果を中心に。Markdown不要、プレーンテキストのみ。',
        '',
        dataParts.join('\n'),
    ].join('\n');

    const result = await spawnGeminiAcp({
        cwd: workspacePath,
        trigger: 'manual',
        prompt,
        model,
        poolPriority: 'background',
    });

    return result.responseText.trim();
}
