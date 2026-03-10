/**
 * channels/progress-reporter.ts — Channel-agnostic progress reporting interface.
 *
 * ProgressReporter decouples the agent execution layer from channel-specific
 * formatting. Each channel (Discord, Slack, TUI, …) provides its own
 * implementation that translates StreamEvents into the appropriate UI updates.
 *
 * Usage pattern (inside agent-run step):
 *
 *   const reporter = await createProgressReporter(data, config);
 *   await reporter?.start();
 *   try {
 *     const result = await runGemini({ ...params, onEvent: (e) => reporter?.onEvent(e) });
 *   } finally {
 *     await reporter?.finish();
 *   }
 */

import type { StreamEvent } from '../agent/runner.js';

export interface ProgressReporter {
    /**
     * Called once before the agent run starts.
     * Implementations typically send an initial "processing…" indicator.
     */
    start(): Promise<void>;

    /**
     * Called synchronously for every StreamEvent during the run.
     * Must not throw — any async work should be fire-and-forget.
     */
    onEvent(event: StreamEvent): void;

    /**
     * Called once after the agent run finishes (success or error).
     *
     * When finalText is provided and short enough, implementations may
     * edit the progress message into the final reply instead of deleting
     * it (preview direct finalization). This avoids the delete+repost
     * flicker and lets users see the response faster.
     */
    finish(finalText?: string): Promise<void>;
}
