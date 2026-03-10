/**
 * mcp/status-server.ts — MCP server exposing geminiclaw_status.
 *
 * Equivalent to OpenClaw's session_status tool. The agent calls this
 * whenever it needs to know the current date or time — the system prompt
 * only carries the timezone (static), so time is always fetched on demand.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** Progress signal written by spawnGemini on each tool_use event. */
interface ProgressSignal {
    runId: string;
    lastToolUse: string;
    toolName: string;
}

/** Age in ms of a progress signal before it's considered stale. */
const PROGRESS_STALE_MS = 5 * 60 * 1000; // 5 minutes

const TOOLS = [
    {
        name: 'geminiclaw_status',
        description:
            'Get the current date, time, timezone, and agent activity status. ' +
            'Call this whenever you need to know what time or date it is right now, ' +
            'or to check if another agent run is currently in progress.',
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
];

export function createStatusServer(timezone: string, workspaceRoot?: string): Server {
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const wsRoot = workspaceRoot ?? join(homedir(), '.geminiclaw', 'workspace');

    const server = new Server({ name: 'geminiclaw-status', version: '0.1.0' }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (request.params.name !== 'geminiclaw_status') {
            return {
                content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }],
                isError: true,
            };
        }

        const now = new Date();

        const dateStr = now.toLocaleDateString('ja-JP', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            weekday: 'short',
        });

        const timeStr = now.toLocaleTimeString('ja-JP', {
            timeZone: tz,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });

        // ISO 8601 with offset, e.g. 2026-02-23T15:30:00+09:00
        const isoWithOffset = now
            .toLocaleString('sv-SE', {
                timeZone: tz,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            })
            .replace(' ', 'T');

        // Derive UTC offset from the configured timezone (not system TZ)
        const offsetStr = (() => {
            const fmt = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                timeZoneName: 'longOffset',
            });
            const parts = fmt.formatToParts(now);
            const tzPart = parts.find((p) => p.type === 'timeZoneName');
            // longOffset returns e.g. "GMT+09:00" or "GMT" (for UTC)
            const raw = tzPart?.value ?? 'GMT';
            return raw === 'GMT' ? '+00:00' : raw.replace('GMT', '');
        })();

        // Check if any run is currently in progress.
        // Per-session progress files: run-progress-<sessionId>.json
        let isWorking = false;
        let currentToolName: string | undefined;
        try {
            const memoryDir = join(wsRoot, 'memory');
            const progressFiles = readdirSync(memoryDir).filter(
                (f) => f.startsWith('run-progress') && f.endsWith('.json'),
            );

            let latestProgress: ProgressSignal | undefined;
            let latestAge = Infinity;

            for (const file of progressFiles) {
                try {
                    const raw = readFileSync(join(memoryDir, file), 'utf-8').trim();
                    const progress = JSON.parse(raw) as ProgressSignal;
                    const age = now.getTime() - new Date(progress.lastToolUse).getTime();
                    if (age < latestAge) {
                        latestAge = age;
                        latestProgress = progress;
                    }
                } catch {
                    // Skip unparseable files
                }
            }

            if (latestProgress && latestAge < PROGRESS_STALE_MS) {
                isWorking = true;
                currentToolName = latestProgress.toolName;
            }
        } catch {
            // No memory dir or read error — not working
        }

        // Read preview-info.json if available
        let previewUrl: string | undefined;
        let previewDir: string | undefined;
        try {
            const previewInfoPath = join(wsRoot, 'memory', 'preview-info.json');
            const raw = readFileSync(previewInfoPath, 'utf-8');
            const info = JSON.parse(raw) as { baseUrl?: string; previewDir?: string };
            previewUrl = info.baseUrl;
            previewDir = info.previewDir;
        } catch {
            // No preview info — skip
        }

        const lines = [
            `Current time: ${isoWithOffset}${offsetStr}`,
            `Date: ${dateStr}`,
            `Time: ${timeStr}`,
            `Timezone: ${tz}`,
            `Agent working: ${isWorking ? `yes (last tool: ${currentToolName})` : 'no'}`,
        ];
        if (previewUrl) {
            lines.push(`Preview URL: ${previewUrl}`);
        }
        if (previewDir) {
            lines.push(`Preview directory: ${previewDir}`);
        }
        const text = lines.join('\n');

        return { content: [{ type: 'text' as const, text }] };
    });

    return server;
}

export async function startStatusServer(timezone: string, workspaceRoot?: string): Promise<void> {
    const server = createStatusServer(timezone, workspaceRoot);
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
