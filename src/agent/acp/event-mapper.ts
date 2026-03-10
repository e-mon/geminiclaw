/**
 * agent/acp/event-mapper.ts — Map ACP session updates to StreamEvent.
 *
 * Pure functions that convert ACP notification payloads into the
 * StreamEvent types consumed by RunResultBuilder and progress reporters.
 */

import { createLogger } from '../../logger.js';
import type {
    ErrorEvent,
    MessageEvent,
    ResultEvent,
    StreamEvent,
    ThinkEvent,
    ToolResultEvent,
    ToolUseEvent,
} from '../runner.js';
import type { AcpSessionUpdate } from './types.js';

const _log = createLogger('acp-event-mapper');

/**
 * Extract tool name from an ACP toolCallId.
 *
 * ACP toolCallIds follow the pattern "toolName-timestamp" (e.g.
 * "activate_skill-1772250597414", "run_shell_command-1772250636256").
 * Strips the trailing numeric suffix to recover the tool name.
 */
function extractToolNameFromId(toolCallId: string): string {
    // Strip trailing "-<digits>" suffix
    return toolCallId.replace(/-\d+$/, '');
}

/**
 * Extract text from ACP tool_call_update content array.
 *
 * ACP sends tool output as:
 *   content: [{ type: "content", content: { type: "text", text: "..." } }]
 *
 * Concatenates all text blocks and returns a single string.
 */
function extractContentText(content: unknown): string | undefined {
    if (!Array.isArray(content)) return undefined;
    const texts: string[] = [];
    for (const block of content) {
        const b = block as { type?: string; content?: { type?: string; text?: string } };
        if (b.content?.type === 'text' && typeof b.content.text === 'string') {
            texts.push(b.content.text);
        }
    }
    return texts.length > 0 ? texts.join('\n') : undefined;
}

/**
 * Stateful mapper that tracks seen toolCallIds per session to avoid
 * emitting duplicate ToolUseEvents.
 *
 * Create one instance per ACP prompt invocation (not per process).
 */
export class AcpEventMapper {
    private readonly seenToolCallIds = new Set<string>();

    /**
     * Convert an ACP session update to one or more StreamEvents.
     *
     * Returns null for update types that have no StreamEvent equivalent.
     *
     * ACP v0.31+ sends `tool_call` with `status: "in_progress"` at tool
     * start (including `title` description) and `tool_call_update` at
     * completion. We emit ToolUseEvent from whichever arrives first.
     */
    map(update: AcpSessionUpdate): StreamEvent | StreamEvent[] | null {
        const now = new Date().toISOString();

        switch (update.sessionUpdate) {
            case 'agent_message_chunk': {
                const content = (update as { content?: { type?: string; text?: string } }).content;
                if (content?.type === 'text' && typeof content.text === 'string') {
                    return {
                        type: 'message',
                        role: 'assistant',
                        content: '',
                        delta: content.text,
                        timestamp: now,
                    } satisfies MessageEvent;
                }
                return null;
            }

            case 'tool_call': {
                // ACP v0.31+ tool_call fields:
                //   toolCallId, status ("in_progress"|"completed"), title, content, locations, kind
                const tc = update as Record<string, unknown>;
                const toolCallId = String(tc.toolCallId ?? tc.toolId ?? tc.tool_id ?? tc.id ?? '');
                const toolName =
                    String(tc.toolName ?? tc.tool_name ?? tc.name ?? '') || extractToolNameFromId(toolCallId);
                const title = typeof tc.title === 'string' ? tc.title : undefined;

                // ACP sends rawInput (v0.34+); fall back to input/args for compat
                let parameters = tc.rawInput ?? tc.input ?? tc.args ?? tc.arguments;
                if (parameters === undefined && (title || tc.locations)) {
                    const locations = tc.locations as Array<{ path?: string }> | undefined;
                    const path = locations?.[0]?.path;
                    parameters = {
                        ...(title ? { title } : {}),
                        ...(path ? { file_path: path } : {}),
                    };
                }

                if (toolCallId) this.seenToolCallIds.add(toolCallId);
                const events: StreamEvent[] = [];

                events.push({
                    type: 'tool_use',
                    tool_name: toolName,
                    tool_id: toolCallId,
                    parameters,
                    title,
                    timestamp: now,
                } satisfies ToolUseEvent);

                // ACP sometimes sends a single tool_call with status "completed"
                // instead of separate tool_call + tool_call_update. Extract the
                // result from content so it isn't lost.
                if (tc.status === 'completed') {
                    const output = extractContentText(tc.content);
                    events.push({
                        type: 'tool_result',
                        tool_id: toolCallId,
                        status: 'completed',
                        output,
                        timestamp: now,
                    } satisfies ToolResultEvent);
                }

                return events.length === 1 ? events[0] : events;
            }

            case 'tool_call_update': {
                const tcu = update as {
                    toolCallId?: string;
                    toolId?: string;
                    status?: string;
                    output?: string;
                    rawOutput?: unknown;
                    error?: string;
                    content?: unknown;
                };
                const toolCallId = tcu.toolCallId ?? tcu.toolId ?? '';
                const events: StreamEvent[] = [];

                // Synthesize ToolUseEvent if ACP skipped the tool_call notification
                if (toolCallId && !this.seenToolCallIds.has(toolCallId)) {
                    this.seenToolCallIds.add(toolCallId);
                    const toolName = extractToolNameFromId(toolCallId);
                    events.push({
                        type: 'tool_use',
                        tool_name: toolName,
                        tool_id: toolCallId,
                        parameters: undefined,
                        timestamp: now,
                    } satisfies ToolUseEvent);
                }

                // Extract output: prefer rawOutput (v0.34+), then plain output, then content array
                const rawOut = tcu.rawOutput != null ? String(tcu.rawOutput) : undefined;
                const output = rawOut ?? tcu.output ?? extractContentText(tcu.content);

                events.push({
                    type: 'tool_result',
                    tool_id: toolCallId,
                    status: tcu.status ?? 'success',
                    output,
                    error: tcu.error,
                    timestamp: now,
                } satisfies ToolResultEvent);

                return events.length === 1 ? events[0] : events;
            }

            case 'agent_thought_chunk':
            case 'thinking': {
                const content = (update as { content?: { type?: string; text?: string } }).content;
                if (content?.type === 'text' && typeof content.text === 'string') {
                    return {
                        type: 'think',
                        content: content.text,
                        timestamp: now,
                    } satisfies ThinkEvent;
                }
                return null;
            }

            case 'error': {
                const err = update as { message?: string; severity?: string };
                return {
                    type: 'error',
                    severity: err.severity ?? 'error',
                    message: err.message ?? 'Unknown ACP error',
                    timestamp: now,
                } satisfies ErrorEvent;
            }

            default:
                return null;
        }
    }
}

