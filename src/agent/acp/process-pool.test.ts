/**
 * agent/acp/process-pool.test.ts — Tests for AcpProcessPool.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock AcpClient before importing pool
vi.mock('./client.js', () => {
    return {
        AcpClient: vi.fn().mockImplementation(() => ({
            initialize: vi.fn().mockResolvedValue(undefined),
            close: vi.fn().mockResolvedValue(undefined),
            closed: false,
            setUpdateHandler: vi.fn(),
            forceKill: vi.fn(),
        })),
        pickSafeEnv: vi.fn(() => ({})),
    };
});

vi.mock('../../logger.js', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

import { AcpClient } from './client.js';
import { AcpProcessPool } from './process-pool.js';

// Use type cast instead of vi.mocked() which is unavailable in Bun's vitest
const MockAcpClient = AcpClient as unknown as ReturnType<typeof vi.fn>;

describe('AcpProcessPool', () => {
    beforeEach(async () => {
        await AcpProcessPool._reset();
        MockAcpClient.mockClear();
    });

    afterEach(async () => {
        await AcpProcessPool._reset();
    });

    it('spawns a new client on first acquire', async () => {
        const { client } = await AcpProcessPool.acquire('/workspace/a');

        expect(MockAcpClient).toHaveBeenCalledTimes(1);
        expect(client.initialize).toHaveBeenCalledTimes(1);
        expect(AcpProcessPool.size).toBe(1);
    });

    it('reuses existing client on second acquire after release', async () => {
        const { client: client1 } = await AcpProcessPool.acquire('/workspace/a');
        AcpProcessPool.release('/workspace/a', client1);

        const { client: client2 } = await AcpProcessPool.acquire('/workspace/a');

        expect(client2).toBe(client1);
        expect(MockAcpClient).toHaveBeenCalledTimes(1);
    });

    it('spawns new client for different cwd, evicts sessionless idle', async () => {
        AcpProcessPool.configure({ maxSize: 4, reservedSlots: 0 });
        const { client: client1 } = await AcpProcessPool.acquire('/workspace/a');
        AcpProcessPool.release('/workspace/a', client1);

        const { client: client2 } = await AcpProcessPool.acquire('/workspace/b');

        expect(client2).not.toBe(client1);
        expect(MockAcpClient).toHaveBeenCalledTimes(2);
        // Sessionless idle with different key is proactively evicted
        expect(client1.close).toHaveBeenCalled();
        expect(AcpProcessPool.size).toBe(1);
    });

    it('preserves idle with session when acquiring different key', async () => {
        AcpProcessPool.configure({ maxSize: 4, reservedSlots: 0 });
        const { client: client1 } = await AcpProcessPool.acquire('/workspace/a');
        AcpProcessPool.release('/workspace/a', client1, undefined, 'sess-1');

        const { client: client2 } = await AcpProcessPool.acquire('/workspace/b');

        expect(client2).not.toBe(client1);
        // Idle with session is preserved (has affinity value)
        expect(client1.close).not.toHaveBeenCalled();
        expect(AcpProcessPool.size).toBe(2);
    });

    it('spawns separate processes for concurrent requests on same cwd', async () => {
        AcpProcessPool.configure({ maxSize: 4, reservedSlots: 0 });
        const { client: c1 } = await AcpProcessPool.acquire('/workspace/a');
        // Don't release — still in use
        const { client: c2 } = await AcpProcessPool.acquire('/workspace/a');

        expect(c2).not.toBe(c1);
        expect(MockAcpClient).toHaveBeenCalledTimes(2);
        expect(AcpProcessPool.size).toBe(2);

        // Both survive after release (no overwrite)
        AcpProcessPool.release('/workspace/a', c1, undefined, 'sess-1');
        AcpProcessPool.release('/workspace/a', c2, undefined, 'sess-2');
        expect(AcpProcessPool.size).toBe(2);
        expect(AcpProcessPool.idle).toBe(2);
    });

    it('clears update handler on release', async () => {
        const { client } = await AcpProcessPool.acquire('/workspace/a');
        AcpProcessPool.release('/workspace/a', client);

        expect(client.setUpdateHandler).toHaveBeenCalledWith(undefined);
    });

    it('closes untracked client on release', async () => {
        const { client } = await AcpProcessPool.acquire('/workspace/a');
        await AcpProcessPool._reset(); // Clears pool

        AcpProcessPool.release('/workspace/a', client);
        expect(client.close).toHaveBeenCalled();
    });

    it('evicts idle client when maxSize is reached', async () => {
        AcpProcessPool.configure({ maxSize: 2, reservedSlots: 0 });

        const { client: c1 } = await AcpProcessPool.acquire('/workspace/a');
        AcpProcessPool.release('/workspace/a', c1, undefined, 'sess-1');

        const { client: c2 } = await AcpProcessPool.acquire('/workspace/b');
        AcpProcessPool.release('/workspace/b', c2, undefined, 'sess-2');

        // Third acquire should evict lowest-value idle (c1 — has session but older)
        const { client: c3 } = await AcpProcessPool.acquire('/workspace/c');

        expect(c1.close).toHaveBeenCalled();
        expect(AcpProcessPool.size).toBe(2);

        AcpProcessPool.release('/workspace/c', c3);
    });

    it('cleans up dead client on acquire', async () => {
        const { client } = await AcpProcessPool.acquire('/workspace/a');
        AcpProcessPool.release('/workspace/a', client);

        Object.defineProperty(client, 'closed', { get: () => true });

        const { client: client2 } = await AcpProcessPool.acquire('/workspace/a');

        expect(client2).not.toBe(client);
        expect(MockAcpClient).toHaveBeenCalledTimes(2);
    });

    it('shutdown closes all clients', async () => {
        AcpProcessPool.configure({ maxSize: 4, reservedSlots: 0 });
        const { client: c1 } = await AcpProcessPool.acquire('/workspace/a');
        AcpProcessPool.release('/workspace/a', c1);

        const { client: c2 } = await AcpProcessPool.acquire('/workspace/b');
        AcpProcessPool.release('/workspace/b', c2);

        await AcpProcessPool.shutdown();

        expect(c1.close).toHaveBeenCalled();
        expect(c2.close).toHaveBeenCalled();
        expect(AcpProcessPool.size).toBe(0);
    });

    it('configure updates pool parameters', () => {
        AcpProcessPool.configure({ idleMinutes: 30, maxSize: 8, reservedSlots: 2 });
    });

    it('_reset restores defaults and clears pool', async () => {
        const { client } = await AcpProcessPool.acquire('/workspace/a');
        AcpProcessPool.release('/workspace/a', client);

        await AcpProcessPool._reset();

        expect(AcpProcessPool.size).toBe(0);
        expect(client.close).toHaveBeenCalled();
    });

    it('returns activeSessionId for reused client via session affinity', async () => {
        const { client } = await AcpProcessPool.acquire('/workspace/a');
        AcpProcessPool.release('/workspace/a', client, undefined, 'session-abc');

        // Priority 1: session affinity match
        const { client: client2, activeSessionId } = await AcpProcessPool.acquire(
            '/workspace/a',
            undefined,
            undefined,
            'session-abc',
        );

        expect(client2).toBe(client);
        expect(activeSessionId).toBe('session-abc');
    });

    it('prefers free over bound process', async () => {
        AcpProcessPool.configure({ maxSize: 4, reservedSlots: 0 });
        const { client: c1 } = await AcpProcessPool.acquire('/workspace/a');
        const { client: c2 } = await AcpProcessPool.acquire('/workspace/a');

        // c1 released with session (bound), c2 released without (free)
        AcpProcessPool.release('/workspace/a', c1, undefined, 'session-abc');
        AcpProcessPool.release('/workspace/a', c2);

        // Should pick c2 (free, score=50) over c1 (bound, score=1)
        const { client: picked } = await AcpProcessPool.acquire('/workspace/a');
        expect(picked).toBe(c2);
    });

    it('reuses bound process as last resort when no free available', async () => {
        const { client } = await AcpProcessPool.acquire('/workspace/a');
        AcpProcessPool.release('/workspace/a', client, undefined, 'session-abc');

        // Only bound process available → reused (score=1) rather than spawn+evict
        // No preferSessionId passed, so activeSessionId is not returned
        const { client: client2, activeSessionId } = await AcpProcessPool.acquire('/workspace/a');

        expect(client2).toBe(client);
        expect(activeSessionId).toBeUndefined();
    });

    it('returns no activeSessionId for fresh client', async () => {
        const { activeSessionId } = await AcpProcessPool.acquire('/workspace/a');
        expect(activeSessionId).toBeUndefined();
    });

    it('session affinity: prefers process with matching sessionId', async () => {
        AcpProcessPool.configure({ maxSize: 4, reservedSlots: 0 });
        // Acquire two concurrently so they get separate processes
        const { client: c1 } = await AcpProcessPool.acquire('/workspace/a');
        const { client: c2 } = await AcpProcessPool.acquire('/workspace/a');
        expect(c1).not.toBe(c2);

        AcpProcessPool.release('/workspace/a', c1, undefined, 'sess-A');
        AcpProcessPool.release('/workspace/a', c2, undefined, 'sess-B');

        // Request with preferSessionId=sess-A should get c1 back
        const { client: picked, activeSessionId } = await AcpProcessPool.acquire(
            '/workspace/a',
            undefined,
            undefined,
            'sess-A',
        );

        expect(picked).toBe(c1);
        expect(activeSessionId).toBe('sess-A');
    });

    it('concurrent requests get separate processes, both survive release', async () => {
        AcpProcessPool.configure({ maxSize: 4, reservedSlots: 0 });

        // Simulate 3 concurrent lanes
        const { client: c1 } = await AcpProcessPool.acquire('/workspace/a');
        const { client: c2 } = await AcpProcessPool.acquire('/workspace/a');
        const { client: c3 } = await AcpProcessPool.acquire('/workspace/a');

        expect(AcpProcessPool.size).toBe(3);
        expect(new Set([c1, c2, c3]).size).toBe(3); // All different

        // Release all — all should survive
        AcpProcessPool.release('/workspace/a', c1, undefined, 'sess-1');
        AcpProcessPool.release('/workspace/a', c2, undefined, 'sess-2');
        AcpProcessPool.release('/workspace/a', c3, undefined, 'sess-3');

        expect(AcpProcessPool.size).toBe(3);
        expect(AcpProcessPool.idle).toBe(3);

        // Next acquire for sess-2 should get c2 back (affinity)
        const { client: reused } = await AcpProcessPool.acquire('/workspace/a', undefined, undefined, 'sess-2');
        expect(reused).toBe(c2);
    });

    // ── Affinity-aware eviction ──────────────────────────────────

    it('evicts session-less process before session-holding process', async () => {
        AcpProcessPool.configure({ maxSize: 2, reservedSlots: 0 });

        const { client: c1 } = await AcpProcessPool.acquire('/workspace/a');
        const { client: c2 } = await AcpProcessPool.acquire('/workspace/b');

        // c1 released WITHOUT session, c2 released WITH session
        AcpProcessPool.release('/workspace/a', c1);
        AcpProcessPool.release('/workspace/b', c2, undefined, 'sess-X');

        // Acquiring /workspace/c should evict c1 (no session) not c2 (has session)
        const { client: c3 } = await AcpProcessPool.acquire('/workspace/c');

        expect(c1.close).toHaveBeenCalled();
        expect(c2.close).not.toHaveBeenCalled();
        expect(AcpProcessPool.size).toBe(2);

        AcpProcessPool.release('/workspace/c', c3);
    });

    it('evicts oldest lastUsedAt within same session tier', async () => {
        AcpProcessPool.configure({ maxSize: 2, reservedSlots: 0 });

        const { client: c1 } = await AcpProcessPool.acquire('/workspace/a');
        const { client: c2 } = await AcpProcessPool.acquire('/workspace/b');

        // Both released with sessions, but c1 released first (older lastUsedAt)
        AcpProcessPool.release('/workspace/a', c1, undefined, 'sess-old');
        // Small delay to ensure different timestamps
        await new Promise((r) => setTimeout(r, 5));
        AcpProcessPool.release('/workspace/b', c2, undefined, 'sess-new');

        const { client: c3 } = await AcpProcessPool.acquire('/workspace/c');

        // c1 should be evicted (older lastUsedAt, same tier)
        expect(c1.close).toHaveBeenCalled();
        expect(c2.close).not.toHaveBeenCalled();

        AcpProcessPool.release('/workspace/c', c3);
    });

    // ── Hard limit & wait queue ──────────────────────────────────

    it('waits when pool is full and all in use, resumes on release', async () => {
        AcpProcessPool.configure({ maxSize: 1, reservedSlots: 0, waitTimeoutMs: 5000 });

        const { client: c1 } = await AcpProcessPool.acquire('/workspace/a');

        // Second acquire should wait — yield to let it reach waitForSlot
        let acquired = false;
        const acquirePromise = AcpProcessPool.acquire('/workspace/b').then((result) => {
            acquired = true;
            return result;
        });
        await new Promise((r) => setTimeout(r, 10));

        expect(AcpProcessPool.waiting).toBe(1);
        expect(acquired).toBe(false);

        // Release c1 — should wake the waiter
        AcpProcessPool.release('/workspace/a', c1);

        const { client: c2 } = await acquirePromise;
        expect(acquired).toBe(true);
        expect(AcpProcessPool.waiting).toBe(0);
        // Waiter evicts the idle c1 to make room for /workspace/b
        expect(c1.close).toHaveBeenCalled();

        AcpProcessPool.release('/workspace/b', c2);
    });

    it('wait queue times out with error', async () => {
        AcpProcessPool.configure({ maxSize: 1, reservedSlots: 0, waitTimeoutMs: 50 });

        const { client: c1 } = await AcpProcessPool.acquire('/workspace/a');

        await expect(AcpProcessPool.acquire('/workspace/b')).rejects.toThrow('timed out');

        expect(AcpProcessPool.waiting).toBe(0);
        AcpProcessPool.release('/workspace/a', c1);
    });

    it('shutdown rejects pending waiters', async () => {
        AcpProcessPool.configure({ maxSize: 1, reservedSlots: 0, waitTimeoutMs: 5000 });

        await AcpProcessPool.acquire('/workspace/a');

        // Start waiting acquire, yield to let it enter the queue
        const acquirePromise = AcpProcessPool.acquire('/workspace/b');
        await new Promise((r) => setTimeout(r, 10));

        expect(AcpProcessPool.waiting).toBe(1);

        // Shutdown should reject the waiter — catch reject to avoid unhandled
        const [, shutdownResult] = await Promise.allSettled([acquirePromise, AcpProcessPool.shutdown()]);

        expect(shutdownResult.status).toBe('fulfilled');
        expect(AcpProcessPool.waiting).toBe(0);
    });

    // ── Reserved slots ───────────────────────────────────────────

    it('normal priority cannot use reserved slots', async () => {
        AcpProcessPool.configure({ maxSize: 2, reservedSlots: 1, waitTimeoutMs: 50 });

        // First acquire uses 1 of 2 slots (effective max for normal = 1)
        const { client: c1 } = await AcpProcessPool.acquire('/workspace/a');

        // Second normal acquire hits effective limit and waits → times out
        await expect(AcpProcessPool.acquire('/workspace/b', undefined, undefined, undefined, 'normal')).rejects.toThrow(
            'timed out',
        );

        AcpProcessPool.release('/workspace/a', c1);
    });

    it('background priority can use reserved slots', async () => {
        AcpProcessPool.configure({ maxSize: 2, reservedSlots: 1, waitTimeoutMs: 50 });

        const { client: c1 } = await AcpProcessPool.acquire('/workspace/a');

        // Background acquire can use reserved slot
        const { client: c2 } = await AcpProcessPool.acquire(
            '/workspace/b',
            undefined,
            undefined,
            undefined,
            'background',
        );

        expect(AcpProcessPool.size).toBe(2);

        AcpProcessPool.release('/workspace/a', c1);
        AcpProcessPool.release('/workspace/b', c2);
    });
});
