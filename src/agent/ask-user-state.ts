/**
 * agent/ask-user-state.ts — Pending question IPC for ask_user MCP tool.
 *
 * Provides file-based coordination between MCP servers (poll for answer),
 * the runner (detects ask_user tool_use), the progress reporter (posts question
 * to chat and writes pending state), and the chat handler (routes user reply
 * to answer file instead of dispatching a new run).
 *
 * File layout under {workspace}/memory/:
 *   ask-user-pending-{askId}.json  — written by MCP server / progress reporter
 *   ask-user-answer-{askId}.json   — written by chat handler, polled by MCP server
 *
 * Each ask gets its own file pair keyed by askId, enabling concurrent requests
 * from multiple MCP servers (e.g. ask_user + tool-effect confirmation).
 */

import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** State written by MCP server / ChatProgressReporter when an ask_user event fires. */
export interface PendingQuestion {
    askId: string;
    sessionId: string;
    question: string;
    options?: string[];
    timestamp: string;
    /**
     * Stable run identifier set by AcpClient via `GEMINICLAW_RUN_ID` env var.
     * MCP servers inherit this from their parent Gemini CLI process.
     * The runner poller uses it to scope detection to its own process tree,
     * preventing cross-session contamination.
     */
    runId?: string;
    /** Discord/Slack message ID of the ask card, used to edit it into a Q&A log after answer. */
    cardMessageId?: string;
}

/** Answer written by chat handler when user replies to a pending question. */
export interface PendingAnswer {
    askId: string;
    answer: string;
}

/** Maximum age (ms) before a pending question is considered expired. */
const PENDING_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

// ── Path helpers ─────────────────────────────────────────────────

function memoryDir(workspace: string): string {
    return join(workspace, 'memory');
}

export function getPendingPath(workspace: string, askId: string): string {
    return join(memoryDir(workspace), `ask-user-pending-${askId}.json`);
}

export function getAnswerPath(workspace: string, askId: string): string {
    return join(memoryDir(workspace), `ask-user-answer-${askId}.json`);
}

// ── Pending (written by MCP server / progress reporter, read by chat handler) ─

export function writePending(workspace: string, data: PendingQuestion): void {
    writeFileSync(getPendingPath(workspace, data.askId), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Find a pending question that matches the given sessionId and has not expired.
 * Scans all ask-user-pending-*.json files.
 *
 * Returns the first valid match, or null if none found.
 */
export function findPending(workspace: string, sessionId: string): PendingQuestion | null {
    for (const pending of listAllPending(workspace)) {
        if (pending.sessionId !== '*' && pending.sessionId !== sessionId) continue;
        const age = Date.now() - new Date(pending.timestamp).getTime();
        if (age > PENDING_MAX_AGE_MS) continue;
        return pending;
    }
    return null;
}

/**
 * Find a pending question by askId only (no sessionId match required).
 * Used by button click handlers where the thread context may differ
 * from the original session that posted the ask card.
 */
export function findPendingByAskId(workspace: string, askId: string): PendingQuestion | null {
    // Reject path traversal — askId comes from untrusted Discord/Slack action callbacks
    if (!askId || !/^[\w-]+$/.test(askId)) return null;
    const path = getPendingPath(workspace, askId);
    try {
        const raw = readFileSync(path, 'utf-8');
        const pending = JSON.parse(raw) as PendingQuestion;
        const age = Date.now() - new Date(pending.timestamp).getTime();
        if (age > PENDING_MAX_AGE_MS) return null;
        return pending;
    } catch {
        return null;
    }
}

/**
 * Find a pending question regardless of expiry — used to detect stale
 * pending state that should be cleaned up before normal dispatch.
 */
export function findPendingRaw(workspace: string, sessionId: string): PendingQuestion | null {
    for (const pending of listAllPending(workspace)) {
        if (pending.sessionId !== '*' && pending.sessionId !== sessionId) continue;
        return pending;
    }
    return null;
}

/** List all pending questions (regardless of sessionId or expiry). */
export function listAllPending(workspace: string): PendingQuestion[] {
    const dir = memoryDir(workspace);
    try {
        return readdirSync(dir)
            .filter((f) => f.startsWith('ask-user-pending-') && f.endsWith('.json'))
            .map((f) => {
                try {
                    return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as PendingQuestion;
                } catch {
                    return null;
                }
            })
            .filter((p): p is PendingQuestion => p !== null);
    } catch {
        return [];
    }
}

export function clearPending(workspace: string, askId: string): void {
    try {
        unlinkSync(getPendingPath(workspace, askId));
    } catch {
        // File may not exist — ignore
    }
}

/**
 * Remove all expired pending files and their orphaned answer files.
 * Call at MCP server startup to clean up leftovers from crashed runs.
 */
export function clearStaleFiles(workspace: string): void {
    const dir = memoryDir(workspace);
    for (const pending of listAllPending(workspace)) {
        const age = Date.now() - new Date(pending.timestamp).getTime();
        if (age > PENDING_MAX_AGE_MS) {
            clearPending(workspace, pending.askId);
            clearAnswer(workspace, pending.askId);
        }
    }
    // Also clean up orphaned answer files with no matching pending
    try {
        const answerFiles = readdirSync(dir).filter((f) => f.startsWith('ask-user-answer-') && f.endsWith('.json'));
        const pendingIds = new Set(listAllPending(workspace).map((p) => p.askId));
        for (const f of answerFiles) {
            const askId = f.replace('ask-user-answer-', '').replace('.json', '');
            if (!pendingIds.has(askId)) {
                clearAnswer(workspace, askId);
            }
        }
    } catch {
        // Directory may not exist
    }
}

// ── Answer (written by chat handler, polled by MCP server) ──────

export function writeAnswer(workspace: string, askId: string, answer: string): void {
    const data: PendingAnswer = { askId, answer };
    writeFileSync(getAnswerPath(workspace, askId), JSON.stringify(data, null, 2), 'utf-8');
}

export function readAnswer(workspace: string, askId: string): PendingAnswer | null {
    try {
        return JSON.parse(readFileSync(getAnswerPath(workspace, askId), 'utf-8')) as PendingAnswer;
    } catch {
        return null;
    }
}

export function clearAnswer(workspace: string, askId: string): void {
    try {
        unlinkSync(getAnswerPath(workspace, askId));
    } catch {
        // File may not exist — ignore
    }
}

// ── Polling helper (shared by ask-user-server and tool-effect) ───

const POLL_INTERVAL_MS = 500;
const MAX_WAIT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Poll for an answer file and resolve when it appears.
 *
 * On success: clears answer + pending files.
 * On timeout: clears pending + answer files, rejects with timeout error.
 */
export function waitForAnswer(workspace: string, askId: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
            const answer = readAnswer(workspace, askId);
            if (answer) {
                clearInterval(timer);
                clearAnswer(workspace, askId);
                clearPending(workspace, askId);
                resolve(answer.answer);
            } else if (Date.now() - start > MAX_WAIT_MS) {
                clearInterval(timer);
                clearPending(workspace, askId);
                clearAnswer(workspace, askId);
                reject(new Error('Timed out waiting for user answer (30 min)'));
            }
        }, POLL_INTERVAL_MS);
    });
}