/** Gemini API usageMetadata shape returned via the geminiclaw ACP patch. */
export interface AcpUsageMetadata {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
    /** Implicit/explicit cache hit tokens — billed at 10% of input rate. */
    cachedContentTokenCount?: number;
}

/** Shape of the `_meta` block injected by the geminiclaw ACP patch. */
interface AcpPromptMeta {
    usageMetadata?: AcpUsageMetadata;
    /** Actual model version string from the Gemini API response (e.g. "gemini-2.5-flash-preview-04-17"). */
    modelVersion?: string;
}

/**
 * Extract usageMetadata from an ACP prompt response result.
 *
 * The geminiclaw monkey-patch on zedIntegration.js forwards
 * `_meta.usageMetadata` in the prompt response. Without the patch
 * this returns undefined and we fall back to zero tokens.
 */
export function extractUsageMetadata(result: unknown): AcpUsageMetadata | undefined {
    return extractMeta(result)?.usageMetadata;
}

/**
 * Extract the actual model version from an ACP prompt response result.
 *
 * The geminiclaw monkey-patch captures `modelVersion` from the Gemini API
 * stream response and includes it in `_meta.modelVersion`. This is the
 * real model used by the backend (e.g. "gemini-2.5-flash-preview-04-17"),
 * as opposed to the alias requested by the client (e.g. "auto").
 */
export function extractModelVersion(result: unknown): string | undefined {
    return extractMeta(result)?.modelVersion;
}

function extractMeta(result: unknown): AcpPromptMeta | undefined {
    const r = result as { _meta?: AcpPromptMeta } | undefined;
    return r?._meta;
}

/**
 * Synthesize a ResultEvent when the ACP prompt response completes.
 *
 * If usageMetadata is available (via the geminiclaw ACP patch),
 * populates real token counts. Otherwise falls back to zeros.
 */
export function synthesizeResultEvent(durationMs: number, usage?: AcpUsageMetadata): ResultEvent {
    return {
        type: 'result',
        status: 'success',
        stats: {
            total_tokens: usage?.totalTokenCount ?? 0,
            input_tokens: usage?.promptTokenCount ?? 0,
            output_tokens: usage?.candidatesTokenCount ?? 0,
            thinking_tokens: usage?.thoughtsTokenCount ?? 0,
            cached: usage?.cachedContentTokenCount ?? 0,
            duration_ms: durationMs,
            tool_calls: 0,
        },
        timestamp: new Date().toISOString(),
    };
}
