/**
 * agent/turn/pre-execution.ts — Pipeline functions for pre-execution phase.
 *
 * checkResumable() determines whether the ACP session is alive.
 * buildAgentContext() writes static files + builds the dynamic session context.
 *
 * Both produce data consumed by later phases (Pipeline pattern).
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChannelContextData } from '../../channels/channel-context.js';
import { createLogger } from '../../logger.js';
import { shouldBootstrap } from '../bootstrap.js';
import { ContextBuilder } from '../context-builder.js';
import type { TriggerType } from '../runner.js';
import { generateHeartbeatDigest } from '../session/heartbeat-digest.js';
import { SessionStore } from '../session/index.js';
import { ensureGeminiSettings } from './helpers.js';
import type { ResumeCheck, RunTurnParams } from './types.js';

const log = createLogger('turn-pre');

/**
 * Determine whether the current session can resume an existing Gemini CLI session.
 *
 * Always resumes when a geminiSessionId exists — Gemini CLI handles its own
 * conversation history via internal compaction. No idle timeout needed.
 *
 * Heartbeat runs always start fresh to avoid accumulating conversation
 * history across periodic checks.
 */
export function checkResumable(params: {
    sessionId: string;
    trigger: TriggerType;
    workspacePath: string;
}): ResumeCheck {
    if (params.trigger === 'heartbeat') {
        return { canResume: false };
    }

    const sessionStore = new SessionStore(join(params.workspacePath, 'memory', 'sessions'));
    const lastEntry = sessionStore.getLastEntry(params.sessionId);
    const resumeSessionId = lastEntry?.geminiSessionId;

    return {
        canResume: !!resumeSessionId,
        resumeSessionId,
    };
}

/**
 * Ensure static GEMINI.md exists + build dynamic session context.
 *
 * Returns the session context string for injection via `-p`.
 * Idempotent — safe to re-run if interrupted before execution starts.
 *
 * Session history is no longer injected here — Gemini CLI manages its own
 * conversation history via always-resume + internal compaction.
 */
export async function buildAgentContext(
    params: Pick<
        RunTurnParams,
        | 'sessionId'
        | 'trigger'
        | 'workspacePath'
        | 'model'
        | 'timezone'
        | 'language'
        | 'autonomyLevel'
        | 'channelTopic'
        | 'channelContext'
        | 'channelContextMaxChars'
        | 'isHomeChannel'
        | 'isDM'
        | 'deliveryTarget'
    >,
): Promise<{ sessionContext: string }> {
    const builder = new ContextBuilder(params.workspacePath);

    // Write static GEMINI.md only if it doesn't already exist
    if (!builder.geminiMdExists()) {
        await builder.writeStaticGeminiMd({
            autonomyLevel: params.autonomyLevel,
            timezone: params.timezone,
            language: params.language,
        });
    }

    // Sanitize stray @-imports in MEMORY.md
    await builder.sanitizeMemoryImports();

    ensureGeminiSettings(params.workspacePath);
    mkdirSync(join(params.workspacePath, 'runs'), { recursive: true });

    // Generate incremental digest for heartbeat runs
    if (params.trigger === 'heartbeat') {
        generateHeartbeatDigest({
            sessionsDir: join(params.workspacePath, 'memory', 'sessions'),
            workspacePath: params.workspacePath,
            timezone: params.timezone,
        });
    }

    // Deserialize channel context if present
    let channelContext: { data: ChannelContextData; maxChars: number } | undefined;
    if (params.channelContext) {
        try {
            const data = JSON.parse(params.channelContext) as ChannelContextData;
            channelContext = { data, maxChars: params.channelContextMaxChars ?? 6000 };
        } catch {
            log.warn('failed to parse channelContext JSON');
        }
    }

    // Check if this turn should run bootstrap (first-run setup)
    const bootstrap = shouldBootstrap({
        workspacePath: params.workspacePath,
        trigger: params.trigger,
        channelId: params.sessionId,
        isHomeChannel: params.isHomeChannel,
        isDM: params.isDM,
    });
    if (bootstrap) {
        log.info('bootstrap mode activated', { sessionId: params.sessionId });
    }

    const sessionContext = builder.buildSessionContext({
        trigger: params.trigger,
        sessionId: params.sessionId,
        channelTopic: params.channelTopic,
        channelContext,
        bootstrap,
        timezone: params.timezone,
        deliveryTarget: params.deliveryTarget,
    });

    return { sessionContext };
}
