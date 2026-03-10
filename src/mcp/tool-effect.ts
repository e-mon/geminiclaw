/**
 * mcp/tool-effect.ts — Common confirmation gate for dangerous MCP operations.
 *
 * `elevated` / `destructive` operations block until the user approves via the
 * ask-user file protocol. `read` / `write` pass through immediately.
 *
 * In `supervised` mode, `write` is promoted to `elevated` (requires confirmation).
 * The autonomy level is read from `GEMINICLAW_AUTONOMY_LEVEL` env var.
 *
 * Reusable by any MCP server:
 *   import { confirmIfNeeded } from './tool-effect.js';
 */

import { randomUUID } from 'node:crypto';
import { clearPending, waitForAnswer, writePending } from '../agent/ask-user-state.js';

export type ToolEffect = 'read' | 'write' | 'elevated' | 'destructive';
export type AutonomyLevel = 'autonomous' | 'supervised' | 'read_only';

/** Convert ToolEffect to MCP ToolAnnotations for ListTools responses. */
export function toAnnotations(effect: ToolEffect): Record<string, boolean> {
    switch (effect) {
        case 'read':
            return { readOnlyHint: true };
        case 'write':
            return { readOnlyHint: false, destructiveHint: false };
        case 'elevated':
            return { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
        case 'destructive':
            return { readOnlyHint: false, destructiveHint: true };
    }
}

/**
 * Resolve the effective tool effect, promoting `write` to `elevated`
 * when the autonomy level is `supervised`.
 */
export function effectiveToolEffect(base: ToolEffect, autonomyLevel: AutonomyLevel): ToolEffect {
    if (base === 'write' && autonomyLevel === 'supervised') return 'elevated';
    return base;
}

/**
 * Block until user approves an elevated/destructive operation.
 * read/write operations pass through without confirmation.
 *
 * Automatically applies autonomy-level escalation: in `supervised` mode,
 * `write` operations are promoted to `elevated` and require confirmation.
 *
 * @throws Error if the user rejects or the request times out.
 */
export async function confirmIfNeeded(workspace: string, effect: ToolEffect, description: string): Promise<void> {
    const autonomyLevel = (process.env.GEMINICLAW_AUTONOMY_LEVEL ?? 'autonomous') as AutonomyLevel;
    const resolved = effectiveToolEffect(effect, autonomyLevel);
    if (resolved !== 'elevated' && resolved !== 'destructive') return;

    const askId = randomUUID();
    writePending(workspace, {
        askId,
        sessionId: '*',
        question: description,
        options: ['Approve', 'Reject'],
        timestamp: new Date().toISOString(),
        runId: process.env.GEMINICLAW_RUN_ID,
    });

    process.stderr.write(`[tool-effect] Awaiting confirmation: ${description}\n`);

    try {
        const answer = await waitForAnswer(workspace, askId);
        const normalized = answer.toLowerCase().trim();
        if (normalized === 'approve' || normalized === 'yes') {
            process.stderr.write(`[tool-effect] Approved\n`);
            return;
        }
        throw new Error(`User rejected operation: ${answer}`);
    } catch (err) {
        // Ensure cleanup on any failure path
        clearPending(workspace, askId);
        throw err;
    }
}
