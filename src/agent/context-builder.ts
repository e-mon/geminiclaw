/**
 * agent/context-builder.ts — Static GEMINI.md + dynamic session context.
 *
 * GEMINI.md is now **fully static** — written once at init / sync-templates
 * and never rewritten per-run. Session-specific content (history, runtime
 * directives, channel formatting) is returned as a string for `-p` injection.
 *
 * This eliminates the race condition where parallel sessions overwrite each
 * other's GEMINI.md.
 */

import { existsSync, readFileSync } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChannelContextData } from '../channels/channel-context.js';
import { renderChannelContext } from '../channels/channel-context.js';
import type { TriggerType } from './runner.js';
import { buildSessionContinuation, renderContinuation } from './session/continuation.js';
import { SessionStore } from './session/store.js';

// ── Types ────────────────────────────────────────────────────────

export type AutonomyLevel = 'autonomous' | 'supervised' | 'read_only';

export interface StaticGeminiMdOptions {
    /** IANA timezone string, e.g. "Asia/Tokyo". Defaults to system timezone. */
    timezone?: string;
    /**
     * Agent autonomy level injected into GEMINI.md as operational constraints.
     * Defaults to 'autonomous' (no behavioral restrictions).
     */
    autonomyLevel?: AutonomyLevel;
    /** Preferred language for agent responses (IETF tag, e.g. "en", "ja"). */
    language?: string;
}

export interface SessionContextOptions {
    trigger: TriggerType;
    sessionId?: string;
    /** Channel topic/description from Discord or Slack. Used for per-channel behavior control. */
    channelTopic?: string;
    /** Recent channel conversation context. Rendered before session history for broader awareness. */
    channelContext?: { data: ChannelContextData; maxChars: number };
    /** When true, inject BOOTSTRAP.md content into session context for first-run setup. */
    bootstrap?: boolean;
    /** IANA timezone for timestamp formatting. Falls back to system timezone. */
    timezone?: string;
}

// ── Truncation helper ────────────────────────────────────────────

/**
 * Truncate content using OpenClaw 70/20/10 strategy: keep 70% head, 20% tail,
 * 10% for the omission marker. Preserves context from both ends of the text.
 */
export function truncateWithContext(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    const headSize = Math.floor(maxChars * 0.7);
    const tailSize = Math.floor(maxChars * 0.2);
    const head = content.substring(0, headSize);
    const tail = content.substring(content.length - tailSize);
    const omitted = content.length - headSize - tailSize;
    return `${head}\n\n[...${omitted} chars omitted...]\n\n${tail}`;
}

// ── Context Builder ──────────────────────────────────────────────

export class ContextBuilder {
    constructor(private workspaceRoot: string) {}

    /**
     * Check whether GEMINI.md already exists in the workspace.
     */
    geminiMdExists(): boolean {
        return existsSync(join(this.workspaceRoot, 'GEMINI.md'));
    }

