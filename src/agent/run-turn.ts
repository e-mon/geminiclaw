/**
 * agent/run-turn.ts — Canonical single-turn agent execution logic.
 *
 * This is the single source of truth for how GeminiClaw runs one agent turn:
 *   1. Ensure static GEMINI.md exists → build dynamic session context
 *   2. Execute prompt via ACP (Gemini CLI Agent Communication Protocol)
 *   3. Persist session, usage, and workspace git commit
 *
 * Both the Inngest daemon (agent-run.ts) and the TUI (index.ts) call these
 * same functions so the two paths never diverge.
 *
 * The Inngest path wraps each step in step.run() for retry durability;
 * the TUI path calls them sequentially in runAgentTurn().
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { loadGeminiclawSettings, type McpServerConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { MemoryDB } from '../memory/db.js';
import { UsageTracker } from '../memory/usage.js';
import { spawnGeminiAcp } from './acp/runner.js';
import type { AcpMcpServerEntry } from './acp/types.js';
import { type AutonomyLevel, ContextBuilder } from './context-builder.js';
import type { RunResult, StreamEvent, TriggerType } from './runner.js';
import { type FlushDeps, GeminiCompactor, SessionStore, type SummarizeFn, silentMemoryFlush } from './session/index.js';

const log = createLogger('run-turn');

// ── Overflow Detection ────────────────────────────────────────────

/** Pattern-match Gemini CLI / ACP errors that indicate context window overflow. */
function isContextOverflow(error: string | undefined): boolean {
    if (!error) return false;
    const lower = error.toLowerCase();
    return (
        lower.includes('context window') ||
        lower.includes('context length') ||
        lower.includes('token limit') ||
        lower.includes('too long') ||
        lower.includes('max_tokens') ||
        (lower.includes('context') && lower.includes('exceed'))
    );
}

/** Detect ACP session/load failure — the session we tried to resume no longer exists. */
function isResumeFailure(error: string | undefined): boolean {
    if (!error) return false;
    const lower = error.toLowerCase();
    return lower.includes('session/load') || lower.includes('session not found') || lower.includes('sessionnotfound');
}

// ── MCP config conversion ────────────────────────────────────────

/** Convert geminiclaw settings MCP config to ACP mcpServers format. */
function buildAcpMcpServers(): AcpMcpServerEntry[] {
    const settings = loadGeminiclawSettings();
    if (!settings.mcpServers) return [];

    return Object.entries(settings.mcpServers).map(([name, cfg]: [string, McpServerConfig]) => ({
        name,
        command: cfg.command,
        args: cfg.args,
        env: cfg.env ? Object.entries(cfg.env).map(([k, v]) => ({ name: k, value: v })) : undefined,
        cwd: cfg.cwd,
    }));
}

// ── Gemini CLI settings injection ────────────────────────────────

/**
 * Write .gemini/settings.json with non-MCP settings only.
 *
 * MCP servers are injected via ACP session/new params — they must NOT
 * be in the file or they'll be registered twice. This function also
 * cleans up legacy mcpServers entries left by the old injection flow.
 */
