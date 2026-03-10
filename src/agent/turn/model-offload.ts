/**
 * agent/turn/model-offload.ts — Automatic model offloading on quota exhaustion.
 *
 * When the primary model's quota is exhausted, the agent automatically falls
 * back to a lighter model (e.g. gemini-2.5-flash) and recovers once the
 * quota resets. State is persisted to disk so offload survives restarts.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../logger.js';

const log = createLogger('model-offload');

// ── Types ──────────────────────────────────────────────────────────

interface OffloadState {
    /** The model that hit quota exhaustion. */
    primaryModel: string;
    /** The fallback model being used instead. */
    fallbackModel: string;
    /** ISO timestamp when offload was activated. */
    offloadedAt: string;
    /** ISO timestamp when quota is expected to reset. */
    resetAt: string;
}

interface QuotaExhausted {
    /** Parsed reset duration in milliseconds. */
    resetAfterMs: number;
}

// ── Default fallback model ─────────────────────────────────────────

const DEFAULT_FALLBACK_MODEL = 'gemini-2.5-flash';

// ── Quota exhaustion detection ─────────────────────────────────────

/**
 * Parse a quota exhaustion error from Gemini CLI.
 *
 * Matches messages like:
 *   "You have exhausted your capacity on this model. Your quota will reset after 8h36m20s."
 *   "exhausted your capacity ... reset after 2h15m"
 *
 * Returns parsed reset duration, or undefined if the error is not quota-related.
 */
export function parseQuotaExhausted(error: string | undefined): QuotaExhausted | undefined {
    if (!error) return undefined;

    const match = error.match(/exhausted.*?(?:capacity|quota).*?reset\s+after\s+(\d+h)?(\d+m)?(\d+s)?/i);
    if (!match) return undefined;

    const hours = match[1] ? parseInt(match[1], 10) : 0;
    const minutes = match[2] ? parseInt(match[2], 10) : 0;
    const seconds = match[3] ? parseInt(match[3], 10) : 0;

    const resetAfterMs = (hours * 3600 + minutes * 60 + seconds) * 1000;

    // If we matched the pattern but couldn't parse any time, use a conservative 1-hour default
    if (resetAfterMs === 0) {
        return { resetAfterMs: 3600 * 1000 };
    }

    return { resetAfterMs };
}

// ── State persistence ──────────────────────────────────────────────

function offloadPath(workspacePath: string): string {
    return join(workspacePath, 'memory', 'model-offload.json');
}

/** Read the current offload state from disk. Returns undefined if not offloaded or expired. */
export function getOffloadState(workspacePath: string): OffloadState | undefined {
    const path = offloadPath(workspacePath);
    if (!existsSync(path)) return undefined;

    try {
        const state: OffloadState = JSON.parse(readFileSync(path, 'utf-8'));

        // Check if quota has reset
        if (new Date(state.resetAt).getTime() <= Date.now()) {
            log.info('quota reset time reached, clearing offload', {
                primaryModel: state.primaryModel,
                resetAt: state.resetAt,
            });
            clearOffloadState(workspacePath);
            return undefined;
        }

        return state;
    } catch {
        // Corrupt file — clear it
        clearOffloadState(workspacePath);
        return undefined;
    }
}

/** Activate model offloading. */
export function setOffloadState(
    workspacePath: string,
    primaryModel: string,
    fallbackModel: string,
    resetAfterMs: number,
): void {
    const now = Date.now();
    const state: OffloadState = {
        primaryModel,
        fallbackModel,
        offloadedAt: new Date(now).toISOString(),
        resetAt: new Date(now + resetAfterMs).toISOString(),
    };

    writeFileSync(offloadPath(workspacePath), JSON.stringify(state, null, 2), 'utf-8');

    const resetMin = Math.ceil(resetAfterMs / 60_000);
    log.warn('model offloaded due to quota exhaustion', {
        primaryModel,
        fallbackModel,
        resetInMinutes: resetMin,
        resetAt: state.resetAt,
    });
}

/** Clear offload state (quota recovered or manual reset). */
export function clearOffloadState(workspacePath: string): void {
    const path = offloadPath(workspacePath);
    try {
        if (existsSync(path)) unlinkSync(path);
    } catch {
        // Best-effort
    }
}

// ── Model resolution ───────────────────────────────────────────────

/**
 * Resolve the effective model, considering active offload state.
 *
 * If the requested model matches the offloaded primary model (or is 'auto'
 * which typically resolves to the same model), returns the fallback model.
 * Otherwise returns the original model unchanged.
 */
export function resolveModelWithOffload(
    model: string,
    workspacePath: string,
    fallbackModelOverride?: string,
): { model: string; offloaded: boolean } {
    const state = getOffloadState(workspacePath);
    if (!state) return { model, offloaded: false };

    // Match the primary model or 'auto' (which typically maps to the primary)
    const isAffected = model === state.primaryModel || model === 'auto' || model === '';
    if (!isAffected) return { model, offloaded: false };

    const effective = fallbackModelOverride ?? state.fallbackModel;
    log.info('using offloaded model', { requested: model, effective, resetAt: state.resetAt });
    return { model: effective, offloaded: true };
}

/**
 * Handle quota exhaustion: set offload state and return the fallback model.
 *
 * Called from execution.ts when a quota exhaustion error is detected.
 */
export function activateOffload(
    workspacePath: string,
    primaryModel: string,
    resetAfterMs: number,
    fallbackModelOverride?: string,
): string {
    const fallback = fallbackModelOverride ?? DEFAULT_FALLBACK_MODEL;
    setOffloadState(workspacePath, primaryModel, fallback, resetAfterMs);
    return fallback;
}
