/**
 * agent/runner.ts — Shared types, RunResultBuilder, and post-processing utilities.
 *
 * The actual Gemini execution is handled by acp/runner.ts (spawnGeminiAcp).
 * This module retains the types and builder that all consumers depend on.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';

const _log = createLogger('runner');

// ── Types ────────────────────────────────────────────────────────

/**
 * Known system triggers. Channel names (e.g. 'discord', 'slack', and any
 * future adapter's channelType) are also valid — they come in as plain
 * strings from ChannelRouter and are treated as channel triggers.
 */
export type TriggerType = 'heartbeat' | 'manual' | 'cron' | (string & {});

export interface RunResult {
    runId: string;
    sessionId: string;
    model: string;
    trigger: TriggerType;
    /** Short session title generated from the first turn. */
    title?: string;
    /** The user prompt that was passed to Gemini CLI for this run. */
    prompt?: string;
    /** Full prompt text injected via `-p` (context prefix + user prompt). For dashboard debugging. */
    injectedContext?: string;
    toolCalls: ToolCall[];
    /** Skill names detected via <activated_skill> tags during the run. */
    skillActivations: string[];
    responseText: string;
    heartbeatOk: boolean;
    tokens: {
        total: number;
        input: number;
        output: number;
        thinking: number;
        cached: number;
    };
    durationMs: number;
    costEstimate?: number;
    error?: string;
    /** True when the run was externally aborted (user cancel or hard timeout). */
    aborted?: boolean;
    timestamp: Date;
}

export interface ToolCall {
    id: string;
    name: string;
    args: unknown;
    result?: string;
    status?: string;
    startedAt: Date;
}

// ── Stream-JSON event types ──────────────────────────────────────

export interface InitEvent {
    type: 'init';
    session_id: string;
    model: string;
    timestamp: string;
}

export interface MessageEvent {
    type: 'message';
    role: string;
    content: string;
    delta?: string;
    timestamp: string;
}

export interface ToolUseEvent {
    type: 'tool_use';
    tool_name: string;
    tool_id: string;
    parameters: unknown;
    /** Human-readable description of what the tool is doing (ACP v0.31+ `title` field). */
    title?: string;
    timestamp: string;
}

export interface ToolResultEvent {
    type: 'tool_result';
    tool_id: string;
    status: string;
    output?: string;
    error?: string;
    timestamp: string;
}

export interface ErrorEvent {
    type: 'error';
    severity: string;
    message: string;
    timestamp: string;
}

export interface ResultEvent {
    type: 'result';
    status: string;
    error?: string;
    stats: {
        total_tokens: number;
        input_tokens: number;
        output_tokens: number;
        thinking_tokens: number;
        cached: number;
        duration_ms: number;
        tool_calls: number;
    };
    timestamp: string;
}

/** Synthetic event emitted when a complete <think>...</think> or <thought>...</thought> block is detected. */
export interface ThinkEvent {
    type: 'think';
    content: string;
    timestamp: string;
}

/**
 * Synthetic event emitted when an <activated_skill name="..."> opening tag appears in the stream.
 * Emitted immediately on opening tag detection (before the block closes) so progress reporters
 * can surface the skill name without waiting for potentially large instruction blocks to complete.
 */
export interface SkillActivationEvent {
    type: 'skill_activation';
    skillName: string;
    timestamp: string;
}

/**
 * Synthetic event emitted when the agent calls geminiclaw_ask_user.
 * Detected from the tool_use stream event — used by ChatProgressReporter
 * to post the question to the chat thread and write pending state.
 */
export interface AskUserEvent {
    type: 'ask_user';
    askId: string;
    question: string;
    options?: string[];
    timestamp: string;
    /** Stable run identifier for IPC scoping. Propagated to ChatProgressReporter. */
    runId?: string;
}

export type StreamEvent =
    | InitEvent
    | MessageEvent
    | ToolUseEvent
    | ToolResultEvent
    | ErrorEvent
    | ResultEvent
    | ThinkEvent
    | SkillActivationEvent
    | AskUserEvent;

