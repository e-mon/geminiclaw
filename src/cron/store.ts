/**
 * cron/store.ts — CRUD and scheduling logic for cron jobs.
 *
 * Source of truth: {workspace}/cron/jobs.json
 * Pure functions for findDueJobs / advanceNextRun; side-effectful load/save for I/O.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Cron } from 'croner';
import type { CronJob, CronRunEntry } from './types.js';

// ── I/O ─────────────────────────────────────────────────────────

function jobsPath(workspacePath: string): string {
    return join(workspacePath, 'cron', 'jobs.json');
}

/** Load all jobs from disk. Returns empty array if file doesn't exist. */
export function loadJobs(workspacePath: string): CronJob[] {
    const path = jobsPath(workspacePath);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as CronJob[];
}

/** Persist the full job list to disk (atomic overwrite). */
export function saveJobs(workspacePath: string, jobs: CronJob[]): void {
    const path = jobsPath(workspacePath);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(jobs, null, 2), 'utf-8');
}

// ── Pure scheduling helpers ─────────────────────────────────────

/** Return enabled jobs whose nextRunAt is at or before `now`. */
export function findDueJobs(jobs: CronJob[], now: Date): CronJob[] {
    const nowMs = now.getTime();
    return jobs.filter((j) => {
        if (!j.enabled || !j.nextRunAt) return false;
        return new Date(j.nextRunAt).getTime() <= nowMs;
    });
}

/**
 * Advance a job's nextRunAt based on its schedule type.
 * Mutates the job in place.
 *
 * - `at`: one-shot — sets enabled=false after firing.
 * - `every`: adds intervalMin to now.
 * - `cron`: uses croner to compute the next occurrence.
 */
export function advanceNextRun(job: CronJob, now: Date, fallbackTz?: string): void {
    job.lastRunAt = now.toISOString();
    const tz = job.timezone ?? fallbackTz;

    switch (job.schedule.type) {
        case 'at':
            job.enabled = false;
            job.nextRunAt = undefined;
            break;

        case 'every': {
            const next = new Date(now.getTime() + job.schedule.intervalMin * 60_000);
            job.nextRunAt = next.toISOString();
            break;
        }

        case 'cron': {
            const cron = new Cron(job.schedule.expression, { timezone: tz });
            const next = cron.nextRun(now);
            job.nextRunAt = next ? next.toISOString() : undefined;
            if (!job.nextRunAt) job.enabled = false;
            break;
        }
    }
}

/**
 * Compute the initial nextRunAt for a newly created job.
 * Called once when a job is added. Mutates the job in place.
 */
export function computeInitialNextRun(job: CronJob, now: Date, fallbackTz?: string): void {
    const tz = job.timezone ?? fallbackTz;

    switch (job.schedule.type) {
        case 'at':
            job.nextRunAt = job.schedule.datetime;
            break;

        case 'every': {
            const next = new Date(now.getTime() + job.schedule.intervalMin * 60_000);
            job.nextRunAt = next.toISOString();
            break;
        }

        case 'cron': {
            const cron = new Cron(job.schedule.expression, { timezone: tz });
            const next = cron.nextRun(now);
            job.nextRunAt = next ? next.toISOString() : undefined;
            break;
        }
    }
}

// ── CRUD helpers ────────────────────────────────────────────────

export function addJob(workspacePath: string, job: CronJob): void {
    const jobs = loadJobs(workspacePath);
    jobs.push(job);
    saveJobs(workspacePath, jobs);
}

export function removeJob(workspacePath: string, jobId: string): boolean {
    const jobs = loadJobs(workspacePath);
    const idx = jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return false;
    jobs.splice(idx, 1);
    saveJobs(workspacePath, jobs);
    return true;
}

export function listJobs(workspacePath: string): CronJob[] {
    return loadJobs(workspacePath);
}

/**
 * Update a job in-place by merging patch fields.
 * Only keys explicitly present in patch are applied (undefined values are treated as "clear this field").
 * The `id` field is immutable and cannot be patched.
 */
export function editJob(workspacePath: string, jobId: string, patch: Partial<CronJob>): CronJob | null {
    const jobs = loadJobs(workspacePath);
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return null;
    for (const key of Object.keys(patch) as Array<keyof CronJob>) {
        if (key === 'id') continue;
        (job as unknown as Record<string, unknown>)[key] = patch[key];
    }
    saveJobs(workspacePath, jobs);
    return job;
}

// ── Run log ──────────────────────────────────────────────────────

function runsDir(workspacePath: string): string {
    return join(workspacePath, 'cron', 'runs');
}

/** Append a run entry to {workspace}/cron/runs/{jobId}.jsonl. */
export function appendRunLog(workspacePath: string, jobId: string, entry: CronRunEntry): void {
    const dir = runsDir(workspacePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${jobId}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf-8');
}

/** Load all run entries for a job (newest last). */
export function loadRunLog(workspacePath: string, jobId: string, limit?: number): CronRunEntry[] {
    const filePath = join(runsDir(workspacePath), `${jobId}.jsonl`);
    if (!existsSync(filePath)) return [];
    const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l) as CronRunEntry);
    return limit ? entries.slice(-limit) : entries;
}

const RUN_LOG_MAX_LINES = 500;

/** Trim a run log file to the newest N lines if it exceeds the limit. */
export function pruneRunLog(workspacePath: string, jobId: string): void {
    const filePath = join(runsDir(workspacePath), `${jobId}.jsonl`);
    if (!existsSync(filePath)) return;
    const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    if (lines.length <= RUN_LOG_MAX_LINES) return;
    writeFileSync(filePath, `${lines.slice(-RUN_LOG_MAX_LINES).join('\n')}\n`, 'utf-8');
}

// ── Session retention ────────────────────────────────────────────

/**
 * Delete cron session JSONL files older than retentionHours.
 * Cron sessions use the naming convention `cron:{jobId}.jsonl`.
 */
export function pruneCronSessions(sessionsDir: string, retentionHours: number): number {
    if (!existsSync(sessionsDir)) return 0;
    const cutoff = Date.now() - retentionHours * 3600_000;
    let pruned = 0;
    for (const file of readdirSync(sessionsDir)) {
        if (!file.startsWith('cron:') || !file.endsWith('.jsonl')) continue;
        const filePath = join(sessionsDir, file);
        const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
        if (lines.length === 0) continue;
        // Check last entry's timestamp
        try {
            const lastLine = lines.at(-1);
            if (!lastLine) continue;
            const last = JSON.parse(lastLine) as { timestamp?: string };
            if (last.timestamp && new Date(last.timestamp).getTime() < cutoff) {
                unlinkSync(filePath);
                pruned++;
            }
        } catch {
            // Malformed JSONL — skip
        }
    }
    return pruned;
}
