/**
 * memory/indexer.ts — File→SQLite indexer for chunk-based memory search.
 *
 * Reads markdown files from the memory directory, splits them into
 * ~400-token chunks with 80-token overlap, and indexes them into
 * SQLite FTS5 + sqlite-vec. SHA-256 caching avoids re-embedding
 * unchanged chunks.
 *
 * Files are the source of truth. This indexer builds a search index
 * from them — the DB can be rebuilt at any time from the files.
 */

import { createHash } from 'node:crypto';
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { MemoryDB, type MemoryDBOptions } from './db.js';
import { type Embedder, tryEmbed } from './embedder.js';

// ── Constants ────────────────────────────────────────────────────

/** Approximate tokens per chunk (~400 tokens ≈ 1600 chars for English/mixed). */
const CHUNK_TARGET_CHARS = 1600;

/** Overlap between consecutive chunks (~80 tokens ≈ 320 chars). */
const CHUNK_OVERLAP_CHARS = 320;

// ── Types ────────────────────────────────────────────────────────

export interface Chunk {
    filePath: string;
    startLine: number;
    endLine: number;
    content: string;
    sha256: string;
}

export interface IndexerOptions extends MemoryDBOptions {
    /** Base directory for resolving relative file paths in search results. */
    memoryDir: string;
    /** Path to MEMORY.md (outside memory dir). */
    memoryMdPath: string;
    /** Enable session JSONL indexing (experimental.sessionMemory). */
    sessionMemoryEnabled?: boolean;
    /** Directory containing session JSONL files. Defaults to memoryDir/sessions. */
    sessionsDir?: string;
}

// ── MemoryIndexer ────────────────────────────────────────────────

export class MemoryIndexer {
    private readonly db: MemoryDB;
    private readonly embedder: Embedder | null;
    private readonly memoryDir: string;
    private readonly memoryMdPath: string;
    private readonly sessionMemoryEnabled: boolean;
    private readonly sessionsDir: string;
    private closed = false;

    constructor(dbPath: string, embedder: Embedder | null, options: IndexerOptions) {
        this.db = new MemoryDB(dbPath, {
            embeddingDimensions: embedder?.dimensions,
            embeddingModel: embedder?.model,
        });
        this.embedder = embedder;
        this.memoryDir = options.memoryDir;
        this.memoryMdPath = options.memoryMdPath;
        this.sessionMemoryEnabled = options.sessionMemoryEnabled ?? false;
        this.sessionsDir = options.sessionsDir ?? join(options.memoryDir, 'sessions');
    }

    /**
     * Re-index all memory files: MEMORY.md + memory/*.md.
     * Clears existing chunks for each file before re-indexing.
     */
    async indexAll(): Promise<number> {
        let totalChunks = 0;

        // Index MEMORY.md
        totalChunks += await this.indexFile(this.memoryMdPath);

        // Index all .md files in memory/
        const mdFiles = await this.listMarkdownFiles(this.memoryDir);
        for (const filePath of mdFiles) {
            totalChunks += await this.indexFile(filePath);
        }

        return totalChunks;
    }

