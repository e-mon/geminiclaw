/**
 * inngest/cron-scheduler.ts — Self-rescheduling cron job runner.
 *
 * Each cron job gets its own Inngest function run that sleeps until
 * the next execution time, fires the agent, then reschedules itself.
 * No more per-minute polling — runs only exist for active jobs.
 *
 * Lifecycle:
 *   1. cron_add (MCP/CLI) → sends 'cron/job.scheduled' event
 *   2. cronJobRunner receives event → sleepUntil(nextRunAt)
 *   3. Wakes up → fires 'geminiclaw/run' → advances nextRunAt in jobs.json
 *   4. Sends 'cron/job.scheduled' with new nextRunAt → loop
 *
 * Cancellation:
 *   cron_remove sends 'cron/job.cancelled' → cancelOn kills sleeping run
 *
 * Recovery:
 *   On server startup, scheduleAllJobs() reads jobs.json and sends
 *   'cron/job.scheduled' for every enabled job with a nextRunAt.
 */

import { join } from 'node:path';
import { getWorkspacePath, loadConfig } from '../config.js';
import { advanceNextRun, appendRunLog, loadJobs, pruneCronSessions, pruneRunLog, saveJobs } from '../cron/store.js';
import type { CronJob } from '../cron/types.js';
import { createLogger } from '../logger.js';
import { inngest } from './client.js';

const log = createLogger('cron-scheduler');

// ── Shared helpers ───────────────────────────────────────────────

/** Resolve the reply destination for a cron job (job → config → homeChannel). */
function buildCronReply(
    job: CronJob,
    config: ReturnType<typeof loadConfig>,
): { channelType: string; channelId: string; replyRef?: string } | undefined {
    const source = job.reply ?? config.cron.defaultReply ?? resolveHomeChannel(config);
    if (!source) return undefined;
    return {
        channelType: source.channel,
        channelId: source.channelId,
        replyRef: ('threadTs' in source ? source.threadTs : undefined) as string | undefined,
    };
}

function resolveHomeChannel(config: ReturnType<typeof loadConfig>): CronJob['reply'] | undefined {
    if (config.channels.discord.enabled && config.channels.discord.homeChannel) {
        return { channel: 'discord', channelId: config.channels.discord.homeChannel };
    }
    if (config.channels.slack.enabled && config.channels.slack.homeChannel) {
        return { channel: 'slack', channelId: config.channels.slack.homeChannel };
    }
    return undefined;
}

// ── Inngest function ─────────────────────────────────────────────

/** Event payload for scheduling / cancelling a cron job run. */
export interface CronJobEventData {
    jobId: string;
    nextRunAt: string;
}

export const cronJobRunner = inngest.createFunction(
    {
        id: 'cron-job-runner',
        name: 'Cron Job Runner',
        cancelOn: [{ event: 'cron/job.cancelled', match: 'data.jobId' }],
        concurrency: [{ scope: 'fn', key: 'event.data.jobId', limit: 1 }],
    },
    { event: 'cron/job.scheduled' },
    async ({ event, step }) => {
        const { jobId, nextRunAt } = event.data as CronJobEventData;

        // Sleep until scheduled execution time
        await step.sleepUntil('wait-until-due', new Date(nextRunAt));

        // Load the job to get its current config (prompt, reply, etc.)
        const config = loadConfig();
        const ws = getWorkspacePath(config);

        const job = await step.run('load-job', () => {
            const all = loadJobs(ws);
            return all.find((j) => j.id === jobId) ?? null;
        });

        if (!job || !job.enabled) {
            const reason = job ? 'disabled' : 'not-found';
            appendRunLog(ws, jobId, { timestamp: new Date().toISOString(), status: 'skipped', reason });
            log.info('job-skipped', { jobId, reason });
            return { fired: false, reason };
        }

        // Dispatch the agent run
        await step.sendEvent('fire', {
            name: 'geminiclaw/run',
            data: {
                sessionId: `cron:${job.id}`,
                trigger: 'cron',
                prompt: job.prompt,
                model: job.model,
                reply: buildCronReply(job, config),
            },
        });
        log.info('dispatched', { jobId: job.id, jobName: job.name, model: job.model });

        // Advance nextRunAt and persist — auto-delete when deleteAfterRun is set
        const nextJob = await step.run('advance-next-run', () => {
            const all = loadJobs(ws);
            const j = all.find((x) => x.id === jobId);
            if (!j) return null;
            advanceNextRun(j, new Date(), config.timezone || undefined);

            // Resolve deleteAfterRun: explicit field > default (true for `at`)
            const shouldDelete = j.deleteAfterRun ?? j.schedule.type === 'at';

            if (!j.enabled && shouldDelete) {
                saveJobs(
                    ws,
                    all.filter((x) => x.id !== jobId),
                );
                appendRunLog(ws, jobId, {
                    timestamp: new Date().toISOString(),
                    status: 'deleted',
                    reason: 'auto-delete after run',
                });
                log.info('auto-deleted', { jobId, reason: 'deleteAfterRun' });
                return { nextRunAt: undefined as string | undefined, enabled: false as const, deleted: true };
            }

            appendRunLog(ws, jobId, { timestamp: new Date().toISOString(), status: 'dispatched' });
            pruneRunLog(ws, jobId);
            saveJobs(ws, all);
            return { nextRunAt: j.nextRunAt, enabled: j.enabled, deleted: false };
        });

        // Reschedule if still enabled and has a next run time
        if (nextJob?.enabled && nextJob.nextRunAt) {
            await step.sendEvent('reschedule', {
                name: 'cron/job.scheduled',
                data: { jobId, nextRunAt: nextJob.nextRunAt },
            });
            log.info('rescheduled', { jobId, nextRunAt: nextJob.nextRunAt });
        }

        return { fired: true, nextRunAt: nextJob?.nextRunAt };
    },
);

