/**
 * agent/turn/types.ts — Type definitions for the turn lifecycle.
 */

import type { Config } from '../../config.js';
import type { SandboxMode } from '../acp/client.js';
import type { AutonomyLevel } from '../context-builder.js';
import type { RunResult, StreamEvent, TriggerType } from '../runner.js';

// ── Event schema (canonical location) ────────────────────────────

export interface AgentRunEventData {
    /** Lane key — runs with the same sessionId are serialized */
    sessionId: string;
    /** What triggered this run */
    trigger: TriggerType;
    /** The prompt to send to Gemini CLI */
    prompt: string;
    /**
     * Chat SDK thread (serialized JSON from thread.toJSON()).
     * Used for reply pipeline — deserialized via ThreadImpl.fromJSON() in the send-reply step.
     * Present for messages received through Chat SDK handlers.
     */
    serializedThread?: string;
    /**
     * Legacy reply info — kept for cron jobs and non-Chat-SDK triggers (heartbeat, manual).
     * When serializedThread is present, this field is ignored.
     */
    reply?: {
        /** Adapter identifier — matches ChannelAdapter.channelType (e.g. 'discord'). */
        channelType: string;
        channelId: string;
        /** Threading reference passed to sendReply as opts.replyRef. */
        replyRef?: string;
    };
    /** Discord/Slack channel topic (description). Injected into session context for per-channel behavior control. */
    channelTopic?: string;
    /** Recent channel conversation context (messages + thread summaries). Serialized ChannelContextData. */
    channelContext?: string;
    /** Whether this message originates from the configured home channel. */
    isHomeChannel?: boolean;
    /** Whether this message originates from a DM. */
    isDM?: boolean;
    /** Multimodal input files (workspace-relative paths, already saved to disk). */
    files?: Array<{ path: string; originalName?: string }>;
    /** Override model for this run (e.g. "flash", "auto"). Falls back to config.model. */
    model?: string;
}

/** A file to include as multimodal input via Gemini CLI's @ command. */
export interface InputFile {
    /** Workspace-relative path (e.g. runs/{sessionId}/attachments/xxx.png) */
    path: string;
    /** Original filename for logging/debugging */
    originalName?: string;
}

export interface RunTurnParams {
    sessionId: string;
    trigger: TriggerType;
    prompt: string;
    workspacePath: string;
    model: string;
    timezone?: string;
    language?: string;
    autonomyLevel?: AutonomyLevel;
    maxToolIterations?: number;
    /** Called for each streaming event — used by TUI to update the display in real time. */
    onEvent?: (event: StreamEvent) => void;
    /** Files to include as multimodal input (images etc.) via Gemini CLI's @ command. */
    files?: InputFile[];
    /** Whether this session originates from the configured home channel. */
    isHomeChannel?: boolean;
    /** Whether this session originates from a DM. */
    isDM?: boolean;
    /** Channel topic/description from Discord or Slack. Injected into session context. */
    channelTopic?: string;
    /** Serialized ChannelContextData JSON for channel conversation context injection. */
    channelContext?: string;
    /** Max chars for rendered channel context block. Sourced from config.experimental.channelContext.maxChars. */
    channelContextMaxChars?: number;
    /** Sandbox mode: true (auto-detect), false (disabled), 'seatbelt', or 'docker'. */
    sandbox?: SandboxMode;
    /** Internal flag to prevent infinite retry on context overflow. */
    _isRetry?: boolean;
}

export interface ResumeCheck {
    canResume: boolean;
    resumeSessionId?: string;
}

/** Context for post-run handlers (save session, track usage, memory flush). */
export interface PostRunContext {
    params: Pick<RunTurnParams, 'sessionId' | 'trigger' | 'workspacePath' | 'model' | 'timezone'>;
    runResult: RunResult;
}

/** Context for deliver handlers (Inngest only — title, notify, reply). */
export interface DeliverContext {
    params: RunTurnParams;
    runResult: RunResult;
    eventData: AgentRunEventData;
    config: Config;
    progressFinalized: boolean;
    workspacePath: string;
}
