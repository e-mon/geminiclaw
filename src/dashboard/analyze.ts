/**
 * dashboard/analyze.ts — Aggregate tool/session analytics from JSONL files.
 *
 * Performs a single pass over all *.jsonl session files to extract:
 *   - Tool usage frequency (by trigger)
 *   - Tool error rates (success vs failure per tool)
 *   - Error message patterns (top N most common)
 *   - Retry detection (consecutive same-tool calls within a run)
 *   - Session efficiency (heartbeat rate, avg turns, token efficiency)
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Public types ────────────────────────────────────────────────

export interface ToolUsageEntry {
    name: string;
    count: number;
    byTrigger: Record<string, number>;
}

export interface SkillUsageEntry {
    name: string;
    count: number;
    byTrigger: Record<string, number>;
}

export interface ToolErrorEntry {
    name: string;
    total: number;
    errors: number;
    errorRate: number;
}

export interface ErrorPattern {
    message: string;
    count: number;
    tools: string[];
}

export interface RetryEntry {
    /** Tool that was retried consecutively. */
    tool: string;
    /** Number of occurrences of 3+ consecutive calls. */
    occurrences: number;
    /** Maximum consecutive run length observed. */
    maxStreak: number;
    /** Average consecutive run length. */
    avgStreak: number;
}

export interface SessionEfficiency {
    totalSessions: number;
    totalRuns: number;
    heartbeatOkRuns: number;
    heartbeatOkRate: number;
    errorRuns: number;
    errorRate: number;
    avgToolCallsPerRun: number;
    avgTokensPerRun: number;
    /** Sessions with at least one error run. */
    sessionsWithErrors: number;
}

// ── Internal parsed line ────────────────────────────────────────

interface ParsedLine {
    toolCalls: Array<{ name: string; args?: unknown; status?: string; result?: string }>;
    trigger: string;
    timestamp: string;
    heartbeatOk: boolean;
    skillActivations?: string[];
    responseText?: string;
    tokens: { total: number };
    error?: string;
}

// ── Single-pass aggregator ──────────────────────────────────────

interface AggregatedData {
    toolUsage: Map<string, { total: number; byTrigger: Map<string, number> }>;
    skillUsage: Map<string, { total: number; byTrigger: Map<string, number> }>;
    toolErrors: Map<string, { total: number; errors: number }>;
    errorMessages: Map<string, { count: number; tools: Set<string> }>;
    retries: Map<string, { occurrences: number; maxStreak: number; streaks: number[] }>;
    sessions: {
        ids: Set<string>;
        totalRuns: number;
        heartbeatOkRuns: number;
        errorRuns: number;
        totalToolCalls: number;
        totalTokens: number;
        sessionsWithErrors: Set<string>;
    };
}

function createAggregator(): AggregatedData {
    return {
        toolUsage: new Map(),
        skillUsage: new Map(),
        toolErrors: new Map(),
        errorMessages: new Map(),
        retries: new Map(),
        sessions: {
            ids: new Set(),
            totalRuns: 0,
            heartbeatOkRuns: 0,
            errorRuns: 0,
            totalToolCalls: 0,
            totalTokens: 0,
            sessionsWithErrors: new Set(),
        },
    };
}

/** Extract skill names from response text by parsing <activated_skill> tags. */
export function extractSkillsFromText(text: string): string[] {
    const skills: string[] = [];
    const regex = /<activated_skill\s+name="([^"]+)"/g;
    for (const match of text.matchAll(regex)) {
        skills.push(match[1]);
    }
    return skills;
}

/** Truncate and normalize an error message for grouping. */
function normalizeError(raw: string): string {
    return raw
        .replace(/\s+/g, ' ')
        .replace(/['"][^'"]{40,}['"]/g, '"..."')
        .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
        .replace(/https?:\/\/\S+/g, '<url>')
        .trim()
        .substring(0, 200);
}

