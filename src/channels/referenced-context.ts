/**
 * channels/referenced-context.ts — Fetch referenced message context for replies and threads.
 *
 * Provides a unified `fetchReferencedContext()` that covers three cases:
 *   1. Discord Reply (type 19) — extracts referenced_message from raw data
 *   2. Discord Thread (non-reply) — fetches the thread starter message via REST
 *   3. Slack Thread — fetches the parent message via conversations.history
 *
 * Called only on the first turn (!hasHistory) to inject context into the agent prompt.
 */

import type { Message, Thread } from 'chat';
import { createLogger } from '../logger.js';

const log = createLogger('referenced-context');

const MAX_CONTENT_LENGTH = 300;
const SURROUNDING_LIMIT = 5;

/** Discord IDs (channel, message, guild) are numeric snowflakes. */
const DISCORD_ID_RE = /^\d+$/;

// ── Types ────────────────────────────────────────────────────────

interface ContextMessage {
    author: string;
    content: string;
}

export interface ReferencedContext {
    /** The referenced / starter message */
    reference: ContextMessage;
    /** Surrounding messages in chronological order (includes reference) */
    surrounding?: ContextMessage[];
    /** Index of the reference message within surrounding (for highlighting) */
    referenceIndex?: number;
    /** Context kind for formatting */
    kind: 'discord-reply' | 'discord-thread-starter' | 'slack-thread-starter';
}

// ── Unified entry point ──────────────────────────────────────────

/**
 * Fetch referenced context for the current message/thread.
 *
 * Determines the context type from platform-specific raw data and
 * delegates to the appropriate fetcher. Returns undefined when no
 * referenced context is available.
 *
 * Args:
 *     thread: Chat SDK Thread instance.
 *     message: Chat SDK Message.
 *
 * Returns:
 *     Referenced context with optional surrounding messages, or undefined.
 */
export async function fetchReferencedContext(thread: Thread, message: Message): Promise<ReferencedContext | undefined> {
    try {
        const adapterName = thread.adapter.name;

        if (adapterName === 'discord') {
            const raw = message.raw as Record<string, unknown> | undefined;
            // Discord Reply (type 19) takes priority over thread starter —
            // when a reply creates a thread, the thread starter IS the reply itself
            if (raw?.type === 19) {
                return await fetchDiscordReplyContext(thread, message);
            }
            // Discord Thread (non-reply): 4-part thread ID
            if (thread.id.split(':').length === 4) {
                return await fetchDiscordThreadStarterContext(thread);
            }
        }

        if (adapterName === 'slack') {
            // Slack Thread: thread.id = "slack:channel:threadTs"
            const parts = thread.id.split(':');
            if (parts.length >= 3 && parts[2]) {
                return await fetchSlackThreadStarterContext(thread);
            }
        }

        return undefined;
    } catch (err) {
        log.warn('failed to fetch referenced context', { error: String(err) });
        return undefined;
    }
}

// ── Discord Reply ────────────────────────────────────────────────

async function fetchDiscordReplyContext(thread: Thread, message: Message): Promise<ReferencedContext | undefined> {
    const raw = message.raw as Record<string, unknown> | undefined;
    if (!raw) return undefined;

    // Extract referenced_message directly from raw (no API call needed)
    let refMsg = raw.referenced_message as {
        id?: string;
        content?: string;
        author?: { username?: string; global_name?: string };
    } | null;

    // Fallback: if referenced_message is null (Discord cache miss),
    // fetch via message_reference.message_id
    if (!refMsg) {
        const msgRef = raw.message_reference as { message_id?: string; channel_id?: string } | undefined;
        if (!msgRef?.message_id) return undefined;

        const botToken = getBotToken(thread);
        if (!botToken) return undefined;

        const channelId = msgRef.channel_id ?? extractDiscordMessageChannelId(thread.id);
        if (!isValidDiscordId(channelId) || !isValidDiscordId(msgRef.message_id)) return undefined;
        try {
            const resp = await fetch(
                `https://discord.com/api/v10/channels/${channelId}/messages/${msgRef.message_id}`,
                { headers: { Authorization: `Bot ${botToken}` } },
            );
            if (!resp.ok) return undefined;
            refMsg = (await resp.json()) as typeof refMsg;
        } catch (err) {
            log.warn('failed to fetch referenced message by ID', { error: String(err) });
            return undefined;
        }
    }

    if (!refMsg?.id) return undefined;

    const reference = toContextMessage(refMsg.author, refMsg.content);

    // Best-effort: fetch surrounding messages
    const surroundingResult = await fetchDiscordSurrounding(thread, refMsg.id);

    return {
        reference,
        surrounding: surroundingResult?.messages,
        referenceIndex: surroundingResult?.referenceIndex,
        kind: 'discord-reply',
    };
}