/**
 * Extract the skill name from an activate_skill tool call's parameters.
 * Gemini CLI passes `{ name: "skill-name" }` as the parameters.
 */
function extractSkillNameFromToolArgs(params: unknown): string | null {
    if (typeof params !== 'object' || params === null) return null;
    const rec = params as Record<string, unknown>;

    // Primary: { name: "skill-name" }
    if (typeof rec.name === 'string') return rec.name;

    // Fallback: { title: "\"skill-name\": description..." }
    if (typeof rec.title === 'string') {
        const m = rec.title.match(/^"([^"]+)"/);
        if (m) return m[1];
    }

    return null;
}

/**
 * Accumulate parsed events into a RunResult.
 * This is the core state machine of the parser.
 */
export class RunResultBuilder {
    private result: RunResult;
    private toolCallMap = new Map<string, ToolCall>();
    private toolUseCount = 0;
    private emittedThinkCount = 0;
    private emittedSkillCount = 0;
    readonly maxToolIterations: number;

    constructor(trigger: TriggerType = 'manual', maxToolIterations: number = 50) {
        this.maxToolIterations = maxToolIterations;
        this.result = {
            runId: randomUUID(),
            sessionId: '',
            model: '',
            trigger,
            toolCalls: [],
            skillActivations: [],
            responseText: '',
            heartbeatOk: false,
            tokens: { total: 0, input: 0, output: 0, thinking: 0, cached: 0 },
            durationMs: 0,
            error: undefined,
            timestamp: new Date(),
        };
    }

    /**
     * Reset accumulated response state.
     *
     * ACP `session/load` replays all prior `agent_message_chunk` notifications.
     * Due to event-loop timing, some replayed chunks may arrive after the
     * update handler is registered. Call this immediately before sending the
     * prompt to discard any replay artifacts.
     */
    resetResponse(): void {
        this.result.responseText = '';
        this.result.toolCalls = [];
        this.toolCallMap.clear();
        this.toolUseCount = 0;
    }

    /**
     * Process a single event and mutate internal state.
     * Returns 'kill' when max tool iterations is exceeded — caller should SIGTERM the child.
     */
    handleEvent(event: StreamEvent): 'continue' | 'kill' {
        switch (event.type) {
            case 'init':
                this.result.sessionId = event.session_id;
                this.result.model = event.model;
                break;

            case 'message':
                if (event.role === 'assistant') {
                    // Guard against non-string delta (Gemini CLI sends delta:true as boolean
                    // for thinking events; only accumulate actual string content).
                    if (typeof event.delta === 'string') {
                        this.result.responseText += event.delta;
                    } else if (typeof event.content === 'string' && event.content) {
                        this.result.responseText += event.content;
                    }
                }
                break;

            case 'tool_use': {
                this.toolUseCount++;
                if (this.toolUseCount > this.maxToolIterations) {
                    // Exceeded limit — signal caller to terminate the child process.
                    this.result.error = `Max tool iterations (${this.maxToolIterations}) exceeded`;
                    return 'kill';
                }
                const toolCall: ToolCall = {
                    id: event.tool_id,
                    name: event.tool_name,
                    args: event.parameters,
                    startedAt: new Date(event.timestamp),
                };
                this.toolCallMap.set(event.tool_id, toolCall);
                this.result.toolCalls.push(toolCall);

                // Detect skill activation from activate_skill tool calls
                if (event.tool_name === 'activate_skill') {
                    const skillName = extractSkillNameFromToolArgs(event.parameters);
                    if (skillName) this.result.skillActivations.push(skillName);
                }
                break;
            }

            case 'tool_result': {
                const existing = this.toolCallMap.get(event.tool_id);
                if (existing) {
                    existing.result = event.output ?? event.error;
                    existing.status = event.status;
                }
                break;
            }

            case 'error':
                if (event.severity === 'error') {
                    this.result.error = event.message;
                }
                break;

            case 'result':
                this.result.tokens = {
                    total: event.stats.total_tokens,
                    input: event.stats.input_tokens,
                    output: event.stats.output_tokens,
                    thinking: event.stats.thinking_tokens,
                    cached: event.stats.cached,
                };
                this.result.durationMs = event.stats.duration_ms;
                if (event.error) {
                    this.result.error = typeof event.error === 'string' ? event.error : JSON.stringify(event.error);
                }
                break;
        }

        return 'continue';
    }

