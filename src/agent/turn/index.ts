/**
 * agent/turn/index.ts — Turn lifecycle barrel export + overview.
 *
 * ┌──────────────────┬──────────────────────────┬───────┬─────────┐
 * │ TIMING           │ STEP                     │ ERROR │ PATTERN │
 * ├──────────────────┼──────────────────────────┼───────┼─────────┤
 * │ pre-execution    │ checkResumable           │ close │ fn      │
 * │                  │ buildAgentContext         │ close │ fn      │
 * │                  │   ├ ensureStaticFiles     │       │         │
 * │                  │   ├ ensureGeminiSettings  │       │         │
 * │                  │   ├ ensureSandboxImage     │       │         │
 * │                  │   └ loadSessionHistory    │       │         │
 * ├──────────────────┼──────────────────────────┼───────┼─────────┤
 * │ execution        │ runGemini                │ close │ fn      │
 * │                  │   ├ spawnGeminiAcp        │       │         │
 * │                  │   ├ handleResumeFailure   │ retry │         │
 * │                  │   └ handleOverflow        │ retry │         │
 * ├──────────────────┼──────────────────────────┼───────┼─────────┤
 * │ postRun          │ saveSession              │ close │ arr     │
 * │                  │ trackUsage               │ close │ arr     │
 * │                  │ memoryFlushAndReindex     │ open  │ arr     │
 * ├──────────────────┼──────────────────────────┼───────┼─────────┤
 * │ deliver          │ generateTitle            │ open  │ arr     │
 * │ (Inngest only)   │ notifyHeartbeat          │ open  │ arr     │
 * │                  │ sendReply                │ open  │ arr     │
 * └──────────────────┴──────────────────────────┴───────┴─────────┘
 *
 * fn  = pipeline function (data-producing, explicit call)
 * arr = handler array (independent side-effects, runHandlers<C>)
 *
 * External lifecycle (pool/cron/startup/shutdown) is managed by:
 *   pool    → process-pool.ts (idle timeout, eviction, replenish, shutdown)
 *   cron    → inngest/ (heartbeat, daily-summary, job-runner)
 *   startup → serve.ts (backfill, schedule, pre-warm)
 *   shutdown → start.ts (gateway abort, tailscale, pool, server close)
 */

// ── Execution ──
export { runGemini } from './execution.js';
// ── Deliver ──
export { runDeliver } from './finalize.js';
// ── Handlers (for testing) ──
export { type Handler, runHandlers, runHandlersParallel } from './handlers.js';
// ── Model offload ──
export { clearOffloadState, getOffloadState, resolveModelWithOffload } from './model-offload.js';
// ── Post-run ──
export { runPostRun } from './post-execution.js';
// ── Pre-execution ──
export { buildAgentContext, checkResumable } from './pre-execution.js';
// ── TUI entry point ──
export { runAgentTurn } from './runner.js';
// ── Sandbox ──
export {
    buildDockerSandboxMounts,
    ensureSandboxImage,
    isDockerAvailable,
} from './sandbox.js';
// ── Types ──
export type {
    AgentRunEventData,
    DeliverContext,
    InputFile,
    PostRunContext,
    ResumeCheck,
    RunTurnParams,
} from './types.js';