// ── Public helpers (CLI / MCP) ───────────────────────────────────

/**
 * Send 'cron/job.scheduled' events for all enabled jobs.
 * Called on server startup to recover sleeping runs.
 * Also prunes old cron sessions and orphaned run logs at startup.
 */
export async function scheduleAllJobs(): Promise<number> {
    const config = loadConfig();
    const ws = getWorkspacePath(config);
    const jobs = loadJobs(ws);
    const enabledJobs = jobs.filter((j) => j.enabled && j.nextRunAt);

    // Startup-time housekeeping: prune old cron sessions
    if (config.cron.sessionRetentionHours > 0) {
        const sessionsDir = join(ws, 'memory', 'sessions');
        const pruned = pruneCronSessions(sessionsDir, config.cron.sessionRetentionHours);
        if (pruned > 0) log.info('startup-prune-sessions', { pruned });
    }

    if (enabledJobs.length === 0) return 0;

    const events = enabledJobs.map((j) => ({
        name: 'cron/job.scheduled' as const,
        data: { jobId: j.id, nextRunAt: j.nextRunAt as string },
    }));

    await inngest.send(events);
    log.info('startup-recovery', { scheduledJobs: enabledJobs.length });
    return enabledJobs.length;
}

/**
 * Send a single 'cron/job.scheduled' event for immediate scheduling.
 * Used by MCP cron_add and CLI cron add.
 */
export async function scheduleCronJob(job: CronJob): Promise<void> {
    if (!job.enabled || !job.nextRunAt) return;
    await inngest.send({
        name: 'cron/job.scheduled',
        data: { jobId: job.id, nextRunAt: job.nextRunAt },
    });
    log.info('scheduled', { jobId: job.id, nextRunAt: job.nextRunAt });
}

/**
 * Manually fire a cron job immediately (extra execution, does not consume the schedule).
 * Used by CLI `cron run` and MCP `geminiclaw_cron_run`.
 */
export async function fireCronJob(
    job: CronJob,
    config: ReturnType<typeof loadConfig>,
    workspacePath: string,
): Promise<void> {
    await inngest.send({
        name: 'geminiclaw/run',
        data: {
            sessionId: `cron:${job.id}`,
            trigger: 'cron',
            prompt: job.prompt,
            model: job.model,
            reply: buildCronReply(job, config),
        },
    });
    appendRunLog(workspacePath, job.id, {
        timestamp: new Date().toISOString(),
        status: 'dispatched',
        reason: 'manual',
    });
    log.info('manual-fire', { jobId: job.id, jobName: job.name });
}

/**
 * Send a 'cron/job.cancelled' event to cancel a sleeping run.
 * Used by MCP cron_remove and CLI cron rm.
 */
export async function cancelCronJob(jobId: string): Promise<void> {
    await inngest.send({
        name: 'cron/job.cancelled',
        data: { jobId, nextRunAt: '' },
    });
    log.info('cancelled', { jobId });
}
