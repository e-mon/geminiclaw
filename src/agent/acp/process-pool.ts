/**
 * agent/acp/process-pool.ts — ACP process pool with K8s-inspired scheduling.
 *
 * Pool lifecycle: idle timeout, eviction, replenish, shutdown.
 * onSessionEnd callback is configured by serve.ts at startup.
 * See also: serve.ts (startup/config), start.ts (shutdown), turn/index.ts (turn lifecycle).
 *
 * ## Scheduling model (inspired by K8s scheduler)
 *
 * acquire() uses a **Filter → Score → Bind** pipeline:
 *   1. Filter: idle, alive, matching key (cwd+model)
 *   2. Score:  affinity match (100) > free/sessionless (50) > bound to other session (1, last resort)
 *   3. Bind:   check out highest-scoring candidate
 *
 * Session-holding processes score low (1) for non-affinity requests,
 * acting as a soft taint. They CAN be reused as a last resort (e.g. when
 * pool is full), but free processes are always preferred. Each process
 * tracks ALL sessions it has loaded (sessionIds Set), since Gemini CLI
 * never removes sessions from its in-memory Map.
 *
 * ## Eviction strategy
 *
 * When spawning requires freeing a slot, the pool evicts the lowest-value
 * idle entry: sessionless first, then LRU within the same tier.
 *
 * ## Hard limit & wait queue
 *
 * When all `maxSize` slots are occupied (in-use + idle), callers wait
 * on a FIFO queue rather than exceeding the limit. `reservedSlots`
 * keeps headroom for background tasks (heartbeat, summarize, flush).
 */

import { createLogger } from '../../logger.js';
import { AcpClient, type SandboxMode } from './client.js';

const log = createLogger('acp-pool');

/** Callback fired when a session-holding process leaves the pool (idle timeout or eviction). */
type SessionEndCallback = (sessionId: string) => void;

interface PoolEntry {
    client: AcpClient;
    /**
     * All ACP session IDs ever loaded in this process (for scoring).
     *
     * Gemini CLI never removes sessions from its in-memory Map, so every
     * session created or loaded on a process remains usable for the
     * lifetime of that process. Used to determine bound vs free (scoring).
     */
    sessionIds: Set<string>;
    /**
     * The session most recently used on this process.
     *
     * Only THIS session is safe for in-process reuse (skipping loadSession),
     * because its Gemini CLI internal history is guaranteed up-to-date.
     * Other sessions in `sessionIds` may have been used on other processes
     * since, making their local state stale.
     */
    lastSessionId?: string;
    /** Timer for idle expiration. */
    idleTimer?: ReturnType<typeof setTimeout>;
    /** Whether this client is currently checked out. */
    inUse: boolean;
    /** cwd + model combo this process was spawned for. */
    key: string;
    /** Epoch ms when this entry was last released (for LRU scoring). */
    lastUsedAt: number;
}

/** Resolve function for a queued acquire() caller. */
interface WaitEntry {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_IDLE_MS = 60 * 60_000; // 60 minutes
/** Total pool capacity: Inngest global limit (4) + headroom for internal tasks. */
const DEFAULT_MAX_POOL_SIZE = 6;
/** Slots reserved for background tasks (heartbeat, compaction, flush). */
const DEFAULT_RESERVED_SLOTS = 2;
/** Minimum number of idle processes to keep warm (avoids cold starts). */
const DEFAULT_MIN_IDLE = 1;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000; // 1 minute

// biome-ignore lint/complexity/noStaticOnlyClass: singleton pattern used for process lifecycle management
export class AcpProcessPool {
    private static pool: PoolEntry[] = [];
    private static idleMs = DEFAULT_IDLE_MS;
    private static maxSize = DEFAULT_MAX_POOL_SIZE;
    private static reservedSlots = DEFAULT_RESERVED_SLOTS;
    private static minIdle = DEFAULT_MIN_IDLE;
    private static waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
    private static exitHandlerRegistered = false;
    private static waitQueue: WaitEntry[] = [];
    private static sessionEndCallback?: SessionEndCallback;

