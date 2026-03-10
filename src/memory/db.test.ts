/**
 * memory/db.test.ts — Tests for SQLite usage tracking database.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageDB, type UsageRecord } from './db.js';

describe('UsageDB', () => {
    let tmpDir: string;
    let db: UsageDB;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'geminiclaw-db-test-'));
        db = new UsageDB(join(tmpDir, 'memory', 'memory.db'));
    });

    afterEach(() => {
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('usage tracking', () => {
        const sampleUsage: Omit<UsageRecord, 'id'> = {
            runId: 'run-123',
            timestamp: '2026-02-22T10:00:00Z',
            model: 'gemini-2.5-flash',
            trigger: 'heartbeat',
            inputTokens: 1000,
            outputTokens: 500,
            thinkingTokens: 0,
            cachedTokens: 200,
            totalTokens: 1500,
            durationMs: 3000,
            costEstimate: 0.000225,
        };

        it('saves and summarizes usage with token breakdown', () => {
            db.saveUsage(sampleUsage);
            db.saveUsage({ ...sampleUsage, runId: 'run-456', model: 'gemini-2.5-pro', costEstimate: 0.001875 });

            const summary = db.getUsageSummary();
            expect(summary.totalRuns).toBe(2);
            expect(summary.totalTokens).toBe(3000);
            expect(summary.totalInputTokens).toBe(2000);
            expect(summary.totalOutputTokens).toBe(1000);
            expect(summary.totalCachedTokens).toBe(400);
            expect(summary.byModel['gemini-2.5-flash'].runs).toBe(1);
            expect(summary.byModel['gemini-2.5-flash'].inputTokens).toBe(1000);
            expect(summary.byModel['gemini-2.5-flash'].outputTokens).toBe(500);
            expect(summary.byModel['gemini-2.5-pro'].runs).toBe(1);
        });

        it('filters by date', () => {
            db.saveUsage({ ...sampleUsage, timestamp: '2026-02-20T10:00:00Z' });
            db.saveUsage({ ...sampleUsage, runId: 'run-new', timestamp: '2026-02-22T10:00:00Z' });

            const summary = db.getUsageSummary('2026-02-21T00:00:00Z');
            expect(summary.totalRuns).toBe(1);
        });

        it('returns zero summary when empty', () => {
            const summary = db.getUsageSummary();
            expect(summary.totalRuns).toBe(0);
            expect(summary.totalTokens).toBe(0);
            expect(summary.totalInputTokens).toBe(0);
            expect(summary.totalOutputTokens).toBe(0);
            expect(summary.totalCachedTokens).toBe(0);
            expect(summary.totalCost).toBe(0);
            expect(Object.keys(summary.byModel)).toHaveLength(0);
        });
    });
});
