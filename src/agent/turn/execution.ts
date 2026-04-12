/**
 * agent/turn/execution.ts — Pipeline function for the execution phase.
 *
 * Spawns Gemini CLI via ACP and handles recovery for resume failures
 * and context overflow.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { spawnGeminiAcp } from '../acp/runner.js';
import type { AcpPromptPart } from '../acp/types.js';
import type { RunResult } from '../runner.js';
import { generateSessionSummary, SessionStore, silentMemoryFlush } from '../session/index.js';
import {
    buildAcpMcpServers,
    detectGarbledResponse,
    isContextOverflow,
    isNonRetryableError,
    isResumeFailure,
    makeFlushDeps,
    sanitizeForFilename,
} from './helpers.js';
import { activateOffload, clearOffloadState, parseQuotaExhausted, resolveModelWithOffload } from './model-offload.js';
import { buildAgentContext } from './pre-execution.js';
import type { ResumeCheck, RunTurnParams } from './types.js';

const log = createLogger('turn-exec');

/**
 * Spawn Gemini CLI and return the structured run result.
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
        | 'files'
        | 'sandbox'
        | 'timezone'
        | '_isRetry'
    > & { sessionContext: string; resumeCheck: ResumeCheck },
): Promise<RunResult> {
    const resume = params.resumeCheck;
    const resumeSessionId = resume.resumeSessionId;
    const contextPrefix = params.sessionContext;

    // Resolve model with offload (use fallback if primary model is quota-exhausted)
    const config = loadConfig();
    const offloadEnabled = config.offload.enabled;
    const { model: effectiveModel, offloaded } = offloadEnabled
        ? resolveModelWithOffload(params.model, params.workspacePath, config.offload.model)
        : { model: params.model, offloaded: false };
    if (offloaded) {
        log.info('model offloaded for this run', { requested: params.model, effective: effectiveModel });
    }

    const { fileRefs, parts: multimodalParts } = buildPromptParts(params);
    const promptWithFiles = fileRefs ? `${params.prompt}\n\n${fileRefs}` : params.prompt;
    const fullPrompt = contextPrefix.trim() ? `${contextPrefix}\n\n---\n\n${promptWithFiles}` : promptWithFiles;

    const sanitizedSession = sanitizeForFilename(params.sessionId);
    const mcpServers = buildAcpMcpServers();

    const result = await spawnGeminiAcp({
        cwd: params.workspacePath,
        trigger: params.trigger,
        prompt: fullPrompt,
        model: effectiveModel,
        maxToolIterations: params.maxToolIterations,
        progressFile: join(params.workspacePath, 'memory', `run-progress-${sanitizedSession}.json`),
        debugFile: join(params.workspacePath, 'memory', `last-run-events-${sanitizedSession}.jsonl`),
        onEvent: params.onEvent,
        mcpServers,
        resumeSessionId,
        laneSessionId: params.sessionId,
        poolPriority: params.trigger === 'heartbeat' ? 'background' : 'normal',
        sandbox: params.sandbox,
        multimodalParts: multimodalParts.length > 0 ? multimodalParts : undefined,
    });

    result.prompt = params.prompt;
    result.injectedContext = fullPrompt;

    // ── Quota exhaustion → offload to fallback model and retry ──
    const quota = offloadEnabled ? parseQuotaExhausted(result.error) : undefined;
    if (quota && !params._isRetry) {
        return handleQuotaExhausted(params, quota.resetAfterMs);
    }

    // If we were offloaded and the primary model succeeded, clear offload state
    // (this handles early recovery when quota resets sooner than expected)
    if (offloaded && !result.error) {
        clearOffloadState(params.workspacePath);
        log.info('offload cleared after successful run with fallback model');
    }

    if (resumeSessionId && isResumeFailure(result.error) && !params._isRetry) {
        return handleResumeFailure(params, resumeSessionId);
    }

    if (isContextOverflow(result.error) && !params._isRetry) {
        return handleContextOverflow(params);
    }

    if (result.error && !params._isRetry && !isNonRetryableError(result.error)) {
        return handleErrorInformedRetry(params, result.error);
    }

    const garbledReason = !params._isRetry ? detectGarbledResponse(result.responseText, result.error) : undefined;
    if (garbledReason) {
        return handleErrorInformedRetry(params, garbledReason);
    }

    return result;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const AUDIO_EXTS = new Set(['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac']);

const MIME_MAP: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
};

/**
 * Build multimodal prompt parts and file references from attached files.
 *
 * Images/audio are encoded as inline base64 AcpPromptParts for direct
 * multimodal processing. Other files use `@filepath` text references
 * for Gemini CLI's native file handling.
 */
function buildPromptParts(params: Pick<RunTurnParams, 'files' | 'workspacePath'>): {
    fileRefs: string;
    parts: AcpPromptPart[];
} {
    if (!params.files?.length) return { fileRefs: '', parts: [] };

    const refs: string[] = [];
    const parts: AcpPromptPart[] = [];
    const realBase = realpathSync(params.workspacePath);

    for (const f of params.files) {
        const abs = resolve(params.workspacePath, f.path);
        if (!existsSync(abs)) {
            throw new Error(`Multimodal input file not found: ${f.path}`);
        }
        const realFile = realpathSync(abs);
        if (!realFile.startsWith(realBase + sep)) {
            throw new Error(`File path escapes workspace: ${f.path}`);
        }

        const ext = extname(f.path).toLowerCase();
        if (IMAGE_EXTS.has(ext)) {
            const data = readFileSync(realFile).toString('base64');
            parts.push({ type: 'image', mimeType: MIME_MAP[ext] ?? 'application/octet-stream', data });
        } else if (AUDIO_EXTS.has(ext)) {
            const data = readFileSync(realFile).toString('base64');
            parts.push({ type: 'audio', mimeType: MIME_MAP[ext] ?? 'application/octet-stream', data });
        } else {
            refs.push(`@${relative(realBase, realFile)}`);
        }
    }

    return { fileRefs: refs.join('\n'), parts };
}