    /**
     * Write the **static** GEMINI.md that does not change between runs.
     *
     * Contains: header, @-imports, workspace info, memory guidelines,
     * autonomy level, timezone. Does NOT contain session history,
     * runtime directives, daily logs, or channel formatting.
     */
    async writeStaticGeminiMd(options: StaticGeminiMdOptions = {}): Promise<string> {
        const parts: string[] = [];
        const tz = options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

        // ── Header ──
        parts.push('# GeminiClaw Agent Context\n');
        parts.push('You are a personal autonomous agent running via GeminiClaw.');
        parts.push(`Timezone: ${tz}`);
        if (options.language && options.language !== 'en') {
            parts.push(
                `Preferred language: ${options.language} — always respond in this language unless the user writes in a different language.`,
            );
        }
        parts.push('If you need the current date or time, call `geminiclaw_status`.');
        parts.push('');

        // ── Static workspace files ──
        // SOUL.md, AGENTS.md, USER.md use native @-import.
        // MEMORY.md also uses @-import now (was inlined before).
        for (const filename of ['SOUL.md', 'AGENTS.md', 'USER.md', 'MEMORY.md']) {
            if (await this.fileExists(filename)) {
                parts.push(`@${filename}`);
                parts.push('');
            }
        }

        // ── Workspace ──
        parts.push('## Workspace');
        parts.push(`Your working directory is: ${this.workspaceRoot}`);
        parts.push('Treat this directory as the single global workspace for file operations.');
        parts.push('');

        parts.push('## Workspace Files');
        parts.push('These files contain important state. Do not remove them.');
        parts.push('- `HEARTBEAT.md` - Instructions for periodic heartbeat checks (user-customizable)');
        parts.push('- `memory/heartbeat-digest.md` - Auto-generated digest of recent session activity for heartbeat');
        parts.push('- `MEMORY.md` - Curated long-term memory (< 5KB, updated via file tools)');
        parts.push('- `memory/heartbeat-state.json` - Tracks last run time for each check category');
        parts.push('- `memory/logs/YYYY-MM-DD.md` - Daily append-only activity log');
        parts.push('- `cron/jobs.json` - Scheduled cron jobs (managed via cron skill)');
        parts.push('- `runs/` - Per-session work directories for file output (managed via workspace skill)');
        parts.push('');

        // ── Memory Guidelines ──
        parts.push('## Memory Management');
        parts.push('`MEMORY.md` is the canonical source of truth for long-term memory.');
        parts.push('Read and write it with native file tools — no special memory commands needed.');
        parts.push('');
        parts.push('After taking significant actions or learning important information:');
        parts.push('1. Edit `MEMORY.md` — add new facts, remove outdated ones (keep < 5KB)');
        parts.push('2. Append to `memory/logs/YYYY-MM-DD.md` for the audit trail.');
        parts.push('   If the file does not exist, create it with this frontmatter:');
        parts.push('```markdown');
        parts.push('---');
        parts.push('date: "YYYY-MM-DD"');
        parts.push('type: daily-log');
        parts.push('tags:');
        parts.push('  - type/daily-log');
        parts.push('---');
        parts.push('# YYYY-MM-DD Activity Log');
        parts.push('```');
        parts.push('   Then append entries in this format:');
        parts.push('```markdown');
        parts.push('## HH:MM - Brief description');
        parts.push('Details of what was done and why.');
        parts.push('```');
        parts.push('');
        parts.push('**IMPORTANT — always use absolute dates in MEMORY.md.**');
        parts.push("Call `geminiclaw_status` first to confirm today's date, then write it explicitly.");
        parts.push(
            'Never write relative terms like "tomorrow", "next week" — they become meaningless when read later.',
        );
        parts.push('');
        parts.push(
            'To review recent activity, use `qmd_search` for keyword search or `qmd_deep_search` for hybrid search across daily logs and memory files, then `qmd_get` to drill into results.',
        );
        parts.push('');

        // ── Autonomy Level ──
        const autonomyLevel = options.autonomyLevel ?? 'autonomous';
        if (autonomyLevel === 'read_only') {
            parts.push('## Restriction: READ_ONLY Mode');
            parts.push('**This session is limited to read-only operations.**');
            parts.push('- Allowed: file reads, searches, information gathering, `qmd_search`, `qmd_get`');
            parts.push('- Prohibited: file writes/deletes, shell command execution, form submissions');
            parts.push('- If asked to perform a prohibited operation, explain the restriction and decline');
            parts.push('');
        } else if (autonomyLevel === 'supervised') {
            parts.push('## Restriction: SUPERVISED Mode');
            parts.push('**You must confirm with the user before performing destructive or irreversible operations.**');
            parts.push('Operations requiring confirmation:');
            parts.push('- File deletion or overwriting existing files');
            parts.push('- Sending to external services (email, form submissions, API POST/PUT/DELETE)');
            parts.push('- Purchases or financial transactions');
            parts.push('- git push / operations on public repositories');
            parts.push(
                'Confirmation method: explain the operation and its impact, then wait for explicit user approval before proceeding',
            );
            parts.push('');
        }

        const content = parts.join('\n');
        await writeFile(join(this.workspaceRoot, 'GEMINI.md'), content, 'utf-8');
        return content;
    }

