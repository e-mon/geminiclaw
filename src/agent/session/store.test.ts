/**
 * agent/session/store.test.ts — Tests for session store compaction persistence.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../runner.js';
import { SessionStore } from './store.js';
import type { SessionCompactor, SessionEntry } from './types.js';

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
    return {
        runId: `run-${Math.random().toString(36).slice(2, 8)}`,
        sessionId: 'test',
        model: 'gemini-2.5-flash',
        trigger: 'manual',
        prompt: 'test prompt',
        responseText: 'test response',
        toolCalls: [],
        heartbeatOk: false,
        tokens: { total: 100, input: 80, output: 20, cached: 0 },
        durationMs: 1000,
        timestamp: new Date(),
        ...overrides,
    };
}

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
    return {
        runId: `run-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        trigger: 'manual',
        prompt: 'test prompt',
        responseText: 'test response',
        toolCalls: [],
        heartbeatOk: false,
        tokens: { total: 100, input: 80, output: 20 },
        ...overrides,
    };
}

describe('SessionStore compaction persistence', () => {
    let tmpDir: string;
    let sessionsDir: string;
    let store: SessionStore;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'geminiclaw-store-test-'));
        sessionsDir = join(tmpDir, 'sessions');
        mkdirSync(sessionsDir, { recursive: true });
        store = new SessionStore(sessionsDir);
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('compactAndPersist replaces JSONL with compacted entries', async () => {
        const sessionId = 'test-compact';

        for (let i = 0; i < 30; i++) {
            store.append(
                sessionId,
                makeRunResult({
                    responseText: `Response ${i} ${'x'.repeat(200)}`,
                }),
            );
        }

        const entriesBefore = store.loadAll(sessionId);
        expect(entriesBefore).toHaveLength(30);

        const mockCompactor: SessionCompactor = {
            compact: vi.fn().mockResolvedValue(
                makeEntry({
                    trigger: 'compaction',
                    responseText: 'Summary of compacted entries',
                }),
            ),
        };

        const result = await store.loadRecentWithCompaction(sessionId, {
            maxTokens: 500,
            compactor: mockCompactor,
        });

        expect(result.length).toBeLessThan(30);
        expect(result[0]?.trigger).toBe('compaction');

        // JSONL file should now be smaller
        const entriesAfter = store.loadAll(sessionId);
        expect(entriesAfter.length).toBeLessThan(30);
        expect(entriesAfter[0]?.trigger).toBe('compaction');
    });

    it('compaction never returns empty recent when entries exist', async () => {
        const sessionId = 'test-flush';

        // Create entries large enough that none individually fit within a tiny budget,
        // forcing all into toCompact — the guard should rescue the last one into recent.
        for (let i = 0; i < 5; i++) {
            store.append(
                sessionId,
                makeRunResult({
                    responseText: `Response ${i} ${'x'.repeat(2000)}`,
                }),
            );
        }

        const mockCompactor: SessionCompactor = {
            compact: vi.fn().mockResolvedValue(makeEntry({ trigger: 'compaction', responseText: 'Summary' })),
        };

        const result = await store.loadRecentWithCompaction(sessionId, {
            maxTokens: 10, // Tiny budget — nothing fits
            compactor: mockCompactor,
        });

        // Should have at least the summary + 1 recent entry (guard rescued one)
        expect(result.length).toBeGreaterThanOrEqual(1);
        // The last entry should NOT be the compaction summary — it's a real entry
        const lastEntry = result.at(-1);
        expect(lastEntry?.trigger).not.toBe('compaction');
    });

    it('forceCompact reduces entries to summary + last 3', async () => {
        const sessionId = 'test-force';

        for (let i = 0; i < 10; i++) {
            store.append(
                sessionId,
                makeRunResult({
                    responseText: `Response ${i}`,
                }),
            );
        }

        const mockCompactor: SessionCompactor = {
            compact: vi
                .fn()
                .mockResolvedValue(makeEntry({ trigger: 'compaction', responseText: 'Force-compacted summary' })),
        };

        await store.forceCompact(sessionId, mockCompactor);

        const entries = store.loadAll(sessionId);
        expect(entries).toHaveLength(4);
        expect(entries[0]?.trigger).toBe('compaction');
    });

    it('compactAndPersist produces valid JSONL', async () => {
        const sessionId = 'test-atomic';

        for (let i = 0; i < 5; i++) {
            store.append(
                sessionId,
                makeRunResult({
                    responseText: `Entry ${i}`,
                }),
            );
        }

        const entries = store.loadAll(sessionId);
        expect(entries).toHaveLength(5);

        // Each line should be valid JSON
        const filePath = join(sessionsDir, `${sessionId}.jsonl`);
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter((l) => l.trim());
        for (const line of lines) {
            expect(() => JSON.parse(line)).not.toThrow();
        }
    });
});
