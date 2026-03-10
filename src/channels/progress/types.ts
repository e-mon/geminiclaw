/**
 * channels/progress/types.ts — Semantic data model for progress display.
 *
 * Platform-agnostic representation of agent execution progress.
 * StreamEvents are accumulated into a ProgressView snapshot, which
 * is then decomposed into ProgressParts for rendering.
 */

export type ProgressPhase = 'thinking' | 'tool_active' | 'streaming' | 'waiting_user' | 'completed' | 'error';

export interface ToolEntry {
    name: string;
    /** Human-readable description (ACP title or args summary). */
    description: string;
    /** First line of tool_result output. */
    resultSummary?: string;
    status: 'running' | 'success' | 'error';
    startedAt: number;
    completedAt?: number;
}

export interface ProgressView {
    phase: ProgressPhase;
    skill?: string;
    tools: ToolEntry[];
    thinkingText?: string;
    streamText?: string;
    pendingQuestion?: string;
    elapsedSec: number;
    errorMessage?: string;
}

// ── Semantic parts ───────────────────────────────────────────────

export interface ProgressHeader {
    type: 'header';
    phase: ProgressPhase;
    skill?: string;
}

export interface ToolTimeline {
    type: 'tool_timeline';
    tools: ToolEntry[];
}

export interface ThinkingBlock {
    type: 'thinking';
    text: string;
}

export interface StreamPreview {
    type: 'stream_preview';
    text: string;
}

export interface StatsFooter {
    type: 'stats_footer';
    elapsedSec: number;
    toolCount: number;
}

export type ProgressPart = ProgressHeader | ToolTimeline | ThinkingBlock | StreamPreview | StatsFooter;
