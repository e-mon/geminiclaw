/**
 * tui/pi/state-manager.ts — EventEmitter → state bridge (no React).
 *
 * Replaces useRunState / useInteractiveState hooks with plain TypeScript
 * classes. On each relevant event, state is updated and `onUpdate()` is
 * called so the TUI can request a re-render.
 */

import type { EventEmitter } from 'node:events';
import type { RunResult, StreamEvent } from '../../agent/runner.js';
import { applyEvent } from '../apply-event.js';
import type { OutputChunk, RunState, ToolEntry } from '../types.js';
import { createThinkFilterState, type ThinkFilterState } from '../utils/think-filter.js';

// ── Single-run state manager ──────────────────────────────────────────────

export class RunStateManager {
    private state: RunState;
    private thinkRef: { current: ThinkFilterState };

    constructor(
        private emitter: EventEmitter,
        defaultModel: string,
        private onUpdate: () => void,
    ) {
        this.thinkRef = { current: createThinkFilterState() };
        this.state = {
            status: 'initializing',
            model: defaultModel,
            sessionId: '',
            elapsedMs: 0,
            tools: [],
            chunks: [],
            tokens: { input: 0, output: 0, thinking: 0, total: 0, cached: 0 },
            durationMs: 0,
        };

        this.emitter.on('event', this.handleEvent);
    }

    getState(): RunState {
        return this.state;
    }

    destroy(): void {
        this.emitter.off('event', this.handleEvent);
    }

    private handleEvent = (event: StreamEvent): void => {
        this.state = applyEvent(this.state, event, this.thinkRef);
        this.onUpdate();
    };
}

// ── Interactive state ─────────────────────────────────────────────────────

export interface InteractiveState {
    status: 'idle' | 'running';
    model: string;
    sessionId: string;
    turnCount: number;
    turnElapsedMs: number;
    currentTools: ToolEntry[];
    conversationChunks: OutputChunk[];
    totalTokens: { input: number; output: number; thinking: number; total: number; cached: number };
    lastDurationMs: number;
    errorMessage?: string;
}

function addChunk(chunks: OutputChunk[], chunk: OutputChunk): OutputChunk[] {
    return [...chunks, chunk];
}

export class InteractiveStateManager {
    private state: InteractiveState;
    private thinkRef: { current: ThinkFilterState };
    private turnStartMs = 0;
    private tickTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private emitter: EventEmitter,
        defaultModel: string,
        private onUpdate: () => void,
    ) {
        this.thinkRef = { current: createThinkFilterState() };
        this.state = {
            status: 'idle',
            model: defaultModel,
            sessionId: '',
            turnCount: 0,
            turnElapsedMs: 0,
            currentTools: [],
            conversationChunks: [],
            totalTokens: { input: 0, output: 0, thinking: 0, total: 0, cached: 0 },
            lastDurationMs: 0,
        };

        this.emitter.on('turn-start', this.onTurnStart);
        this.emitter.on('event', this.onEvent);
        this.emitter.on('turn-done', this.onTurnDone);
        this.emitter.on('turn-error', this.onTurnError);

        // Elapsed-time ticker (100 ms)
        this.tickTimer = setInterval(() => {
            if (this.state.status === 'running') {
                this.state = { ...this.state, turnElapsedMs: Date.now() - this.turnStartMs };
                this.onUpdate();
            }
        }, 100);
    }

    getState(): InteractiveState {
        return this.state;
    }

    /** Clear the conversation history (chunks) while preserving session/token state. */
    clearConversation(): void {
        this.state = { ...this.state, conversationChunks: [], currentTools: [] };
        this.onUpdate();
    }

    destroy(): void {
        if (this.tickTimer) clearInterval(this.tickTimer);
        this.emitter.off('turn-start', this.onTurnStart);
        this.emitter.off('event', this.onEvent);
        this.emitter.off('turn-done', this.onTurnDone);
        this.emitter.off('turn-error', this.onTurnError);
    }

    private onTurnStart = (userPrompt: string): void => {
        this.thinkRef.current = createThinkFilterState();
        this.turnStartMs = Date.now();
        this.state = {
            ...this.state,
            status: 'running',
            turnElapsedMs: 0,
            currentTools: [],
            errorMessage: undefined,
            conversationChunks: addChunk(this.state.conversationChunks, {
                kind: 'user_message',
                content: userPrompt,
            }),
        };
        this.onUpdate();
    };

    private onEvent = (event: StreamEvent): void => {
        // Bridge to applyEvent using a temporary RunState
        const bridge: RunState = {
            status: 'running',
            model: this.state.model,
            sessionId: this.state.sessionId,
            elapsedMs: this.state.turnElapsedMs,
            tools: this.state.currentTools,
            chunks: this.state.conversationChunks,
            tokens: this.state.totalTokens,
            durationMs: this.state.lastDurationMs,
            errorMessage: this.state.errorMessage,
        };

        const next = applyEvent(bridge, event, this.thinkRef);
        this.state = {
            ...this.state,
            model: next.model,
            sessionId: next.sessionId,
            currentTools: next.tools,
            conversationChunks: next.chunks,
            errorMessage: next.errorMessage ?? this.state.errorMessage,
        };
        this.onUpdate();
    };

    private onTurnDone = (result: RunResult): void => {
        this.state = {
            ...this.state,
            status: 'idle',
            turnCount: this.state.turnCount + 1,
            lastDurationMs: result.durationMs,
            totalTokens: {
                input: this.state.totalTokens.input + result.tokens.input,
                output: this.state.totalTokens.output + result.tokens.output,
                thinking: this.state.totalTokens.thinking + result.tokens.thinking,
                total: this.state.totalTokens.total + result.tokens.total,
                cached: this.state.totalTokens.cached + result.tokens.cached,
            },
        };
        this.onUpdate();
    };

    private onTurnError = (err: Error): void => {
        this.state = { ...this.state, status: 'idle', errorMessage: err.message };
        this.onUpdate();
    };
}
