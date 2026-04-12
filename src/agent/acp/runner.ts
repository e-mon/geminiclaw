/**
 * agent/acp/runner.ts — ACP-based Gemini execution (replaces spawnGemini).
 *
 * Drop-in replacement for the old stream-json based `spawnGemini()`.
 * Uses AcpClient + AcpProcessPool to maintain persistent connections
 * and converts ACP notifications into StreamEvents for RunResultBuilder.
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { createLogger } from '../../logger.js';
import { clearStaleFiles, listAllPending } from '../ask-user-state.js';
import {
    calculateMaxToolResultChars,
    type RunResult,
    RunResultBuilder,
    type SpawnGeminiOptions,
    trimToolResult,
} from '../runner.js';
import type { AcpClient, SandboxMode } from './client.js';
import { AcpEventMapper, extractModelVersion, extractUsageMetadata, synthesizeResultEvent } from './event-mapper.js';
import { AcpProcessPool } from './process-pool.js';
import type { AcpMcpServerEntry, AcpPromptPart } from './types.js';

const log = createLogger('acp-runner');

/** Timeout while ask_user tool blocks waiting for human input (matches MCP tool's 30 min). */
const ASK_USER_TIMEOUT_MS = 31 * 60 * 1000;

/** Active laneSessionId → AcpClient mapping for external abort. */
const activeRuns = new Map<string, { client: AcpClient; sessionId: string }>();

/**
 * Abort an active session by lane sessionId.
 *
 * Scans activeRuns for a matching laneSessionId and issues ACP cancel.
 * Returns true if a running session was found and cancelled.
 */
export function abortSession(targetLaneSessionId: string): boolean {
    const entry = activeRuns.get(targetLaneSessionId);
    if (!entry) return false;
    entry.client.cancel(entry.sessionId);
    return true;
}

/**
 * Switch the model on the first active session.
 *
 * Uses `unstable_setSessionModel` — falls back gracefully if unavailable.
 * Returns the laneSessionId that was switched, or undefined if no active session.
 */
export async function switchActiveModel(modelId: string): Promise<string | undefined> {
    for (const [laneSessionId, { client, sessionId }] of activeRuns) {
        await client.setSessionModel(sessionId, modelId);
        return laneSessionId;
    }
    return undefined;
}

export interface SpawnGeminiAcpOptions extends SpawnGeminiOptions {
    /** MCP server configurations to inject via session/new. */
    mcpServers?: AcpMcpServerEntry[];
    /** When set, loads an existing ACP session instead of creating a new one. */
    resumeSessionId?: string;
    /** Lane sessionId — used for abort routing (distinct from ACP sessionId). */
    laneSessionId?: string;
    /** Hard timeout in ms. Default: 15 minutes. */
    timeoutMs?: number;
    /** Pool priority. 'background' can use reserved slots (heartbeat/summarize/flush). */
    poolPriority?: 'normal' | 'background';
    /** Sandbox mode: true (auto-detect), false (disabled), 'seatbelt', or 'docker'. */
    sandbox?: SandboxMode;
    /** Multimodal prompt parts (images, audio) to send alongside text. */
    multimodalParts?: AcpPromptPart[];
}

/**
 * Execute a Gemini prompt via ACP protocol.
 *
 * Accepts the same SpawnGeminiOptions as the old spawnGemini() plus
 * ACP-specific fields (mcpServers, resumeSessionId).
 */