/**
 * Quota exhaustion recovery: the primary model has no remaining capacity.
 * Activate offload state and retry immediately with the fallback model.
 * Subsequent runs will automatically use the fallback until the quota resets.
 */
async function handleQuotaExhausted(params: Parameters<typeof runGemini>[0], resetAfterMs: number): Promise<RunResult> {
    const cfg = loadConfig();
    const fallbackModel = activateOffload(params.workspacePath, params.model, resetAfterMs, cfg.offload.model);
    log.warn('quota exhausted, offloading to fallback model', {
        primaryModel: params.model,
        fallbackModel,
        resetInMinutes: Math.ceil(resetAfterMs / 60_000),
    });

    // Retry immediately with the fallback model — no resume (different model = new session)
    return runGemini({
        ...params,
        resumeCheck: { canResume: false },
        _isRetry: true,
    });
}

/**
 * Resume failure recovery: the ACP session no longer exists.
 * Generate/update session summary for continuity, then retry as new session.
 */
async function handleResumeFailure(
    params: Parameters<typeof runGemini>[0],
    resumeSessionId: string,
): Promise<RunResult> {
    log.warn('resume failed, retrying without resume', { resumeSessionId });

    const sessionRef = await generateSessionRefForRetry(params);
    const { sessionContext: freshContext } = await buildAgentContext({
        sessionId: params.sessionId,
        trigger: params.trigger,
        workspacePath: params.workspacePath,
        model: params.model,
    });

    return runGemini({
        ...params,
        sessionContext: sessionRef ? `${sessionRef}\n\n${freshContext}` : freshContext,
        resumeCheck: { canResume: false },
        _isRetry: true,
    });
}

/**
 * Error-informed retry: the previous prompt failed with a non-structural error
 * (e.g. PDF parse failure inside Gemini CLI). Re-run with the error message
 * injected so the model can adapt its approach.
 */
async function handleErrorInformedRetry(params: Parameters<typeof runGemini>[0], error: string): Promise<RunResult> {
    log.warn('error-informed retry', { error: error.substring(0, 200) });
    const retryPrefix =
        `[System: Your previous attempt failed with the following error: "${error}"\n` +
        "Try a different approach to accomplish the user's request.]";
    return runGemini({
        ...params,
        prompt: `${retryPrefix}\n\n${params.prompt}`,
        resumeCheck: { canResume: false },
        _isRetry: true,
    });
}

/**
 * Hard overflow recovery: flush important context to MEMORY.md, generate
 * session summary for continuity, then retry as a new session (no resume)
 * so Gemini CLI starts with a clean context.
 *
 * The overflow is in Gemini CLI's internal conversation history, which we
 * cannot reduce from outside. Starting fresh lets the model reference
 * session summaries and JSONL logs for continuity.
 */
async function handleContextOverflow(params: Parameters<typeof runGemini>[0]): Promise<RunResult> {
    const overflowStore = new SessionStore(join(params.workspacePath, 'memory', 'sessions'));
    const allEntries = overflowStore.loadAll(params.sessionId);
    if (allEntries.length > 3) {
        await silentMemoryFlush(
            allEntries.slice(0, -3),
            params.workspacePath,
            params.model,
            makeFlushDeps(params.workspacePath),
            params.timezone,
        );
    }

    const sessionRef = await generateSessionRefForRetry(params);
    const { sessionContext: newContext } = await buildAgentContext({
        sessionId: params.sessionId,
        trigger: params.trigger,
        workspacePath: params.workspacePath,
        model: params.model,
    });

    return runGemini({
        ...params,
        sessionContext: sessionRef ? `${sessionRef}\n\n${newContext}` : newContext,
        resumeCheck: { canResume: false },
        _isRetry: true,
    });
}

/**
 * Generate/update session summary and return a Session Reference block
 * for injection into the retry prompt. Fail-open — returns undefined
 * if summary generation fails.
 */
async function generateSessionRefForRetry(
    params: Pick<Parameters<typeof runGemini>[0], 'sessionId' | 'workspacePath' | 'model' | 'timezone'>,
): Promise<string | undefined> {
    const sessionsDir = join(params.workspacePath, 'memory', 'sessions');
    const summariesDir = join(params.workspacePath, 'memory', 'summaries');

    try {
        await generateSessionSummary({
            sessionId: params.sessionId,
            sessionsDir,
            summariesDir,
            workspacePath: params.workspacePath,
            model: params.model,
            timezone: params.timezone,
        });
    } catch (err) {
        log.warn('session summary generation failed during retry', { error: String(err).substring(0, 200) });
    }

    return [
        '## Session Reference',
        `- Session summary: memory/summaries/ (search for sessionId: ${params.sessionId})`,
        `- History log: memory/sessions/${params.sessionId}.jsonl`,
    ].join('\n');
}