// ── Discord Thread Starter ───────────────────────────────────────

async function fetchDiscordThreadStarterContext(thread: Thread): Promise<ReferencedContext | undefined> {
    const parts = thread.id.split(':');
    const parentChannelId = parts[2]; // discord:guildId:channelId:threadId
    const threadId = parts[3];
    if (!isValidDiscordId(parentChannelId) || !isValidDiscordId(threadId)) return undefined;

    const botToken = getBotToken(thread);
    if (!botToken) return undefined;

    try {
        const resp = await fetch(`https://discord.com/api/v10/channels/${parentChannelId}/messages/${threadId}`, {
            headers: { Authorization: `Bot ${botToken}` },
        });
        if (!resp.ok) return undefined;

        const data = (await resp.json()) as {
            id?: string;
            content?: string;
            author?: { username?: string; global_name?: string };
        };

        const reference = toContextMessage(data.author, data.content);

        // Best-effort: fetch surrounding messages in the parent channel
        const surroundingResult = await fetchDiscordSurrounding(thread, threadId, parentChannelId);

        return {
            reference,
            surrounding: surroundingResult?.messages,
            referenceIndex: surroundingResult?.referenceIndex,
            kind: 'discord-thread-starter',
        };
    } catch (err) {
        log.warn('failed to fetch thread starter message', { error: String(err) });
        return undefined;
    }
}

// ── Slack Thread Starter ─────────────────────────────────────────

async function fetchSlackThreadStarterContext(thread: Thread): Promise<ReferencedContext | undefined> {
    const parts = thread.id.split(':');
    const channel = parts[1];
    const threadTs = parts[2];
    if (!channel || !threadTs) return undefined;

    const botToken = getBotToken(thread);
    if (!botToken) return undefined;

    try {
        // Fetch parent message + surrounding via conversations.history
        // inclusive=true includes the threadTs message itself
        const params = new URLSearchParams({
            channel,
            latest: threadTs,
            inclusive: 'true',
            limit: String(SURROUNDING_LIMIT),
        });

        const resp = await fetch(`https://slack.com/api/conversations.history?${params}`, {
            headers: { Authorization: `Bearer ${botToken}` },
        });
        if (!resp.ok) return undefined;

        const body = (await resp.json()) as {
            ok: boolean;
            messages?: Array<{
                ts?: string;
                text?: string;
                user?: string;
                username?: string;
                bot_id?: string;
            }>;
        };
        if (!body.ok || !body.messages?.length) return undefined;

        // Messages from Slack are newest-first; reverse for chronological order
        const msgs = [...body.messages].reverse();

        // Find the parent message (matching threadTs)
        const parentIndex = msgs.findIndex((m) => m.ts === threadTs);
        if (parentIndex < 0) return undefined;
        const parentMsg = msgs[parentIndex];

        const reference: ContextMessage = {
            author: parentMsg.username || parentMsg.user || 'Unknown',
            content: truncate(parentMsg.text || '[empty message]'),
        };

        const surrounding: ContextMessage[] = msgs.map((m) => ({
            author: m.username || m.user || 'Unknown',
            content: truncate(m.text || '[empty message]'),
        }));

        return {
            reference,
            surrounding: surrounding.length > 1 ? surrounding : undefined,
            referenceIndex: surrounding.length > 1 ? parentIndex : undefined,
            kind: 'slack-thread-starter',
        };
    } catch (err) {
        log.warn('failed to fetch slack thread starter', { error: String(err) });
        return undefined;
    }
}

