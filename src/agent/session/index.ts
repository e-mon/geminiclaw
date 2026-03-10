/**
 * agent/session/index.ts — Barrel export for the session module.
 */

export {
    buildSessionContinuation,
    type ContinuationResult,
    renderContinuation,
    type TopicDigest,
} from './continuation.js';
export {
    backfillMissingDailySummaries,
    generateDailySummary,
    generateHeartbeatActivityLog,
    todayInTimezone,
    toLocalDate,
    toLocalDateTime,
    toLocalDateTimeSec,
    toLocalTime,
} from './daily-summary.js';
export { type FlushDeps, silentMemoryFlush } from './flush.js';
export { generateHeartbeatDigest } from './heartbeat-digest.js';
export { SessionStore, todayDateString } from './store.js';
export { generateSessionSummary } from './summary.js';
export { buildFallbackTitle, generateSessionTitle, parseSerializedThread, renameDiscordThread } from './title.js';
export type { SessionEntry } from './types.js';
