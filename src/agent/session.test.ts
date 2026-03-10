/**
 * agent/session.test.ts — Tests for session module (store, flush, title).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from './runner.js';
import {
    buildFallbackTitle,
    type FlushDeps,
    parseSerializedThread,
    type SessionEntry,
    SessionStore,
    silentMemoryFlush,
} from './session/index.js';

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
    return {
        runId: 'run-123',
        sessionId: 'sess-1',
        model: 'gemini-2.5-flash',
        trigger: 'manual',
        toolCalls: [],
        responseText: 'Hello world',
        heartbeatOk: false,
        tokens: { total: 100, input: 60, output: 40, cached: 10 },
        durationMs: 1000,
        timestamp: new Date('2026-02-22T10:00:00Z'),
        ...overrides,
    };
}

describe('SessionStore', () => {
    let tmpDir: string;
    let store: SessionStore;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'geminiclaw-session-test-'));
        store = new SessionStore(join(tmpDir, 'sessions'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('append / loadAll', () => {
        it('appends and loads a single entry', () => {
            const result = makeRunResult();
            store.append('session-1', result);

            const entries = store.loadAll('session-1');
            expect(entries).toHaveLength(1);
            expect(entries[0].runId).toBe('run-123');
            expect(entries[0].responseText).toBe('Hello world');
        });

        it('appends multiple entries to the same session', () => {
            store.append('session-1', makeRunResult({ runId: 'run-1' }));
            store.append('session-1', makeRunResult({ runId: 'run-2' }));
            store.append('session-1', makeRunResult({ runId: 'run-3' }));

            const entries = store.loadAll('session-1');
            expect(entries).toHaveLength(3);
            expect(entries[0].runId).toBe('run-1');
            expect(entries[2].runId).toBe('run-3');
        });

        it('returns empty array for non-existent session', () => {
            expect(store.loadAll('nonexistent')).toEqual([]);
        });

        it('stores tool call details', () => {
            const result = makeRunResult({
                toolCalls: [
                    {
                        id: 'tool-1',
                        name: 'ReadFile',
                        args: { path: '/tmp/test' },
                        result: 'file content',
                        status: 'success',
                        startedAt: new Date(),
                    },
                ],
            });
            store.append('session-1', result);

            const entries = store.loadAll('session-1');
            expect(entries[0].toolCalls).toHaveLength(1);
            expect(entries[0].toolCalls[0].name).toBe('ReadFile');
            expect(entries[0].toolCalls[0].result).toBe('file content');
        });

        it('writes valid JSONL format', () => {
            store.append('session-1', makeRunResult({ runId: 'run-1' }));
            store.append('session-1', makeRunResult({ runId: 'run-2' }));

            const raw = readFileSync(join(tmpDir, 'sessions', 'session-1.jsonl'), 'utf-8');
            const lines = raw.trim().split('\n');
            expect(lines).toHaveLength(2);

            // Each line should be valid JSON
            for (const line of lines) {
                expect(() => JSON.parse(line)).not.toThrow();
            }
        });
    });

    describe('exists', () => {
        it('returns false for non-existent session', () => {
            expect(store.exists('nonexistent')).toBe(false);
        });

        it('returns true after append', () => {
            store.append('session-1', makeRunResult());
            expect(store.exists('session-1')).toBe(true);
        });
    });

    describe('toEntry', () => {
        it('strips internal fields from RunResult', () => {
            const result = makeRunResult();
            const entry = SessionStore.toEntry(result);

            expect(entry).not.toHaveProperty('sessionId');
            expect(entry.model).toBe(result.model);
            expect(entry).not.toHaveProperty('durationMs');
            expect(entry).not.toHaveProperty('costEstimate');
            expect(entry.runId).toBe('run-123');
            expect(entry.timestamp).toBe('2026-02-22T10:00:00.000Z');
        });

        it('preserves prompt from RunResult', () => {
            const result = makeRunResult({ prompt: 'Hello, what can you do?' });
            const entry = SessionStore.toEntry(result);
            expect(entry.prompt).toBe('Hello, what can you do?');
        });

        it('prompt is undefined when not set on RunResult', () => {
            const result = makeRunResult();
            const entry = SessionStore.toEntry(result);
            expect(entry.prompt).toBeUndefined();
        });

        it('includes title when present in RunResult', () => {
            const result = makeRunResult({ title: 'My Title' });
            const entry = SessionStore.toEntry(result);
            expect(entry.title).toBe('My Title');
        });

        it('omits title when not present in RunResult', () => {
            const result = makeRunResult();
            const entry = SessionStore.toEntry(result);
            expect(entry.title).toBeUndefined();
        });
    });
});

// ── Helpers ──────────────────────────────────────────────────────

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
    return {
        runId: 'run-1',
        timestamp: '2026-02-24T10:00:00.000Z',
        trigger: 'manual',
        prompt: 'Hello',
        responseText: 'Hi there',
        toolCalls: [],
        heartbeatOk: false,
        tokens: { total: 100, input: 60, output: 40 },
        ...overrides,
    };
}

// ── silentMemoryFlush ─────────────────────────────────────────────

describe('silentMemoryFlush', () => {
    function makeMockFlushDeps(): FlushDeps & { spawnFlushMock: ReturnType<typeof vi.fn> } {
        const spawnFlushMock = vi.fn().mockResolvedValue({ responseText: '', error: undefined });
        return {
            spawnFlush: spawnFlushMock,
            spawnFlushMock,
        };
    }

    it('does not call spawnFlush for empty entries', async () => {
        const deps = makeMockFlushDeps();
        await silentMemoryFlush([], '/tmp/workspace', 'gemini-2.5-flash', deps);
        expect(deps.spawnFlushMock).not.toHaveBeenCalled();
    });

    it('calls spawnFlush with correct args for non-empty entries', async () => {
        const deps = makeMockFlushDeps();
        await silentMemoryFlush([makeEntry()], '/tmp/workspace', 'gemini-2.5-flash', deps);
        expect(deps.spawnFlushMock).toHaveBeenCalledOnce();
        const [args, opts] = deps.spawnFlushMock.mock.calls[0];
        // Args now contain the prompt text (ACP-style, no CLI flags)
        expect(args).toHaveLength(1);
        expect(args[0]).toContain('memory archiving agent');
        expect(opts.cwd).toBe('/tmp/workspace');
        expect(opts.maxToolIterations).toBe(5);
    });

    it('does not throw when spawnFlush returns error', async () => {
        const deps = makeMockFlushDeps();
        deps.spawnFlushMock.mockResolvedValueOnce({
            responseText: '',
            error: 'something went wrong',
        });
        await expect(
            silentMemoryFlush([makeEntry()], '/tmp/workspace', 'gemini-2.5-flash', deps),
        ).resolves.toBeUndefined();
    });

    it('does not throw when spawnFlush rejects', async () => {
        const deps = makeMockFlushDeps();
        deps.spawnFlushMock.mockRejectedValueOnce(new Error('spawn failed'));
        await expect(
            silentMemoryFlush([makeEntry()], '/tmp/workspace', 'gemini-2.5-flash', deps),
        ).resolves.toBeUndefined();
    });
});

// ── Session Title ─────────────────────────────────────────────────

describe('buildFallbackTitle', () => {
    it('returns prompt as-is when short enough', () => {
        expect(buildFallbackTitle('Tell me about TypeScript')).toBe('Tell me about TypeScript');
    });

    it('strips channel prefix', () => {
        expect(buildFallbackTitle('[discord] Alice: What is Rust?')).toBe('What is Rust?');
    });

    it('truncates long prompt with ellipsis', () => {
        const longPrompt = 'A'.repeat(100);
        const title = buildFallbackTitle(longPrompt);
        expect(title.length).toBeLessThanOrEqual(30);
        expect(title).toContain('…');
    });

    it('handles slack prefix', () => {
        expect(buildFallbackTitle('[slack] Bob: Deploy to prod')).toBe('Deploy to prod');
    });
});

describe('parseSerializedThread', () => {
    it('parses discord thread with threadId', () => {
        const serialized = JSON.stringify({ id: 'discord:guild123:channel456:thread789' });
        const result = parseSerializedThread(serialized);
        expect(result.adapter).toBe('discord');
        expect(result.discordThreadId).toBe('thread789');
    });

    it('skips rename for discord channel without threadId', () => {
        const serialized = JSON.stringify({ id: 'discord:guild123:channel456' });
        const result = parseSerializedThread(serialized);
        expect(result.adapter).toBe('discord');
        expect(result.discordThreadId).toBeUndefined();
    });

    it('returns empty adapter for invalid JSON', () => {
        const result = parseSerializedThread('not-json');
        expect(result.adapter).toBe('');
        expect(result.discordThreadId).toBeUndefined();
    });

    it('returns no discordThreadId for slack', () => {
        const serialized = JSON.stringify({ id: 'slack:channel:thread' });
        const result = parseSerializedThread(serialized);
        expect(result.adapter).toBe('slack');
        expect(result.discordThreadId).toBeUndefined();
    });
});

describe('SessionStore title methods', () => {
    let tmpDir: string;
    let store: SessionStore;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'geminiclaw-title-test-'));
        store = new SessionStore(join(tmpDir, 'sessions'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('getTitle returns undefined when no title is set', () => {
        store.append('sess-1', makeRunResult());
        expect(store.getTitle('sess-1')).toBeUndefined();
    });

    it('setTitle persists title to dedicated file', () => {
        store.append('sess-1', makeRunResult({ runId: 'run-1' }));
        store.setTitle('sess-1', 'Test Title');

        expect(store.getTitle('sess-1')).toBe('Test Title');
    });

    it('getTitle survives entry truncation', () => {
        store.append('sess-1', makeRunResult({ runId: 'run-1' }));
        store.setTitle('sess-1', 'My Title');
        store.append('sess-1', makeRunResult({ runId: 'run-2' }));

        // Title is stored separately, not in JSONL entries
        expect(store.getTitle('sess-1')).toBe('My Title');
    });

    it('getTitle falls back to legacy title in JSONL entry', () => {
        // Simulate legacy data where title is embedded in entry
        store.append('sess-1', makeRunResult({ runId: 'run-1', title: 'Legacy Title' }));
        expect(store.getTitle('sess-1')).toBe('Legacy Title');
    });

    it('setTitle works even before any entries exist', () => {
        store.setTitle('new-sess', 'Early Title');
        expect(store.getTitle('new-sess')).toBe('Early Title');
    });
});
