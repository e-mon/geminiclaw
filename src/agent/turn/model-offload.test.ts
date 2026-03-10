import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    activateOffload,
    clearOffloadState,
    getOffloadState,
    parseQuotaExhausted,
    resolveModelWithOffload,
} from './model-offload.js';

describe('parseQuotaExhausted', () => {
    it('parses full h/m/s format', () => {
        const result = parseQuotaExhausted(
            'You have exhausted your capacity on this model. Your quota will reset after 8h36m20s.',
        );
        expect(result).toBeDefined();
        expect(result?.resetAfterMs).toBe((8 * 3600 + 36 * 60 + 20) * 1000);
    });

    it('parses hours and minutes only', () => {
        const result = parseQuotaExhausted('exhausted your capacity. quota will reset after 2h15m');
        expect(result).toBeDefined();
        expect(result?.resetAfterMs).toBe((2 * 3600 + 15 * 60) * 1000);
    });

    it('parses minutes only', () => {
        const result = parseQuotaExhausted('exhausted capacity on this model. reset after 45m');
        expect(result).toBeDefined();
        expect(result?.resetAfterMs).toBe(45 * 60 * 1000);
    });

    it('returns undefined for non-quota errors', () => {
        expect(parseQuotaExhausted('Rate limit exceeded (429). Try again later.')).toBeUndefined();
        expect(parseQuotaExhausted('ACP timeout: session/prompt')).toBeUndefined();
        expect(parseQuotaExhausted(undefined)).toBeUndefined();
    });

    it('defaults to 1 hour when time cannot be parsed', () => {
        const result = parseQuotaExhausted('exhausted your capacity. quota will reset after soon');
        // "soon" doesn't match \d+ patterns, all groups are undefined → 0ms → fallback to 1h
        expect(result).toBeDefined();
        expect(result?.resetAfterMs).toBe(3600 * 1000);
    });
});

describe('offload state management', () => {
    let workspacePath: string;

    beforeEach(() => {
        workspacePath = mkdtempSync(join(tmpdir(), 'offload-test-'));
        mkdirSync(join(workspacePath, 'memory'), { recursive: true });
    });

    afterEach(() => {
        rmSync(workspacePath, { recursive: true, force: true });
    });

    it('returns undefined when no offload is active', () => {
        expect(getOffloadState(workspacePath)).toBeUndefined();
    });

    it('activates and reads offload state', () => {
        activateOffload(workspacePath, 'auto', 3600_000);
        const state = getOffloadState(workspacePath);
        expect(state).toBeDefined();
        expect(state?.primaryModel).toBe('auto');
        expect(state?.fallbackModel).toBe('gemini-2.5-flash');
        expect(new Date(state?.resetAt ?? 0).getTime()).toBeGreaterThan(Date.now());
    });

    it('uses custom fallback model', () => {
        activateOffload(workspacePath, 'auto', 3600_000, 'gemini-2.5-flash-lite');
        const state = getOffloadState(workspacePath);
        expect(state?.fallbackModel).toBe('gemini-2.5-flash-lite');
    });

    it('clears expired offload state', () => {
        // Write state with resetAt in the past
        const path = join(workspacePath, 'memory', 'model-offload.json');
        writeFileSync(
            path,
            JSON.stringify({
                primaryModel: 'auto',
                fallbackModel: 'gemini-2.5-flash',
                offloadedAt: new Date(Date.now() - 7200_000).toISOString(),
                resetAt: new Date(Date.now() - 1000).toISOString(),
            }),
        );
        expect(getOffloadState(workspacePath)).toBeUndefined();
    });

    it('clearOffloadState removes the file', () => {
        activateOffload(workspacePath, 'auto', 3600_000);
        expect(getOffloadState(workspacePath)).toBeDefined();
        clearOffloadState(workspacePath);
        expect(getOffloadState(workspacePath)).toBeUndefined();
    });
});

describe('resolveModelWithOffload', () => {
    let workspacePath: string;

    beforeEach(() => {
        workspacePath = mkdtempSync(join(tmpdir(), 'offload-resolve-'));
        mkdirSync(join(workspacePath, 'memory'), { recursive: true });
    });

    afterEach(() => {
        rmSync(workspacePath, { recursive: true, force: true });
    });

    it('returns original model when not offloaded', () => {
        const { model, offloaded } = resolveModelWithOffload('auto', workspacePath);
        expect(model).toBe('auto');
        expect(offloaded).toBe(false);
    });

    it('returns fallback model when offloaded', () => {
        activateOffload(workspacePath, 'auto', 3600_000);
        const { model, offloaded } = resolveModelWithOffload('auto', workspacePath);
        expect(model).toBe('gemini-2.5-flash');
        expect(offloaded).toBe(true);
    });

    it('uses override fallback model', () => {
        activateOffload(workspacePath, 'auto', 3600_000);
        const { model } = resolveModelWithOffload('auto', workspacePath, 'gemini-2.5-flash-lite');
        expect(model).toBe('gemini-2.5-flash-lite');
    });

    it('does not offload unrelated models', () => {
        activateOffload(workspacePath, 'auto', 3600_000);
        const { model, offloaded } = resolveModelWithOffload('gemini-2.5-flash', workspacePath);
        expect(model).toBe('gemini-2.5-flash');
        expect(offloaded).toBe(false);
    });
});
