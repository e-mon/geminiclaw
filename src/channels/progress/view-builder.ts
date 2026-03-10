/**
 * channels/progress/view-builder.ts — Accumulates StreamEvents into ProgressView snapshots.
 *
 * Extracted from ChatProgressReporter's state management logic so that
 * view state is decoupled from rendering and platform-specific behavior.
 */

import type { StreamEvent } from '../../agent/runner.js';
import type { ProgressPhase, ProgressView, ToolEntry } from './types.js';

const MAX_THINK_CHARS = 150;
const MAX_ARGS_CHARS = 80;
const MAX_TITLE_CHARS = 150;
const MAX_RESULT_CHARS = 120;
const MAX_STREAM_CHARS = 300;

/**
 * Stateful builder that processes StreamEvents and produces ProgressView snapshots.
 *
 * Call `processEvent()` for each incoming event, then `snapshot()` to get
 * the current state for rendering.
 */
export class ProgressViewBuilder {
    private readonly startTime: number;
    private phase: ProgressPhase = 'thinking';
    private skill: string | undefined;
    private tools: ToolEntry[] = [];
    private thinkingText: string | undefined;
    private streamText = '';
    private pendingQuestion: string | undefined;
    private errorMessage: string | undefined;
    private hasError = false;

    constructor(startTime?: number) {
        this.startTime = startTime ?? Date.now();
    }

    /**
     * Process a stream event and update internal state.
     *
     * Returns:
     *     True if the view changed and a re-render is warranted.
     */
    processEvent(event: StreamEvent): boolean {
        switch (event.type) {
            case 'message':
                return this.handleMessage(event);
            case 'tool_use':
                return this.handleToolUse(event);
            case 'tool_result':
                return this.handleToolResult(event);
            case 'think':
                return this.handleThink(event);
            case 'skill_activation':
                this.skill = event.skillName;
                return true;
            case 'ask_user':
                this.pendingQuestion = event.question;
                this.phase = 'waiting_user';
                return true;
            case 'error':
                this.hasError = true;
                this.errorMessage = event.message;
                this.phase = 'error';
                return true;
            default:
                return false;
        }
    }

    /** Produce a read-only snapshot of current progress state. */
    snapshot(): ProgressView {
        return {
            phase: this.phase,
            skill: this.skill,
            tools: [...this.tools],
            thinkingText: this.thinkingText,
            streamText: this.streamText || undefined,
            pendingQuestion: this.pendingQuestion,
            elapsedSec: Math.floor((Date.now() - this.startTime) / 1000),
            errorMessage: this.errorMessage,
        };
    }

    /** Whether any error event was received during the run. */
    get hadError(): boolean {
        return this.hasError;
    }

    /** Total number of tools invoked. */
    get toolCount(): number {
        return this.tools.length;
    }

    // ── Private handlers ─────────────────────────────────────────

    private handleMessage(event: StreamEvent): boolean {
        if (event.type !== 'message' || event.role !== 'assistant' || !event.delta) return false;
        this.streamText += event.delta;
        if (this.streamText.length > MAX_STREAM_CHARS * 2) {
            this.streamText = this.streamText.slice(-MAX_STREAM_CHARS);
        }
        this.phase = 'streaming';
        return true;
    }

    private handleToolUse(event: StreamEvent): boolean {
        if (event.type !== 'tool_use') return false;

        let description: string;
        if (event.title) {
            description =
                event.title.length > MAX_TITLE_CHARS ? `${event.title.substring(0, MAX_TITLE_CHARS)}…` : event.title;
        } else {
            const argsStr = event.parameters != null ? JSON.stringify(event.parameters) : '';
            description = argsStr.length > MAX_ARGS_CHARS ? `${argsStr.substring(0, MAX_ARGS_CHARS)}…` : argsStr;
        }

        this.tools.push({
            name: event.tool_name,
            description,
            status: 'running',
            startedAt: Date.now(),
        });

        this.streamText = '';
        this.pendingQuestion = undefined;
        this.phase = 'tool_active';
        return true;
    }

    private handleToolResult(event: StreamEvent): boolean {
        if (event.type !== 'tool_result') return false;

        // Find the most recent running tool and mark it complete
        const runningTool = [...this.tools].reverse().find((t) => t.status === 'running');
        if (runningTool) {
            const isError = event.status === 'error' || !!event.error;
            runningTool.status = isError ? 'error' : 'success';
            runningTool.completedAt = Date.now();

            const output = event.output ?? event.error ?? '';
            if (output) {
                const firstLine = output.split('\n').find((l: string) => l.trim()) ?? '';
                runningTool.resultSummary =
                    firstLine.length > MAX_RESULT_CHARS ? `${firstLine.substring(0, MAX_RESULT_CHARS)}…` : firstLine;
            }
        }

        this.streamText = '';
        this.phase = 'thinking';
        return true;
    }

    private handleThink(event: StreamEvent): boolean {
        if (event.type !== 'think') return false;
        this.thinkingText =
            event.content.length > MAX_THINK_CHARS ? `${event.content.substring(0, MAX_THINK_CHARS)}…` : event.content;
        this.phase = 'thinking';
        return true;
    }
}