    /** Configure pool parameters. Call once at startup if needed. */
    static configure(opts: {
        idleMinutes?: number;
        maxSize?: number;
        reservedSlots?: number;
        minIdle?: number;
        waitTimeoutMs?: number;
        onSessionEnd?: SessionEndCallback;
    }): void {
        if (opts.idleMinutes !== undefined) AcpProcessPool.idleMs = opts.idleMinutes * 60_000;
        if (opts.maxSize !== undefined) AcpProcessPool.maxSize = opts.maxSize;
        if (opts.reservedSlots !== undefined) AcpProcessPool.reservedSlots = opts.reservedSlots;
        if (opts.minIdle !== undefined) AcpProcessPool.minIdle = opts.minIdle;
        if (opts.waitTimeoutMs !== undefined) AcpProcessPool.waitTimeoutMs = opts.waitTimeoutMs;
        if (opts.onSessionEnd !== undefined) AcpProcessPool.sessionEndCallback = opts.onSessionEnd;
    }

    /**
     * Acquire an ACP client from the pool.
     *
     * Uses a Filter → Score → Bind pipeline to select the best idle process,
     * then falls back to spawning, eviction, or waiting.
     *
     * @param priority - 'normal' for user requests, 'background' for heartbeat/summarize/flush.
     *   Background requests can use reserved slots that normal requests cannot.
     */
    static async acquire(
        cwd: string,
        env?: Record<string, string>,
        model?: string,
        preferSessionId?: string,
        priority: 'normal' | 'background' = 'normal',
        sandbox: SandboxMode = true,
    ): Promise<{ client: AcpClient; activeSessionId?: string }> {
        const key = `${cwd}::${model ?? ''}`;

        AcpProcessPool.evictDead();

        // ── Filter → Score → Bind ────────────────────────────────
        //
        // Score: affinity (100) > free (50) > bound to other (1, last resort)
        // Tiebreak by score tier:
        //   100/50: most recently used first (freshest process)
        //   1:      least recently used first (least valuable affinity to lose)
        const candidates = AcpProcessPool.pool
            .filter((e) => !e.inUse && !e.client.closed && e.key === key)
            .map((e) => ({ entry: e, score: AcpProcessPool.scoreForReuse(e, preferSessionId) }))
            .sort((a, b) => {
                if (a.score !== b.score) return b.score - a.score;
                // For bound (score=1): prefer oldest (least valuable affinity)
                // For free/affinity: prefer newest (freshest process)
                return a.score === 1
                    ? a.entry.lastUsedAt - b.entry.lastUsedAt
                    : b.entry.lastUsedAt - a.entry.lastUsedAt;
            });

        const best = candidates[0];
        if (best) {
            AcpProcessPool.checkOut(best.entry);
            // activeSessionId: only safe for in-process reuse when this process
            // was the LAST one to use this session (lastSessionId matches).
            // sessionIds.has() alone is insufficient — the session may have been
            // used on another process since, making the local state stale.
            const canReuseInProcess = preferSessionId && best.entry.lastSessionId === preferSessionId;
            const label =
                best.score === 100
                    ? 'pool: affinity hit'
                    : best.score === 50
                      ? 'pool: reusing free'
                      : 'pool: reusing bound';
            log.info(label, {
                sessionId: canReuseInProcess ? preferSessionId?.substring(0, 8) : undefined,
                sessions: best.entry.sessionIds.size,
                score: best.score,
                poolSize: AcpProcessPool.pool.length,
            });
            return { client: best.entry.client, activeSessionId: canReuseInProcess ? preferSessionId : undefined };
        }

        // ── No eligible idle → spawn or evict ────────────────────
        const effectiveMax =
            priority === 'background' ? AcpProcessPool.maxSize : AcpProcessPool.maxSize - AcpProcessPool.reservedSlots;

        if (AcpProcessPool.pool.length < effectiveMax) {
            // Proactively evict sessionless idle with a different key —
            // they will never be reused and waste pool slots (e.g.
            // pre-warmed with no model vs actual requests with model=flash).
            const stale = AcpProcessPool.pool.find(
                (e) => !e.inUse && !e.client.closed && e.key !== key && e.sessionIds.size === 0,
            );
            if (stale) {
                AcpProcessPool.removeEntry(stale);
                await stale.client
                    .close()
                    .catch((err) => log.warn('pool: close failed during evict', { error: String(err) }));
                log.info('pool: evicted stale idle', {
                    evictedKey: stale.key.substring(stale.key.length - 40),
                    poolSize: AcpProcessPool.pool.length,
                });
            }
            return AcpProcessPool.spawnNew(cwd, env, model, key, sandbox);
        }

        // At capacity → evict lowest-value idle, spawn new
        const evicted = await AcpProcessPool.evictLowestValue();
        if (evicted) {
            return AcpProcessPool.spawnNew(cwd, env, model, key, sandbox);
        }

        // ── All slots busy → wait queue ──────────────────────────
        log.warn('pool: all slots busy, entering wait queue', {
            poolSize: AcpProcessPool.pool.length,
            max: effectiveMax,
            queueLength: AcpProcessPool.waitQueue.length,
        });

        await AcpProcessPool.waitForSlot();
        return AcpProcessPool.acquire(cwd, env, model, preferSessionId, priority, sandbox);
    }

