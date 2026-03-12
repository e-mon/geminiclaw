/**
 * inngest/heartbeat.ts — Cron trigger for heartbeat.
 *
 * This is now a thin wrapper: the cron fires an event which
 * is picked up by the unified agent-run function (Lane Queue).
 *
 * This ensures heartbeats are serialized per session and
 * don't conflict with ongoing manual or channel tasks.
 */

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
                },
            });

            return { fired: true };
        },
    );
}
