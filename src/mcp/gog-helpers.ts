/**
 * mcp/gog-helpers.ts — Shared helpers for gog MCP server setup.
 *
 * Pure utility functions with no top-level side effects, safe to import
 * from both the stdio entrypoint (gog-serve.ts) and the HTTP host (serve.ts).
 */

import { execFileSync } from 'node:child_process';

/** Resolve the gog CLI binary path, or null if not installed. */
export function resolveGogPath(): string | null {
    try {
        return execFileSync('which', ['gog'], { encoding: 'utf-8' }).trim();
    } catch {
        process.stderr.write('[gog-server] gog CLI not found — server will expose no tools\n');
        return null;
    }
}

/** Detect the default gog account from `gog auth list` output. */
export function detectAccount(gogPath: string): string | undefined {
    try {
        const output = execFileSync(gogPath, ['auth', 'list'], { encoding: 'utf-8', timeout: 5000 });
        const lines = output.trim().split('\n').filter(Boolean);
        const defaultLine = lines.find((l) => l.split('\t')[1]?.trim() === 'default');
        const email = (defaultLine ?? lines[0])?.split('\t')[0]?.trim();
        if (email?.includes('@')) {
            process.stderr.write(`[gog-server] auto-detected account: ${email}\n`);
            return email;
        }
    } catch {
        // gog auth list failed — no accounts configured
    }
    return undefined;
}
