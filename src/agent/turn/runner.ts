/**
 * agent/turn/runner.ts — Full turn wrapper for TUI / direct callers.
 *
 * Calls the turn lifecycle functions sequentially without Inngest step durability.
 * The Inngest daemon wraps each step individually for retry.
 */

import type { RunResult } from '../runner.js';
import { runGemini } from './execution.js';
import { runPostRun } from './post-execution.js';
import { buildAgentContext, checkResumable } from './pre-execution.js';
import type { RunTurnParams } from './types.js';

/**
 * Full turn: check resume → build context → run Gemini → post-run.
 *
 * Used by TUI (geminiclaw run) and direct callers. The Inngest daemon wraps
 * the individual step functions in step.run() for retry durability instead
 * of calling this wrapper.
 */
export async function runAgentTurn(params: RunTurnParams): Promise<RunResult> {
    const resumeCheck = checkResumable(params);
    const { sessionContext } = await buildAgentContext(params);
    const result = await runGemini({ ...params, sessionContext, resumeCheck });
    await runPostRun({ params, runResult: result });
    return result;
}