    /**
     * Return a client to the pool.
     *
     * Starts the idle timeout — if not reacquired before it expires,
     * the process is closed and removed. Wakes up the next waiter
     * in the queue if any.
     */
    static release(_cwd: string, client: AcpClient, _model?: string, lastSessionId?: string): void {
        const entry = AcpProcessPool.pool.find((e) => e.client === client);
        if (!entry) {
            client.close().catch((err) => log.warn('pool: close failed for untracked client', { error: String(err) }));
            return;
        }

        if (client.closed) {
            AcpProcessPool.removeEntry(entry);
            AcpProcessPool.wakeNextWaiter();
            return;
        }

        entry.inUse = false;
        if (lastSessionId) entry.sessionIds.add(lastSessionId);
        entry.lastSessionId = lastSessionId;
        entry.lastUsedAt = Date.now();
        client.setUpdateHandler(undefined);

        // Session-holding processes get longer grace period (more valuable)
        const idleTimeout =
            entry.sessionIds.size > 0 ? AcpProcessPool.idleMs : Math.min(AcpProcessPool.idleMs, 10 * 60_000);

        entry.idleTimer = setTimeout(async () => {
            if (!entry.inUse) {
                const sessions = new Set(entry.sessionIds);
                AcpProcessPool.removeEntry(entry);
                await client
                    .close()
                    .catch((err) => log.warn('pool: close failed on idle timeout', { error: String(err) }));
                log.info('pool: idle timeout', {
                    key: entry.key.substring(entry.key.length - 40),
                    sessions: sessions.size,
                    poolSize: AcpProcessPool.pool.length,
                });
                AcpProcessPool.notifySessionEnds(sessions);
                AcpProcessPool.replenishIfNeeded(entry.key).catch(() => {});
                AcpProcessPool.wakeNextWaiter();
            }
        }, idleTimeout);

        AcpProcessPool.wakeNextWaiter();
    }

    /** Gracefully close all pooled clients. */
    static async shutdown(): Promise<void> {
        log.info('pool: shutting down', { count: AcpProcessPool.pool.length });

        for (const waiter of AcpProcessPool.waitQueue) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error('Pool shutting down'));
        }
        AcpProcessPool.waitQueue = [];

