/**
 * channels/chat-handlers.ts — Chat SDK event handlers.
 *
 * Registers onNewMention, onNewMessage, and onSubscribedMessage handlers
 * that translate Chat SDK events into Inngest geminiclaw/run events.
 *
 * This replaces the old ChannelRouter + per-adapter message listeners.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Chat, Message, Thread, ThreadImpl } from 'chat';
import {
    clearPending,
    findPending,
    findPendingByAskId,
    findPendingRaw,
    type PendingQuestion,
    writeAnswer,
} from '../agent/ask-user-state.js';
import { todayDateString } from '../agent/session/store.js';
import { getWorkspacePath, loadConfig } from '../config.js';
import type { AgentRunEventData } from '../inngest/agent-run.js';
import { inngest } from '../inngest/client.js';
import { createLogger } from '../logger.js';
import { buildChannelContext } from './channel-context.js';
import {
    extractDiscordMessageChannelId,
    fetchReferencedContext,
    formatReferencedContext,
} from './referenced-context.js';

const log = createLogger('chat-handlers');

/**
 * Derive a stable sessionId from a Chat SDK thread.
 *
 * Parses the thread.id (format `adapter:guildOrWorkspace:channel[:thread]`)
 * and produces a deterministic key compatible with Lane Queue serialization.
 *
 * Format matches the pre-migration convention:
 *   Discord DM:     discord-dm-{channelId}
 *   Discord Guild:  discord-{guildId}-{channelId}
 *   Slack:          slack-{channelId}-{threadTs}
 *
 * Args:
 *     thread: Chat SDK Thread instance.
 *
 * Returns:
 *     Session ID string for Lane Queue.
 */
function deriveSessionId(thread: Thread, tz?: string): string {
    const parts = thread.id.split(':');
    const adapterName = thread.adapter.name;
    // Date suffix for non-thread sessions (channels, DMs) to rotate daily
    const dateSuffix = todayDateString(tz);

    if (adapterName === 'discord') {
        // thread.id = "discord:guildId:channelId" or "discord:guildId:channelId:threadId"
        const guildId = parts[1] ?? '';
        const channelId = parts[2] ?? '';
        const threadId = parts[3];
        if (thread.isDM) {
            return `discord-dm-${channelId}-${dateSuffix}`;
        }
        // Threads have a natural lifecycle; channels/DMs rotate daily
        return threadId
            ? `discord-${guildId}-${channelId}-${threadId}`
            : `discord-${guildId}-${channelId}-${dateSuffix}`;
    }

    if (adapterName === 'slack') {
        // thread.id = "slack:channel:threadTs"
        const channel = parts[1] ?? '';
        const threadTs = parts[2] ?? '';
        if (thread.isDM) {
            return `slack-dm-${channel}-${dateSuffix}`;
        }
        return threadTs ? `slack-${channel}-${threadTs}` : `slack-${channel}-${dateSuffix}`;
    }

    if (adapterName === 'telegram') {
        // thread.id = "telegram:chatId" or "telegram:chatId:messageThreadId"
        const chatId = parts[1] ?? '';
        if (thread.isDM) {
            return `telegram-dm-${chatId}-${dateSuffix}`;
        }
        return `telegram-${chatId}-${dateSuffix}`;
    }

    // Fallback for unknown adapters
    return `${adapterName}-${thread.id}`;
}

/**
 * Extract the raw platform channel ID from a Chat SDK thread.
 *
 * thread.channelId returns the guildId for Discord (Chat SDK quirk),
 * so we parse thread.id instead:
 *   Discord: "discord:guildId:channelId" → parts[2]
 *   Slack:   "slack:channel:threadTs"    → parts[1]
 */
function extractRawChannelId(thread: Thread): string {
    const parts = thread.id.split(':');
    if (thread.adapter.name === 'discord') return parts[2] ?? '';
    if (thread.adapter.name === 'slack') return parts[1] ?? '';
    if (thread.adapter.name === 'telegram') return parts[1] ?? '';
    return thread.channelId;
}

/**
 * Derive the common session ID prefix for a channel (without thread-specific suffix).
 *
 * Used to construct full session IDs for thread summary lookups:
 *   prefix + "-" + threadId = full session ID
 */