    /**
     * Build the dynamic session context string for `-p` injection.
     *
     * Contains: session history, runtime directives, channel formatting.
     * Does NOT write any files — returns a string to be prepended to the prompt.
     */
    buildSessionContext(options: SessionContextOptions): string {
        const parts: string[] = [];

        // ── Bootstrap (first-run setup) ──
        if (options.bootstrap) {
            const bootstrapPath = join(this.workspaceRoot, 'BOOTSTRAP.md');
            try {
                const content = readFileSync(bootstrapPath, 'utf-8');
                parts.push(content);
                parts.push('');
            } catch {
                // BOOTSTRAP.md may have been deleted mid-session — ignore
            }
        }

        // ── Session Continuation (previous day's context for date-rotated sessions) ──
        if (options.sessionId) {
            const continuation = buildSessionContinuation({
                sessionId: options.sessionId,
                sessionsDir: join(this.workspaceRoot, 'memory', 'sessions'),
                summariesDir: join(this.workspaceRoot, 'memory', 'summaries'),
            });
            if (continuation) {
                parts.push(renderContinuation(continuation));
            }
        }

        // ── Channel Context (experimental) ──
        if (options.channelContext) {
            parts.push(renderChannelContext(options.channelContext.data, options.channelContext.maxChars));
        }

        // ── Proactive Posts (inject own posts that aren't in ACP history) ──
        if (options.sessionId) {
            try {
                const store = new SessionStore(join(this.workspaceRoot, 'memory', 'sessions'));
                const entries = store.loadAll(options.sessionId);
                let lastRunTs: string | undefined;
                for (let i = entries.length - 1; i >= 0; i--) {
                    if (entries[i]?.trigger !== 'proactive') {
                        lastRunTs = entries[i]?.timestamp;
                        break;
                    }
                }
                const newProactive = entries.filter(
                    (e) => e.trigger === 'proactive' && (!lastRunTs || e.timestamp > lastRunTs),
                );
                if (newProactive.length > 0) {
                    parts.push('### Your Previous Posts in This Channel');
                    parts.push('You posted these messages (not in your conversation history):');
                    for (const e of newProactive.slice(-5)) {
                        parts.push(`- [${e.timestamp}]: ${e.responseText.substring(0, 300)}`);
                    }
                    parts.push('');
                }
            } catch {
                // Best-effort — don't fail context build if session read fails
            }
        }

        // ── Runtime Directives ──
        parts.push('## Runtime & Directives');
        parts.push(`Trigger source: ${options.trigger}`);
        if (options.sessionId) {
            parts.push(`Session ID: ${options.sessionId}`);
            parts.push(`Session work directory: runs/${options.sessionId}/`);
        }

        if (options.trigger === 'heartbeat') {
            parts.push('');
            parts.push('### Heartbeat Mode');
            parts.push(
                'Follow `HEARTBEAT.md` strictly. Use `memory/heartbeat-state.json` to track last-check timestamps ' +
                    'and rotate through checks (not everything every run). Update timestamps after each run.',
            );
            parts.push('');
            parts.push('**Every run:** Activity review (digest + summaries), calendar, email.');
            parts.push('**Rotate (every few hours):** Memory maintenance, proactive background work.');
            parts.push('');
            parts.push(
                'After completing checks: reply with summary if you acted, or `HEARTBEAT_OK` if nothing needs attention.',
            );
        } else if (options.trigger === 'cron') {
            parts.push('');
            parts.push('### Cron Job Mode');
            parts.push('You are running as a scheduled cron job.');
            parts.push('Focus exclusively on the prompt and produce the requested output.');
            parts.push('Do NOT run background heartbeat checks.');
            parts.push('Do NOT respond with HEARTBEAT_OK.');
        } else {
            parts.push('');
            parts.push('### Interactive Mode');
            parts.push('You are responding to a direct user request (manual run or channel message).');
            parts.push("Focus exclusively on the user's prompt and be helpful.");
            parts.push('Do NOT run background heartbeat checks.');
            parts.push('Do NOT respond with HEARTBEAT_OK under any circumstances.');
        }

        if (options.trigger === 'discord' || options.trigger === 'slack') {
            parts.push('');
            parts.push('### Channel Context');
            parts.push('You are replying in a chat channel. Follow SOUL.md Communication Style.');
            parts.push('');
            parts.push('**Platform Markdown**');
            parts.push('- **bold** for key terms or results');
            parts.push('- `inline code` for commands, file paths, values');
            parts.push('- ```language blocks for multi-line code or structured output```');
            parts.push('- Use `-` bullet lists for enumeration; avoid walls of text');

            // Channel topic placed last (closest to user message) for maximum visibility.
            // Topic often contains behavioral instructions (e.g. "use translate-preview skill")
            // that must not get buried among formatting rules.
            if (options.channelTopic) {
                parts.push('');
                parts.push('### Channel Behavior (from channel topic)');
                parts.push(
                    'The channel topic below contains **mandatory behavioral instructions**. You MUST follow them:',
                );
                const quotedTopic = options.channelTopic
                    .split('\n')
                    .map((line) => `> ${line}`)
                    .join('\n');
                parts.push(quotedTopic);
            }
        }
        parts.push('');

        return parts.join('\n');
    }

    /**
     * Sanitize stray @-imports in MEMORY.md that Gemini CLI's ImportProcessor
     * would misinterpret as file references (e.g. `@username` Twitter handles).
     *
     * Strips the `@` prefix from patterns that are neither known file extensions
     * (.md, .json, .txt, .yaml, .yml) nor existing workspace files.
     * Only rewrites the file when changes are actually needed.
     *
     * @returns Array of references whose `@` was removed.
     */
    async sanitizeMemoryImports(): Promise<string[]> {
        const memoryPath = join(this.workspaceRoot, 'MEMORY.md');
        let content: string;
        try {
            content = await readFile(memoryPath, 'utf-8');
        } catch {
            return [];
        }

        const removed: string[] = [];
        const sanitized = content.replace(/@(\S+)/g, (match, ref: string) => {
            // Keep known valid extensions — likely intentional @-imports
            if (/\.(md|json|txt|yaml|yml)$/i.test(ref)) return match;
            // Keep references to files that actually exist in the workspace
            if (existsSync(join(this.workspaceRoot, ref))) return match;
            removed.push(ref);
            return ref; // strip the @ prefix
        });

        if (removed.length > 0) {
            await writeFile(memoryPath, sanitized, 'utf-8');
        }
        return removed;
    }

    // ── Private helpers ──────────────────────────────────────────

    /** Check whether a workspace-relative path exists. */
    private async fileExists(filename: string): Promise<boolean> {
        try {
            await access(join(this.workspaceRoot, filename));
            return true;
        } catch {
            return false;
        }
    }
}
