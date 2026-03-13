/**
 * agent/bootstrap.ts — First-run bootstrap state management.
 *
 * Manages the bootstrap lock (TTL-based, no PID tracking) to coordinate
 * the initial setup conversation across multiple channels.
 *
 * Bootstrap triggers when BOOTSTRAP.md exists and the message arrives
 * from a home channel or DM. The lock prevents concurrent bootstrap sessions.
 * Stale locks (older than TTL) are automatically cleaned up.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TriggerType } from './runner.js';

const LOCK_FILENAME = '.bootstrap.lock';
const BOOTSTRAP_FILENAME = 'BOOTSTRAP.md';
const LOCK_TTL_MS = 60 * 60 * 1000; // 1 hour

interface BootstrapLock {
    channelId: string;
    startedAt: string;
}

/**
 * Check whether this turn should run in bootstrap mode.
 *
 * Returns true only when:
 * - BOOTSTRAP.md exists in the workspace
 * - Trigger is interactive (not heartbeat/cron)
 * - Session originates from a home channel, DM, or manual trigger
 * - No active (non-stale) lock exists, OR we can acquire one
 */
export function shouldBootstrap(params: {
    workspacePath: string;
    trigger: TriggerType;
    channelId?: string;
    isHomeChannel?: boolean;
    isDM?: boolean;
}): boolean {
    const { workspacePath, trigger, channelId, isHomeChannel, isDM } = params;

    // Only interactive triggers
    if (trigger === 'heartbeat' || trigger === 'cron') return false;

    // BOOTSTRAP.md must exist
    if (!existsSync(join(workspacePath, BOOTSTRAP_FILENAME))) return false;

    // For channel triggers, only activate in home channel or DMs
    if (trigger === 'discord' || trigger === 'slack' || trigger === 'telegram') {
        if (!isHomeChannel && !isDM) return false;
    }

    const lockPath = join(workspacePath, LOCK_FILENAME);
    const lock = readLock(lockPath);

    if (lock) {
        if (isStale(lock)) {
            // Stale lock — clean up and allow new bootstrap
            removeLock(lockPath);
        } else {
            // Active lock — only the same channel can continue
            return lock.channelId === (channelId ?? trigger);
        }
    }

    // Acquire lock
    writeLock(lockPath, { channelId: channelId ?? trigger, startedAt: new Date().toISOString() });
    return true;
}

/**
 * Clean up bootstrap lock. Called after bootstrap completes or is skipped.
 * BOOTSTRAP.md deletion is handled by the agent itself via file tools.
 */
export function clearBootstrapLock(workspacePath: string): void {
    removeLock(join(workspacePath, LOCK_FILENAME));
}

/**
 * Check if bootstrap is pending (BOOTSTRAP.md exists).
 */
export function isBootstrapPending(workspacePath: string): boolean {
    return existsSync(join(workspacePath, BOOTSTRAP_FILENAME));
}

// ── Internal helpers ──

function readLock(lockPath: string): BootstrapLock | undefined {
    if (!existsSync(lockPath)) return undefined;
    try {
        return JSON.parse(readFileSync(lockPath, 'utf-8')) as BootstrapLock;
    } catch {
        return undefined;
    }
}

function writeLock(lockPath: string, lock: BootstrapLock): void {
    writeFileSync(lockPath, JSON.stringify(lock), 'utf-8');
}

function removeLock(lockPath: string): void {
    try {
        rmSync(lockPath, { force: true });
    } catch {
        // Ignore — may already be deleted
    }
}

function isStale(lock: BootstrapLock): boolean {
    return Date.now() - new Date(lock.startedAt).getTime() > LOCK_TTL_MS;
}