function deriveChannelSessionPrefix(thread: Thread): string {
    const parts = thread.id.split(':');
    const adapterName = thread.adapter.name;

    if (adapterName === 'discord') {
        const guildId = parts[1] ?? '';
        const channelId = parts[2] ?? '';
        if (thread.isDM) return `discord-dm-${channelId}`;
        return `discord-${guildId}-${channelId}`;
    }

    if (adapterName === 'slack') {
        const channel = parts[1] ?? '';
        if (thread.isDM) return `slack-dm-${channel}`;
        return `slack-${channel}`;
    }

    if (adapterName === 'telegram') {
        const chatId = parts[1] ?? '';
        if (thread.isDM) return `telegram-dm-${chatId}`;
        return `telegram-${chatId}`;
    }

    return `${adapterName}-${parts.slice(0, -1).join('-')}`;
}

/**
 * Download chat message attachments and save them to the session's attachments directory.
 *
 * Returns workspace-relative paths suitable for Gemini CLI @ references.
 * Skips attachments that lack fetchData (URL-only) or fail to download.
 */
const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB

async function downloadAttachments(
    message: Message,
    sessionId: string,
    workspacePath: string,
): Promise<Array<{ path: string; originalName?: string }>> {
    const attachments = (message as unknown as { attachments?: Array<Record<string, unknown>> }).attachments;
    if (!attachments?.length) return [];

    const attachDir = join(workspacePath, 'runs', sessionId, 'attachments');
    mkdirSync(attachDir, { recursive: true });

    const files: Array<{ path: string; originalName?: string }> = [];
    for (const att of attachments.slice(0, MAX_ATTACHMENT_COUNT)) {
        const name = (att.name as string) || `attachment-${Date.now()}`;
        const fetchData = att.fetchData as (() => Promise<Buffer>) | undefined;
        const url = att.url as string | undefined;

        if (!fetchData && !url) {
            log.info('skipping attachment without fetchData or url', { name });
            continue;
        }

        try {
            const data = fetchData ? await fetchData() : await fetchFromUrl(url as string);
            if (data.length > MAX_ATTACHMENT_BYTES) {
                log.warn('attachment too large, skipping', { name, size: data.length });
                continue;
            }
            const safeName = `${Date.now()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            const destPath = join(attachDir, safeName);
            writeFileSync(destPath, data);

            const wsRelative = `runs/${sessionId}/attachments/${safeName}`;
            files.push({ path: wsRelative, originalName: name });
            log.info('attachment saved', { name, size: data.length, path: wsRelative });
        } catch (err) {
            log.warn('failed to download attachment', { name, error: String(err) });
        }
    }
    return files;
}

/** Fetch attachment data from a URL when fetchData is not provided by the adapter. */
async function fetchFromUrl(url: string): Promise<Buffer> {
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} fetching attachment: ${url}`);
    }
    return Buffer.from(await resp.arrayBuffer());
}

/**
 * Fetch channel topic from the platform via Chat SDK.
 *
 * Reads `metadata.topic` which Slack adapter sets directly.
 * Discord adapter currently omits this field, so we fall back to
 * `metadata.raw.topic` (the raw Discord API channel object).
 * Once the Discord adapter is fixed to set `metadata.topic`,
 * the fallback becomes a no-op.
 *
 * Returns undefined on error or when the channel has no topic.
 */
async function fetchChannelTopic(thread: Thread): Promise<string | undefined> {
    try {
        const info = await thread.channel.fetchMetadata();
        const { metadata } = info;

        // Prefer the canonical field (Slack sets this; Discord should too)
        let topic: unknown = metadata.topic;

        // Fallback: Discord adapter stores raw API response in metadata.raw
        if (topic === undefined) {
            const raw = metadata.raw as Record<string, unknown> | undefined;
            topic = raw?.topic;
        }

        return typeof topic === 'string' && topic.trim() ? topic.trim() : undefined;
    } catch (err) {
        log.warn('failed to fetch channel topic', { error: String(err) });
        return undefined;
    }
}

/**
 * Build an AgentRunEventData from a Chat SDK thread and message.
 *
 * Serializes the thread so it can be deserialized in the Inngest step
 * for reply delivery. Downloads any message attachments to the workspace
 * for multimodal input.
 *
 * Args:
 *     thread: Chat SDK Thread instance.
 *     message: Chat SDK Message.
 *
 * Returns:
 *     Event data ready for Inngest dispatch.
 */