function processLine(agg: AggregatedData, entry: ParsedLine, sessionFile: string): void {
    const trigger = entry.trigger;
    const toolCalls = entry.toolCalls ?? [];

    // Session efficiency
    agg.sessions.ids.add(sessionFile);
    agg.sessions.totalRuns++;
    agg.sessions.totalToolCalls += toolCalls.length;
    agg.sessions.totalTokens += entry.tokens?.total ?? 0;
    if (entry.heartbeatOk) agg.sessions.heartbeatOkRuns++;
    if (entry.error) {
        agg.sessions.errorRuns++;
        agg.sessions.sessionsWithErrors.add(sessionFile);
    }

    // Skill usage tracking
    const skills = entry.skillActivations ?? [];
    for (const skill of skills) {
        let su = agg.skillUsage.get(skill);
        if (!su) {
            su = { total: 0, byTrigger: new Map() };
            agg.skillUsage.set(skill, su);
        }
        su.total++;
        su.byTrigger.set(trigger, (su.byTrigger.get(trigger) ?? 0) + 1);
    }

    // Tool usage + error tracking
    for (const tc of toolCalls) {
        if (!tc.name) continue;

        // Usage
        let usage = agg.toolUsage.get(tc.name);
        if (!usage) {
            usage = { total: 0, byTrigger: new Map() };
            agg.toolUsage.set(tc.name, usage);
        }
        usage.total++;
        usage.byTrigger.set(trigger, (usage.byTrigger.get(trigger) ?? 0) + 1);

        // Error rate
        let errBucket = agg.toolErrors.get(tc.name);
        if (!errBucket) {
            errBucket = { total: 0, errors: 0 };
            agg.toolErrors.set(tc.name, errBucket);
        }
        errBucket.total++;
        const isError = tc.status === 'error' || tc.status === 'ERROR';
        if (isError) {
            errBucket.errors++;

            // Error message pattern
            const msg = tc.result ? normalizeError(tc.result) : 'Unknown error';
            let pattern = agg.errorMessages.get(msg);
            if (!pattern) {
                pattern = { count: 0, tools: new Set() };
                agg.errorMessages.set(msg, pattern);
            }
            pattern.count++;
            pattern.tools.add(tc.name);
        }
    }

    // Retry detection: find consecutive runs of the same tool (3+)
    if (toolCalls.length >= 3) {
        let streak = 1;
        for (let i = 1; i < toolCalls.length; i++) {
            if (toolCalls[i]?.name === toolCalls[i - 1]?.name) {
                streak++;
            } else {
                if (streak >= 3) {
                    recordRetry(agg, toolCalls[i - 1]?.name, streak);
                }
                streak = 1;
            }
        }
        if (streak >= 3) {
            recordRetry(agg, toolCalls[toolCalls.length - 1]?.name, streak);
        }
    }
}

function recordRetry(agg: AggregatedData, tool: string, streak: number): void {
    let entry = agg.retries.get(tool);
    if (!entry) {
        entry = { occurrences: 0, maxStreak: 0, streaks: [] };
        agg.retries.set(tool, entry);
    }
    entry.occurrences++;
    entry.streaks.push(streak);
    if (streak > entry.maxStreak) entry.maxStreak = streak;
}

// ── Public API ──────────────────────────────────────────────────

function scanSessions(sessionsDir: string, sinceDate?: string): AggregatedData {
    const agg = createAggregator();
    const sinceMs = sinceDate ? new Date(sinceDate).getTime() : 0;

    let files: string[];
    try {
        files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
        return agg;
    }

    for (const file of files) {
        const content = readFileSync(join(sessionsDir, file), 'utf-8');
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            let entry: ParsedLine;
            try {
                entry = JSON.parse(line) as ParsedLine;
            } catch {
                continue;
            }
            if (sinceMs && entry.timestamp) {
                const ts = new Date(entry.timestamp).getTime();
                if (ts < sinceMs) continue;
            }
            // Backfill skillActivations for entries without the field
            if (!entry.skillActivations) {
                const skills: string[] = [];
                // Extract from activate_skill tool calls (primary mechanism)
                for (const tc of entry.toolCalls ?? []) {
                    if (tc.name === 'activate_skill' || tc.name?.endsWith('_activate_skill')) {
                        const a = tc.args as Record<string, unknown> | undefined;
                        if (typeof a?.name === 'string') {
                            skills.push(a.name);
                        } else if (typeof a?.title === 'string') {
                            const m = a.title.match(/^"([^"]+)"/);
                            if (m) skills.push(m[1]);
                        }
                    }
                }
                // Also extract from <activated_skill> tags in responseText
                if (entry.responseText) {
                    skills.push(...extractSkillsFromText(entry.responseText));
                }
                if (skills.length > 0) entry.skillActivations = skills;
            }
            processLine(agg, entry, file);
        }
    }

    return agg;
}

/** Cache to avoid re-scanning within the same request cycle. */
let cachedAgg: { key: string; data: AggregatedData; ts: number } | undefined;
const CACHE_TTL_MS = 10_000;

function getAggregated(sessionsDir: string, sinceDate?: string): AggregatedData {
    const key = `${sessionsDir}::${sinceDate ?? 'all'}`;
    if (cachedAgg && cachedAgg.key === key && Date.now() - cachedAgg.ts < CACHE_TTL_MS) {
        return cachedAgg.data;
    }
    const data = scanSessions(sessionsDir, sinceDate);
    cachedAgg = { key, data, ts: Date.now() };
    return data;
}