export async function spawnGeminiAcp(options: SpawnGeminiAcpOptions): Promise<RunResult> {
    const startMs = Date.now();
    const maxToolIterations = options.maxToolIterations ?? 50;
    const maxToolResultChars = calculateMaxToolResultChars(options.model ?? '');
    const builder = new RunResultBuilder(options.trigger ?? 'manual', maxToolIterations);

    // Truncate debug file at run start
    if (options.debugFile) {
        try {
            writeFileSync(options.debugFile, '', 'utf-8');
        } catch {
            // Non-fatal
        }
    }

    let client: AcpClient | undefined;
    let sessionId: string | undefined;
    let resolvedModelId: string | undefined;
    let actualModelVersion: string | undefined;
    let killed = false;
    let cancelled = false;
    let timedOut = false;

    try {
        // Acquire client from pool
        log.info('acquiring ACP client', { resume: !!options.resumeSessionId });
        const acquireMs = Date.now();
        const poolResult = await AcpProcessPool.acquire(
            options.cwd,
            options.env,
            options.model,
            options.resumeSessionId,
            options.poolPriority ?? 'normal',
            options.sandbox ?? true,
        );
        client = poolResult.client;
        log.info('ACP client acquired', {
            ms: Date.now() - acquireMs,
            activeSessionId: poolResult.activeSessionId?.substring(0, 8),
        });

        // Inject GEMINICLAW_RUN_ID into command-based MCP server env so
        // ask-user pending files carry the correct runId for cross-session
        // scoping. Without this, Docker sandbox MCP servers don't inherit
        // the host process env and all runners pick up each other's pending files.
        if (options.mcpServers) {
            for (const srv of options.mcpServers) {
                const existing = srv.env ?? [];
                if (!existing.some((e) => e.name === 'GEMINICLAW_RUN_ID')) {
                    srv.env = [...existing, { name: 'GEMINICLAW_RUN_ID', value: client.runId }];
                }
            }
        }

        // Create, load, or reuse session.
        // If the pool returned a client that already has the desired session
        // active in-process, skip loadSession entirely — this avoids the
        // costly replay of all prior notifications.
        const sessionMs = Date.now();
        const canReuseInProcess = options.resumeSessionId && poolResult.activeSessionId === options.resumeSessionId;

        if (canReuseInProcess && options.resumeSessionId) {
            log.info('reusing in-process ACP session (skipping loadSession)', {
                sessionId: options.resumeSessionId.substring(0, 8),
            });
            sessionId = options.resumeSessionId;
        } else if (options.resumeSessionId) {
            log.info('loading ACP session', { sessionId: options.resumeSessionId.substring(0, 8) });
            resolvedModelId = await client.loadSession(options.resumeSessionId, options.cwd, options.mcpServers);
            sessionId = options.resumeSessionId;
        } else {
            log.info('creating ACP session', { mcpServers: options.mcpServers?.length ?? 0 });
            const newResult = await client.newSession(options.cwd, options.mcpServers);
            sessionId = newResult.sessionId;
            resolvedModelId = newResult.models?.currentModelId;
            if (newResult.models?.availableModels?.length) {
                log.info('available models', {
                    models: newResult.models.availableModels.map((m) => m.modelId).join(', '),
                });
            }
            if (newResult.modes?.availableModes?.length) {
                log.info('available modes', {
                    modes: newResult.modes.availableModes.map((m) => m.id).join(', '),
                    current: newResult.modes.currentModeId,
                });
            }
        }
        log.info('ACP session ready', { ms: Date.now() - sessionMs });

        // Register for external abort
        if (options.laneSessionId) {
            activeRuns.set(options.laneSessionId, { client, sessionId });
        }

        // Inject Session Reference when loading a session from disk (cold resume).
        // The model loses in-memory context on process restart, so point it to
        // the session summary and JSONL log for continuity.
        const needsSessionRef = options.resumeSessionId && !poolResult.activeSessionId;
        if (needsSessionRef && options.laneSessionId) {
            const ref = [
                '## Session Reference',
                `- Session summary: memory/summaries/ (search for sessionId: ${options.laneSessionId})`,
                `- History log: memory/sessions/${options.laneSessionId}.jsonl`,
            ].join('\n');
            options = { ...options, prompt: `${ref}\n\n${options.prompt ?? ''}` };
        }

        // Build the event handler that converts ACP notifications → StreamEvents.
        // On resume, session/load replays ALL prior notifications. To avoid
        // capturing these replays, we defer handler registration until AFTER
        // the prompt RPC is written to stdin (see below).
        const eventMapper = new AcpEventMapper();
        const promptText = options.prompt ?? '';
        const updateHandler: import('./client.js').SessionUpdateHandler = (_sid, update) => {
            try {
                const mapped = eventMapper.map(update);

                // Write ALL updates to debug file (including unmapped ones)
                if (options.debugFile) {
                    try {
                        appendFileSync(
                            options.debugFile,
                            `${new Date().toISOString()} [${update.sessionUpdate ?? 'unknown'}] ${JSON.stringify(update)}\n`,
                            'utf-8',
                        );
                    } catch {
                        // Non-fatal
                    }
                }

                if (!mapped) return;

                // Normalize to array (tool_call_update may synthesize multiple events)
                const rawEvents = Array.isArray(mapped) ? mapped : [mapped];

                for (const rawEvent of rawEvents) {
                    // Write mapped event to debug file
                    if (options.debugFile) {
                        try {
                            appendFileSync(
                                options.debugFile,
                                `${new Date().toISOString()} [mapped:${rawEvent.type}] ${JSON.stringify(rawEvent)}\n`,
                                'utf-8',
                            );
                        } catch {
                            // Non-fatal
                        }
                    }

                    // Apply tool result trimming
                    const event = trimToolResult(rawEvent, maxToolResultChars);
                    const signal = builder.handleEvent(event);
                    options.onEvent?.(event);

                    // Emit synthetic SkillActivationEvent
                    const skillName = builder.extractPendingSkillActivation();
                    if (skillName) {
                        options.onEvent?.({
                            type: 'skill_activation',
                            skillName,
                            timestamp: new Date().toISOString(),
                        });
                    }

                    // Log tool usage + reset timeout (tool activity = not hung)
                    if (event.type === 'tool_use') {
                        log.info('tool_use', {
                            tool: event.tool_name,
                            sid: sessionId?.substring(0, 8),
                            pid: client?.pid,
                        });
                        // ask_user / tool-effect confirmation blocks up to 30 min
                        // waiting for user input — extend the prompt timeout.
                        if (event.tool_name?.includes('ask_user')) {
                            client?.extendPromptTimeout(ASK_USER_TIMEOUT_MS);
                        } else {
                            client?.extendPromptTimeout();
                        }
                    }

                    // Write progress signal
                    if (event.type === 'tool_use' && options.progressFile) {
                        try {
                            writeFileSync(
                                options.progressFile,
                                `${JSON.stringify({
                                    runId: builder.build().runId,
                                    lastToolUse: new Date().toISOString(),
                                    toolName: event.tool_name,
                                })}\n`,
                                'utf-8',
                            );
                        } catch {
                            // Non-fatal
                        }
                    }

                    // Max tool iterations exceeded → cancel
                    if (signal === 'kill' && !killed && sessionId) {
                        killed = true;
                        client?.cancel(sessionId);
                    }
                }
            } catch (err) {
                log.error('event handler error', { error: String(err).substring(0, 200) });
            }
        };

        // Register handler immediately — no replay drain needed.
        //
        // Gemini CLI's loadSession() normally calls streamHistory() which
        // replays all prior notifications via fire-and-forget. This caused
        // late notifications to contaminate the current turn's response
        // (writeQueue race). Fixed by patching loadSession() to skip
        // streamHistory() entirely (see patches/@google%2Fgemini-cli).
        client.setUpdateHandler(updateHandler);

        log.info('sending ACP prompt', {
            sessionId: sessionId.substring(0, 8),
            promptChars: promptText.length,
            resume: !!options.resumeSessionId,
        });

        // Poll for ask-user-pending-{askId}.json written by MCP tools.
        // ACP only sends tool_call notifications AFTER the tool completes,
        // but MCP tools block waiting for user input — deadlock.
        // The MCP tool writes pending-{askId}.json before blocking to break this.
        //
        // Scoping: AcpClient sets GEMINICLAW_RUN_ID env var which propagates to
        // all child MCP servers. Each pending file carries the runId, and the
        // poller only processes files matching its own client's runId.
        const myRunId = client.runId;
        const seenAskIds = new Set<string>();
        const askUserPoller = setInterval(() => {
            try {
                for (const pending of listAllPending(options.cwd)) {
                    if (seenAskIds.has(pending.askId)) continue;
                    if (pending.runId && pending.runId !== myRunId) continue;
                    seenAskIds.add(pending.askId);
                    log.info('ask_user pending detected', {
                        askId: pending.askId,
                        runId: pending.runId,
                        question: pending.question.substring(0, 80),
                    });
                    // Extend prompt timeout — tool is blocking for user input
                    client?.extendPromptTimeout(ASK_USER_TIMEOUT_MS);
                    options.onEvent?.({
                        type: 'ask_user',
                        askId: pending.askId,
                        question: pending.question,
                        options: pending.options,
                        timestamp: new Date().toISOString(),
                        runId: pending.runId,
                    });
                }
            } catch {
                // Directory read error — ignore
            }
        }, 1000);

        let resp: Awaited<ReturnType<typeof client.prompt>>;
        try {
            resp = await client.prompt(sessionId, promptText, {
                parts: options.multimodalParts,
                timeoutMs: options.timeoutMs,
            });
        } finally {
            clearInterval(askUserPoller);
        }

        // Extract stopReason from prompt result
        const promptResult = resp.result as { stopReason?: string } | undefined;
        const stopReason = promptResult?.stopReason;

        // Log prompt response for debugging
        if (options.debugFile) {
            try {
                appendFileSync(
                    options.debugFile,
                    `${new Date().toISOString()} [prompt_response] ${JSON.stringify({ hasResult: !!resp.result, stopReason, error: resp.error ?? null })}\n`,
                    'utf-8',
                );
            } catch {
                // Non-fatal
            }
        }

        // Small grace period for trailing notifications
        await new Promise((r) => setTimeout(r, 300));

        // Synthesize a ResultEvent with wall-clock duration and token usage
        const usage = extractUsageMetadata(resp.result);
        actualModelVersion = extractModelVersion(resp.result);
        const resultEvent = synthesizeResultEvent(Date.now() - startMs, usage);
        builder.handleEvent(resultEvent);

        // Handle non-normal stopReasons.
        // ACP protocol defines: end_turn, cancelled, max_tokens, max_turn_requests, refusal
        if (stopReason === 'cancelled') {
            cancelled = true;
        } else if (stopReason === 'refusal') {
            builder.handleEvent({
                type: 'error',
                severity: 'error',
                message: 'Model refused the request',
                timestamp: new Date().toISOString(),
            });
        } else if (stopReason === 'max_tokens') {
            log.warn('ACP prompt stopped due to max_tokens', { sessionId: sessionId?.substring(0, 8) });
        } else if (stopReason === 'max_turn_requests') {
            log.warn('ACP prompt stopped due to max_turn_requests', { sessionId: sessionId?.substring(0, 8) });
        }

        // Handle prompt-level errors.
        // Gemini CLI v0.33+ has a known bug where _lastUsageMetadata is
        // not defined after prompt completion, causing a spurious -32603
        // Internal error. The prompt itself succeeds — ignore this specific error.
        if (resp.error) {
            const errorData = resp.error.data as { details?: string } | undefined;
            const isUsageMetadataBug =
                resp.error.code === -32603 &&
                typeof errorData?.details === 'string' &&
                errorData.details.includes('_lastUsageMetadata');

            // Gemini CLI throws NO_RESPONSE_TEXT when the model produces only
            // thinking tokens with no visible output. This is not a fatal error —
            // treat it as an empty response so the reply falls back to "(no response)"
            // instead of surfacing an alarming error message to the user.
            const isEmptyResponseError =
                typeof resp.error.message === 'string' && resp.error.message.includes('empty response text');

            // Rate-limit (429) is a non-retryable infrastructure error
            const isRateLimited = resp.error.code === 429;

            if (isUsageMetadataBug) {
                log.warn('ACP prompt completed with known _lastUsageMetadata bug (ignored)', {
                    code: resp.error.code,
                });
            } else if (isEmptyResponseError) {
                log.warn('ACP prompt returned empty response text (treated as empty reply)', {
                    code: resp.error.code,
                });
            } else {
                log.error('ACP prompt-level error', {
                    code: resp.error.code,
                    message: resp.error.message,
                    data: JSON.stringify(resp.error.data ?? null).substring(0, 500),
                    rateLimited: isRateLimited,
                });
                builder.handleEvent({
                    type: 'error',
                    severity: 'error',
                    message: isRateLimited ? 'Rate limit exceeded (429). Try again later.' : resp.error.message,
                    timestamp: new Date().toISOString(),
                });
            }
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        timedOut = msg.includes('ACP timeout');
        log.error('ACP run failed', { error: msg.substring(0, 200) });
        builder.handleEvent({
            type: 'error',
            severity: 'error',
            message: msg,
            timestamp: new Date().toISOString(),
        });
    } finally {
        // Remove from active runs map so abortSession() doesn't target a finished run
        if (options.laneSessionId) {
            activeRuns.delete(options.laneSessionId);
        }

        // Clean up stale ask-user files (orphaned answers, expired pending)
        try {
            clearStaleFiles(options.cwd);
        } catch {
            // Non-fatal
        }

        if (client) {
            client.setUpdateHandler(undefined);
            if (client.closed) {
                // Dead client — pool will clean up on next acquire
            } else if (timedOut) {
                // Timed-out process may be hung — kill it to prevent
                // zombie reuse via session affinity
                log.warn('killing timed-out ACP process', { pid: client.pid });
                client.close().catch((err) => log.warn('close failed for timed-out process', { error: String(err) }));
            } else {
                AcpProcessPool.release(options.cwd, client, options.model, sessionId);
            }
        }
    }

    const result = builder.build();
    result.prompt = options.prompt;
    result.durationMs = Date.now() - startMs;
    // Model resolution priority:
    // 1. actualModelVersion from Gemini API response (e.g. "gemini-2.5-flash-preview-04-17")
    //    — the real model used by the backend, captured via geminiclaw ACP patch
    // 2. resolvedModelId from session/new or session/load (config-level alias)
    // 3. options.model — the requested model alias (e.g. "auto")
    if (actualModelVersion) {
        result.model = actualModelVersion;
    } else if (!result.model && resolvedModelId) {
        result.model = resolvedModelId;
    }
    if (!result.model) {
        result.model = options.model ?? 'auto';
    }
    // Store ACP session ID so session freshness logic can resume it next turn
    if (sessionId) result.sessionId = sessionId;
    // Mark run as aborted if cancelled (by user, max iterations, or timeout)
    if (cancelled || killed || timedOut) result.aborted = true;

    if (result.error) {
        log.error('ACP run error', { error: result.error.substring(0, 200) });
    } else {
        log.info('ACP run done', {
            toolCalls: result.toolCalls.length,
            durationMs: result.durationMs,
        });
    }

    return result;
}
