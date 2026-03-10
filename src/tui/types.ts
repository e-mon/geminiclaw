/**
 * tui/types.ts — Shared type definitions for the rich TUI.
 */

export type RunStatus = 'initializing' | 'running' | 'done' | 'error';

export interface ToolEntry {
    id: string;
    name: string;
    status: 'pending' | 'done' | 'error';
    /** Character count of the result output, for display. */
    resultChars?: number;
}

export type OutputChunkKind = 'text' | 'tool_call' | 'user_message' | 'think';

export interface OutputChunk {
    kind: OutputChunkKind;
    content: string;
    /** For tool_call chunks: links to the tool_id so the result can be merged in-place. */
    toolId?: string;
    /** Populated once the tool result arrives (chars count). */
    resultChars?: number;
    /** 'done' | 'error' once the result arrives. */
    toolStatus?: 'done' | 'error';
    /** JSON-stringified tool parameters (tool_call only, truncated for display). */
    toolParams?: string;
}

export interface RunState {
    status: RunStatus;
    model: string;
    sessionId: string;
    elapsedMs: number;
    tools: ToolEntry[];
    /** Ring buffer: capped at MAX_OUTPUT_CHUNKS to prevent unbounded growth. */
    chunks: OutputChunk[];
    tokens: {
        input: number;
        output: number;
        thinking: number;
        total: number;
        cached: number;
    };
    durationMs: number;
    errorMessage?: string;
}
