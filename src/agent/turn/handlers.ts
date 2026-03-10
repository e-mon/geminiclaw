/**
 * agent/turn/handlers.ts — Generic handler array runner.
 *
 * Provides a typed, declarative pattern for executing independent
 * side-effects with per-handler error semantics and automatic timing.
 */

import { createLogger } from '../../logger.js';

const log = createLogger('turn-handlers');

export interface Handler<C> {
    readonly id: string;
    readonly errorSemantics: 'fail-closed' | 'fail-open';
    readonly condition?: (ctx: C) => boolean;
    readonly run: (ctx: C) => Promise<void>;
}

/**
 * Execute an ordered array of handlers sequentially with per-handler error control.
 *
 * - `fail-closed`: error propagates (caller sees the throw)
 * - `fail-open`: error is logged and swallowed
 * - Handlers with a `condition` that returns false are skipped
 * - Each handler gets automatic timing + structured logging
 */
export async function runHandlers<C>(timing: string, handlers: readonly Handler<C>[], ctx: C): Promise<void> {
    for (const h of handlers) {
        if (!isEligible(timing, h, ctx)) continue;
        await executeHandler(timing, h, ctx);
    }
}

/**
 * Execute all handlers concurrently via Promise.allSettled.
 *
 * All handlers MUST be fail-open — there is no ordering guarantee and
 * one handler's failure must not affect others. Condition checks and
 * per-handler timing/logging are identical to the sequential variant.
 */
export async function runHandlersParallel<C>(timing: string, handlers: readonly Handler<C>[], ctx: C): Promise<void> {
    const eligible = handlers.filter((h) => isEligible(timing, h, ctx));
    await Promise.allSettled(eligible.map((h) => executeHandler(timing, h, ctx)));
}

function isEligible<C>(timing: string, h: Handler<C>, ctx: C): boolean {
    if (h.condition && !h.condition(ctx)) {
        log.info(`skip ${h.id}`, { timing });
        return false;
    }
    return true;
}

async function executeHandler<C>(timing: string, h: Handler<C>, ctx: C): Promise<void> {
    const t0 = Date.now();
    try {
        await h.run(ctx);
        log.info(`${h.id} ok`, { timing, ms: Date.now() - t0 });
    } catch (err) {
        if (h.errorSemantics === 'fail-closed') throw err;
        log.warn(`${h.id} failed`, {
            timing,
            ms: Date.now() - t0,
            error: String(err).substring(0, 200),
        });
    }
}
