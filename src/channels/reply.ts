/**
 * channels/reply.ts — Reply delivery and channel posting.
 *
 * Handles Chat SDK thread replies and generic channel posting via
 * postToChannel(), including message splitting for Discord's 2000-char limit.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { RunResult } from '../agent/runner.js';
import { filterResponseText, parseMediaMarkers } from '../agent/runner.js';
import type { AgentRunEventData } from '../agent/turn/types.js';
import type { Config } from '../config.js';
import { createLogger } from '../logger.js';
import type { MediaItem } from './channel.js';
import { isMediaUrl } from './channel.js';

const log = createLogger('reply');

/**
 * Discord's max message content length. Slack's limit is ~40k so only
 * Discord needs splitting in practice.
 */
const DISCORD_MAX_LENGTH = 2000;

/**
 * Split a long message into chunks that fit within Discord's 2000-char limit.
 *
 * Splitting strategy (in priority order):
 *   1. Prefer splitting at blank lines (paragraph boundary)
 *   2. Fall back to splitting at line boundaries
 *   3. If a single line exceeds the limit, hard-cut at max length
 *
 * Code blocks (```) are tracked so that if a split occurs mid-block,
 * the closing/opening fence is inserted to keep each chunk valid Markdown.
 */
export function splitMessage(text: string, maxLen = DISCORD_MAX_LENGTH): string[] {
    if (text.length <= maxLen) return [text];

    const lines = text.split('\n');
    const chunks: string[] = [];
    let current = '';
    let inCodeBlock = false;
    let codeFence = '';

    for (const line of lines) {
        const fenceMatch = line.match(/^(`{3,})(\S*)/);
        const wouldBeLen = current.length + (current ? 1 : 0) + line.length;

        if (wouldBeLen > maxLen && current) {
            if (inCodeBlock) {
                current += '\n```';
            }
            chunks.push(current);
            current = inCodeBlock ? codeFence : '';
        }

        current += (current ? '\n' : '') + line;

        if (fenceMatch) {
            if (!inCodeBlock) {
                inCodeBlock = true;
                codeFence = fenceMatch[0];
            } else {
                inCodeBlock = false;
                codeFence = '';
            }
        }
    }

    if (current) chunks.push(current);
    return chunks;
}

/**
 * Deliver a reply via Chat SDK or legacy adapter.
 *
 * Handles:
 * - Filtering internal meta-tags from response text
 * - Extracting MEDIA: markers for attachments
 * - Chat SDK thread path (deserialize + thread.post)
 * - Legacy adapter path (cron/heartbeat replies)
 * - Message splitting for Discord's character limit
 */
export async function deliverReply(opts: {
    runResult: RunResult;
    eventData: AgentRunEventData;
    config: Config;
    workspacePath: string;
    progressFinalized: boolean;
}): Promise<void> {
    const { runResult, eventData, config, workspacePath, progressFinalized } = opts;

    // Skip if progress message was already finalized into the reply
    if (progressFinalized) {
        log.info('reply already finalized in progress message, skipping send-reply');
        return;
    }

    const t0 = Date.now();
    const filtered = filterResponseText(runResult.responseText);
    const { mediaSrcs, cleanedText } = parseMediaMarkers(filtered);
    const replyText = cleanedText || (runResult.error ? `Error: ${runResult.error}` : '(no response)');

    // Resolve media sources: relative paths -> absolute against workspace
    const mediaItems: MediaItem[] = mediaSrcs
        .map((src): MediaItem | null => {
            if (isMediaUrl(src)) return { src };
            const abs = isAbsolute(src) ? src : resolve(workspacePath, src);
            return existsSync(abs) ? { src: abs } : null;
        })
        .filter((item): item is MediaItem => item !== null);

    // Chat SDK path: deserialize thread and use thread.post()
    if (eventData.serializedThread) {
        const tChat = Date.now();
        const { ThreadImpl } = await import('chat');
        const { createChat } = await import('./chat-setup.js');
        await createChat(config);
        const tChatDone = Date.now();

        const serialized = JSON.parse(eventData.serializedThread);
        const thread = ThreadImpl.fromJSON(serialized);

        log.info('sending reply via Chat SDK', {
            chars: replyText.length,
            mediaItems: mediaItems.length,
            chatInitMs: tChatDone - tChat,
        });

        const files = mediaItems
            .filter((item) => !isMediaUrl(item.src))
            .map((item) => ({
                data: readFileSync(item.src),
                filename: item.src.split('/').pop() ?? 'file',
            }));
        const urls = mediaItems.filter((item) => isMediaUrl(item.src));

        const chunks = splitMessage(replyText);
        const firstChunk = chunks[0];
        if (files.length > 0) {
            await thread.post({ raw: firstChunk, files });
        } else {
            await thread.post(firstChunk);
        }
        for (let i = 1; i < chunks.length; i++) {
            await thread.post(chunks[i]);
        }
        for (const urlItem of urls) {
            await thread.post(urlItem.src);
        }

        log.info('reply sent via Chat SDK', { totalMs: Date.now() - t0, postMs: Date.now() - tChatDone });
        return;
    }

    // Legacy path: use postToChannel for cron/heartbeat replies
    const { reply } = eventData;
    if (!reply) return;

    log.info('sending reply (legacy)', {
        channelType: reply.channelType,
        channelId: reply.channelId,
        chars: replyText.length,
        mediaItems: mediaItems.length,
    });

    await postToChannel({
        channelType: reply.channelType as 'discord' | 'slack',
        channelId: reply.channelId,
        threadRef: reply.replyRef,
        text: replyText,
        files: mediaItems,
        config,
    });
}

/**
 * Post a message to a specific channel or thread.
 * Unified replacement for the former sendLegacyReply and sendHeartbeatToChannel.
 */
export async function postToChannel(opts: {
    channelType: 'discord' | 'slack';
    channelId: string;
    threadRef?: string;
    text: string;
    files?: MediaItem[];
    config: Config;
}): Promise<void> {
    const { channelType, channelId, threadRef, text, files: mediaItems = [], config } = opts;
    const { createChat } = await import('./chat-setup.js');
    const chat = await createChat(config);

    const adapter = chat.getAdapter(channelType);
    if (!adapter) {
        log.warn('no adapter for channel post', { channelType });
        return;
    }

    let threadId: string;
    if (channelType === 'slack') {
        threadId = adapter.encodeThreadId({
            channel: channelId,
            threadTs: threadRef ?? '',
        } as never);
    } else {
        threadId = threadRef
            ? adapter.encodeThreadId({ channelId, guildId: '@me', threadId: threadRef } as never)
            : adapter.encodeThreadId({ channelId, guildId: '@me' } as never);
    }

    const fileAttachments = mediaItems
        .filter((item) => !isMediaUrl(item.src))
        .map((item) => ({
            data: readFileSync(item.src),
            filename: item.src.split('/').pop() ?? 'file',
        }));
    const urls = mediaItems.filter((item) => isMediaUrl(item.src));

    const chunks = splitMessage(text);
    if (fileAttachments.length > 0) {
        await adapter.postMessage(threadId, { raw: chunks[0], files: fileAttachments });
    } else {
        await adapter.postMessage(threadId, chunks[0]);
    }
    for (let i = 1; i < chunks.length; i++) {
        await adapter.postMessage(threadId, chunks[i]);
    }
    for (const urlItem of urls) {
        await adapter.postMessage(threadId, urlItem.src);
    }
}
