/**
 * memory/mcp-server.ts — MCP server for file-based memory search.
 *
 * Exposes search-only memory operations to Gemini CLI agents via MCP.
 * Files are the source of truth; this server provides search over
 * the indexed chunks.
 *
 * Tools:
 *   - memory_search(query, limit?) → hybrid search over indexed memory files
 *   - memory_get(file, startLine?, endLine?) → read a range of lines from a memory file
 */

import { basename, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { MemoryIndexer } from './indexer.js';

const TOOLS = [
    {
        name: 'memory_search',
        description:
            'Search past memories and notes using full-text + semantic search. ' +
            'Returns relevant snippets from MEMORY.md and memory/*.md files, ranked by relevance.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                query: {
                    type: 'string',
                    description: 'Search query (natural language or keywords).',
                },
                limit: {
                    type: 'number',
                    description: 'Maximum number of results to return (default: 10).',
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'memory_get',
        description:
            'Read a range of lines from a memory file. ' +
            'Use this to drill into search results and get full context around a snippet.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                file: {
                    type: 'string',
                    description: 'File path (from memory_search results, e.g. "MEMORY.md" or "memory/2026-02-24.md").',
                },
                startLine: {
                    type: 'number',
                    description: 'First line to read (1-indexed, default: 1).',
                },
                endLine: {
                    type: 'number',
                    description: 'Last line to read (inclusive, default: end of file).',
                },
            },
            required: ['file'],
        },
    },
];

export interface MemoryServerOptions {
    /** Base directory containing memory files (workspace root). */
    workspaceRoot: string;
    /** Allowed file access paths (resolved absolute). */
    allowedPaths: string[];
}

export function createMemoryServer(indexer: MemoryIndexer, options: MemoryServerOptions): Server {
    const server = new Server({ name: 'geminiclaw-memory', version: '0.2.0' }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const params = (args ?? {}) as Record<string, unknown>;

        switch (name) {
            case 'memory_search': {
                const query = String(params.query ?? '');
                if (!query.trim()) {
                    return {
                        content: [{ type: 'text' as const, text: 'Error: query cannot be empty' }],
                        isError: true,
                    };
                }
                const limit = typeof params.limit === 'number' ? params.limit : 10;

                try {
                    const results = await indexer.search(query, limit);

                    // Convert absolute paths to workspace-relative for readability
                    const relativeResults = results.map((r) => ({
                        ...r,
                        file: toRelativePath(r.filePath, options.workspaceRoot),
                    }));

                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: JSON.stringify({ results: relativeResults, count: relativeResults.length }),
                            },
                        ],
                    };
                } catch (err) {
                    process.stderr.write(`[geminiclaw-memory] search error: ${String(err)}\n`);
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: JSON.stringify({
                                    results: [],
                                    count: 0,
                                    note: 'Search error — try simpler terms',
                                }),
                            },
                        ],
                    };
                }
            }

            case 'memory_get': {
                const file = String(params.file ?? '');
                if (!file.trim()) {
                    return {
                        content: [{ type: 'text' as const, text: 'Error: file cannot be empty' }],
                        isError: true,
                    };
                }

                // Resolve to absolute path and validate access
                const absPath = resolve(options.workspaceRoot, file);
                if (!isPathAllowed(absPath, options.allowedPaths)) {
                    return {
                        content: [{ type: 'text' as const, text: 'Error: access denied — file outside memory scope' }],
                        isError: true,
                    };
                }

                const startLine = typeof params.startLine === 'number' ? params.startLine : undefined;
                const endLine = typeof params.endLine === 'number' ? params.endLine : undefined;

                const content = await indexer.getChunk(absPath, startLine, endLine);
                if (content === null) {
                    return {
                        content: [{ type: 'text' as const, text: `Error: file not found: ${file}` }],
                        isError: true,
                    };
                }

                return {
                    content: [{ type: 'text' as const, text: content }],
                };
            }

            default:
                return {
                    content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
                    isError: true,
                };
        }
    });

    return server;
}

export async function startMemoryServer(indexer: MemoryIndexer, options: MemoryServerOptions): Promise<void> {
    const server = createMemoryServer(indexer, options);
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

// ── Helpers ──────────────────────────────────────────────────────

function toRelativePath(absPath: string, workspaceRoot: string): string {
    if (absPath.startsWith(workspaceRoot)) {
        const rel = absPath.slice(workspaceRoot.length).replace(/^\//, '');
        return rel || basename(absPath);
    }
    return absPath;
}

function isPathAllowed(absPath: string, allowedPaths: string[]): boolean {
    return allowedPaths.some((allowed) => {
        // Ensure exact directory prefix match (prevent /workspace matching /workspaceEvil)
        const prefix = allowed.endsWith('/') ? allowed : `${allowed}/`;
        return absPath === allowed || absPath.startsWith(prefix);
    });
}
