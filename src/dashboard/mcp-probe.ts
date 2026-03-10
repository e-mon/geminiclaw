/**
 * dashboard/mcp-probe.ts — Probe MCP servers to discover available tools.
 *
 * Spawns each configured MCP server via StdioClientTransport, calls
 * tools/list, then shuts down. Results are cached for 5 minutes to
 * avoid repeated cold starts on dashboard refreshes.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from '../config/gemini-settings.js';
import { createLogger } from '../logger.js';

const log = createLogger('mcp-probe');

const PROBE_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60_000;

export interface McpToolInfo {
    name: string;
    description?: string;
}

export interface McpServerProbe {
    name: string;
    healthy: boolean;
    tools: McpToolInfo[];
    error?: string;
}

interface CacheEntry {
    result: McpServerProbe;
    ts: number;
}

const cache = new Map<string, CacheEntry>();

function createTransport(cfg: McpServerConfig): Transport | undefined {
    if (cfg.httpUrl) {
        return new StreamableHTTPClientTransport(new URL(cfg.httpUrl));
    }
    if (cfg.command) {
        return new StdioClientTransport({
            command: cfg.command,
            args: cfg.args,
            env: cfg.env ? ({ ...process.env, ...cfg.env } as Record<string, string>) : undefined,
            cwd: cfg.cwd,
            stderr: 'ignore',
        });
    }
    return undefined;
}

async function probeOne(name: string, cfg: McpServerConfig): Promise<McpServerProbe> {
    const cached = cache.get(name);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        return cached.result;
    }

    const transport = createTransport(cfg);
    if (!transport) {
        const result: McpServerProbe = { name, healthy: true, tools: [] };
        cache.set(name, { result, ts: Date.now() });
        return result;
    }

    try {
        const client = new Client({ name: 'geminiclaw-probe', version: '1.0.0' });
        await client.connect(transport);

        const result = await Promise.race([
            client.listTools(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS)),
        ]);

        const tools: McpToolInfo[] = (result.tools ?? []).map((t) => ({
            name: t.name,
            description: t.description,
        }));

        const probe: McpServerProbe = { name, healthy: true, tools };
        cache.set(name, { result: probe, ts: Date.now() });

        await client.close().catch(() => {});
        return probe;
    } catch (err) {
        const probe: McpServerProbe = {
            name,
            healthy: false,
            tools: [],
            error: String(err).substring(0, 200),
        };
        cache.set(name, { result: probe, ts: Date.now() });
        log.warn('mcp probe failed', { server: name, error: probe.error });
        return probe;
    }
}

/**
 * Probe all configured MCP servers in parallel to discover tools and health.
 */
export async function probeAllServers(servers: Record<string, McpServerConfig>): Promise<McpServerProbe[]> {
    const entries = Object.entries(servers);
    if (entries.length === 0) return [];

    const results = await Promise.allSettled(entries.map(([name, cfg]) => probeOne(name, cfg)));

    return results.map((r, i) =>
        r.status === 'fulfilled'
            ? r.value
            : {
                  name: entries[i]?.[0] ?? 'unknown',
                  healthy: false,
                  tools: [],
                  error: String(r.reason).substring(0, 200),
              },
    );
}