        const promises: Promise<void>[] = [];
        for (const entry of AcpProcessPool.pool) {
            if (entry.idleTimer) clearTimeout(entry.idleTimer);
            promises.push(
                entry.client.close().catch((err) => log.warn('pool: close failed on shutdown', { error: String(err) })),
            );
        }
        AcpProcessPool.pool = [];
        await Promise.all(promises);
    }

    /** Number of processes in the pool (idle + in-use). */
    static get size(): number {
        return AcpProcessPool.pool.length;
    }

    /** Number of idle processes. */
    static get idle(): number {
        return AcpProcessPool.pool.filter((e) => !e.inUse && !e.client.closed).length;
    }

    /** Number of callers waiting for a slot. */
    static get waiting(): number {
        return AcpProcessPool.waitQueue.length;
    }

    /** Return a snapshot of the pool state for dashboard display. */
    static snapshot(): {
        maxSize: number;
        reservedSlots: number;
        entries: {
            key: string;
            inUse: boolean;
            sessionIds: string[];
            lastSessionId?: string;
            lastUsedAt: number;
            closed: boolean;
        }[];
        waiting: number;
    } {
        return {
            maxSize: AcpProcessPool.maxSize,
            reservedSlots: AcpProcessPool.reservedSlots,
            entries: AcpProcessPool.pool.map((e) => ({
                key: e.key,
                inUse: e.inUse,
                sessionIds: [...e.sessionIds],
                lastSessionId: e.lastSessionId,
                lastUsedAt: e.lastUsedAt,
                closed: e.client.closed,
            })),
            waiting: AcpProcessPool.waitQueue.length,
        };
    }

    /** Reset pool state (for testing). */
    static async _reset(): Promise<void> {
        await AcpProcessPool.shutdown();
        AcpProcessPool.idleMs = DEFAULT_IDLE_MS;
        AcpProcessPool.maxSize = DEFAULT_MAX_POOL_SIZE;
        AcpProcessPool.reservedSlots = DEFAULT_RESERVED_SLOTS;
        AcpProcessPool.minIdle = DEFAULT_MIN_IDLE;
        AcpProcessPool.waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
        AcpProcessPool.sessionEndCallback = undefined;
    }

    // ── Scoring ──────────────────────────────────────────────────

    /**
     * Score an idle entry for reuse.
     *
     * Continuous scoring avoids hard binary cutoffs — bound processes
     * CAN be reused as a last resort (better than evict+spawn).
     *
     *   100 = affinity match (session === preferSessionId, in-process reuse)
     *    50 = free (no session held, no affinity to lose)
     *     1 = bound to other session (last resort, loses other session's affinity)
     */
    private static scoreForReuse(entry: PoolEntry, preferSessionId?: string): number {
        if (preferSessionId && entry.sessionIds.has(preferSessionId)) return 100;
        if (entry.sessionIds.size === 0) return 50;
        return 1;
    }

    /**
     * Score an idle entry for eviction (lower = evict first).
     *
     * Tiers: sessionless (0) < session-holding (1)
     * Within tier: older lastUsedAt evicted first.
     */
    private static scoreForEviction(entry: PoolEntry): number {
        const tier = entry.sessionIds.size > 0 ? 1 : 0;
        return tier * 1e15 + entry.lastUsedAt;
    }

    // ── Private ──────────────────────────────────────────────────

    /** Notify session end for all sessions held by an entry. */
    private static notifySessionEnds(sessionIds: Set<string>): void {
        if (!AcpProcessPool.sessionEndCallback) return;
        for (const sid of sessionIds) {
            try {
                AcpProcessPool.sessionEndCallback(sid);
            } catch (err) {
                log.warn('sessionEnd callback error', { error: String(err).substring(0, 200) });
            }
        }
    }

    private static async spawnNew(
        cwd: string,
        env: Record<string, string> | undefined,
        model: string | undefined,
        key: string,
        sandbox: SandboxMode = true,
    ): Promise<{ client: AcpClient; activeSessionId?: string }> {
        const client = new AcpClient(cwd, env, model, sandbox);
        await client.initialize();

        const entry: PoolEntry = {
            client,
            sessionIds: new Set(),
            lastSessionId: undefined,
            inUse: true,
            key,
            lastUsedAt: Date.now(),
        };
        AcpProcessPool.pool.push(entry);
        AcpProcessPool.registerExitHandler();

        log.info('pool: spawned new', {
            key: key.substring(key.length - 40),
            poolSize: AcpProcessPool.pool.length,
        });
        return { client };
    }

    private static checkOut(entry: PoolEntry): void {
        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = undefined;
        }
        entry.inUse = true;
    }

    private static removeEntry(entry: PoolEntry): void {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        const idx = AcpProcessPool.pool.indexOf(entry);
        if (idx >= 0) AcpProcessPool.pool.splice(idx, 1);
    }

    private static evictDead(): void {
        const dead = AcpProcessPool.pool.filter((e) => e.client.closed);
        for (const entry of dead) {
            AcpProcessPool.removeEntry(entry);
            log.info('pool: evicted dead', { key: entry.key.substring(entry.key.length - 40) });
        }
    }

    /** Evict the lowest-value idle entry to free a slot. */
    private static async evictLowestValue(): Promise<boolean> {
        const idle = AcpProcessPool.pool.filter((e) => !e.inUse && !e.client.closed);
        if (idle.length === 0) return false;

        idle.sort((a, b) => AcpProcessPool.scoreForEviction(a) - AcpProcessPool.scoreForEviction(b));

        // biome-ignore lint/style/noNonNullAssertion: idle.length > 0 checked above
        const victim = idle[0]!;
        const victimSessions = new Set(victim.sessionIds);
        AcpProcessPool.removeEntry(victim);
        await victim.client
            .close()
            .catch((err) => log.warn('pool: close failed during eviction', { error: String(err) }));
        log.info('pool: evicted for spawn', {
            key: victim.key.substring(victim.key.length - 40),
            sessions: victimSessions.size,
            lastUsedAt: new Date(victim.lastUsedAt).toISOString(),
            poolSize: AcpProcessPool.pool.length,
        });
        AcpProcessPool.notifySessionEnds(victimSessions);
        return true;
    }

    private static waitForSlot(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = AcpProcessPool.waitQueue.findIndex((w) => w.resolve === resolve);
                if (idx >= 0) AcpProcessPool.waitQueue.splice(idx, 1);
                reject(
                    new Error(
                        `ACP pool: timed out waiting for slot (${AcpProcessPool.waitTimeoutMs}ms, ` +
                            `pool=${AcpProcessPool.pool.length}, queue=${AcpProcessPool.waitQueue.length})`,
                    ),
                );
            }, AcpProcessPool.waitTimeoutMs);

            AcpProcessPool.waitQueue.push({ resolve, reject, timer });
        });
    }

    private static wakeNextWaiter(): void {
        const waiter = AcpProcessPool.waitQueue.shift();
        if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve();
        }
    }

    private static async replenishIfNeeded(lastKey: string): Promise<void> {
        const idleCount = AcpProcessPool.pool.filter((e) => !e.inUse && !e.client.closed).length;
        if (idleCount >= AcpProcessPool.minIdle) return;
        if (AcpProcessPool.pool.length >= AcpProcessPool.maxSize) return;

        const [cwd, model] = lastKey.split('::') as [string, string];
        try {
            const { client } = await AcpProcessPool.spawnNew(cwd, undefined, model || undefined, lastKey, true);
            AcpProcessPool.release(cwd, client, model || undefined);
            log.info('pool: replenished idle', {
                key: lastKey.substring(lastKey.length - 40),
                poolSize: AcpProcessPool.pool.length,
            });
        } catch (err) {
            log.warn('pool: replenish failed', { error: String(err).substring(0, 200) });
        }
    }

    private static registerExitHandler(): void {
        if (AcpProcessPool.exitHandlerRegistered) return;
        AcpProcessPool.exitHandlerRegistered = true;
        process.on('exit', () => {
            for (const entry of AcpProcessPool.pool) {
                entry.client.forceKill();
            }
        });
    }
}
