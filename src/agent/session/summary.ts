/**
 * agent/session/summary.ts — On-demand LLM-powered session summary generation.
 *
 * Generates Obsidian-optimized Markdown summaries from session JSONL data.
 * Triggered on session idle (automatic) or via CLI (manual).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../logger.js';
import { spawnGeminiAcp } from '../acp/runner.js';
import { todayInTimezone, toLocalDate, toLocalDateTime, toLocalTime } from './daily-summary.js';
import { SessionStore } from './store.js';
import { DEFAULT_SUMMARY_TEMPLATE, renderSummaryTemplate, type SummaryTemplateVars } from './summary-template.js';
import type { SessionEntry } from './types.js';

const log = createLogger('session-summary');

/** Max characters of agent responseText to include in LLM input. */
const MAX_RESPONSE_CHARS_FOR_LLM = 2000;
/** Max length for LLM-generated title. */
const MAX_TITLE_LENGTH = 30;

interface SummaryParams {
    sessionId: string;
    sessionsDir: string;
    summariesDir: string;
    workspacePath: string;
    model?: string;
    templatePath?: string;
    timezone?: string;
}

interface LlmSummaryResult {
    title: string;
    slug: string;
    tldr: string;
    topics: Array<{ topic: string; summary: string }>;
    decisions: string[];
    tags: string[];
}

/**
 * Generate or update a session summary Markdown file from JSONL session data.
 *
 * Loads session entries, filters to user/assistant messages, calls LLM
 * for title/slug/tldr/decisions/tags, then renders a Markdown file
 * into the summaries directory.
 *
 * When a summary already exists but new entries have been added (e.g. after
 * session resume), the existing summary is fed to the LLM alongside only
 * the new entries for an incremental update, avoiding re-processing the
 * entire history.
 *
 * Returns the output file path, or undefined if the session has no
 * meaningful entries to summarize.
 */
export async function generateSessionSummary(params: SummaryParams): Promise<string | undefined> {
    const { sessionId, sessionsDir, summariesDir, workspacePath, model, templatePath, timezone } = params;

    const store = new SessionStore(sessionsDir);
    const allEntries = store.loadAll(sessionId);

    // Filter out heartbeat and compaction entries
    const entries = allEntries.filter((e) => e.trigger !== 'heartbeat' && !e.compactionMeta);

    if (entries.length === 0) {
        log.info('no meaningful entries to summarize', { sessionId });
        return undefined;
    }

    // Check for existing summary — skip only if turns match (truly idempotent)
    const existing = findExistingSummary(summariesDir, sessionId);
    if (existing && existing.turns >= entries.length) {
        // Skip silently — no useful info when summary is already current
        return undefined;
    }

    // Validate timestamps before computing metadata
    const firstEntry = entries[0];
    const lastEntry = entries[entries.length - 1];
    if (!firstEntry || !lastEntry) return undefined;

    const startTime = new Date(firstEntry.timestamp);
    if (Number.isNaN(startTime.getTime())) {
        log.warn('invalid timestamp in session entry', { timestamp: firstEntry.timestamp, sessionId });
        return undefined;
    }

    // Call LLM for summary analysis — incremental if existing summary available
    let llmResult: LlmSummaryResult | undefined;
    if (existing) {
        const newEntries = entries.slice(existing.turns);
        const formattedNew = formatEntriesForLlm(newEntries, timezone);
        llmResult = await callLlmForIncrementalSummary(existing.tldr, formattedNew, workspacePath, model);
        log.info('incremental summary update', {
            sessionId,
            existingTurns: existing.turns,
            newTurns: newEntries.length,
        });
    } else {
        const formattedEntries = formatEntriesForLlm(entries, timezone);
        llmResult = await callLlmForSummary(formattedEntries, workspacePath, model);
    }

    if (!llmResult) {
        log.warn('LLM summary generation failed', { sessionId });
        return undefined;
    }

    // Compute metadata
    const trigger = firstEntry.trigger;
    const totalTokens = entries.reduce((sum, e) => sum + e.tokens.total, 0);
    const endTime = new Date(lastEntry.timestamp);
    const durationMin = Math.round((endTime.getTime() - startTime.getTime()) / 60_000);
    const dateStr = toLocalDate(firstEntry.timestamp, timezone);

    // Add session trigger tag
    const tags = [`session/${trigger}`, ...llmResult.tags];

    // Build conversation log from ALL entries (not just new ones)
    const conversationLog = buildConversationLog(entries, timezone);

    // Load template
    const template = loadTemplate(templatePath);

    // Render
    const templateVars: SummaryTemplateVars = {
        date: dateStr,
        sessionId,
        trigger,
        turns: entries.length,
        tokens: totalTokens,
        durationMin,
        tags,
        title: llmResult.title,
        tldr: llmResult.tldr,
        topics: llmResult.topics,
        decisions: llmResult.decisions,
        conversationLog,
    };

    const markdown = renderSummaryTemplate(template, templateVars);

    // Write summary — overwrite existing if updating
    mkdirSync(summariesDir, { recursive: true });
    const outputPath = existing?.path ?? resolveOutputPath(summariesDir, dateStr, llmResult.slug);
    writeFileSync(outputPath, markdown, 'utf-8');

    log.info('session summary generated', { sessionId, outputPath, turns: entries.length, updated: !!existing });
    return outputPath;
}