    /**
     * Index a single file: chunk it, store in FTS + vec, skip unchanged chunks.
     * Returns the number of chunks indexed.
     */
    async indexFile(filePath: string): Promise<number> {
        let content: string;
        try {
            content = await readFile(filePath, 'utf-8');
        } catch {
            return 0;
        }

        if (!content.trim()) {
            this.db.deleteChunksByFile(filePath);
            return 0;
        }

        const chunks = chunkText(content, filePath);
        if (chunks.length === 0) return 0;

        // Check which chunks already exist (by SHA-256)
        const existingHashes = this.db.getFileChunkHashes(filePath);
        const newChunkHashes = new Set(chunks.map((c) => c.sha256));

        // If all chunk hashes match, skip re-indexing entirely
        if (existingHashes.size === newChunkHashes.size && [...newChunkHashes].every((h) => existingHashes.has(h))) {
            return chunks.length;
        }

        // File changed — delete old chunks and re-insert
        this.db.deleteChunksByFile(filePath);

        for (const chunk of chunks) {
            const id = this.db.insertChunk({
                filePath: chunk.filePath,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                content: chunk.content,
                sha256: chunk.sha256,
            });

            // Embed: check cache first, then call embedder
            if (this.embedder && this.db.vecEnabled) {
                let vec = this.db.getCachedEmbedding(chunk.sha256);
                if (!vec) {
                    vec = await tryEmbed(this.embedder, chunk.content, 'retrieval.passage');
                    if (vec) {
                        this.db.cacheEmbedding(chunk.sha256, vec);
                    }
                }
                if (vec) {
                    this.db.upsertChunkEmbedding(id, vec);
                }
            }
        }

        return chunks.length;
    }

    /**
     * Search indexed chunks using hybrid FTS5 + vec (or FTS5 fallback).
     * When session memory is enabled, syncs pending session JSONLs before searching.
     */
    async search(query: string, limit: number = 10): Promise<import('./db.js').SearchResult[]> {
        if (this.sessionMemoryEnabled) {
            this.syncPendingSessions();
            // Fire-and-forget: embed session chunks in the background
            void this.embedPendingSessionChunks();
        }

        if (this.embedder && this.db.vecEnabled) {
            const vec = await tryEmbed(this.embedder, query, 'retrieval.query');
            if (vec) {
                return this.db.searchHybrid(query, vec, limit);
            }
        }
        return this.db.searchFTS(query, limit);
    }

    /**
     * Read a range of lines from a file for the memory_get tool.
     */
    async getChunk(filePath: string, startLine?: number, endLine?: number): Promise<string | null> {
        let content: string;
        try {
            content = await readFile(filePath, 'utf-8');
        } catch {
            return null;
        }

        const lines = content.split('\n');
        const start = Math.max(0, (startLine ?? 1) - 1);
        const end = Math.min(lines.length, endLine ?? lines.length);
        return lines.slice(start, end).join('\n');
    }

    // ── Session JSONL Indexing ─────────────────────────────────────

