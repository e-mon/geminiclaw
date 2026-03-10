/**
 * memory/mcp-serve.ts — Entry point for the geminiclaw-memory MCP server.
 *
 * Invoked by Gemini CLI as a subprocess via settings.json:
 *
 *   "geminiclaw-memory": {
 *     "command": "node",
 *     "args": ["dist/memory/mcp-serve.js"],
 *     "env": {
 *       "GEMINICLAW_WORKSPACE": "/path/to/workspace"
 *     }
 *   }
 *
 * On startup:
 *   1. Indexes all memory files (MEMORY.md + memory/*.md)
 *   2. Starts FSWatcher for live re-indexing on file changes
 *   3. Connects to Gemini CLI via stdio MCP transport
 */

import { watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { createEmbedder, type Embedder } from './embedder.js';
import { MemoryIndexer } from './indexer.js';
import { startMemoryServer } from './mcp-server.js';

const defaultWorkspace = join(homedir(), '.geminiclaw', 'workspace');
const workspaceRoot = process.env.GEMINICLAW_WORKSPACE ?? defaultWorkspace;
const memoryDir = join(workspaceRoot, 'memory');
const sessionsDir = join(memoryDir, 'sessions');
const memoryMdPath = join(workspaceRoot, 'MEMORY.md');
const dbPath = join(memoryDir, 'memory.db');

// Build embedder from config
const config = loadConfig();
const sessionMemoryEnabled = config.experimental?.sessionMemory ?? false;
let embedder: Embedder | null = null;
try {
    embedder = createEmbedder(config.embedding);
} catch (err) {
    process.stderr.write(`[geminiclaw-memory] embedder init failed: ${String(err)}\n`);
}

// Create indexer
const indexer = new MemoryIndexer(dbPath, embedder, {
    memoryDir,
    memoryMdPath,
    sessionMemoryEnabled,
    sessionsDir,
});

// Index all files on startup, then start MCP server + file watcher
(async () => {
    try {
        const count = await indexer.indexAll();
        process.stderr.write(`[geminiclaw-memory] indexed ${count} chunks from memory files\n`);
    } catch (err) {
        process.stderr.write(`[geminiclaw-memory] initial indexing failed: ${String(err)}\n`);
    }

    // FSWatcher: re-index changed files with 1.5s debounce
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const DEBOUNCE_MS = 1500;

    const scheduleReindex = (filePath: string): void => {
        const existing = debounceTimers.get(filePath);
        if (existing) clearTimeout(existing);

        debounceTimers.set(
            filePath,
            setTimeout(async () => {
                debounceTimers.delete(filePath);
                try {
                    const count = await indexer.indexFile(filePath);
                    if (count > 0) {
                        process.stderr.write(`[geminiclaw-memory] re-indexed ${filePath} (${count} chunks)\n`);
                    }
                } catch (err) {
                    process.stderr.write(`[geminiclaw-memory] re-index error for ${filePath}: ${String(err)}\n`);
                }
            }, DEBOUNCE_MS),
        );
    };

    // Watch MEMORY.md
    try {
        watch(memoryMdPath, () => scheduleReindex(memoryMdPath));
    } catch {
        process.stderr.write(`[geminiclaw-memory] could not watch ${memoryMdPath}\n`);
    }

    // Watch memory/ directory
    try {
        watch(memoryDir, (_event, filename) => {
            if (filename?.endsWith('.md')) {
                scheduleReindex(join(memoryDir, filename));
            }
        });
    } catch {
        process.stderr.write(`[geminiclaw-memory] could not watch ${memoryDir}\n`);
    }

    // Start MCP server
    const allowedPaths = [workspaceRoot];
    await startMemoryServer(indexer, { workspaceRoot, allowedPaths });
})().catch((err: unknown) => {
    process.stderr.write(`geminiclaw-memory MCP server error: ${String(err)}\n`);
    process.exit(1);
});