// ── Formatting ───────────────────────────────────────────────────

/**
 * Format referenced context into a human-readable text block for prompt injection.
 *
 * Args:
 *     ctx: The referenced context to format.
 *
 * Returns:
 *     Formatted text block with context header and messages.
 */
export function formatReferencedContext(ctx: ReferencedContext): string {
    const header = ctx.kind === 'discord-reply' ? 'Replying to message' : 'Thread started from message';

    if (!ctx.surrounding || ctx.surrounding.length <= 1) {
        // Simple single-message format
        const label = ctx.kind === 'discord-reply' ? 'Replying to' : 'Thread started from message by';
        return `[${label} ${ctx.reference.author}: ${ctx.reference.content}]\n`;
    }

    // Full surrounding context format — use index for reliable highlighting
    const refIdx = ctx.referenceIndex ?? 0;
    const lines = ctx.surrounding.map((m, i) => {
        const isRef = i === refIdx;
        const prefix = isRef ? '> **' : '> ';
        const suffix = isRef ? '** ← (referenced)' : '';
        return `${prefix}${m.author}: ${m.content}${suffix}`;
    });

    return `[Context: ${header}]\n${lines.join('\n')}\n`;
}

// ── Helpers ──────────────────────────────────────────────────────

function getBotToken(thread: Thread): string | undefined {
    const token = (thread.adapter as unknown as { botToken: string }).botToken;
    if (!token) {
        log.warn('botToken not available on adapter', { adapter: thread.adapter.name });
    }
    return token || undefined;
}

/**
 * Extract the Discord channel ID where messages actually live.
 *
 * In threads, messages are under the thread's own channel ID (parts[3]),
 * not the parent channel (parts[2]).
 */
export function extractDiscordMessageChannelId(threadId: string): string {
    const parts = threadId.split(':');
    return parts[3] ?? parts[2] ?? '';
}

/** Validate that a string is a valid Discord snowflake ID before using in API URLs. */
function isValidDiscordId(id: string | undefined): id is string {
    return !!id && DISCORD_ID_RE.test(id);
}

function toContextMessage(
    author: { username?: string; global_name?: string } | undefined | null,
    content: string | undefined | null,
): ContextMessage {
    return {
        author: author?.global_name || author?.username || 'Unknown',
        content: truncate(content || '[empty message]'),
    };
}

function truncate(text: string): string {
    if (text.length <= MAX_CONTENT_LENGTH) return text;
    return `${text.substring(0, MAX_CONTENT_LENGTH)}…`;
}

/**
 * Fetch surrounding messages around a Discord message ID.
 *
 * Returns messages in chronological order, or undefined on failure.
 */
async function fetchDiscordSurrounding(
    thread: Thread,
    messageId: string,
    channelIdOverride?: string,
): Promise<{ messages: ContextMessage[]; referenceIndex: number } | undefined> {
    const botToken = getBotToken(thread);
    if (!botToken) return undefined;

    const channelId = channelIdOverride ?? extractDiscordMessageChannelId(thread.id);
    if (!isValidDiscordId(channelId) || !isValidDiscordId(messageId)) return undefined;

    try {
        const resp = await fetch(
            `https://discord.com/api/v10/channels/${channelId}/messages?around=${messageId}&limit=${SURROUNDING_LIMIT}`,
            { headers: { Authorization: `Bot ${botToken}` } },
        );
        if (!resp.ok) return undefined;

        const messages = (await resp.json()) as Array<{
            id?: string;
            content?: string;
            author?: { username?: string; global_name?: string };
        }>;
        if (!messages?.length || messages.length <= 1) return undefined;

        // Discord returns newest-first; reverse for chronological order
        const reversed = [...messages].reverse();
        const referenceIndex = reversed.findIndex((m) => m.id === messageId);
        return {
            messages: reversed.map((m) => toContextMessage(m.author, m.content)),
            referenceIndex: referenceIndex >= 0 ? referenceIndex : 0,
        };
    } catch (err) {
        log.warn('failed to fetch surrounding messages', { error: String(err) });
        return undefined;
    }
}
