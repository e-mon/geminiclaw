/**
 * mcp/audit.ts — Lightweight audit log for MCP tool calls.
 *
 * Appends JSONL entries to {workspace}/memory/audit.jsonl.
 * Reusable by any MCP server: `import { auditLog } from './audit.js'`.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface AuditEntry {
    ts: string;
    tool: string;
    effect: string;
    params: Record<string, unknown>;
    ok: boolean;
    ms: number;
    /** Number of lines in the tool output (for read-audit visibility). */
    resultLines?: number;
}

/** Max characters for any single param value in the audit log. */
const PARAM_TRUNCATE_CHARS = 200;

/** Truncate long string values in params to avoid logging full email bodies etc. */
function truncateParams(params: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
        if (typeof value === 'string' && value.length > PARAM_TRUNCATE_CHARS) {
            result[key] = `${value.substring(0, PARAM_TRUNCATE_CHARS)}…[${value.length} chars]`;
        } else {
            result[key] = value;
        }
    }
    return result;
}

export function auditLog(workspace: string, entry: AuditEntry): void {
    try {
        const dir = join(workspace, 'memory');
        mkdirSync(dir, { recursive: true });
        const sanitized = { ...entry, params: truncateParams(entry.params) };
        appendFileSync(join(dir, 'audit.jsonl'), `${JSON.stringify(sanitized)}\n`);
    } catch {
        // Fire-and-forget — audit failure must never break tool execution
        process.stderr.write(`[audit] failed to write audit log\n`);
    }
}
