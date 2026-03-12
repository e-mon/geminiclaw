/**
 * cron/types.ts — Cron job scheduling types.
 *
 * Defines the shape of jobs stored in {workspace}/cron/jobs.json.
 * Three schedule types mirror OpenClaw's at/every/cron interface.
 */

export interface CronJob {
    id: string;
    name: string;
    schedule: AtSchedule | EverySchedule | CronSchedule;
    prompt: string;
    enabled: boolean;
    /** IANA timezone. Falls back to config.timezone if omitted. */
    timezone?: string;
    /** Override model for this job (e.g. "gemini-2.5-flash"). Falls back to config.model. */
    model?: string;
    /** Auto-delete job from jobs.json after successful run. Default: true for `at`, false otherwise. */
    deleteAfterRun?: boolean;
    /** Delivery target for geminiclaw_post_message. Falls back to homeChannel if omitted. */
    reply?: {
        channel: 'discord' | 'slack';
        channelId: string;
    };
    createdAt: string;
    lastRunAt?: string;
    nextRunAt?: string;
}

/** A single entry in the per-job run log ({workspace}/cron/runs/{jobId}.jsonl). */
export interface CronRunEntry {
    timestamp: string;
    /** dispatched = event sent to Inngest (not agent completion), skipped = job disabled/not-found, deleted = auto-removed */
    status: 'dispatched' | 'skipped' | 'deleted';
    /** Why the job was skipped or deleted. */
    reason?: string;
}

/** One-shot schedule — runs once at the specified datetime, then disables. */
export type AtSchedule = { type: 'at'; datetime: string };

/** Recurring interval schedule — runs every N minutes. */
export type EverySchedule = { type: 'every'; intervalMin: number };

/** Cron expression schedule — standard 5-field cron syntax. */
export type CronSchedule = { type: 'cron'; expression: string };