/**
 * Scan for idle sessions and generate or update their summaries.
 *
 * Called at server startup, on session eviction, and by daily cron.
 * Generates new summaries for unsummarized sessions and updates existing
 * summaries when new entries have been added (e.g. after session resume).
 * Runs sequentially with background priority to avoid competing with active work.
 */
/** Minimum age (ms) since last JSONL write before a session is eligible for summary.
 *  Prevents summarizing sessions that are still active. */
const MIN_IDLE_AGE_MS = 5 * 60_000; // 5 minutes

export async function syncSessionSummaries(params: {
    sessionsDir: string;
    summariesDir: string;
    workspacePath: string;
    model?: string;
    templatePath?: string;
    /** Include today's date-suffixed sessions (used by daily cron at end of day). */
    includeTodaySessions?: boolean;
    timezone?: string;
}): Promise<number> {
    const { sessionsDir, summariesDir, workspacePath, model, templatePath } = params;

    if (!existsSync(sessionsDir)) return 0;

    let generated = 0;
    const now = Date.now();

    const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));

    for (const file of files) {
        const sessionId = file.replace('.jsonl', '');

        // Skip heartbeat-only sessions
        if (sessionId.startsWith('cron:')) continue;

        // Skip today's date-suffixed sessions unless explicitly included (daily cron)
        if (!params.includeTodaySessions && isCurrentDateSession(sessionId, params.timezone)) continue;

        // Skip sessions that were recently written to (likely still active)
        try {
            const mtime = statSync(join(sessionsDir, file)).mtimeMs;
            if (now - mtime < MIN_IDLE_AGE_MS) {
                log.info('skipping recently active session', { sessionId, ageMin: Math.round((now - mtime) / 60_000) });
                continue;
            }
        } catch {
            // stat failed — proceed anyway
        }

        // generateSessionSummary handles both new and incremental updates
        // via findExistingSummary — no need to skip existing summaries here
        try {
            const result = await generateSessionSummary({
                sessionId,
                sessionsDir,
                summariesDir,
                workspacePath,
                model,
                templatePath,
                timezone: params.timezone,
            });
            if (result) generated++;
        } catch (err) {
            log.warn('sync summary failed', { sessionId, error: String(err).substring(0, 200) });
        }
    }

    if (generated > 0) {
        log.info('synced session summaries', { count: generated });
    }
    return generated;
}

interface ExistingSummary {
    path: string;
    /** Number of turns recorded in the frontmatter — used to detect new entries. */
    turns: number;
    /** TL;DR section from the existing summary — fed to LLM for incremental update. */
    tldr: string;
}

/**
 * Find an existing summary for this session, returning its metadata.
 *
 * Searches summaries directory for files whose YAML frontmatter contains this sessionId.
 * Returns the path, turns count, and TL;DR text for incremental regeneration.
 */