export function analyzeSkillUsage(sessionsDir: string, sinceDate?: string): SkillUsageEntry[] {
    const agg = getAggregated(sessionsDir, sinceDate);
    return Array.from(agg.skillUsage.entries())
        .map(([name, { total, byTrigger }]) => ({
            name,
            count: total,
            byTrigger: Object.fromEntries(byTrigger),
        }))
        .sort((a, b) => b.count - a.count);
}

export function analyzeToolUsage(sessionsDir: string, sinceDate?: string): ToolUsageEntry[] {
    const agg = getAggregated(sessionsDir, sinceDate);
    return Array.from(agg.toolUsage.entries())
        .map(([name, { total, byTrigger }]) => ({
            name,
            count: total,
            byTrigger: Object.fromEntries(byTrigger),
        }))
        .sort((a, b) => b.count - a.count);
}

export function analyzeToolErrors(sessionsDir: string, sinceDate?: string): ToolErrorEntry[] {
    const agg = getAggregated(sessionsDir, sinceDate);
    return Array.from(agg.toolErrors.entries())
        .map(([name, { total, errors }]) => ({
            name,
            total,
            errors,
            errorRate: total > 0 ? errors / total : 0,
        }))
        .filter((e) => e.errors > 0)
        .sort((a, b) => b.errorRate - a.errorRate || b.errors - a.errors);
}

export function analyzeErrorPatterns(sessionsDir: string, sinceDate?: string, limit: number = 10): ErrorPattern[] {
    const agg = getAggregated(sessionsDir, sinceDate);
    return Array.from(agg.errorMessages.entries())
        .map(([message, { count, tools }]) => ({
            message,
            count,
            tools: Array.from(tools),
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
}

export function analyzeRetries(sessionsDir: string, sinceDate?: string): RetryEntry[] {
    const agg = getAggregated(sessionsDir, sinceDate);
    return Array.from(agg.retries.entries())
        .map(([tool, { occurrences, maxStreak, streaks }]) => ({
            tool,
            occurrences,
            maxStreak,
            avgStreak: streaks.length > 0 ? streaks.reduce((a, b) => a + b, 0) / streaks.length : 0,
        }))
        .sort((a, b) => b.occurrences - a.occurrences);
}

/** MCP tool call statistics grouped by server and tool. */
export interface McpToolStat {
    server: string;
    tool: string;
    calls: number;
    errors: number;
}

/** MCP separator used by Gemini CLI for qualified tool names. */
const MCP_SEPARATOR = '__';

/**
 * Extract MCP tool call statistics from session logs.
 * MCP tools are identified by the `serverName__toolName` convention.
 */
export function analyzeMcpToolStats(sessionsDir: string, sinceDate?: string): McpToolStat[] {
    const agg = getAggregated(sessionsDir, sinceDate);
    const stats = new Map<string, McpToolStat>();

    for (const [name, { total }] of agg.toolUsage) {
        const sepIdx = name.indexOf(MCP_SEPARATOR);
        if (sepIdx === -1) continue;

        const server = name.substring(0, sepIdx);
        const tool = name.substring(sepIdx + MCP_SEPARATOR.length);

        const errBucket = agg.toolErrors.get(name);
        const errors = errBucket?.errors ?? 0;

        const key = `${server}::${tool}`;
        const existing = stats.get(key);
        if (existing) {
            existing.calls += total;
            existing.errors += errors;
        } else {
            stats.set(key, { server, tool, calls: total, errors });
        }
    }

    return Array.from(stats.values()).sort((a, b) => b.calls - a.calls);
}

export function analyzeSessionEfficiency(sessionsDir: string, sinceDate?: string): SessionEfficiency {
    const agg = getAggregated(sessionsDir, sinceDate);
    const s = agg.sessions;
    return {
        totalSessions: s.ids.size,
        totalRuns: s.totalRuns,
        heartbeatOkRuns: s.heartbeatOkRuns,
        heartbeatOkRate: s.totalRuns > 0 ? s.heartbeatOkRuns / s.totalRuns : 0,
        errorRuns: s.errorRuns,
        errorRate: s.totalRuns > 0 ? s.errorRuns / s.totalRuns : 0,
        avgToolCallsPerRun: s.totalRuns > 0 ? s.totalToolCalls / s.totalRuns : 0,
        avgTokensPerRun: s.totalRuns > 0 ? s.totalTokens / s.totalRuns : 0,
        sessionsWithErrors: s.sessionsWithErrors.size,
    };
}
