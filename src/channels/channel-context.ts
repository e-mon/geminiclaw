/**
 * channels/channel-context.ts — Build channel conversation context for agent injection.
 *
 * Fetches recent channel messages via Chat SDK adapter and enriches
 * thread-starting messages with session summary TL;DRs from memory/summaries/.
 *
 * The output is a platform-agnostic ChannelContextData DTO that
 * context-builder.ts renders into a text block for -p injection.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter, FetchResult, Message } from 'chat';
import { createLogger } from '../logger.js';

const log = createLogger('channel-context');

// ── Public types (platform-agnostic) ─────────────────────────────

export interface ChannelContextData {
    channelName: string;
    /** Common session ID prefix for all threads in this channel. */
    sessionPrefix: string;
    messages: ChannelMessage[];
}

export interface ChannelMessage {
    time: string;
    author: string;
    text: string;
    isBot: boolean;
    thread?: {
        /** Thread-specific suffix appended to sessionPrefix to form the full session ID. */
        sessionSuffix: string;
        replyCount: number;
        tldr?: string;
    };
}

// ── Config ───────────────────────────────────────────────────────

export interface ChannelContextConfig {
    maxDays: number;
    maxMessages: number;
    maxChars: number;
}

// ── Fetch + build ────────────────────────────────────────────────

/**
 * Fetch recent channel messages and build a ChannelContextData DTO.
 *
 * Args:
 *     adapter: Chat SDK adapter instance (Discord or Slack).
 *     adapterName: Adapter identifier ("discord" or "slack").
 *     chatChannelId: Chat SDK format channel ID (e.g. "discord:guild:channel").
 *     channelName: Human-readable channel name (e.g. "#general").
 *     sessionPrefix: Common session ID prefix for this channel.
 *     summariesDir: Path to memory/summaries/ directory.
 *     config: Channel context configuration.
 */
export async function buildChannelContext(params: {
    adapter: Adapter;
    adapterName: string;
    chatChannelId: string;
    channelName: string;
    sessionPrefix: string;
    summariesDir: string;
    config: ChannelContextConfig;
    timezone?: string;
}): Promise<ChannelContextData | undefined> {
    const { adapter, adapterName, chatChannelId, channelName, sessionPrefix, summariesDir, config, timezone } = params;

    if (config.maxDays <= 0) return undefined;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - config.maxDays);

    try {
        const extAdapter = adapter as Adapter & {
            fetchChannelMessages?(id: string, opts?: { limit?: number }): Promise<FetchResult>;
        };

        if (!extAdapter.fetchChannelMessages) {
            log.warn('adapter does not support fetchChannelMessages', { adapterName });
            return undefined;
        }

        const result = await extAdapter.fetchChannelMessages(chatChannelId, { limit: config.maxMessages });

        // Build summary index (session ID → TL;DR)
        const summaryIndex = buildSummaryIndex(summariesDir);

        // Convert messages to platform-agnostic format
        const messages: ChannelMessage[] = [];
        for (const msg of result.messages) {
            const createdAt = resolveTimestamp(msg);
            if (createdAt < cutoff) continue;

            const text = (msg.text ?? '').substring(0, 300).replace(/\n/g, ' ');
            const isBot = msg.author?.isBot === true;
            if (!text.trim() && isBot) continue;

            const thread = extractThreadInfo(msg, adapterName, sessionPrefix, summaryIndex);

            messages.push({
                time: formatTime(createdAt, timezone),
                author: msg.author?.userName ?? '?',
                text,
                isBot,
                thread,
            });
        }

        if (messages.length === 0) return undefined;

        return { channelName, sessionPrefix, messages };
    } catch (err) {
        log.warn('failed to build channel context', { error: String(err).substring(0, 200) });
        return undefined;
    }
}

// ── Render ────────────────────────────────────────────────────────

/**
 * Render a ChannelContextData into a text block for -p injection.
 * Trims oldest messages first to stay within maxChars.
 */