    /**
     * Check if a newly completed thinking block has been accumulated since the last check.
     * Matches both <think>...</think> and <thought>...</thought> (backreference ensures
     * the same tag is used for open and close).
     * Returns the trimmed content if a new block is found, null otherwise.
     */
    extractCompletedThink(): string | null {
        const regex = /<(think|thought)>([\s\S]*?)<\/\1>/g;
        let count = 0;
        let match: RegExpExecArray | null = regex.exec(this.result.responseText);
        while (match !== null) {
            count++;
            if (count > this.emittedThinkCount) {
                this.emittedThinkCount = count;
                return match[2].trim();
            }
            match = regex.exec(this.result.responseText);
        }
        return null;
    }

    /**
     * Check if a new <activated_skill name="..."> opening tag has appeared since the last check.
     * Emits on the opening tag (before the block closes) so callers can surface the skill name
     * immediately without waiting for potentially large instruction content to finish streaming.
     * Returns the skill name if a new activation is found, null otherwise.
     */
    extractPendingSkillActivation(): string | null {
        const regex = /<activated_skill\s+name="([^"]+)"/g;
        let count = 0;
        let match: RegExpExecArray | null = regex.exec(this.result.responseText);
        while (match !== null) {
            count++;
            if (count > this.emittedSkillCount) {
                this.emittedSkillCount = count;
                this.result.skillActivations.push(match[1]);
                return match[1];
            }
            match = regex.exec(this.result.responseText);
        }
        return null;
    }

    /**
     * Finalize and return the RunResult.
     */
    build(): RunResult {
        // Strip <think>...</think> and <thought>...</thought> reasoning blocks before checking —
        // the HEARTBEAT_OK signal must come from the actual response, not internal reasoning.
        const responseWithoutThink = this.result.responseText.replace(/<(think|thought)>[\s\S]*?<\/\1>/g, '');
        // HEARTBEAT_OK must appear as a standalone line, not embedded in prose.
        // Also check inside <reply> tags — agents may wrap HEARTBEAT_OK in <reply>HEARTBEAT_OK</reply>.
        const filtered = filterResponseText(responseWithoutThink);
        this.result.heartbeatOk =
            /^\s*HEARTBEAT_OK\s*$/m.test(responseWithoutThink) || /^\s*HEARTBEAT_OK\s*$/m.test(filtered);

        // Safety net: if extractPendingSkillActivation() was never called by the caller,
        // parse all skill activations from the response text now.
        if (this.result.skillActivations.length === 0) {
            const skillRegex = /<activated_skill\s+name="([^"]+)"/g;
            for (const match of this.result.responseText.matchAll(skillRegex)) {
                this.result.skillActivations.push(match[1]);
            }
        }

        return {
            ...this.result,
            toolCalls: [...this.result.toolCalls],
            skillActivations: [...this.result.skillActivations],
        };
    }
}

// ── Tool result truncation ───────────────────────────────────────

/**
 * Known context window sizes (tokens) for Gemini models.
 * Used to compute a dynamic per-tool-result size cap.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
    'gemini-3.1-pro': 2_097_152,
    'gemini-3-pro': 1_048_576,
    'gemini-3-flash': 1_048_576,
    'gemini-2.5-pro': 1_048_576,
    'gemini-2.5-flash': 1_048_576,
    'gemini-2.0-flash': 1_048_576,
    'gemini-1.5-pro': 2_097_152,
    'gemini-1.5-flash': 1_048_576,
};

const DEFAULT_CONTEXT_WINDOW = 1_048_576;
/** Never let a single tool result consume more than 30% of the context window. */
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;
/** Absolute ceiling regardless of context window size (~100K tokens). */
const HARD_MAX_TOOL_RESULT_CHARS = 400_000;