function findExistingSummary(summariesDir: string, sessionId: string): ExistingSummary | undefined {
    if (!existsSync(summariesDir)) return undefined;
    try {
        const files = readdirSync(summariesDir).filter((f) => f.endsWith('.md'));
        for (const file of files) {
            const content = readFileSync(join(summariesDir, file), 'utf-8');
            if (!content.includes(`session: "${sessionId}"`)) continue;

            // Extract turns from frontmatter
            const turnsMatch = content.match(/^turns:\s*(\d+)/m);
            const turns = turnsMatch ? Number.parseInt(turnsMatch[1] as string, 10) : 0;

            // Extract TL;DR section
            const tldrMatch = content.match(/## TL;DR\n([\s\S]*?)(?=\n## |$)/);
            const tldr = tldrMatch ? (tldrMatch[1] ?? '').trim() : '';

            return { path: join(summariesDir, file), turns, tldr };
        }
    } catch {
        // Non-critical — proceed with generation
    }
    return undefined;
}

/**
 * Format session entries into a concise text block for LLM analysis.
 * Only includes user prompts and agent responses (no tool results).
 */
function formatEntriesForLlm(entries: SessionEntry[], timezone?: string): string {
    const lines: string[] = [];

    for (const entry of entries) {
        const time = toLocalDateTime(entry.timestamp, timezone);
        lines.push(`### ${time}`);

        if (entry.prompt) {
            lines.push(`User: ${entry.prompt}`);
        }

        if (entry.toolCalls.length > 0) {
            const toolNames = [...new Set(entry.toolCalls.map((tc) => tc.name))].join(', ');
            lines.push(`Tools: ${toolNames}`);
        }

        if (entry.responseText) {
            const text =
                entry.responseText.length > MAX_RESPONSE_CHARS_FOR_LLM
                    ? `${entry.responseText.substring(0, MAX_RESPONSE_CHARS_FOR_LLM)}...`
                    : entry.responseText;
            lines.push(`Agent: ${text}`);
        }

        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Call LLM to generate title, slug, TL;DR, decisions, and tags from conversation.
 */
async function callLlmForSummary(
    formattedEntries: string,
    workspacePath: string,
    model?: string,
): Promise<LlmSummaryResult | undefined> {
    const prompt = [
        'Analyze the following agent conversation and respond in JSON format:',
        `- title: A concise title (max ${MAX_TITLE_LENGTH} chars, in the conversation language)`,
        '- slug: 2-3 lowercase hyphenated English words (for filename)',
        '- tldr: 2-3 sentence summary',
        '- topics: Array of {topic, summary} objects grouping the conversation by distinct topics discussed (max 5). Each has a short topic name and a 1-sentence summary. Use the conversation language.',
        '- decisions: List of key decisions made (empty array if none)',
        '- tags: 3-5 tags in topic/xxx format',
        '',
        'Output ONLY the JSON object, nothing else.',
        '',
        'Conversation:',
        formattedEntries,
    ].join('\n');

    try {
        const result = await spawnGeminiAcp({
            cwd: workspacePath,
            trigger: 'manual',
            prompt,
            model,
            poolPriority: 'background',
        });

        return parseLlmResponse(result.responseText);
    } catch (err) {
        log.warn('LLM call for summary failed', { error: String(err).substring(0, 200) });
        return undefined;
    }
}

/**
 * Call LLM for incremental summary update — extends an existing summary with new entries.
 * Provides the existing TL;DR as context so the model can produce a coherent update.
 */
async function callLlmForIncrementalSummary(
    existingTldr: string,
    formattedNewEntries: string,
    workspacePath: string,
    model?: string,
): Promise<LlmSummaryResult | undefined> {
    const prompt = [
        'Update the following session summary with new conversation entries. Respond in JSON format:',
        `- title: A concise title reflecting the full session (max ${MAX_TITLE_LENGTH} chars, in the conversation language)`,
        '- slug: 2-3 lowercase hyphenated English words (for filename)',
        '- tldr: 2-3 sentence summary integrating existing summary with new content',
        '- topics: Array of {topic, summary} objects grouping the full session by distinct topics (max 5). Each has a short topic name and a 1-sentence summary. Use the conversation language.',
        '- decisions: Combined list of key decisions (existing + new, empty array if none)',
        '- tags: 3-5 tags in topic/xxx format',
        '',
        'Output ONLY the JSON object, nothing else.',
        '',
        'Existing summary:',
        existingTldr,
        '',
        'New entries:',
        formattedNewEntries,
    ].join('\n');

    try {
        const result = await spawnGeminiAcp({
            cwd: workspacePath,
            trigger: 'manual',
            prompt,
            model,
            poolPriority: 'background',
        });

        return parseLlmResponse(result.responseText);
    } catch (err) {
        log.warn('LLM call for incremental summary failed', { error: String(err).substring(0, 200) });
        return undefined;
    }
}

/**
 * Parse the LLM JSON response, tolerating markdown code fences.
 */
function parseLlmResponse(text: string): LlmSummaryResult | undefined {
    try {
        // Strip markdown code fences if present
        const cleaned = text
            .replace(/^```(?:json)?\s*/m, '')
            .replace(/\s*```\s*$/m, '')
            .trim();

        const raw: unknown = JSON.parse(cleaned);
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            log.warn('LLM response is not a JSON object', { text: text.substring(0, 200) });
            return undefined;
        }
        const parsed = raw as Record<string, unknown>;

        // Parse topics array — each entry should have {topic, summary}
        const rawTopics = Array.isArray(parsed.topics) ? parsed.topics : [];
        const topics: Array<{ topic: string; summary: string }> = rawTopics
            .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
            .map((t) => ({
                topic: String(t.topic ?? '').substring(0, 40),
                summary: String(t.summary ?? '').substring(0, 200),
            }))
            .filter((t) => t.topic && t.summary);

        return {
            title: String(parsed.title ?? '').substring(0, MAX_TITLE_LENGTH),
            slug: sanitizeSlug(String(parsed.slug ?? 'session')),
            tldr: String(parsed.tldr ?? ''),
            topics,
            decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(String) : [],
            tags: Array.isArray(parsed.tags)
                ? parsed.tags.map(String).filter((t: string) => t.startsWith('topic/'))
                : [],
        };
    } catch (err) {
        log.warn('failed to parse LLM summary response', { error: String(err), text: text.substring(0, 200) });
        return undefined;
    }
}

/** Sanitize a slug for safe filesystem use. */
function sanitizeSlug(slug: string): string {
    return (
        slug
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 40) || 'session'
    );
}

/**
 * Build a formatted conversation log from session entries.
 */
function buildConversationLog(entries: SessionEntry[], timezone?: string): string {
    const lines: string[] = [];

    for (const entry of entries) {
        const time = toLocalTime(entry.timestamp, timezone);

        if (entry.prompt) {
            lines.push(`### ${time} — User`);
            lines.push(entry.prompt);
            lines.push('');
        }

        if (entry.responseText) {
            lines.push(`### ${time} — Agent`);
            lines.push(entry.responseText);
            lines.push('');
        }

        if (entry.error) {
            lines.push(`### ${time} — Error`);
            lines.push(entry.error);
            lines.push('');
        }
    }

    return lines.join('\n');
}

/**
 * Load a custom template from the given path, or return the default.
 */
function loadTemplate(templatePath?: string): string {
    if (!templatePath) return DEFAULT_SUMMARY_TEMPLATE;

    try {
        if (existsSync(templatePath)) {
            return readFileSync(templatePath, 'utf-8');
        }
        log.warn('custom template not found, using default', { templatePath });
    } catch (err) {
        log.warn('failed to load custom template', { error: String(err) });
    }

    return DEFAULT_SUMMARY_TEMPLATE;
}

/**
 * Resolve the output file path with dedup suffix for same-day same-slug collisions.
 */
function resolveOutputPath(summariesDir: string, dateStr: string, slug: string): string {
    const baseName = `${dateStr}-${slug}`;
    let candidate = join(summariesDir, `${baseName}.md`);

    if (!existsSync(candidate)) return candidate;

    // Append numeric suffix for dedup
    for (let i = 2; i <= 99; i++) {
        candidate = join(summariesDir, `${baseName}-${i}.md`);
        if (!existsSync(candidate)) return candidate;
    }

    // Extremely unlikely — fall back to timestamp suffix
    return join(summariesDir, `${baseName}-${Date.now()}.md`);
}

/**
 * Check if a session ID ends with today's date suffix (YYYYMMDD).
 * These are channel/DM sessions that rotate daily and should not
 * be summarized until the day is over.
 *
 * Uses config timezone to align with session ID date suffixes
 * generated by chat-handlers' todayDateString().
 */
function isCurrentDateSession(sessionId: string, timezone?: string): boolean {
    const match = sessionId.match(/-(\d{8})$/);
    if (!match) return false;
    const today = todayInTimezone(timezone).replace(/-/g, '');
    return match[1] === today;
}