function ensureGeminiSettings(workspacePath: string): void {
    const geminiDir = join(workspacePath, '.gemini');
    mkdirSync(geminiDir, { recursive: true });

    const settingsPath = join(geminiDir, 'settings.json');
    const appSettings = loadGeminiclawSettings();

    // Read existing file to preserve unknown keys (e.g. user customizations)
    let existing: Record<string, unknown> = {};
    try {
        existing = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
        // File doesn't exist or is invalid — start fresh
    }

    // Remove mcpServers — ACP session/new handles MCP injection
    delete existing.mcpServers;

    // Exclude built-in ask_user — we use MCP geminiclaw_ask_user with
    // file-based IPC (pending.json polling) to avoid ACP deadlock.
    const toolsObj = (existing.tools ?? {}) as Record<string, unknown>;
    toolsObj.exclude = ['ask_user'];
    existing.tools = toolsObj;

    // Sync thinkingBudget from app settings
    if (appSettings.thinkingBudget !== undefined) {
        existing.thinkingBudget = appSettings.thinkingBudget;
    }

    // Enable sub-agents for parallel heartbeat checks.
    // Requires local patch to gemini-cli local-executor.js (MCP prefix bug).
    // See: github.com/google-gemini/gemini-cli/issues/18712
    const experimental = (existing.experimental ?? {}) as Record<string, unknown>;
    experimental.enableAgents = true;
    existing.experimental = experimental;

    writeFileSync(settingsPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf-8');
}

// ── Types ─────────────────────────────────────────────────────────

/** A file to include as multimodal input via Gemini CLI's @ command. */
export interface InputFile {
    /** Workspace-relative path (e.g. runs/{sessionId}/attachments/xxx.png) */
    path: string;
    /** Original filename for logging/debugging */
    originalName?: string;
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Sanitize a session ID for use in filenames.
 * Replaces characters that are problematic on various filesystems.
 */
function sanitizeForFilename(sessionId: string): string {
    return sessionId.replace(/[:/\\]/g, '_');
}

/**
 * Strip the "## Recent Session History" section from session context.
 * Used on resume runs to avoid duplicating history that ACP's native
 * conversation state already holds.
 */
function stripSessionHistory(ctx: string): string {
    return ctx.replace(/## Recent Session History[\s\S]*?(?=\n## |\n---\n|$)/, '').trim();
}

// ── DI wiring ────────────────────────────────────────────────────

/** SummarizeFn backed by spawnGeminiAcp — injected into GeminiCompactor. */
function makeSummarizeFn(workspacePath: string, model?: string): SummarizeFn {
    return async (text: string, _model: string): Promise<string> => {
        const result = await spawnGeminiAcp({
            cwd: workspacePath,
            trigger: 'manual',
            prompt: text,
            model,
            poolPriority: 'background',
        });
        return result.responseText;
    };
}

/** FlushDeps backed by spawnGeminiAcp — injected into silentMemoryFlush. */
function makeFlushDeps(_workspacePath: string): FlushDeps {
    return {
        spawnFlush: async (_args, opts) => {
            const result = await spawnGeminiAcp({
                cwd: opts.cwd,
                trigger: opts.trigger as TriggerType,
                maxToolIterations: opts.maxToolIterations,
                model: opts.model,
                mcpServers: buildAcpMcpServers(),
                poolPriority: 'background',
            });
            return { responseText: result.responseText, error: result.error };
        },
    };
}

// ── Resume Detection ──────────────────────────────────────────────

export interface ResumeCheck {
    canResume: boolean;
    resumeSessionId?: string;
}

/**
 * Determine whether the current session can resume an existing Gemini CLI session.
 *
 * Extracted from runGemini() so it can run before buildAgentContext() —
 * when canResume=true, compaction + flush are skipped entirely because
 * stripSessionHistory() removes the injected history anyway.
 */
export function checkResumable(params: {
    sessionId: string;
    trigger: TriggerType;
    workspacePath: string;
    sessionIdleMinutes?: number;
}): ResumeCheck {
    const sessionStore = new SessionStore(join(params.workspacePath, 'memory', 'sessions'));
    const lastEntry = sessionStore.getLastEntry(params.sessionId);
    const idleMinutes = params.sessionIdleMinutes ?? 60;

    const lastGeminiSessionId = lastEntry?.geminiSessionId;
    const lastUpdated = lastEntry ? new Date(lastEntry.timestamp).getTime() : 0;
    const isFresh = lastGeminiSessionId && Date.now() - lastUpdated < idleMinutes * 60_000;

    // Heartbeat runs always start fresh — resume accumulates conversation
    // history across periodic checks, inflating tokens for no benefit.
    const resumeSessionId = params.trigger === 'heartbeat' ? undefined : isFresh ? lastGeminiSessionId : undefined;

    return {
        canResume: !!resumeSessionId,
        resumeSessionId: resumeSessionId ?? undefined,
    };
}

export interface RunTurnParams {
    sessionId: string;
    trigger: TriggerType;
    prompt: string;
    workspacePath: string;
    model: string;
    timezone?: string;
    autonomyLevel?: AutonomyLevel;
    maxToolIterations?: number;
    costPerMillionTokens?: Record<string, number>;
    /**
     * Minutes of inactivity before a Gemini CLI session is considered stale.
     * When fresh, --resume latest is passed so Gemini inherits the native conversation history.
     * Defaults to 60 minutes (mirrors OpenClaw's DEFAULT_IDLE_MINUTES).
     */
    sessionIdleMinutes?: number;
    /** Token budget for session history in the `-p` prompt. Default: 4000. */
    promptBudget?: { sessionHistory?: number };
    /** Called for each streaming event — used by TUI to update the display in real time. */
    onEvent?: (event: StreamEvent) => void;
    /** Files to include as multimodal input (images etc.) via Gemini CLI's @ command. */
    files?: InputFile[];
    /** Channel topic/description from Discord or Slack. Injected into session context. */
    channelTopic?: string;
    /** Internal flag to prevent infinite retry on context overflow. */
    _isRetry?: boolean;
}

/**
 * Step 1: Ensure static GEMINI.md exists + build dynamic session context.
 *
 * Returns the session context string for injection via `-p`.
 * Idempotent — safe to re-run if interrupted before step 2 starts.
 *
 * When canResume=true the ACP session is alive and stripSessionHistory()
 * will remove injected history anyway — skip compaction + flush entirely
 * to avoid ~16s of unnecessary LLM calls.
 */
export async function buildAgentContext(
    params: Pick<
        RunTurnParams,
        | 'sessionId'
        | 'trigger'
        | 'workspacePath'
        | 'model'
        | 'timezone'
        | 'autonomyLevel'
        | 'promptBudget'
        | 'channelTopic'
    > & { canResume?: boolean },
): Promise<{ sessionContext: string }> {
    const builder = new ContextBuilder(params.workspacePath);

    // Write static GEMINI.md only if it doesn't already exist.
    // ACP still reads GEMINI.md from cwd at session/new time.
    if (!builder.geminiMdExists()) {
        await builder.writeStaticGeminiMd({
            autonomyLevel: params.autonomyLevel,
            timezone: params.timezone,
        });
    }

    // Sanitize stray @-imports in MEMORY.md (e.g. @username mistaken as file ref)
    await builder.sanitizeMemoryImports();

    // Sync .gemini/settings.json — write thinkingBudget, remove legacy
    // mcpServers (MCP is now injected via ACP session/new params).
    ensureGeminiSettings(params.workspacePath);

    // Ensure runs/ directory exists for session work output
    mkdirSync(join(params.workspacePath, 'runs'), { recursive: true });

    // Load session history — skip compaction when resumable (history is stripped anyway)
    const sessionStore = new SessionStore(join(params.workspacePath, 'memory', 'sessions'));
    const budget = params.promptBudget ?? {};
    const maxTokens = budget.sessionHistory ?? 4000;

    let sessionHistory: import('./session/types.js').SessionEntry[];
    if (params.canResume || params.trigger === 'heartbeat') {
        // Sync path: no LLM calls, no compaction, no flush.
        // Heartbeat runs are independent checks — past history has no value,
        // and compacting them wastes a Gemini CLI call for nothing.
        sessionHistory = sessionStore.loadRecent(params.sessionId, { maxTokens });
        log.info('build-context: skipped compaction', { canResume: params.canResume, trigger: params.trigger });
    } else {
        const compactor = new GeminiCompactor(makeSummarizeFn(params.workspacePath, params.model), params.model);
        sessionHistory = await sessionStore.loadRecentWithCompaction(params.sessionId, {
            maxTokens,
            compactor,
        });
    }

    // Build the dynamic session context (not written to a file)
    const sessionContext = builder.buildSessionContext({
        trigger: params.trigger,
        sessionId: params.sessionId,
        sessionHistory: sessionHistory.length > 0 ? sessionHistory : undefined,
        channelTopic: params.channelTopic,
    });

    return { sessionContext };
}

/**
 * Step 2: Spawn Gemini CLI and return the structured run result.
 *
 * Session context is injected as a prefix to the `-p` prompt, ensuring
 * each parallel session gets its own context without file conflicts.
 *
 * Resume detection is pre-computed via checkResumable() and passed in
 * as resumeCheck — this allows build-context to skip compaction when
 * the session is resumable.
 */
export async function runGemini(
    params: Pick<
        RunTurnParams,
        | 'sessionId'
        | 'prompt'
        | 'workspacePath'
        | 'model'
        | 'trigger'
        | 'maxToolIterations'
        | 'onEvent'
        | 'sessionIdleMinutes'
        | 'files'
        | '_isRetry'
    > & { sessionContext: string; resumeCheck?: ResumeCheck },
): Promise<RunResult> {
    // Use pre-computed resume check, or compute inline for backward compat
    const resume =
        params.resumeCheck ??
        checkResumable({
            sessionId: params.sessionId,
            trigger: params.trigger,
            workspacePath: params.workspacePath,
            sessionIdleMinutes: params.sessionIdleMinutes,
        });
    const resumeSessionId = resume.resumeSessionId;

    // On resume, strip session history from context to avoid duplication
    // with ACP's native conversation state.
    const contextPrefix = resumeSessionId ? stripSessionHistory(params.sessionContext) : params.sessionContext;

    // Build @ file references for multimodal input.
    // Security: validate each file stays within the workspace using realpath().
    const fileRefs = params.files?.length
        ? params.files
              .map((f) => {
                  const abs = resolve(params.workspacePath, f.path);
                  if (!existsSync(abs)) {
                      throw new Error(`Multimodal input file not found: ${f.path}`);
                  }
                  const realFile = realpathSync(abs);
                  const realBase = realpathSync(params.workspacePath);
                  if (!realFile.startsWith(realBase + sep)) {
                      throw new Error(`File path escapes workspace: ${f.path}`);
                  }
                  return `@${relative(realBase, realFile)}`;
              })
              .join('\n')
        : '';

    // Combine context prefix with user prompt and file references
    const promptWithFiles = fileRefs ? `${params.prompt}\n\n${fileRefs}` : params.prompt;
    const fullPrompt = contextPrefix.trim() ? `${contextPrefix}\n\n---\n\n${promptWithFiles}` : promptWithFiles;

    const sanitizedSession = sanitizeForFilename(params.sessionId);
    const mcpServers = buildAcpMcpServers();

    const result = await spawnGeminiAcp({
        cwd: params.workspacePath,
        trigger: params.trigger,
        prompt: fullPrompt,
        model: params.model,
        maxToolIterations: params.maxToolIterations,
        progressFile: join(params.workspacePath, 'memory', `run-progress-${sanitizedSession}.json`),
        debugFile: join(params.workspacePath, 'memory', `last-run-events-${sanitizedSession}.jsonl`),
        onEvent: params.onEvent,
        mcpServers,
        resumeSessionId,
        poolPriority: params.trigger === 'heartbeat' ? 'background' : 'normal',
    });

    // Store the original user prompt (not the full context+prompt)
    result.prompt = params.prompt;

    // Resume failure recovery: the ACP session we tried to resume no longer exists
    // (e.g. pool eviction, Inngest retry after delay). Rebuild context with compaction
    // and retry without resume.
    if (resumeSessionId && isResumeFailure(result.error) && !params._isRetry) {
        log.warn('resume failed, retrying without resume', { resumeSessionId });
        const { sessionContext: freshContext } = await buildAgentContext({
            sessionId: params.sessionId,
            trigger: params.trigger,
            workspacePath: params.workspacePath,
            model: params.model,
            // canResume intentionally omitted → compaction runs to build proper history
        });
        return runGemini({
            ...params,
            sessionContext: freshContext,
            // Clear resumeCheck so the retry starts a fresh ACP session
            resumeCheck: { canResume: false },
            _isRetry: true,
        });
    }

    // Hard overflow recovery: flush important context, force-compact, and retry once.
    // canResume is intentionally omitted → compaction runs to shrink history.
    // The old resumeCheck is cleared so retry starts a fresh ACP session.
    if (isContextOverflow(result.error) && !params._isRetry) {
        const overflowStore = new SessionStore(join(params.workspacePath, 'memory', 'sessions'));
        const allEntries = overflowStore.loadAll(params.sessionId);
        if (allEntries.length > 3) {
            await silentMemoryFlush(
                allEntries.slice(0, -3),
                params.workspacePath,
                params.model,
                makeFlushDeps(params.workspacePath),
            );
        }

        const compactor = new GeminiCompactor(makeSummarizeFn(params.workspacePath, params.model), params.model);
        await overflowStore.forceCompact(params.sessionId, compactor);

        const { sessionContext: newContext } = await buildAgentContext({
            sessionId: params.sessionId,
            trigger: params.trigger,
            workspacePath: params.workspacePath,
            model: params.model,
        });
        return runGemini({
            ...params,
            sessionContext: newContext,
            resumeCheck: { canResume: false },
            _isRetry: true,
        });
    }

    return result;
}

/** Minimum session entries before post-process flush is triggered. */
const POST_FLUSH_MIN_ENTRIES = 3;

/**
 * Minimum new entries since last flush before another flush is worthwhile.
 * Prevents redundant LLM calls on rapid consecutive messages — each flush
 * covers all entries, so flushing again after 1 new entry is wasteful.
 */
const FLUSH_ENTRY_DELTA = 3;

/**
 * Step 3: Save session history, record token usage, git-commit workspace changes,
 * and run a memory flush.
 *
 * The flush replaces the old pre-compaction flush + session-switch flush —
 * it runs periodically (fail-open, awaited) so important signals are persisted
 * before the next turn's compaction could summarize them away.
 */
export async function postProcessRun(
    params: Pick<RunTurnParams, 'sessionId' | 'trigger' | 'workspacePath' | 'model' | 'costPerMillionTokens'>,
    result: RunResult,
): Promise<void> {
    const db = new MemoryDB(join(params.workspacePath, 'memory', 'memory.db'));
    try {
        const sessionStore = new SessionStore(join(params.workspacePath, 'memory', 'sessions'));
        sessionStore.append(params.sessionId, result);
        sessionStore.saveMarkdownLog(result);

        const tracker = new UsageTracker(db, params.costPerMillionTokens ?? {});
        tracker.saveRecord(result);


        // Post-turn memory flush: persist important signals so next turn's
        // compaction doesn't lose them. Awaited to stay within Inngest step
        // boundary. Fail-open — errors are logged and ignored.
        const allEntries = sessionStore.loadAll(params.sessionId);
        if (allEntries.length >= POST_FLUSH_MIN_ENTRIES && params.model) {
            const markerPath = join(
                params.workspacePath,
                'memory',
                `flush-marker-${sanitizeForFilename(params.sessionId)}.json`,
            );
            const lastFlushCount = readFlushMarker(markerPath);
            const delta = allEntries.length - lastFlushCount;

            if (delta >= FLUSH_ENTRY_DELTA) {
                try {
                    await silentMemoryFlush(
                        allEntries,
                        params.workspacePath,
                        params.model,
                        makeFlushDeps(params.workspacePath),
                    );
                    writeFlushMarker(markerPath, allEntries.length);
                } catch (err) {
                    log.warn('post-process flush failed', { error: String(err).substring(0, 200) });
                }
            }
        }
    } finally {
        db.close();
    }
}

/** Read the last-flushed entry count from a marker file. Returns 0 if absent. */
function readFlushMarker(path: string): number {
    try {
        const data = JSON.parse(readFileSync(path, 'utf-8')) as { entryCount?: number };
        return data.entryCount ?? 0;
    } catch {
        return 0;
    }
}

/** Write the current entry count to the flush marker file. */
function writeFlushMarker(path: string, entryCount: number): void {
    try {
        writeFileSync(path, JSON.stringify({ entryCount }), 'utf-8');
    } catch {
        // Non-critical — worst case we flush again next turn
    }
}

/**
 * Full turn: check resume → build context → run Gemini → post-process.
 *
 * Used by TUI (geminiclaw run) and direct callers. The Inngest daemon wraps
 * the individual step functions above in step.run() for retry durability instead
 * of calling this wrapper.
 */
export async function runAgentTurn(params: RunTurnParams): Promise<RunResult> {
    const resumeCheck = checkResumable(params);
    const { sessionContext } = await buildAgentContext({ ...params, canResume: resumeCheck.canResume });
    const result = await runGemini({ ...params, sessionContext, resumeCheck });
    await postProcessRun(params, result);
    return result;
}