/**
 * Calculate the maximum characters a single tool result may occupy.
 * Mirrors OpenClaw's dynamic approach: 30% of context window (est. 4 chars/token),
 * capped at HARD_MAX_TOOL_RESULT_CHARS to avoid filling the window with one result.
 */
export function calculateMaxToolResultChars(model: string): number {
    const contextTokens = MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
    const dynamicMax = Math.floor(contextTokens * 4 * MAX_TOOL_RESULT_CONTEXT_SHARE);
    return Math.min(dynamicMax, HARD_MAX_TOOL_RESULT_CHARS);
}

/**
 * Trim a tool_result event's output if it exceeds the per-result char cap.
 * Non-tool_result events are returned unchanged (pure function).
 */
export function trimToolResult(event: StreamEvent, maxChars: number): StreamEvent {
    if (event.type !== 'tool_result') return event;
    if (!event.output || event.output.length <= maxChars) return event;

    const omitted = event.output.length - maxChars;
    return {
        ...event,
        output: `${event.output.substring(0, maxChars)}\n[TRUNCATED: ${omitted} chars omitted]`,
    };
}

/**
 * Strip internal meta-tags from a response before displaying it to the user.
 *
 * Removes:
 *   - <think>...</think> and <thought>...</thought> — model reasoning tokens
 *   - <activated_skill ...>...</activated_skill> — skill instruction blocks
 *
 * If the response contains a `<reply>...</reply>` block, only the content
 * inside that block is returned. This lets agents (e.g. heartbeat) separate
 * internal processing narration from the user-facing response.
 */
export function filterResponseText(text: string): string {
    let result = text
        .replace(/<(think|thought)>[\s\S]*?<\/\1>/g, '')
        .replace(/<activated_skill[^>]*>[\s\S]*?<\/activated_skill>/g, '');

    // Extract <reply> content if present — discards intermediate narration
    const replyMatch = result.match(/<reply>([\s\S]*?)<\/reply>/);
    if (replyMatch) {
        result = replyMatch[1];
    }

    return result.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Extract MEDIA: markers from agent response text and return the media sources
 * alongside the cleaned text with markers removed.
 *
 * Agents signal media delivery by including lines of the form:
 *   MEDIA:<relative-or-absolute-path>
 *   MEDIA:<https://...>
 *
 * - Relative paths are resolved against the workspace root by the caller.
 * - Remote URLs are passed through as-is for channel-native embedding.
 * - This function only extracts and strips markers — it does not touch the filesystem.
 *
 * Matches OpenClaw's MEDIA: convention for cross-platform media delivery.
 */
export function parseMediaMarkers(text: string): { mediaSrcs: string[]; cleanedText: string } {
    const mediaSrcs: string[] = [];
    const cleanedText = text
        .replace(/^MEDIA:(.+)$/gm, (_match, rawSrc: string) => {
            const trimmed = rawSrc.trim();
            if (trimmed) mediaSrcs.push(trimmed);
            return '';
        })
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return { mediaSrcs, cleanedText };
}

export interface SpawnGeminiOptions {
    cwd: string;
    env?: Record<string, string>;
    trigger?: TriggerType;
    /** The user prompt, stored in RunResult for session history. */
    prompt?: string;
    /** Model name — used to compute the dynamic tool-result size cap. */
    model?: string;
    /** Maximum tool call iterations before cancellation. */
    maxToolIterations?: number;
    /**
     * Path to write run-progress.json on each tool_use event.
     * Enables the geminiclaw_status MCP tool to report "still working" status.
     */
    progressFile?: string;
    /**
     * Path to write raw event lines for debugging.
     * File is truncated at run start; each line is appended as received.
     */
    debugFile?: string;
    onEvent?: (event: StreamEvent) => void;
}
