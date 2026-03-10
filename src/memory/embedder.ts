/**
 * memory/embedder.ts — Embedding backend abstraction for hybrid memory search.
 *
 * Defines a common Embedder interface so the TypeScript call site is
 * identical regardless of whether embeddings come from the local
 * embed-server or the Jina AI API.
 *
 * Backends:
 *   - LocalEmbedder : Local HTTP server (embed-server/server.py) — default, auto-started
 *   - JinaEmbedder  : Jina AI REST API (api.jina.ai), free tier 1M tokens/month
 *   - When backend is 'none', createEmbedder() returns null (FTS5-only fallback)
 */

// ── Interface ─────────────────────────────────────────────────────

export interface Embedder {
    /** Fixed output dimension (must match the vec0 table schema). */
    readonly dimensions: number;
    /** Model identifier for tracking and mismatch detection. */
    readonly model: string;
    /**
     * Embed a single text string and return a float vector.
     *
     * @throws {Error} On API/network errors — callers should handle gracefully.
     */
    embed(text: string, task?: EmbedTask): Promise<number[]>;
}

/**
 * Task hint for Jina v5 task-specific adapters.
 * v5 uses asymmetric retrieval — pass 'retrieval.passage' when embedding
 * documents to store, and 'retrieval.query' when embedding search queries.
 */
export type EmbedTask = 'retrieval.query' | 'retrieval.passage' | 'text-matching' | 'clustering' | 'classification';

// ── Jina AI API backend ───────────────────────────────────────────

interface JinaEmbedResponse {
    data: Array<{ embedding: number[] }>;
    usage: { total_tokens: number };
}

export class JinaEmbedder implements Embedder {
    readonly dimensions = 1024;
    readonly model = 'jina-embeddings-v5-text-small';

    constructor(private readonly apiKey: string) {}

    async embed(text: string, task: EmbedTask = 'retrieval.passage'): Promise<number[]> {
        const response = await fetch('https://api.jina.ai/v1/embeddings', {
            method: 'POST',
            signal: AbortSignal.timeout(15_000),
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                task,
                input: [{ text }],
            }),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Jina API error ${response.status}: ${body}`);
        }

        const json = (await response.json()) as JinaEmbedResponse;
        const embedding = json.data[0]?.embedding;
        if (!embedding || embedding.length === 0) {
            throw new Error('Jina API returned empty embedding');
        }
        return embedding;
    }
}

// ── Local HTTP sidecar backend ────────────────────────────────────
//
// Used by embed-server/server.py (FastAPI).
// The server exposes POST /embed with the same JSON contract as Jina's API
// so this client is backend-agnostic (MLX, transformers+MPS, GGUF, etc.).

interface LocalEmbedResponse {
    embedding: number[];
    dimensions: number;
}

export class LocalEmbedder implements Embedder {
    readonly dimensions: number;
    readonly model: string;

    constructor(
        private readonly url: string,
        dimensions: number = 768,
        model: string = 'local',
    ) {
        this.dimensions = dimensions;
        this.model = model;
    }

    async embed(text: string, task: EmbedTask = 'retrieval.passage'): Promise<number[]> {
        const response = await fetch(`${this.url}/embed`, {
            method: 'POST',
            signal: AbortSignal.timeout(15_000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, task }),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Local embedder error ${response.status}: ${body}`);
        }

        const json = (await response.json()) as LocalEmbedResponse;
        if (!json.embedding || json.embedding.length === 0) {
            throw new Error('Local embedder returned empty embedding');
        }
        return json.embedding;
    }
}

// ── Fallback Chain ───────────────────────────────────────────────

/**
 * Tries multiple embedding backends in order, falling back to the next
 * on failure. All backends must share the same dimensions.
 */
export class FallbackEmbedder implements Embedder {
    readonly dimensions: number;

    constructor(private readonly backends: Embedder[]) {
        if (backends.length === 0) {
            throw new Error('FallbackEmbedder requires at least one backend');
        }
        this.dimensions = backends[0]?.dimensions;
    }

    get model(): string {
        return this.backends[0]?.model ?? 'fallback';
    }

    async embed(text: string, task?: EmbedTask): Promise<number[]> {
        let lastError: Error | undefined;
        for (const backend of this.backends) {
            try {
                return await backend.embed(text, task);
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                process.stderr.write(
                    `[geminiclaw-memory] ${backend.constructor.name} failed, trying next: ${lastError.message}\n`,
                );
            }
        }
        throw lastError ?? new Error('All embedding backends failed');
    }
}

// ── Factory ───────────────────────────────────────────────────────

import type { EmbeddingConfig } from '../config.js';

/**
 * Construct an Embedder from config (defaults to LocalEmbedder).
 * Returns null only when backend is explicitly set to 'none'.
 */
export function createEmbedder(cfg: EmbeddingConfig): Embedder | null {
    return createPrimaryEmbedder(cfg);
}

function createPrimaryEmbedder(cfg: EmbeddingConfig): Embedder | null {
    if (cfg.backend === 'local') {
        const url = cfg.localUrl ?? 'http://localhost:11435';
        const dims = cfg.dimensions ?? 768;
        return new LocalEmbedder(url, dims, cfg.model);
    }

    if (cfg.backend === 'jina-api') {
        const key = cfg.jinaApiKey ?? process.env.JINA_API_KEY;
        if (!key) {
            throw new Error(
                'embedding.backend is "jina-api" but no API key found. ' +
                    'Set embedding.jinaApiKey in config or JINA_API_KEY env var.',
            );
        }
        return new JinaEmbedder(key);
    }

    // backend === 'none'
    return null;
}

/**
 * Best-effort embed: returns null on failure instead of throwing.
 * Use this when embedding is optional (e.g. during indexing/search).
 */
export async function tryEmbed(embedder: Embedder, text: string, task?: EmbedTask): Promise<number[] | null> {
    try {
        return await embedder.embed(text, task);
    } catch (err) {
        process.stderr.write(`[geminiclaw-memory] embedding failed, falling back to FTS5: ${String(err)}\n`);
        return null;
    }
}
