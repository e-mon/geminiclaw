/**
 * agent/turn/finalize.ts — Handler array for the "deliver" phase (Inngest only).
 *
 * All handlers are fail-open with conditional execution:
 * - generateTitle: first turn only
 * - notifyBackgroundJob: heartbeat + cron → notifications channel
 * - sendReply: when a reply target exists (skipped for heartbeat OK)
 */

import { resolve } from 'node:path';
import { deliverReply, postToChannel } from '../../channels/reply.js';
import { createLogger } from '../../logger.js';
import { sendDesktopNotification } from '../../notifier.js';
import { filterResponseText } from '../runner.js';
import type { Handler } from './handlers.js';
import { runHandlersParallel } from './handlers.js';
import type { DeliverContext } from './types.js';

const log = createLogger('turn-deliver');

function isBackgroundJob(ctx: DeliverContext): boolean {
    return ctx.eventData.trigger === 'heartbeat' || ctx.eventData.trigger === 'cron';
}

function hasReplyTarget(ctx: DeliverContext): boolean {
    return !!ctx.eventData.serializedThread;
}

async function generateTitle(ctx: DeliverContext): Promise<void> {
    const { SessionStore } = await import('../session/store.js');
    const sessionsDir = resolve(ctx.workspacePath, 'memory', 'sessions');
    const store = new SessionStore(sessionsDir);

    // Skip if a title already exists (not the first turn)
    if (store.getTitle(ctx.eventData.sessionId)) return;

    const { generateSessionTitle, parseSerializedThread, renameDiscordThread } = await import('../session/title.js');
    const title = await generateSessionTitle(ctx.eventData.prompt, ctx.runResult.responseText, ctx.workspacePath);
    store.setTitle(ctx.eventData.sessionId, title);
    log.info('session title generated', { sessionId: ctx.eventData.sessionId, title });

    // Rename Discord thread if applicable
    if (ctx.eventData.serializedThread) {
        const parsed = parseSerializedThread(ctx.eventData.serializedThread);
        if (parsed.adapter === 'discord' && parsed.discordThreadId && ctx.config.channels.discord.token) {
            await renameDiscordThread(ctx.config.channels.discord.token, parsed.discordThreadId, title);
        }
    }
}

/**
 * Post a brief completion notification for background jobs (heartbeat / cron)
 * to the notifications channel. This is separate from the full
 * result reply which goes to the job's own reply channel.
 *
 * Desktop notifications only fire on heartbeat alerts.
 */
async function notifyBackgroundJob(ctx: DeliverContext): Promise<void> {
    const trigger = ctx.eventData.trigger;
    const promises: Promise<void>[] = [];

    let text: string;
    if (trigger === 'heartbeat') {
        const isAlert = !ctx.runResult.heartbeatOk;
        const filtered = filterResponseText(ctx.runResult.responseText);
        text = isAlert ? `\u26a0\ufe0f **Heartbeat Alert**\n${filtered.substring(0, 500)}` : '\u2705 **Heartbeat OK**';
        if (isAlert && ctx.config.heartbeat.desktop) {
            promises.push(sendDesktopNotification('GeminiClaw \u26a0\ufe0f', filtered.substring(0, 300)));
        }
    } else {
        const jobId = ctx.eventData.sessionId.replace(/^cron:/, '');
        const hasError = !!ctx.runResult.error;
        text = hasError
            ? `\u26a0\ufe0f **Cron failed: ${jobId}**\n${ctx.runResult.error?.substring(0, 300)}`
            : `\u2705 **Cron done: ${jobId}**`;
    }

    if (ctx.config.notifications) {
        promises.push(
            postToChannel({
                channelType: ctx.config.notifications.channel,
                channelId: ctx.config.notifications.channelId,
                text,
                config: ctx.config,
            }).catch((err) => {
                log.warn('job notification failed', {
                    channelType: ctx.config.notifications!.channel,
                    error: String(err),
                });
            }),
        );
    }

    await Promise.allSettled(promises);
}

async function sendReply(ctx: DeliverContext): Promise<void> {
    await deliverReply({
        runResult: ctx.runResult,
        eventData: ctx.eventData,
        config: ctx.config,
        workspacePath: ctx.workspacePath,
        progressFinalized: ctx.progressFinalized,
    });
}

const FINALIZE_HANDLERS: readonly Handler<DeliverContext>[] = [
    { id: 'generate-title', errorSemantics: 'fail-open', run: generateTitle },
    { id: 'notify-background-job', errorSemantics: 'fail-open', condition: isBackgroundJob, run: notifyBackgroundJob },
    { id: 'send-reply', errorSemantics: 'fail-open', condition: hasReplyTarget, run: sendReply },
];

export async function runDeliver(ctx: DeliverContext): Promise<void> {
    return runHandlersParallel('deliver', FINALIZE_HANDLERS, ctx);
}