async function buildEventData(thread: Thread, message: Message): Promise<AgentRunEventData> {
    const adapterName = thread.adapter.name;
    const config = loadConfig();
    const tz = config.timezone || undefined;
    const sessionId = deriveSessionId(thread, tz);
    const userName = message.author.fullName || message.author.userName;

    // Handlers always receive ThreadImpl instances; cast to access toJSON()
    const threadImpl = thread as ThreadImpl;

    // Download attachments to workspace for Gemini CLI @ references
    const workspacePath = getWorkspacePath(config);
    const files = await downloadAttachments(message, sessionId, workspacePath);

    // Fetch channel topic for per-channel behavior control (e.g. "日本語で応答")
    const channelTopic = thread.isDM ? undefined : await fetchChannelTopic(thread);

    // Build channel conversation context (experimental)
    let channelContextJson: string | undefined;
    if (!thread.isDM) {
        const ccConfig = config.experimental?.channelContext;
        if (ccConfig && ccConfig.maxDays > 0) {
            const channelContext = await buildChannelContext({
                adapter: thread.adapter,
                adapterName,
                chatChannelId: thread.channelId,
                channelName: thread.channel.name ?? thread.channelId,
                sessionPrefix: deriveChannelSessionPrefix(thread),
                summariesDir: join(workspacePath, 'memory', 'summaries'),
                config: ccConfig,
                timezone: config.timezone || undefined,
            });
            if (channelContext) {
                channelContextJson = JSON.stringify(channelContext);
            }
        }
    }

    // Fetch referenced context (reply target / thread starter) on the first turn only.
    // Covers Discord Reply, Discord Thread Starter, and Slack Thread Starter.
    // Guard: only run for adapters that actually have referenced context support.
    let referencedContextBlock = '';
    if (adapterName === 'discord' || adapterName === 'slack') {
        const { SessionStore } = await import('../agent/session/store.js');
        const store = new SessionStore(join(workspacePath, 'memory', 'sessions'));
        const hasHistory = store.getLastEntry(sessionId) != null;
        if (!hasHistory) {
            const refCtx = await fetchReferencedContext(thread, message);
            if (refCtx) {
                referencedContextBlock = formatReferencedContext(refCtx);
            }
        }
    }

    // Determine if this is the configured home channel
    const rawChannelId = extractRawChannelId(thread);
    const isHomeChannel =
        !!config.home && config.home.channel === adapterName && rawChannelId === config.home.channelId;

    return {
        sessionId,
        trigger: adapterName,
        prompt: `${referencedContextBlock}[${adapterName}] ${userName}: ${message.text}`,
        serializedThread: JSON.stringify(threadImpl.toJSON()),
        ...(isHomeChannel ? { isHomeChannel } : {}),
        ...(thread.isDM ? { isDM: true } : {}),
        ...(channelTopic ? { channelTopic } : {}),
        ...(channelContextJson ? { channelContext: channelContextJson } : {}),
        ...(files.length > 0 ? { files } : {}),
    };
}

/**
 * Check if a message in a non-subscribed, non-mention context should be handled.
 *
 * For Discord/Slack/Telegram: only respond in channels listed in respondInChannels.
 * For other adapters: never respond (require @mention or subscription).
 *
 * Args:
 *     thread: Chat SDK Thread.
 *
 * Returns:
 *     True if the bot should respond.
 */
function shouldRespondInChannel(thread: Thread): boolean {
    const adapterName = thread.adapter.name;
    const config = loadConfig();

    const channelConfig =
        adapterName === 'discord'
            ? config.channels.discord
            : adapterName === 'slack'
              ? config.channels.slack
              : adapterName === 'telegram'
                ? config.channels.telegram
                : null;
    if (!channelConfig) return false;

    const { respondInChannels } = channelConfig;
    if (respondInChannels.length === 0) return false;

    const rawChannelId = extractRawChannelId(thread);
    return respondInChannels.includes(rawChannelId);
}

/**
 * Register all Chat SDK event handlers.
 *
 * This is the single registration point that replaces the old
 * ChannelRouter + DiscordChannel.start() + SlackChannel.start() setup.
 *
 * Args:
 *     chat: Initialized Chat instance.
 */
/**
 * Check if a message should be processed by the agent.
 *
 * Filters out:
 *   1. Bot's own messages — prevents self-reply loops when the agent posts
 *      via postToChannel() or geminiclaw_post_message. Platform SDKs
 *      (discord.js, Slack webhooks) already filter these at the transport
 *      layer, but this is a defense-in-depth guard.
 *   2. Discord system events — thread title changes, pin notifications, etc.
 *      are delivered as MESSAGE_CREATE with non-zero `type` values.
 *      We only process DEFAULT (0) and REPLY (19).
 */
function isUserMessage(thread: Thread, message: Message): boolean {
    // Guard: never process our own messages
    if (message.author.isMe) return false;

    // Discord-specific: filter system messages
    if (thread.adapter.name === 'discord') {
        const raw = message.raw as Record<string, unknown> | undefined;
        if (raw && raw.type !== undefined) {
            const messageType = raw.type as number;
            return messageType === 0 || messageType === 19;
        }
    }

    return true;
}

