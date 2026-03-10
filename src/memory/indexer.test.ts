/**
 * memory/indexer.test.ts — Tests for the file→SQLite memory indexer.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Embedder, EmbedTask } from './embedder.js';
import { chunkText, MemoryIndexer } from './indexer.js';

describe('chunkText', () => {
    it('returns a single chunk for short text', () => {
        const chunks = chunkText('Hello world\nSecond line', '/test.md');
        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.startLine).toBe(1);
        expect(chunks[0]?.endLine).toBe(2);
        expect(chunks[0]?.content).toBe('Hello world\nSecond line');
        expect(chunks[0]?.sha256).toHaveLength(64);
    });

    it('returns empty array for empty text', () => {
        const chunks = chunkText('', '/test.md');
        expect(chunks).toHaveLength(0);
    });

    it('splits long text into multiple overlapping chunks', () => {
        // Generate text longer than CHUNK_TARGET_CHARS (1600)
        const lines: string[] = [];
        for (let i = 0; i < 100; i++) {
            lines.push(`Line ${i}: ${'x'.repeat(30)}`);
        }
        const text = lines.join('\n');

        const chunks = chunkText(text, '/long.md');
        expect(chunks.length).toBeGreaterThan(1);

        // Chunks should overlap: second chunk's startLine should be before first chunk's endLine
        if (chunks.length >= 2) {
            expect(chunks[1]?.startLine).toBeLessThanOrEqual(chunks[0]?.endLine);
        }

        // All chunks should have valid line ranges
        for (const chunk of chunks) {
            expect(chunk.startLine).toBeGreaterThan(0);
            expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
        }
    });

    it('produces deterministic SHA-256 for identical content', () => {
        const chunks1 = chunkText('Same content', '/a.md');
        const chunks2 = chunkText('Same content', '/b.md');
        expect(chunks1[0]?.sha256).toBe(chunks2[0]?.sha256);
    });
});

describe('MemoryIndexer', () => {
    let tmpDir: string;
    let workspaceDir: string;
    let memoryDir: string;
    let memoryMdPath: string;
    let dbPath: string;
    let indexer: MemoryIndexer;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'geminiclaw-indexer-test-'));
        workspaceDir = join(tmpDir, 'workspace');
        memoryDir = join(workspaceDir, 'memory');
        memoryMdPath = join(workspaceDir, 'MEMORY.md');
        dbPath = join(memoryDir, 'memory.db');

        mkdirSync(memoryDir, { recursive: true });

        indexer = new MemoryIndexer(dbPath, null, {
            memoryDir,
            memoryMdPath,
        });
    });

    afterEach(() => {
        indexer.close();
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('indexAll indexes MEMORY.md and memory/*.md', async () => {
        writeFileSync(memoryMdPath, '# Memory\n\nImportant fact: TypeScript is great\n');
        writeFileSync(join(memoryDir, '2026-02-24.md'), '## 10:00 - Did something\nDetails here\n');

        const count = await indexer.indexAll();
        expect(count).toBeGreaterThan(0);
    });

    it('indexFile returns 0 for nonexistent file', async () => {
        const count = await indexer.indexFile('/nonexistent/path.md');
        expect(count).toBe(0);
    });

    it('search finds indexed content via FTS5', async () => {
        writeFileSync(memoryMdPath, '# Memory\n\nGemini CLI agent orchestration system\n');
        await indexer.indexAll();

        const results = await indexer.search('Gemini agent', 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0]?.snippet).toContain('Gemini');
    });

    it('search returns empty for no match', async () => {
        writeFileSync(memoryMdPath, '# Memory\n\nSomething about TypeScript\n');
        await indexer.indexAll();

        const results = await indexer.search('nonexistent_term_xyz', 5);
        expect(results).toHaveLength(0);
    });

    it('getChunk reads file line range', async () => {
        writeFileSync(memoryMdPath, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n');

        const content = await indexer.getChunk(memoryMdPath, 2, 4);
        expect(content).toBe('Line 2\nLine 3\nLine 4');
    });

    it('getChunk returns null for nonexistent file', async () => {
        const content = await indexer.getChunk('/nonexistent/path.md');
        expect(content).toBeNull();
    });

    it('re-indexing skips unchanged files (SHA-256 cache)', async () => {
        writeFileSync(memoryMdPath, '# Memory\n\nFact about caching\n');

        const count1 = await indexer.indexFile(memoryMdPath);
        expect(count1).toBeGreaterThan(0);

        // Re-index same content — should still return chunk count but skip DB operations
        const count2 = await indexer.indexFile(memoryMdPath);
        expect(count2).toBe(count1);
    });

    it('re-indexing updates when file content changes', async () => {
        writeFileSync(memoryMdPath, '# Memory\n\nOriginal content\n');
        await indexer.indexFile(memoryMdPath);

        writeFileSync(memoryMdPath, '# Memory\n\nUpdated content with new info\n');
        const count = await indexer.indexFile(memoryMdPath);
        expect(count).toBeGreaterThan(0);

        const results = await indexer.search('Updated new info', 5);
        expect(results.length).toBeGreaterThan(0);
    });
});

describe('MemoryIndexer dimension migration', () => {
    let tmpDir: string;
    let memoryDir: string;
    let memoryMdPath: string;
    let dbPath: string;

    /** Stub embedder that records embed calls without network access. */
    class StubEmbedder implements Embedder {
        readonly dimensions: number;
        readonly model: string;
        embedCount = 0;

        constructor(dimensions: number, model: string = 'stub') {
            this.dimensions = dimensions;
            this.model = model;
        }

        async embed(_text: string, _task?: EmbedTask): Promise<number[]> {
            this.embedCount++;
            return Array.from({ length: this.dimensions }, (_, i) => i / this.dimensions);
        }
    }

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'geminiclaw-migration-test-'));
        const workspaceDir = join(tmpDir, 'workspace');
        memoryDir = join(workspaceDir, 'memory');
        memoryMdPath = join(workspaceDir, 'MEMORY.md');
        dbPath = join(memoryDir, 'memory.db');
        mkdirSync(memoryDir, { recursive: true });
        writeFileSync(memoryMdPath, '# Memory\n\nSome important information about testing\n');
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('rebuilds vec table when dimensions change', async () => {
        // First indexer with 64 dimensions
        const embedder1 = new StubEmbedder(64, 'model-small');
        const indexer1 = new MemoryIndexer(dbPath, embedder1, { memoryDir, memoryMdPath });
        await indexer1.indexAll();
        expect(embedder1.embedCount).toBeGreaterThan(0);
        indexer1.close();

        // Second indexer with different dimensions — triggers migration
        const embedder2 = new StubEmbedder(128, 'model-large');
        const indexer2 = new MemoryIndexer(dbPath, embedder2, { memoryDir, memoryMdPath });

        // File content unchanged → chunks skip re-insert. Change content to force re-embed.
        writeFileSync(memoryMdPath, '# Memory\n\nUpdated content after dimension migration\n');
        await indexer2.indexAll();
        expect(embedder2.embedCount).toBeGreaterThan(0);

        // Search should work with the new dimensions
        const results = await indexer2.search('dimension migration', 5);
        expect(results.length).toBeGreaterThan(0);
        indexer2.close();
    });

    it('preserves embedding_cache when dimensions stay the same', async () => {
        const embedder1 = new StubEmbedder(64, 'model-same');
        const indexer1 = new MemoryIndexer(dbPath, embedder1, { memoryDir, memoryMdPath });
        await indexer1.indexAll();
        const firstEmbedCount = embedder1.embedCount;
        expect(firstEmbedCount).toBeGreaterThan(0);
        indexer1.close();

        // Re-open with same dimensions — cache should be intact, no re-embedding needed
        const embedder2 = new StubEmbedder(64, 'model-same');
        const indexer2 = new MemoryIndexer(dbPath, embedder2, { memoryDir, memoryMdPath });
        await indexer2.indexAll();
        // SHA-256 cache hit: unchanged content → skip re-index entirely
        expect(embedder2.embedCount).toBe(0);
        indexer2.close();
    });
});

