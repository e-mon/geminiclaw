/**
 * agent/turn/post-execution.ts — Handler array for the "post-run" phase.
 *
 * Independent side-effects after Gemini execution completes:
 * save session (fail-closed), track usage (fail-closed), memory flush (fail-open).
 * Runs in parallel with "deliver" — must not block reply delivery.
 */

import { join } from 'node:path';
import { UsageDB } from '../../memory/db.js';
import { UsageTracker } from '../../memory/usage.js';
import { SessionStore, silentMemoryFlush } from '../session/index.js';
import type { Handler } from './handlers.js';
import { runHandlers } from './handlers.js';
import { makeFlushDeps, readFlushMarker, sanitizeForFilename, writeFlushMarker } from './helpers.js';
import type { PostRunContext } from './types.js';

/**
 * Minimum new entries since last flush before another flush is worthwhile.
 * Prevents redundant LLM calls on rapid consecutive messages.
 * The first flush always runs (regardless of entry count) to ensure
 * short sessions aren't lost at date boundaries.
 */
const FLUSH_ENTRY_DELTA = 3;

function hasModel(ctx: PostRunContext): boolean {
    return !!ctx.params.model;
}

async function saveSession(ctx: PostRunContext): Promise<void> {
    const sessionStore = new SessionStore(join(ctx.params.workspacePath, 'memory', 'sessions'));
    sessionStore.append(ctx.params.sessionId, ctx.runResult);
}

async function trackUsage(ctx: PostRunContext): Promise<void> {
    const db = new UsageDB(join(ctx.params.workspacePath, 'memory', 'memory.db'));
    try {
        const tracker = new UsageTracker(db);
        tracker.saveRecord(ctx.runResult);
    } finally {
        db.close();
    }
}

async function memoryFlush(ctx: PostRunContext): Promise<void> {
    const sessionStore = new SessionStore(join(ctx.params.workspacePath, 'memory', 'sessions'));
    const allEntries = sessionStore.loadAll(ctx.params.sessionId);
    if (allEntries.length === 0) return;

    const markerPath = join(
        ctx.params.workspacePath,
        'memory',
        `flush-marker-${sanitizeForFilename(ctx.params.sessionId)}.json`,
    );
    const lastFlushCount = readFlushMarker(markerPath);

    // First flush always runs (ensures short sessions aren't lost at date boundaries).
    // Subsequent flushes require at least FLUSH_ENTRY_DELTA new entries.
    const isFirstFlush = lastFlushCount === 0;
    if (!isFirstFlush && allEntries.length - lastFlushCount < FLUSH_ENTRY_DELTA) return;

    await silentMemoryFlush(
        allEntries,
        ctx.params.workspacePath,
        ctx.params.model,
        makeFlushDeps(ctx.params.workspacePath),
        ctx.params.timezone,
    );
    writeFlushMarker(markerPath, allEntries.length);
}

async function reindexQmd(_ctx: PostRunContext): Promise<void> {
    const { updateQmdIndex } = await import('../../memory/qmd.js');
    await updateQmdIndex();
}

const POST_EXEC_HANDLERS: readonly Handler<PostRunContext>[] = [
    { id: 'save-session', errorSemantics: 'fail-closed', run: saveSession },
    { id: 'track-usage', errorSemantics: 'fail-closed', run: trackUsage },
    {
        id: 'memory-flush',
        errorSemantics: 'fail-open',
        condition: hasModel,
        run: memoryFlush,
    },
    { id: 'qmd-reindex', errorSemantics: 'fail-open', run: reindexQmd },
];

export async function runPostRun(ctx: PostRunContext): Promise<void> {
    return runHandlers('post-run', POST_EXEC_HANDLERS, ctx);
}