export function registerHandlers(chat: Chat): void {
    // Handle @mentions in unsubscribed threads (Discord guild mentions, Slack app_mention)
    chat.onNewMention(async (thread, message) => {
        if (!isUserMessage(thread, message)) return;
        const t0 = Date.now();
        log.info('mention received', {
            adapter: thread.adapter.name,
            sessionId: deriveSessionId(thread),
            user: message.author.userName,
            text: message.text.substring(0, 80),
        });

        // Subscribe so follow-up messages in this thread also trigger the agent.
        // For Discord top-level channels (non-thread), skip subscribe to avoid
        // capturing all subsequent channel messages. The bot's reply will create
        // a thread, and that thread gets subscribed via onNewMention or onNewMessage.
        const isDiscordTopLevel = thread.adapter.name === 'discord' && thread.id.split(':').length < 4;
        if (!isDiscordTopLevel) {
            await thread.subscribe();
        }
        const t1 = Date.now();

        const data = await buildEventData(thread, message);
        await inngest.send({ name: 'geminiclaw/run', data });
        log.info('mention dispatched', {
            subscribeMs: t1 - t0,
            inngestSendMs: Date.now() - t1,
            totalMs: Date.now() - t0,
        });
    });

    // Handle follow-up messages in subscribed threads
    chat.onSubscribedMessage(async (thread, message) => {
        if (!isUserMessage(thread, message)) return;
        const t0 = Date.now();
        const sessionId = deriveSessionId(thread);
        log.info('subscribed message', {
            adapter: thread.adapter.name,
            sessionId,
            user: message.author.userName,
            text: message.text.substring(0, 80),
        });

        // Check if there's a pending ask_user question for this session.
        const config = loadConfig();
        const workspacePath = getWorkspacePath(config);

        // Route reply to pending MCP ask_user question via answer file.
        // The MCP tool polls answer-{askId}.json and returns the answer to the model.
        const pending = findPending(workspacePath, sessionId);
        if (pending) {
            log.info('routing reply to pending ask_user', { sessionId, askId: pending.askId });
            writeAnswer(workspacePath, pending.askId, message.text);
            clearPending(workspacePath, pending.askId);
            // Edit the ask card into a Q&A log so the conversation stays readable
            await editAskCardToLog(thread, pending, message.text, message.author.fullName || message.author.userName);
            return; // Skip normal dispatch — MCP tool will receive the answer
        }

        // Check for expired pending — clean up and fall through to normal dispatch
        const stalePending = findPendingRaw(workspacePath, sessionId);
        if (stalePending) {
            log.info('clearing expired ask_user pending', { sessionId, askId: stalePending.askId });
            clearPending(workspacePath, stalePending.askId);
        }

        const data = await buildEventData(thread, message);
        await inngest.send({ name: 'geminiclaw/run', data });
        log.info('subscribed message dispatched', { inngestSendMs: Date.now() - t0 });
    });

    // Handle all messages matching any text in unsubscribed, non-mention contexts.
    // Used for respondInChannels feature (respond without @mention) on Discord, Slack, and Telegram.
    chat.onNewMessage(/[\s\S]*/, async (thread, message) => {
        if (!isUserMessage(thread, message)) return;
        if (!shouldRespondInChannel(thread)) return;

        log.info('channel message (respondInChannels)', {
            adapter: thread.adapter.name,
            sessionId: deriveSessionId(thread),
            user: message.author.userName,
            text: message.text.substring(0, 80),
        });

        // Subscribe so follow-up messages trigger the agent too
        await thread.subscribe();

        const data = await buildEventData(thread, message);
        await inngest.send({ name: 'geminiclaw/run', data });
    });

    // Handle button clicks from ask_user cards.
    // Discord responds to component interactions with DeferredUpdateMessage (type 6),
    // which expects the original message to be edited. We must editMessage on the
    // card to satisfy the interaction, then optionally post a follow-up.
    chat.onAction(async (event) => {
        if (!event.actionId.startsWith('ask-user:')) return;

        const [, askId, indexStr] = event.actionId.split(':');
        const optionIndex = parseInt(indexStr, 10);

        const config = loadConfig();
        const workspacePath = getWorkspacePath(config);
        // Look up by askId directly — the thread context from Discord interaction
        // events may differ from the session that posted the ask card (e.g. when
        // the bot auto-creates threads, the interaction channel_id differs from
        // the original channel where the card was posted).
        if (!askId) {
            log.warn('ask-user action missing askId', { actionId: event.actionId });
            return;
        }
        const pending = findPendingByAskId(workspacePath, askId);

        if (!pending) {
            log.info('ignoring stale ask-user action', { askId });
            return;
        }

        const answer = pending.options?.[optionIndex] ?? `Option ${optionIndex}`;
        writeAnswer(workspacePath, pending.askId, answer);
        clearPending(workspacePath, pending.askId);

        const userName = event.user.fullName || event.user.userName;
        const logText = `**Agent asked:** ${pending.question}\n\n**${userName}** selected: ${answer}`;

        try {
            if (!event.thread) {
                log.warn('event.thread is null, cannot edit card');
            } else {
                const adapterName = event.thread.adapter.name;
                if (adapterName === 'discord') {
                    // Discord: clear embeds + components (buttons) via REST API
                    const rawChannelId = extractDiscordMessageChannelId(event.threadId);
                    const botToken = (event.thread.adapter as unknown as { botToken: string }).botToken;
                    await fetch(`https://discord.com/api/v10/channels/${rawChannelId}/messages/${event.messageId}`, {
                        method: 'PATCH',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bot ${botToken}`,
                        },
                        body: JSON.stringify({ content: logText, embeds: [], components: [] }),
                    });
                } else if (adapterName === 'slack') {
                    // Slack: clear blocks (buttons) via REST API so they can't be re-clicked
                    await editSlackMessage(event.thread, event.messageId, logText);
                } else {
                    await event.thread.adapter.editMessage(event.threadId, event.messageId, logText);
                }
            }
        } catch (err) {
            log.warn('failed to edit card into Q&A log, falling back to post', { error: String(err) });
            try {
                await event.thread?.post(`**${userName}** selected: ${answer}`);
            } catch (postErr) {
                log.warn('failed to post action confirmation', { error: String(postErr) });
            }
        }

        log.info('ask-user action handled', { askId, answer, user: event.user.userName });
    });

    log.info('handlers registered');
}

/**
 * Edit the ask card message into a Q&A log showing both question and answer.
 *
 * Uses platform REST APIs directly to clear embeds/blocks and button components,
 * since Chat SDK editMessage doesn't strip them.
 * Falls back silently if the card message ID is missing or the edit fails.
 */
async function editAskCardToLog(
    thread: Thread,
    pending: PendingQuestion,
    answer: string,
    userName: string,
): Promise<void> {
    if (!pending.cardMessageId) return;
    const logText = `**Agent asked:** ${pending.question}\n\n**${userName}** answered: ${answer}`;

    try {
        if (thread.adapter.name === 'discord') {
            // Clear embeds + components (buttons) via REST API
            const rawChannelId = extractDiscordMessageChannelId(thread.id);
            const botToken = (thread.adapter as unknown as { botToken: string }).botToken;
            await fetch(`https://discord.com/api/v10/channels/${rawChannelId}/messages/${pending.cardMessageId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
                body: JSON.stringify({ content: logText, embeds: [], components: [] }),
            });
        } else if (thread.adapter.name === 'slack') {
            // Clear blocks (buttons) via REST API so they can't be re-clicked
            await editSlackMessage(thread, pending.cardMessageId, logText);
        } else {
            await thread.adapter.editMessage(thread.id, pending.cardMessageId, logText);
        }
    } catch (err) {
        log.warn('failed to edit ask card into Q&A log', { error: String(err) });
    }
}

/**
 * Edit a Slack message via REST API, explicitly clearing blocks (buttons).
 *
 * Chat SDK's editMessage only updates text but may preserve existing blocks,
 * leaving buttons clickable. Using chat.update directly with `blocks: []`
 * ensures interactive components are removed.
 */
async function editSlackMessage(
    thread: {
        adapter: { editMessage(threadId: string, messageId: string, text: string): Promise<unknown> };
        id: string;
    },
    messageId: string,
    text: string,
): Promise<void> {
    const botToken = (thread.adapter as unknown as { botToken: string }).botToken;
    if (!botToken) {
        // Fallback to Chat SDK editMessage if token is inaccessible
        await thread.adapter.editMessage(thread.id, messageId, text);
        return;
    }

    // Extract channel from thread.id ("slack:channel:threadTs")
    const channel = thread.id.split(':')[1] ?? '';

    const res = await fetch('https://slack.com/api/chat.update', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({ channel, ts: messageId, text, blocks: [] }),
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    if (!body.ok) {
        log.warn('Slack chat.update failed', { error: body.error, channel, ts: messageId });
        // Fallback to Chat SDK
        await thread.adapter.editMessage(thread.id, messageId, text);
    }
}