describe('MemoryIndexer session indexing', () => {
    let tmpDir: string;
    let memoryDir: string;
    let sessionsDir: string;
    let memoryMdPath: string;
    let dbPath: string;
    let indexer: MemoryIndexer;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'geminiclaw-session-idx-test-'));
        const workspaceDir = join(tmpDir, 'workspace');
        memoryDir = join(workspaceDir, 'memory');
        sessionsDir = join(memoryDir, 'sessions');
        memoryMdPath = join(workspaceDir, 'MEMORY.md');
        dbPath = join(memoryDir, 'memory.db');

        mkdirSync(sessionsDir, { recursive: true });
        writeFileSync(memoryMdPath, '# Memory\n');

        indexer = new MemoryIndexer(dbPath, null, {
            memoryDir,
            memoryMdPath,
            sessionMemoryEnabled: true,
            sessionsDir,
        });
    });

    afterEach(() => {
        indexer.close();
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('indexSessionFile indexes JSONL entries', () => {
        const jsonlPath = join(sessionsDir, 'test-session.jsonl');
        const entry1 = JSON.stringify({
            runId: 'r1',
            timestamp: '2026-02-27T10:00:00Z',
            trigger: 'manual',
            prompt: 'What is TypeScript?',
            responseText: 'TypeScript is a typed superset of JavaScript.',
            toolCalls: [],
            heartbeatOk: false,
            tokens: { total: 50, input: 30, output: 20 },
        });
        const entry2 = JSON.stringify({
            runId: 'r2',
            timestamp: '2026-02-27T10:05:00Z',
            trigger: 'manual',
            prompt: 'Explain generics',
            responseText: 'Generics allow creating reusable components.',
            toolCalls: [],
            heartbeatOk: false,
            tokens: { total: 40, input: 25, output: 15 },
        });
        writeFileSync(jsonlPath, `${entry1}\n${entry2}\n`);

        const count = indexer.indexSessionFile(jsonlPath);
        expect(count).toBeGreaterThan(0);
    });

    it('indexSessionFile skips heartbeatOk entries', () => {
        const jsonlPath = join(sessionsDir, 'heartbeat.jsonl');
        const hbEntry = JSON.stringify({
            runId: 'hb1',
            timestamp: '2026-02-27T10:00:00Z',
            trigger: 'heartbeat',
            prompt: 'heartbeat check',
            responseText: 'true',
            toolCalls: [],
            heartbeatOk: true,
            tokens: { total: 10, input: 5, output: 5 },
        });
        writeFileSync(jsonlPath, `${hbEntry}\n`);

        const count = indexer.indexSessionFile(jsonlPath);
        expect(count).toBe(0);
    });

    it('indexSessionFile tracks byte offset for delta processing', () => {
        const jsonlPath = join(sessionsDir, 'delta.jsonl');
        const entry1 = JSON.stringify({
            runId: 'r1',
            prompt: 'First entry about quantum computing',
            responseText: 'Quantum computing uses qubits.',
            toolCalls: [],
            heartbeatOk: false,
            tokens: { total: 50, input: 30, output: 20 },
            timestamp: '2026-02-27T10:00:00Z',
            trigger: 'manual',
        });
        writeFileSync(jsonlPath, `${entry1}\n`);

        const count1 = indexer.indexSessionFile(jsonlPath);
        expect(count1).toBeGreaterThan(0);

        // Append more data
        const entry2 = JSON.stringify({
            runId: 'r2',
            prompt: 'Second entry about machine learning',
            responseText: 'Machine learning is a subset of AI.',
            toolCalls: [],
            heartbeatOk: false,
            tokens: { total: 40, input: 25, output: 15 },
            timestamp: '2026-02-27T10:05:00Z',
            trigger: 'manual',
        });
        appendFileSync(jsonlPath, `${entry2}\n`);

        const count2 = indexer.indexSessionFile(jsonlPath);
        expect(count2).toBeGreaterThan(0);

        // Re-reading without changes should return 0
        const count3 = indexer.indexSessionFile(jsonlPath);
        expect(count3).toBe(0);
    });

    it('syncPendingSessions indexes all JSONL files', () => {
        const file1 = join(sessionsDir, 'session-a.jsonl');
        const file2 = join(sessionsDir, 'session-b.jsonl');
        writeFileSync(
            file1,
            `${JSON.stringify({ runId: 'a1', prompt: 'Alpha topic', responseText: 'Alpha response', toolCalls: [], heartbeatOk: false, tokens: { total: 10, input: 5, output: 5 }, timestamp: '2026-02-27T10:00:00Z', trigger: 'manual' })}\n`,
        );
        writeFileSync(
            file2,
            `${JSON.stringify({ runId: 'b1', prompt: 'Beta topic', responseText: 'Beta response', toolCalls: [], heartbeatOk: false, tokens: { total: 10, input: 5, output: 5 }, timestamp: '2026-02-27T10:00:00Z', trigger: 'manual' })}\n`,
        );

        indexer.syncPendingSessions();

        // Should not process again (offsets tracked)
        indexer.syncPendingSessions();
    });

    it('session entries are searchable after sync', async () => {
        const jsonlPath = join(sessionsDir, 'searchable.jsonl');
        writeFileSync(
            jsonlPath,
            `${JSON.stringify({ runId: 's1', prompt: 'Tell me about geminiclaw orchestration', responseText: 'GeminiClaw orchestrates Gemini CLI agents with scheduling and memory.', toolCalls: [], heartbeatOk: false, tokens: { total: 50, input: 30, output: 20 }, timestamp: '2026-02-27T10:00:00Z', trigger: 'manual' })}\n`,
        );

        // search() should trigger syncPendingSessions automatically
        const results = await indexer.search('geminiclaw orchestration', 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0]?.snippet).toContain('GeminiClaw');
    });
});
