/**
 * inngest/agent-run.ts — Unified agent execution with Lane Queue.
 *
 * All agent runs (heartbeat, manual, discord, slack) are routed through
 * this single function, serialized per session key (OpenClaw Lane pattern).
 *
 * Each step delegates to the turn/ module so the execution logic stays
 * in one place and is shared with the TUI / direct invocation path.
 *
 * Lane Queue rules:
 *   - Same sessionId → tasks queue and run in serial
 *   - Different sessionId → tasks run in parallel (up to maxConcurrent)
 *   - Prevents git conflicts within the same session
 */

import { filterResponseText, parseMediaMarkers, type RunResult } from '../agent/runner.js';
import {
    type AgentRunEventData,
    buildAgentContext,
    checkResumable,
    runDeliver,
    runGemini,
    runPostRun,
} from '../agent/turn/index.js';
import type { ProgressReporter } from '../channels/progress-reporter.js';
import { getWorkspacePath, loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { inngest } from './client.js';

const log = createLogger('agent-run');

// Re-export so existing consumers don't break
export type { AgentRunEventData } from '../agent/turn/index.js';

// ── Unified agent execution ──────────────────────────────────────

export const agentRun = inngest.createFunction(
    {
        id: 'agent-run',
        name: 'Agent Run (Lane Queue)',
        concurrency: [
            {
                scope: 'fn',
                key: 'event.data.sessionId',
                limit: 1,
            },
            {
                scope: 'account',
                key: '"global"',
                limit: 4,
            },
        ],
    },
    { event: 'geminiclaw/run' },
    async ({ event, step }) => {
        const data = event.data as AgentRunEventData;
        const config = loadConfig();
        const workspacePath = getWorkspacePath(config);

        const baseParams = {
            sessionId: data.sessionId,
            trigger: data.trigger,
            prompt: data.prompt,
            workspacePath,
            model:
                data.model ??
                (data.trigger === 'heartbeat' && config.heartbeat.model ? config.heartbeat.model : config.model),
            timezone: config.timezone || undefined,
            language: config.language,
            autonomyLevel: config.autonomyLevel,
            maxToolIterations: config.maxToolIterations,
            files: data.files,
            isHomeChannel: data.isHomeChannel,
            isDM: data.isDM,
            channelTopic: data.channelTopic,
            channelContext: data.channelContext,
            channelContextMaxChars: config.experimental.channelContext.maxChars,
            sandbox: config.sandbox,
        };

        const runStart = Date.now();
        log.info('starting', { sessionId: data.sessionId, trigger: data.trigger });

        // Step 0: Resume check
        const resumeCheck = await step.run('check-resume', () => {
            const result = checkResumable({
                sessionId: data.sessionId,
                trigger: data.trigger,
                workspacePath,
            });
            log.info('step:check-resume', { canResume: result.canResume, resumeSessionId: result.resumeSessionId });
            return result;
        });

        // Step 1: Build context
        const { sessionContext } = await step.run('build-context', async () => {
            const t0 = Date.now();
            log.info('step:build-context started', { sessionId: data.sessionId });
            const result = await buildAgentContext(baseParams);
            log.info('step:build-context done', { ms: Date.now() - t0 });
            return result;
        });

        // Step 2: Run Gemini with progress reporter (Inngest-specific)
        const runResult = await step.run('run-gemini', async () => {
            log.info('step:run-gemini started', { sessionId: data.sessionId, model: baseParams.model });

            const progressReporter = await createProgressReporter(data, config);
            await progressReporter?.start();

            let runResult: RunResult | undefined;
            let progressFinalized = false;
            try {
                runResult = await runGemini({
                    ...baseParams,
                    sessionContext,
                    resumeCheck,
                    onEvent: progressReporter ? (e) => progressReporter.onEvent(e) : undefined,
                });
                log.info('step:run-gemini done', {
                    sessionId: data.sessionId,
                    tokens: runResult.tokens.total,
                    toolCalls: runResult.toolCalls.length,
                    heartbeatOk: runResult.heartbeatOk,
                    error: runResult.error,
                });
            } finally {
                if (progressReporter) {
                    let finalText: string | undefined;
                    const responseText = runResult?.responseText ?? '';
                    if (responseText && !runResult?.error) {
                        const filtered = filterResponseText(responseText);
                        const { mediaSrcs, cleanedText } = parseMediaMarkers(filtered);
                        if (cleanedText && mediaSrcs.length === 0) {
                            finalText = cleanedText;
                        }
                    }
                    await progressReporter.finish(finalText);

                    const chatReporter = progressReporter as { wasFinalized?: boolean };
                    progressFinalized = chatReporter.wasFinalized === true;
                }
            }

            const result = runResult as RunResult;
            return {
                ...result,
                timestamp: result.timestamp.toISOString(),
                toolCalls: result.toolCalls.map((tc) => ({
                    ...tc,
                    startedAt: tc.startedAt.toISOString(),
                })),
                _progressFinalized: progressFinalized,
            };
        });

        // Step 3+4: Post-run and deliver run in parallel.
        // Deliver (reply) must not be blocked by post-run (memory flush
        // can take 30-90s via ACP).
        const deserializeResult = (): RunResult => ({
            ...runResult,
            timestamp: new Date(runResult.timestamp as unknown as string),
            toolCalls: runResult.toolCalls.map((tc) => ({
                ...tc,
                startedAt: new Date(tc.startedAt as unknown as string),
            })),
        });

        await Promise.allSettled([
            step.run('post-run', async () => {
                const t0 = Date.now();
                log.info('step:post-run started', { sessionId: data.sessionId });
                await runPostRun({ params: baseParams, runResult: deserializeResult() });
                log.info('step:post-run done', { ms: Date.now() - t0 });
            }),
            step.run('deliver', async () => {
                await runDeliver({
                    params: baseParams,
                    runResult: deserializeResult(),
                    eventData: data,
                    config,
                    progressFinalized: (runResult as Record<string, unknown>)._progressFinalized === true,
                    workspacePath,
                });
            }),
        ]);

        log.info('done', { sessionId: data.sessionId, trigger: data.trigger, totalMs: Date.now() - runStart });
        return {
            success: true,
            sessionId: data.sessionId,
            trigger: data.trigger,
            heartbeatOk: runResult.heartbeatOk,
            responseLength: runResult.responseText.length,
        };
    },
);

// ── Progress reporter factory ─────────────────────────────────────

async function createProgressReporter(
    data: AgentRunEventData,
    config: ReturnType<typeof loadConfig>,
): Promise<ProgressReporter | undefined> {
    if (data.serializedThread) {
        try {
            const { ThreadImpl } = await import('chat');
            const { createChat } = await import('../channels/chat-setup.js');
            await createChat(config);

            const serialized = JSON.parse(data.serializedThread);
            const thread = ThreadImpl.fromJSON(serialized);

            const { ChatProgressReporter } = await import('../channels/chat-progress.js');
            const workspacePath = getWorkspacePath(config);
            log.info('progress reporter created', { threadId: thread.id });
            return new ChatProgressReporter(thread, workspacePath, data.sessionId);
        } catch (err) {
            log.warn('failed to create progress reporter', { error: String(err) });
            return undefined;
        }
    }

    return undefined;
}