export function renderChannelContext(data: ChannelContextData, maxChars: number): string {
    const header = `## Channel Context — ${data.channelName}\nSession prefix: \`${data.sessionPrefix}\`\n`;

    // Render all message lines
    const messageLines: string[] = [];
    for (const msg of data.messages) {
        messageLines.push(`- [${msg.time}] ${msg.author}: ${msg.text}`);
        if (msg.thread) {
            const tldr = msg.thread.tldr ? `: ${msg.thread.tldr}` : '';
            messageLines.push(`  └ Thread [${msg.thread.sessionSuffix}] (${msg.thread.replyCount} replies)${tldr}`);
        }
    }

    // Trim oldest lines to fit within maxChars (keep newest = end of array)
    const available = maxChars - header.length - 40;
    const kept: string[] = [];
    let size = 0;
    for (let i = messageLines.length - 1; i >= 0; i--) {
        const line = messageLines[i] as string;
        if (size + line.length + 1 > available) break;
        kept.unshift(line);
        size += line.length + 1;
    }

    const trimmed = kept.length < messageLines.length;
    const body = trimmed ? `(...older messages omitted)\n${kept.join('\n')}` : kept.join('\n');

    return `${header}\n${body}\n`;
}

// ── Internal helpers ─────────────────────────────────────────────

/** Resolve a Message's timestamp to a Date. */
function resolveTimestamp(msg: Message): Date {
    // Chat SDK stores timestamp in metadata.dateSent
    if (msg.metadata?.dateSent instanceof Date && !Number.isNaN(msg.metadata.dateSent.getTime())) {
        return msg.metadata.dateSent;
    }
    // Fallback to raw platform data
    const raw = msg.raw as Record<string, unknown> | undefined;
    const ts = raw?.timestamp ?? raw?.ts;
    if (typeof ts === 'string') {
        if (/^\d+\.\d+$/.test(ts)) return new Date(parseFloat(ts) * 1000);
        return new Date(ts);
    }
    return new Date();
}

/** Format a date as "MM-DD HH:MM" in the configured timezone. */
function formatTime(date: Date, tz?: string): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz || undefined,
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const get = (t: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === t)?.value ?? '00';
    return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/**
 * Extract thread information from a message's raw platform data.
 * Returns undefined if the message did not start a thread.
 */
function extractThreadInfo(
    msg: Message,
    adapterName: string,
    sessionPrefix: string,
    summaryIndex: Map<string, string>,
): ChannelMessage['thread'] | undefined {
    const raw = msg.raw as Record<string, unknown> | undefined;
    if (!raw) return undefined;

    let threadId: string | undefined;
    let replyCount = 0;

    if (adapterName === 'discord') {
        const thread = raw.thread as Record<string, unknown> | undefined;
        if (!thread) return undefined;
        threadId = String(thread.id ?? '');
        replyCount = (thread.message_count ?? thread.total_message_sent ?? 0) as number;
    } else if (adapterName === 'slack') {
        // Slack: messages with reply_count > 0 are thread parents
        const rc = raw.reply_count as number | undefined;
        if (!rc || rc <= 0) return undefined;
        threadId = String(raw.ts ?? '');
        replyCount = rc;
    } else {
        return undefined;
    }

    if (!threadId) return undefined;

    const sessionSuffix = `-${threadId}`;
    const fullSessionId = `${sessionPrefix}${sessionSuffix}`;
    const tldr = summaryIndex.get(fullSessionId);

    return { sessionSuffix, replyCount, tldr };
}

/**
 * Build an index of session ID → TL;DR from summary Markdown files.
 * Reads all .md files in summariesDir and extracts frontmatter session + TL;DR section.
 */
function buildSummaryIndex(summariesDir: string): Map<string, string> {
    const index = new Map<string, string>();

    try {
        const files = readdirSync(summariesDir).filter((f) => f.endsWith('.md'));
        for (const file of files) {
            const content = readFileSync(join(summariesDir, file), 'utf-8');
            const sessionMatch = content.match(/session:\s*"([^"]+)"/);
            if (!sessionMatch?.[1]) continue;
            const tldrMatch = content.match(/## TL;DR\n([\s\S]*?)(?=\n##|$)/);
            if (tldrMatch?.[1]) {
                index.set(sessionMatch[1], tldrMatch[1].trim().substring(0, 200));
            }
        }
    } catch {
        // summaries dir may not exist
    }

    return index;
}
