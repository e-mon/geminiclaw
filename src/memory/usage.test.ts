/**
 * memory/usage.test.ts — Tests for usage tracking and cost calculation.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../agent/runner.js';
import { UsageDB } from './db.js';
import { estimateCost, UsageTracker } from './usage.js';

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
    return {
        runId: 'run-123',
        sessionId: 'sess-1',
        model: 'gemini-2.5-flash',
        trigger: 'manual',
        toolCalls: [],
        responseText: 'Hello',
        heartbeatOk: false,
        tokens: { total: 1500, input: 1000, output: 500, thinking: 0, cached: 200 },
        durationMs: 3000,
        timestamp: new Date('2026-02-22T10:00:00Z'),
        ...overrides,
    };
}

const DEFAULT_COST_TABLE = {
    'gemini-2.5-flash': 0.15,
    'gemini-2.5-pro': 1.25,
};

describe('estimateCost', () => {
    it('calculates cost with cached token discount', () => {
        const result = makeRunResult();
        // tokens: { input: 1000, output: 500, cached: 200 }
        // freshInput = 1000 - 200 = 800
        // cost = (800 + 500) / 1M * 0.15  +  200 / 1M * 0.15 * 0.1
        //      = 1300 / 1M * 0.15  +  200 / 1M * 0.015
        //      = 0.000195  +  0.000003 = 0.000198
        const cost = estimateCost(result, DEFAULT_COST_TABLE);
        expect(cost).toBeCloseTo(0.000198, 6);
    });

    it('uses pro model rate', () => {
        const result = makeRunResult({ model: 'gemini-2.5-pro' });
        // (800 + 500) / 1M * 1.25  +  200 / 1M * 1.25 * 0.1
        // = 0.001625  +  0.000025 = 0.00165
        const cost = estimateCost(result, DEFAULT_COST_TABLE);
        expect(cost).toBeCloseTo(0.00165, 6);
    });

    it('returns 0 for unknown model', () => {
        const result = makeRunResult({ model: 'unknown-model' });
        const cost = estimateCost(result, DEFAULT_COST_TABLE);
        expect(cost).toBe(0);
    });

    it('handles zero cached tokens', () => {
        const result = makeRunResult({ tokens: { total: 1500, input: 1000, output: 500, thinking: 0, cached: 0 } });
        // (1000 + 500) / 1M * 0.15 = 0.000225
        const cost = estimateCost(result, DEFAULT_COST_TABLE);
        expect(cost).toBeCloseTo(0.000225, 6);
    });

    it('handles mostly cached tokens (resume scenario)', () => {
        const result = makeRunResult({
            tokens: { total: 7_845_852, input: 7_817_338, output: 17_301, thinking: 0, cached: 6_502_658 },
        });
        // freshInput = 7_817_338 - 6_502_658 = 1_314_680
        // cost = (1_314_680 + 17_301) / 1M * 0.15  +  6_502_658 / 1M * 0.15 * 0.1
        //      = 0.199797  +  0.097540 = 0.297337
        const cost = estimateCost(result, DEFAULT_COST_TABLE);
        expect(cost).toBeCloseTo(0.2973, 4);
    });

    it('includes thinking tokens in cost', () => {
        const result = makeRunResult({
            tokens: { total: 2000, input: 1000, output: 500, thinking: 300, cached: 0 },
        });
        // (1000 + 500 + 300) / 1M * 0.15 = 0.00027
        const cost = estimateCost(result, DEFAULT_COST_TABLE);
        expect(cost).toBeCloseTo(0.00027, 6);
    });
});

describe('UsageTracker', () => {
    let tmpDir: string;
    let db: UsageDB;
    let tracker: UsageTracker;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'geminiclaw-usage-test-'));
        db = new UsageDB(join(tmpDir, 'memory.db'));
        tracker = new UsageTracker(db, DEFAULT_COST_TABLE);
    });

    afterEach(() => {
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('saves and retrieves usage with input/output breakdown', () => {
        tracker.saveRecord(makeRunResult());
        const summary = tracker.getSummary();

        expect(summary.totalRuns).toBe(1);
        expect(summary.totalTokens).toBe(1500);
        expect(summary.totalInputTokens).toBe(1000);
        expect(summary.totalOutputTokens).toBe(500);
        expect(summary.totalCachedTokens).toBe(200);
        expect(summary.totalCost).toBeCloseTo(0.000198, 6);
    });

    it('aggregates multiple runs with per-model token breakdown', () => {
        tracker.saveRecord(makeRunResult({ runId: 'run-1' }));
        tracker.saveRecord(makeRunResult({ runId: 'run-2', model: 'gemini-2.5-pro' }));

        const summary = tracker.getSummary();
        expect(summary.totalRuns).toBe(2);
        expect(summary.totalInputTokens).toBe(2000);
        expect(summary.totalOutputTokens).toBe(1000);
        expect(summary.totalCachedTokens).toBe(400);
        expect(summary.byModel['gemini-2.5-flash'].runs).toBe(1);
        expect(summary.byModel['gemini-2.5-flash'].inputTokens).toBe(1000);
        expect(summary.byModel['gemini-2.5-flash'].outputTokens).toBe(500);
        expect(summary.byModel['gemini-2.5-pro'].runs).toBe(1);
        expect(summary.byModel['gemini-2.5-pro'].inputTokens).toBe(1000);
        expect(summary.byModel['gemini-2.5-pro'].outputTokens).toBe(500);
    });

    it('formats summary with input/output breakdown', () => {
        tracker.saveRecord(makeRunResult());
        const summary = tracker.getSummary();
        const formatted = UsageTracker.formatSummary(summary, 'Today');

        expect(formatted).toContain('Today:');
        expect(formatted).toContain('Runs: 1');
        expect(formatted).toContain('in: 1,000');
        expect(formatted).toContain('out: 500');
        expect(formatted).toContain('cached: 200');
        expect(formatted).toContain('Est. Cost:');
        expect(formatted).toContain('gemini-2.5-flash');
    });

    it('returns empty summary when no records', () => {
        const summary = tracker.getSummary();
        const formatted = UsageTracker.formatSummary(summary);

        expect(formatted).toContain('Runs: 0');
    });
});
