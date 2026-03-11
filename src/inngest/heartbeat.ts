/**
 * inngest/heartbeat.ts — Cron trigger for heartbeat.
 *
 * This is now a thin wrapper: the cron fires an event which
 * is picked up by the unified agent-run function (Lane Queue).
 *
 * This ensures heartbeats are serialized per session and
 * don't conflict with ongoing manual or channel tasks.
 */

import { loadConfig } from '../config.js';
import { inngest } from './client.js';

/**
 * Build a cron expression from a heartbeat interval in minutes.
 * Supports common intervals; falls back to `*​/N * * * *` for arbitrary values.
 */
function buildCronExpression(intervalMin: number): string {
    if (intervalMin === 60) return '0 * * * *';
    return `*/${intervalMin} * * * *`;
}

/**
 * Resolve the heartbeat reply destination from config.
 * Falls back to the first enabled homeChannel when heartbeat.reply is not set.
 */
function buildHeartbeatReply(): { channelType: string; channelId: string } | undefined {
    const config = loadConfig();
    const hbReply = config.heartbeat.reply;
    if (hbReply) {
        return { channelType: hbReply.channel, channelId: hbReply.channelId };
    }
    // Fall back to homeChannel — heartbeat reply is the default FYI destination
    if (config.channels.discord.enabled && config.channels.discord.homeChannel) {
        return { channelType: 'discord', channelId: config.channels.discord.homeChannel };
    }
    if (config.channels.slack.enabled && config.channels.slack.homeChannel) {
        return { channelType: 'slack', channelId: config.channels.slack.homeChannel };
    }
    return undefined;
}

/**
 * Create the heartbeat cron function with the given interval.
 * Called at server startup so the interval can be read from config.
 */
export function createHeartbeatCron(intervalMin: number) {
    return inngest.createFunction(
        {
            id: 'heartbeat-cron',
            name: 'Heartbeat Cron Trigger',
        },
        { cron: buildCronExpression(intervalMin) },
        async ({ step }) => {
            await step.sendEvent('fire-heartbeat', {
                name: 'geminiclaw/run',
                data: {
                    sessionId: 'cron:heartbeat',
                    trigger: 'heartbeat',
                    prompt:
                        'Execute HEARTBEAT.md. ' +
                        'Review digest, check calendar/email, and handle any needed notifications. ' +
                        'Post notifications to the home channel via geminiclaw_post_message. ' +
                        'Always respond with HEARTBEAT_OK when done.',
                    reply: buildHeartbeatReply(),
                },
            });

            return { fired: true };
        },
    );
}