    /**
     * Index new entries from a session JSONL file using byte-offset tracking.
     * Only processes bytes added since the last index. FTS5 only (no embedding).
     */
    indexSessionFile(filePath: string): number {
        const offset = this.db.getSessionOffset(filePath);
        let fileSize: number;
        try {
            fileSize = statSync(filePath).size;
        } catch {
            return 0;
        }

        if (fileSize <= offset) return 0;

        // Read only the new bytes from the offset position
        const bytesToRead = fileSize - offset;
        const buf = Buffer.alloc(bytesToRead);
        const fd = openSync(filePath, 'r');
        try {
            readSync(fd, buf, 0, bytesToRead, offset);
        } finally {
            closeSync(fd);
        }
        const newContent = buf.toString('utf-8');

        const lines = newContent.split('\n');
        const textParts: string[] = [];

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const entry = JSON.parse(trimmed) as { heartbeatOk?: boolean; prompt?: string; responseText?: string };
                if (entry.heartbeatOk) continue;
                const parts: string[] = [];
                if (entry.prompt) parts.push(entry.prompt);
                if (entry.responseText) parts.push(entry.responseText);
                if (parts.length > 0) textParts.push(parts.join('\n'));
            } catch {
                // Skip malformed lines
            }
        }

        if (textParts.length === 0) {
            this.db.setSessionOffset(filePath, fileSize);
            return 0;
        }

        const fullText = textParts.join('\n\n---\n\n');
        const chunks = chunkText(fullText, filePath);

        for (const chunk of chunks) {
            this.db.insertChunk({
                filePath: chunk.filePath,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                content: chunk.content,
                sha256: chunk.sha256,
            });
        }

        this.db.setSessionOffset(filePath, fileSize);
        return chunks.length;
    }

    /**
     * Sync all session JSONL files that have new data since last index.
     * Called synchronously before search when session memory is enabled.
     */
    syncPendingSessions(): void {
        let entries: string[];
        try {
            entries = readdirSync(this.sessionsDir);
        } catch {
            return;
        }

        for (const entry of entries) {
            if (!entry.endsWith('.jsonl')) continue;
            const filePath = join(this.sessionsDir, entry);
            try {
                const size = statSync(filePath).size;
                const offset = this.db.getSessionOffset(filePath);
                if (size > offset) {
                    this.indexSessionFile(filePath);
                }
            } catch {
                // Skip files that can't be read
            }
        }
    }

    /**
     * Embed session chunks that have FTS5 entries but no vector embedding.
     * Runs sequentially (batch=1 is fastest for local embedder).
     * Called fire-and-forget after syncPendingSessions.
     */
    async embedPendingSessionChunks(): Promise<void> {
        if (!this.embedder || !this.db.vecEnabled) return;

        const pending = this.db.getChunksWithoutEmbedding('%sessions%', 100);
        for (const chunk of pending) {
            if (this.closed) return;
            let vec = this.db.getCachedEmbedding(chunk.sha256);
            if (!vec) {
                vec = await tryEmbed(this.embedder, chunk.content, 'retrieval.passage');
                if (this.closed) return;
                if (vec) {
                    this.db.cacheEmbedding(chunk.sha256, vec);
                }
            }
            if (vec) {
                this.db.upsertChunkEmbedding(chunk.id, vec);
            }
        }
    }

    /**
     * Close the underlying database.
     * Signals any in-flight embedPendingSessionChunks() to stop.
     */
    close(): void {
        this.closed = true;
        this.db.close();
    }

    // ── Private helpers ──────────────────────────────────────────

    private async listMarkdownFiles(dir: string): Promise<string[]> {
        try {
            const entries = await readdir(dir);
            const mdFiles: string[] = [];
            for (const entry of entries) {
                if (extname(entry) === '.md') {
                    const fullPath = join(dir, entry);
                    const s = await stat(fullPath);
                    if (s.isFile()) {
                        mdFiles.push(fullPath);
                    }
                }
            }
            return mdFiles.sort();
        } catch {
            return [];
        }
    }
}

// ── Chunking ─────────────────────────────────────────────────────

/**
 * Split text into overlapping chunks of ~400 tokens.
 * Splits on paragraph boundaries (double newline) first, then on
 * single newlines if paragraphs are too large.
 */
export function chunkText(text: string, filePath: string): Chunk[] {
    const lines = text.split('\n');
    if (lines.length === 0) return [];

    const chunks: Chunk[] = [];
    let chunkStart = 0;
    let currentChars = 0;
    let chunkLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        chunkLines.push(line);
        currentChars += line.length + 1; // +1 for newline

        if (currentChars >= CHUNK_TARGET_CHARS || i === lines.length - 1) {
            const content = chunkLines.join('\n').trim();
            if (content) {
                chunks.push({
                    filePath,
                    startLine: chunkStart + 1, // 1-indexed
                    endLine: i + 1,
                    content,
                    sha256: sha256(content),
                });
            }

            // Calculate overlap: walk backwards from the end
            if (i < lines.length - 1) {
                let overlapChars = 0;
                let overlapLines = 0;
                for (let j = chunkLines.length - 1; j >= 0; j--) {
                    overlapChars += chunkLines[j]?.length + 1;
                    overlapLines++;
                    if (overlapChars >= CHUNK_OVERLAP_CHARS) break;
                }

                chunkStart = i + 1 - overlapLines;
                chunkLines = chunkLines.slice(-overlapLines);
                currentChars = overlapChars;
            } else {
                chunkLines = [];
                currentChars = 0;
                chunkStart = i + 1;
            }
        }
    }

    return chunks;
}

function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf-8').digest('hex');
}
