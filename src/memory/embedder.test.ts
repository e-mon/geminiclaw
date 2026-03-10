/**
 * memory/embedder.test.ts — Unit tests for Embedder implementations.
 *
 * All HTTP calls are intercepted via vi.stubGlobal so no network access occurs.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmbedder, JinaEmbedder, LocalEmbedder, tryEmbed } from './embedder.js';

// ── fetch mock ────────────────────────────────────────────────────

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);
afterAll(() => vi.unstubAllGlobals());

const DIM = 1024;
const fakeEmbedding = Array.from({ length: DIM }, (_, i) => i / DIM);

function jinaOk(embedding: number[] = fakeEmbedding): Response {
    return new Response(JSON.stringify({ data: [{ embedding }], usage: { total_tokens: 5 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function localOk(embedding: number[] = fakeEmbedding): Response {
    return new Response(JSON.stringify({ embedding, dimensions: embedding.length }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function errResponse(status: number, body = 'error'): Response {
    return new Response(body, { status });
}

// ── createEmbedder ────────────────────────────────────────────────

describe('createEmbedder', () => {
    it('returns null for backend none', () => {
        const e = createEmbedder({ backend: 'none', localUrl: 'http://localhost:11435', dimensions: 1024 });
        expect(e).toBeNull();
    });

    it('returns JinaEmbedder when backend is jina-api with key', () => {
        const e = createEmbedder({ backend: 'jina-api', jinaApiKey: 'key-123', localUrl: '', dimensions: 1024 });
        expect(e).toBeInstanceOf(JinaEmbedder);
        expect(e?.dimensions).toBe(1024);
    });

    it('throws when backend is jina-api and no key is available', () => {
        const orig = process.env.JINA_API_KEY;
        delete process.env.JINA_API_KEY;
        expect(() => createEmbedder({ backend: 'jina-api', localUrl: '', dimensions: 1024 })).toThrow(/API key/);
        if (orig !== undefined) process.env.JINA_API_KEY = orig;
    });

    it('reads api key from JINA_API_KEY env when jinaApiKey omitted', () => {
        const orig = process.env.JINA_API_KEY;
        process.env.JINA_API_KEY = 'env-key';
        expect(() => createEmbedder({ backend: 'jina-api', localUrl: '', dimensions: 1024 })).not.toThrow();
        if (orig !== undefined) process.env.JINA_API_KEY = orig;
        else delete process.env.JINA_API_KEY;
    });

    it('returns LocalEmbedder with correct url and dimensions', () => {
        const e = createEmbedder({ backend: 'local', localUrl: 'http://localhost:9999', dimensions: 512 });
        expect(e).toBeInstanceOf(LocalEmbedder);
        expect(e?.dimensions).toBe(512);
    });

    it('LocalEmbedder falls back to default url and dims when omitted', () => {
        const e = createEmbedder({ backend: 'local', dimensions: 1024 });
        expect(e).toBeInstanceOf(LocalEmbedder);
        expect(e?.dimensions).toBe(1024);
    });

    it('defaults to local backend via schema default', async () => {
        // EmbeddingConfigSchema.parse({}) applies default backend='local'
        const { EmbeddingConfigSchema } = await import('../config/schema.js');
        const cfg = EmbeddingConfigSchema.parse({});
        const e = createEmbedder(cfg);
        expect(e).toBeInstanceOf(LocalEmbedder);
        expect(cfg.backend).toBe('local');
    });
});

// ── JinaEmbedder ─────────────────────────────────────────────────

describe('JinaEmbedder', () => {
    let embedder: JinaEmbedder;

    beforeEach(() => {
        embedder = new JinaEmbedder('test-api-key');
        mockFetch.mockReset();
    });

    it('has dimensions = 1024', () => {
        expect(embedder.dimensions).toBe(1024);
    });

    it('returns embedding array on success', async () => {
        mockFetch.mockResolvedValue(jinaOk());
        const result = await embedder.embed('hello world');
        expect(result).toHaveLength(DIM);
        expect(result[0]).toBeCloseTo(fakeEmbedding[0]);
    });

    it('calls the Jina API endpoint', async () => {
        mockFetch.mockResolvedValue(jinaOk());
        await embedder.embed('test');
        expect(mockFetch.mock.calls[0][0]).toBe('https://api.jina.ai/v1/embeddings');
    });

    it('sends correct model, task, and input in body', async () => {
        mockFetch.mockResolvedValue(jinaOk());
        await embedder.embed('doc text', 'retrieval.query');
        const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
        expect(body.model).toBe('jina-embeddings-v5-text-small');
        expect(body.task).toBe('retrieval.query');
        expect(body.input[0].text).toBe('doc text');
    });

    it('defaults task to retrieval.passage', async () => {
        mockFetch.mockResolvedValue(jinaOk());
        await embedder.embed('store this');
        const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
        expect(body.task).toBe('retrieval.passage');
    });

    it('sets Authorization header with Bearer token', async () => {
        mockFetch.mockResolvedValue(jinaOk());
        await embedder.embed('x');
        const headers = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer test-api-key');
    });

    it('includes AbortSignal for timeout', async () => {
        mockFetch.mockResolvedValue(jinaOk());
        await embedder.embed('x');
        expect(mockFetch.mock.calls[0][1]?.signal).toBeDefined();
    });

    it('throws on non-2xx response and includes status code', async () => {
        mockFetch.mockResolvedValue(errResponse(429, 'Rate limited'));
        await expect(embedder.embed('x')).rejects.toThrow('429');
    });

    it('throws when API returns empty embedding array', async () => {
        mockFetch.mockResolvedValue(
            new Response(JSON.stringify({ data: [{ embedding: [] }], usage: { total_tokens: 0 } }), { status: 200 }),
        );
        await expect(embedder.embed('x')).rejects.toThrow(/empty/);
    });

    it('throws when API returns missing data field', async () => {
        mockFetch.mockResolvedValue(
            new Response(JSON.stringify({ data: [], usage: { total_tokens: 0 } }), { status: 200 }),
        );
        await expect(embedder.embed('x')).rejects.toThrow(/empty/);
    });
});

// ── LocalEmbedder ─────────────────────────────────────────────────

describe('LocalEmbedder', () => {
    let embedder: LocalEmbedder;

    beforeEach(() => {
        embedder = new LocalEmbedder('http://localhost:11435', 1024);
        mockFetch.mockReset();
    });

    it('exposes dimensions from constructor', () => {
        expect(embedder.dimensions).toBe(1024);
        expect(new LocalEmbedder('http://localhost:11435', 512).dimensions).toBe(512);
    });

    it('returns embedding on success', async () => {
        mockFetch.mockResolvedValue(localOk());
        const result = await embedder.embed('hello');
        expect(result).toHaveLength(DIM);
    });

    it('calls POST /embed on the configured url', async () => {
        mockFetch.mockResolvedValue(localOk());
        await embedder.embed('test');
        expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:11435/embed');
        expect(mockFetch.mock.calls[0][1]?.method).toBe('POST');
    });

    it('sends text and task in request body', async () => {
        mockFetch.mockResolvedValue(localOk());
        await embedder.embed('doc', 'retrieval.passage');
        const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
        expect(body.text).toBe('doc');
        expect(body.task).toBe('retrieval.passage');
    });

    it('defaults task to retrieval.passage', async () => {
        mockFetch.mockResolvedValue(localOk());
        await embedder.embed('doc');
        const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
        expect(body.task).toBe('retrieval.passage');
    });

    it('includes AbortSignal for timeout', async () => {
        mockFetch.mockResolvedValue(localOk());
        await embedder.embed('x');
        expect(mockFetch.mock.calls[0][1]?.signal).toBeDefined();
    });

    it('throws on server error and includes status code', async () => {
        mockFetch.mockResolvedValue(errResponse(503, 'model not loaded'));
        await expect(embedder.embed('x')).rejects.toThrow('503');
    });

    it('throws when server returns empty embedding', async () => {
        mockFetch.mockResolvedValue(localOk([]));
        await expect(embedder.embed('x')).rejects.toThrow(/empty/);
    });
});

// ── tryEmbed ─────────────────────────────────────────────────────

describe('tryEmbed', () => {
    let embedder: JinaEmbedder;

    beforeEach(() => {
        embedder = new JinaEmbedder('key');
        mockFetch.mockReset();
    });

    it('returns the embedding on success', async () => {
        mockFetch.mockResolvedValue(jinaOk());
        const result = await tryEmbed(embedder, 'hello');
        expect(result).toHaveLength(DIM);
    });

    it('returns null instead of throwing on network error', async () => {
        mockFetch.mockRejectedValue(new Error('Network error'));
        const result = await tryEmbed(embedder, 'hello');
        expect(result).toBeNull();
    });

    it('returns null instead of throwing on API error', async () => {
        mockFetch.mockResolvedValue(errResponse(500, 'server error'));
        const result = await tryEmbed(embedder, 'hello');
        expect(result).toBeNull();
    });

    it('passes task through to the embedder', async () => {
        mockFetch.mockResolvedValue(jinaOk());
        await tryEmbed(embedder, 'test', 'retrieval.query');
        const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
        expect(body.task).toBe('retrieval.query');
    });
});
