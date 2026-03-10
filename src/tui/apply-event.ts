/**
 * tui/apply-event.ts — Pure function: fold a StreamEvent into RunState.
 *
 * Extracted from the old useRunState hook so it can be used without React
 * (by pi-tui state managers) as well as by the old Ink-based hook if needed.
 */

import type { StreamEvent } from '../agent/runner.js';
import type { OutputChunk, RunState, ToolEntry } from './types.js';
import {
    createThinkFilterState,
    flushThinkBuffer,
    processThinkDelta,
    type ThinkFilterState,
} from './utils/think-filter.js';

function addChunk(chunks: OutputChunk[], chunk: OutputChunk): OutputChunk[] {
    return [...chunks, chunk];
}

export function applyEvent(state: RunState, event: StreamEvent, thinkRef: { current: ThinkFilterState }): RunState {
    switch (event.type) {
        case 'init':
            return { ...state, status: 'running', model: event.model, sessionId: event.session_id };

        case 'message': {
            if (event.role !== 'assistant') return state;
            // Guard against non-string delta values (Gemini CLI may send delta:true as a boolean
            // for thinking events; string coercion would produce the literal text "true").
            const rawDelta = typeof event.delta === 'string' ? event.delta : null;
            const raw = rawDelta ?? (typeof event.content === 'string' ? event.content : '');
            if (!raw) return state;

            const { flushed, thinkFlushed, nextState } = processThinkDelta(thinkRef.current, raw);
            thinkRef.current = nextState;
            if (!flushed && !thinkFlushed) return state;

            let chunks = state.chunks;
            if (thinkFlushed) {
                chunks = addChunk(chunks, { kind: 'think', content: thinkFlushed });
            }
            if (flushed) {
                // Split at newlines. The first segment is appended to the last text chunk
                // (if one exists) so that streaming deltas for the same line merge rather
                // than each appearing on its own row. Segments after a newline start new chunks.
                const segs = flushed.split('\n');
                for (let i = 0; i < segs.length; i++) {
                    const seg = segs[i];
                    if (i === 0) {
                        const last = chunks[chunks.length - 1];
                        if (last && last.kind === 'text') {
                            chunks = [...chunks.slice(0, -1), { ...last, content: last.content + seg }];
                        } else {
                            chunks = addChunk(chunks, { kind: 'text', content: seg });
                        }
                    } else {
                        chunks = addChunk(chunks, { kind: 'text', content: seg });
                    }
                }
            }
            return { ...state, chunks };
        }

        case 'tool_use': {
            const entry: ToolEntry = { id: event.tool_id, name: event.tool_name, status: 'pending' };
            let toolParams: string | undefined;
            try {
                const s = JSON.stringify(event.parameters);
                // Truncate args to 200 chars to keep the card readable
                toolParams = s.length > 200 ? `${s.slice(0, 200)}…` : s;
            } catch {
                toolParams = undefined;
            }
            return {
                ...state,
                tools: [...state.tools, entry],
                chunks: addChunk(state.chunks, {
                    kind: 'tool_call',
                    content: event.tool_name,
                    toolId: event.tool_id,
                    toolParams,
                }),
            };
        }

        case 'tool_result': {
            const resultLen = (event.output ?? event.error ?? '').length;
            const toolStatus = event.status === 'success' ? ('done' as const) : ('error' as const);
            const updatedTools = state.tools.map((t) =>
                t.id === event.tool_id ? { ...t, status: toolStatus, resultChars: resultLen } : t,
            );
            // Merge result into the matching tool_call chunk in-place
            const updatedChunks = state.chunks.map((c) =>
                c.kind === 'tool_call' && c.toolId === event.tool_id ? { ...c, resultChars: resultLen, toolStatus } : c,
            );
            return { ...state, tools: updatedTools, chunks: updatedChunks };
        }

        case 'error':
            if (event.severity === 'error') {
                return { ...state, status: 'error', errorMessage: event.message };
            }
            return state;

        case 'result': {
            // Flush pending think-filter buffer so the last characters aren't dropped.
            const { text: pendingText } = flushThinkBuffer(thinkRef.current);
            thinkRef.current = createThinkFilterState();
            const finalChunks = pendingText
                ? addChunk(state.chunks, { kind: 'text', content: pendingText })
                : state.chunks;
            return {
                ...state,
                status: 'done',
                chunks: finalChunks,
                tokens: {
                    input: event.stats.input_tokens,
                    output: event.stats.output_tokens,
                    thinking: event.stats.thinking_tokens,
                    total: event.stats.total_tokens,
                    cached: event.stats.cached,
                },
                durationMs: event.stats.duration_ms,
            };
        }

        default:
            return state;
    }
}
