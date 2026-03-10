/**
 * cron/store.test.ts — Unit tests for cron job scheduling logic.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    addJob,
    advanceNextRun,
    appendRunLog,
    computeInitialNextRun,
    editJob,
    findDueJobs,
    listJobs,
    loadJobs,
    loadRunLog,
    pruneCronSessions,
    pruneRunLog,
    removeJob,
    saveJobs,
} from './store.js';
import type { CronJob } from './types.js';

// ── Test helpers ────────────────────────────────────────────────

let workspacePath: string;

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
    return {
        id: 'test-job-1',
        name: 'Test Job',
        schedule: { type: 'every', intervalMin: 60 },
        prompt: 'Do something',
        enabled: true,
        timezone: 'Asia/Tokyo',
        createdAt: '2026-02-24T00:00:00Z',
        nextRunAt: '2026-02-24T09:00:00Z',
        ...overrides,
    };
}

beforeEach(() => {
    workspacePath = join(tmpdir(), `geminiclaw-test-${Date.now()}`);
    mkdirSync(join(workspacePath, 'cron'), { recursive: true });
});

afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
});

// ── loadJobs / saveJobs ─────────────────────────────────────────

describe('loadJobs / saveJobs', () => {
    it('returns empty array when file does not exist', () => {
        const emptyWs = join(tmpdir(), `geminiclaw-empty-${Date.now()}`);
        expect(loadJobs(emptyWs)).toEqual([]);
    });

    it('round-trips jobs through save and load', () => {
        const jobs = [makeJob(), makeJob({ id: 'test-job-2', name: 'Second Job' })];
        saveJobs(workspacePath, jobs);
        const loaded = loadJobs(workspacePath);
        expect(loaded).toHaveLength(2);
        expect(loaded[0].id).toBe('test-job-1');
        expect(loaded[1].id).toBe('test-job-2');
    });

    it('creates directory if it does not exist', () => {
        const newWs = join(tmpdir(), `geminiclaw-new-${Date.now()}`);
        saveJobs(newWs, [makeJob()]);
        expect(existsSync(join(newWs, 'cron', 'jobs.json'))).toBe(true);
        rmSync(newWs, { recursive: true, force: true });
    });
});

// ── findDueJobs ─────────────────────────────────────────────────

describe('findDueJobs', () => {
    it('returns jobs whose nextRunAt is at or before now', () => {
        const now = new Date('2026-02-24T10:00:00Z');
        const jobs = [
            makeJob({ id: 'past', nextRunAt: '2026-02-24T09:00:00Z' }),
            makeJob({ id: 'future', nextRunAt: '2026-02-24T11:00:00Z' }),
            makeJob({ id: 'exact', nextRunAt: '2026-02-24T10:00:00Z' }),
        ];
        const due = findDueJobs(jobs, now);
        expect(due.map((j) => j.id)).toEqual(['past', 'exact']);
    });

    it('excludes disabled jobs', () => {
        const now = new Date('2026-02-24T10:00:00Z');
        const jobs = [makeJob({ enabled: false, nextRunAt: '2026-02-24T09:00:00Z' })];
        expect(findDueJobs(jobs, now)).toEqual([]);
    });

    it('excludes jobs without nextRunAt', () => {
        const now = new Date('2026-02-24T10:00:00Z');
        const jobs = [makeJob({ nextRunAt: undefined })];
        expect(findDueJobs(jobs, now)).toEqual([]);
    });
});

// ── advanceNextRun ──────────────────────────────────────────────

describe('advanceNextRun', () => {
    it('marks one-shot "at" jobs as disabled (caller deletes from store)', () => {
        const job = makeJob({ schedule: { type: 'at', datetime: '2026-02-24T09:00:00+09:00' } });
        const now = new Date('2026-02-24T09:01:00Z');
        advanceNextRun(job, now);
        expect(job.enabled).toBe(false);
        expect(job.nextRunAt).toBeUndefined();
        expect(job.lastRunAt).toBe(now.toISOString());
    });

    it('advances "every" jobs by intervalMin', () => {
        const job = makeJob({ schedule: { type: 'every', intervalMin: 30 } });
        const now = new Date('2026-02-24T10:00:00Z');
        advanceNextRun(job, now);
        expect(job.nextRunAt).toBe('2026-02-24T10:30:00.000Z');
        expect(job.lastRunAt).toBe(now.toISOString());
    });

    it('advances "cron" jobs to next occurrence', () => {
        const job = makeJob({ schedule: { type: 'cron', expression: '0 9 * * *' }, timezone: 'UTC' });
        const now = new Date('2026-02-24T09:00:00Z');
        advanceNextRun(job, now, 'UTC');
        expect(job.nextRunAt).toBeDefined();
        const next = new Date(job.nextRunAt as string);
        // Next 09:00 UTC should be tomorrow
        expect(next.getTime()).toBeGreaterThan(now.getTime());
        expect(next.getUTCHours()).toBe(9);
        expect(next.getUTCMinutes()).toBe(0);
    });

    it('uses fallback timezone for cron when job has no timezone', () => {
        const job = makeJob({
            schedule: { type: 'cron', expression: '0 9 * * *' },
            timezone: undefined,
        });
        const now = new Date('2026-02-24T09:00:00Z');
        advanceNextRun(job, now, 'UTC');
        expect(job.nextRunAt).toBeDefined();
    });
});

// ── computeInitialNextRun ───────────────────────────────────────

describe('computeInitialNextRun', () => {
    it('sets nextRunAt to datetime for "at" schedule', () => {
        const job = makeJob({
            schedule: { type: 'at', datetime: '2026-03-01T09:00:00+09:00' },
            nextRunAt: undefined,
        });
        computeInitialNextRun(job, new Date());
        expect(job.nextRunAt).toBe('2026-03-01T09:00:00+09:00');
    });

    it('sets nextRunAt to now + interval for "every" schedule', () => {
        const now = new Date('2026-02-24T10:00:00Z');
        const job = makeJob({
            schedule: { type: 'every', intervalMin: 15 },
            nextRunAt: undefined,
        });
        computeInitialNextRun(job, now);
        expect(job.nextRunAt).toBe('2026-02-24T10:15:00.000Z');
    });

    it('computes next cron occurrence for "cron" schedule', () => {
        const now = new Date('2026-02-24T08:00:00Z');
        const job = makeJob({
            schedule: { type: 'cron', expression: '0 9 * * *' },
            timezone: 'UTC',
            nextRunAt: undefined,
        });
        computeInitialNextRun(job, now, 'UTC');
        expect(job.nextRunAt).toBeDefined();
        const next = new Date(job.nextRunAt as string);
        expect(next.getUTCHours()).toBe(9);
    });
});

// ── CRUD helpers ────────────────────────────────────────────────

describe('CRUD helpers', () => {
    it('addJob appends to the list', () => {
        addJob(workspacePath, makeJob());
        addJob(workspacePath, makeJob({ id: 'test-job-2' }));
        const jobs = listJobs(workspacePath);
        expect(jobs).toHaveLength(2);
    });

    it('removeJob removes by ID', () => {
        addJob(workspacePath, makeJob({ id: 'keep' }));
        addJob(workspacePath, makeJob({ id: 'remove' }));
        const removed = removeJob(workspacePath, 'remove');
        expect(removed).toBe(true);
        expect(listJobs(workspacePath)).toHaveLength(1);
        expect(listJobs(workspacePath)[0].id).toBe('keep');
    });

    it('removeJob returns false for unknown ID', () => {
        addJob(workspacePath, makeJob());
        expect(removeJob(workspacePath, 'nonexistent')).toBe(false);
    });

    it('editJob patches fields in-place', () => {
        addJob(workspacePath, makeJob({ id: 'edit-me', name: 'Original' }));
        const updated = editJob(workspacePath, 'edit-me', { name: 'Updated', model: 'gemini-2.5-flash' });
        expect(updated).not.toBeNull();
        expect(updated?.name).toBe('Updated');
        expect(updated?.model).toBe('gemini-2.5-flash');
        expect(updated?.id).toBe('edit-me'); // id is immutable

        const loaded = listJobs(workspacePath);
        expect(loaded[0].name).toBe('Updated');
    });

    it('editJob returns null for unknown ID', () => {
        expect(editJob(workspacePath, 'nope', { name: 'X' })).toBeNull();
    });
});

// ── Run log ────────────────────────────────────────────────────

describe('run log', () => {
    it('appends and loads run entries', () => {
        appendRunLog(workspacePath, 'job-1', { timestamp: '2026-03-01T09:00:00Z', status: 'dispatched' });
        appendRunLog(workspacePath, 'job-1', { timestamp: '2026-03-01T10:00:00Z', status: 'dispatched' });
        const entries = loadRunLog(workspacePath, 'job-1');
        expect(entries).toHaveLength(2);
        expect(entries[0].status).toBe('dispatched');
        expect(entries[1].timestamp).toBe('2026-03-01T10:00:00Z');
    });

    it('respects limit parameter', () => {
        for (let i = 0; i < 5; i++) {
            appendRunLog(workspacePath, 'job-2', { timestamp: `2026-03-0${i + 1}T09:00:00Z`, status: 'dispatched' });
        }
        const entries = loadRunLog(workspacePath, 'job-2', 3);
        expect(entries).toHaveLength(3);
        expect(entries[0].timestamp).toBe('2026-03-03T09:00:00Z');
    });

    it('returns empty array for unknown job', () => {
        expect(loadRunLog(workspacePath, 'nonexistent')).toEqual([]);
    });

    it('pruneRunLog trims to max lines', () => {
        for (let i = 0; i < 510; i++) {
            appendRunLog(workspacePath, 'job-big', {
                timestamp: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`,
                status: 'dispatched',
            });
        }
        expect(loadRunLog(workspacePath, 'job-big')).toHaveLength(510);
        pruneRunLog(workspacePath, 'job-big');
        const after = loadRunLog(workspacePath, 'job-big');
        expect(after).toHaveLength(500);
        // Should keep the newest entries
        expect(after[0].timestamp).toContain('10');
    });
});

// ── Session retention ──────────────────────────────────────────

describe('pruneCronSessions', () => {
    it('deletes cron session files older than retention', () => {
        const sessionsDir = join(workspacePath, 'memory', 'sessions');
        mkdirSync(sessionsDir, { recursive: true });

        // Old session (7 days ago)
        const oldTs = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
        writeFileSync(join(sessionsDir, 'cron:old-job.jsonl'), `${JSON.stringify({ timestamp: oldTs })}\n`);

        // Fresh session (1 hour ago)
        const freshTs = new Date(Date.now() - 3600_000).toISOString();
        writeFileSync(join(sessionsDir, 'cron:new-job.jsonl'), `${JSON.stringify({ timestamp: freshTs })}\n`);

        // Non-cron session (should be ignored)
        writeFileSync(join(sessionsDir, 'discord:abc.jsonl'), `${JSON.stringify({ timestamp: oldTs })}\n`);

        const pruned = pruneCronSessions(sessionsDir, 72);
        expect(pruned).toBe(1);
        expect(existsSync(join(sessionsDir, 'cron:old-job.jsonl'))).toBe(false);
        expect(existsSync(join(sessionsDir, 'cron:new-job.jsonl'))).toBe(true);
        expect(existsSync(join(sessionsDir, 'discord:abc.jsonl'))).toBe(true);
    });

    it('returns 0 when sessions dir does not exist', () => {
        expect(pruneCronSessions(join(workspacePath, 'nonexistent'), 72)).toBe(0);
    });
});
