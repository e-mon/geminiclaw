/**
 * agent/runner.test.ts — Tests for RunResultBuilder and post-processing utilities.
 */

import { describe, expect, it } from 'vitest';
import {
    type ErrorEvent,
    filterResponseText,
    type InitEvent,
    type MessageEvent,
    type ResultEvent,
    RunResultBuilder,
    type ToolResultEvent,
    type ToolUseEvent,
} from './runner.js';

// ── Fixtures ─────────────────────────────────────────────────────

const initEvent: InitEvent = {
    type: 'init',
    session_id: 'sess-123',
    model: 'gemini-2.5-flash',
    timestamp: '2026-02-22T10:00:00Z',
};

const messageEvent: MessageEvent = {
    type: 'message',
    role: 'assistant',
    content: 'Hello!',
    timestamp: '2026-02-22T10:00:01Z',
};

const messageDeltaEvent: MessageEvent = {
    type: 'message',
    role: 'assistant',
    content: '',
    delta: ' World',
    timestamp: '2026-02-22T10:00:02Z',
};

const toolUseEvent: ToolUseEvent = {
    type: 'tool_use',
    tool_name: 'qmd__qmd_query',
    tool_id: 'tool-1',
    parameters: { text: 'user name is Test', category: 'user' },
    timestamp: '2026-02-22T10:00:03Z',
};

const toolResultEvent: ToolResultEvent = {
    type: 'tool_result',
    tool_id: 'tool-1',
    status: 'success',
    output: 'Saved memory id=42',
    timestamp: '2026-02-22T10:00:04Z',
};

const errorEvent: ErrorEvent = {
    type: 'error',
    severity: 'error',
    message: 'Something went wrong',
    timestamp: '2026-02-22T10:00:05Z',
};

const resultEvent: ResultEvent = {
    type: 'result',
    status: 'success',
    stats: {
        total_tokens: 1500,
        input_tokens: 1000,
        output_tokens: 500,
        cached: 200,
        duration_ms: 3456,
        tool_calls: 1,
    },
    timestamp: '2026-02-22T10:00:06Z',
};

// ── RunResultBuilder ─────────────────────────────────────────────

describe('RunResultBuilder', () => {
    it('handles init event', () => {
        const builder = new RunResultBuilder('manual');
        builder.handleEvent(initEvent);
        const result = builder.build();

        expect(result.sessionId).toBe('sess-123');
        expect(result.model).toBe('gemini-2.5-flash');
        expect(result.trigger).toBe('manual');
    });

    it('accumulates message content', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent(messageEvent);
        const result = builder.build();

        expect(result.responseText).toBe('Hello!');
    });

    it('accumulates message deltas', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent(messageEvent);
        builder.handleEvent(messageDeltaEvent);
        const result = builder.build();

        expect(result.responseText).toBe('Hello! World');
    });

    it('ignores non-assistant messages', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent({
            ...messageEvent,
            role: 'user',
            content: 'should be ignored',
        });
        const result = builder.build();

        expect(result.responseText).toBe('');
    });

    it('tracks tool calls', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent(toolUseEvent);
        const result = builder.build();

        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0].id).toBe('tool-1');
        expect(result.toolCalls[0].name).toBe('qmd__qmd_query');
        expect(result.toolCalls[0].args).toEqual({
            text: 'user name is Test',
            category: 'user',
        });
    });

    it('matches tool results to tool calls', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent(toolUseEvent);
        builder.handleEvent(toolResultEvent);
        const result = builder.build();

        expect(result.toolCalls[0].result).toBe('Saved memory id=42');
        expect(result.toolCalls[0].status).toBe('success');
    });

    it('handles orphaned tool results gracefully', () => {
        const builder = new RunResultBuilder();
        // tool_result without prior tool_use — should not throw
        builder.handleEvent(toolResultEvent);
        const result = builder.build();

        expect(result.toolCalls).toHaveLength(0);
    });

    it('records error events', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent(errorEvent);
        const result = builder.build();

        expect(result.error).toBe('Something went wrong');
    });

    it('ignores non-error severity', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent({ ...errorEvent, severity: 'warning' });
        const result = builder.build();

        expect(result.error).toBeUndefined();
    });

    it('extracts token stats and duration from result event', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent(resultEvent);
        const result = builder.build();

        expect(result.tokens).toEqual({
            total: 1500,
            input: 1000,
            output: 500,
            cached: 200,
        });
        expect(result.durationMs).toBe(3456);
    });

    it('detects HEARTBEAT_OK as standalone line', () => {
        const builder = new RunResultBuilder('heartbeat');
        builder.handleEvent({
            ...messageEvent,
            content: 'HEARTBEAT_OK',
        });
        const result = builder.build();

        expect(result.heartbeatOk).toBe(true);
        expect(result.trigger).toBe('heartbeat');
    });

    it('heartbeatOk is false when not present', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent(messageEvent);
        const result = builder.build();

        expect(result.heartbeatOk).toBe(false);
    });

    it('heartbeatOk ignores HEARTBEAT_OK inside <think> tags', () => {
        const builder = new RunResultBuilder('heartbeat');
        builder.handleEvent({
            ...messageEvent,
            content: '<think>I should output HEARTBEAT_OK</think>Something needs attention.',
        });
        const result = builder.build();

        // HEARTBEAT_OK only appeared inside a <think> block — must not count.
        expect(result.heartbeatOk).toBe(false);
    });

    it('has unique runId', () => {
        const b1 = new RunResultBuilder();
        const b2 = new RunResultBuilder();
        expect(b1.build().runId).not.toBe(b2.build().runId);
    });

    it('has timestamp', () => {
        const builder = new RunResultBuilder();
        const result = builder.build();
        expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('extractCompletedThink returns content of a complete <think> block', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent({ ...messageEvent, content: '<think>let me reason</think>response' });
        expect(builder.extractCompletedThink()).toBe('let me reason');
    });

    it('extractCompletedThink returns content of a complete <thought> block', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent({ ...messageEvent, content: '<thought>reasoning here</thought>response' });
        expect(builder.extractCompletedThink()).toBe('reasoning here');
    });

    it('extractCompletedThink handles both <think> and <thought> in same response', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent({ ...messageEvent, content: '<think>first</think>text<thought>second</thought>done' });
        expect(builder.extractCompletedThink()).toBe('first');
        expect(builder.extractCompletedThink()).toBe('second');
        expect(builder.extractCompletedThink()).toBeNull();
    });

    it('extractCompletedThink does not match mismatched open/close tags', () => {
        const builder = new RunResultBuilder();
        // <think> opened but </thought> closed — should not match
        builder.handleEvent({ ...messageEvent, content: '<think>bad</thought>' });
        expect(builder.extractCompletedThink()).toBeNull();
    });

    it('extractCompletedThink returns null when no think block present', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent(messageEvent);
        expect(builder.extractCompletedThink()).toBeNull();
    });

    it('extractCompletedThink returns null for an incomplete think block', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent({ ...messageEvent, content: '<think>incomplete' });
        expect(builder.extractCompletedThink()).toBeNull();
    });

    it('extractCompletedThink does not re-emit the same block', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent({ ...messageEvent, content: '<think>first</think>response' });
        expect(builder.extractCompletedThink()).toBe('first');
        // Second call — same block should not be emitted again
        expect(builder.extractCompletedThink()).toBeNull();
    });

    it('extractCompletedThink emits each block exactly once across multiple blocks', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent({ ...messageEvent, content: '<think>first</think>text<think>second</think>done' });
        expect(builder.extractCompletedThink()).toBe('first');
        expect(builder.extractCompletedThink()).toBe('second');
        expect(builder.extractCompletedThink()).toBeNull();
    });

    it('extractCompletedThink trims whitespace from think content', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent({ ...messageEvent, content: '<think>  trimmed  </think>' });
        expect(builder.extractCompletedThink()).toBe('trimmed');
    });
});

// ── extractPendingSkillActivation ────────────────────────────────

describe('RunResultBuilder (skill activation)', () => {
    it('extracts skill name from <activated_skill> opening tag', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent({
            ...messageEvent,
            content: '<activated_skill name="todo-tracker"><instructions>do stuff</instructions></activated_skill>',
        });
        expect(builder.extractPendingSkillActivation()).toBe('todo-tracker');
    });

    it('returns null when no skill activation present', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent(messageEvent);
        expect(builder.extractPendingSkillActivation()).toBeNull();
    });

    it('does not re-emit the same skill activation', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent({ ...messageEvent, content: '<activated_skill name="my-skill">' });
        expect(builder.extractPendingSkillActivation()).toBe('my-skill');
        expect(builder.extractPendingSkillActivation()).toBeNull();
    });

    it('emits each skill activation once even if two appear', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent({ ...messageEvent, content: '<activated_skill name="a"><activated_skill name="b">' });
        expect(builder.extractPendingSkillActivation()).toBe('a');
        expect(builder.extractPendingSkillActivation()).toBe('b');
        expect(builder.extractPendingSkillActivation()).toBeNull();
    });
});

// ── skillActivations in build() ──────────────────────────────────

describe('RunResultBuilder (skillActivations in build)', () => {
    it('collects skill names when extractPendingSkillActivation is called', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent({
            ...messageEvent,
            content: '<activated_skill name="todo-tracker">instructions</activated_skill>',
        });
        builder.extractPendingSkillActivation();
        const result = builder.build();
        expect(result.skillActivations).toEqual(['todo-tracker']);
    });

    it('collects multiple skill names across calls', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent({
            ...messageEvent,
            content: '<activated_skill name="a">x</activated_skill><activated_skill name="b">y</activated_skill>',
        });
        builder.extractPendingSkillActivation();
        builder.extractPendingSkillActivation();
        const result = builder.build();
        expect(result.skillActivations).toEqual(['a', 'b']);
    });

    it('falls back to parsing responseText when extractPendingSkillActivation was never called', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent({
            ...messageEvent,
            content: '<activated_skill name="deep-research">content</activated_skill>',
        });
        // No extractPendingSkillActivation() call — build() should still find it
        const result = builder.build();
        expect(result.skillActivations).toEqual(['deep-research']);
    });

    it('returns empty array when no skills are activated', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent(messageEvent);
        const result = builder.build();
        expect(result.skillActivations).toEqual([]);
    });

    it('detects skill from activate_skill tool call', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent({
            ...toolUseEvent,
            tool_name: 'activate_skill',
            tool_id: 'activate_skill_123',
            parameters: { name: 'agent-browser' },
        });
        const result = builder.build();
        expect(result.skillActivations).toEqual(['agent-browser']);
    });

    it('collects skills from both activate_skill tool calls and XML tags', () => {
        const builder = new RunResultBuilder();
        builder.handleEvent({
            ...toolUseEvent,
            tool_name: 'activate_skill',
            tool_id: 'activate_skill_123',
            parameters: { name: 'agent-browser' },
        });
        builder.handleEvent({
            ...messageEvent,
            content: '<activated_skill name="todo-tracker">instructions</activated_skill>',
        });
        builder.extractPendingSkillActivation();
        const result = builder.build();
        expect(result.skillActivations).toEqual(['agent-browser', 'todo-tracker']);
    });
});

// ── filterResponseText ────────────────────────────────────────────

describe('filterResponseText', () => {
    it('strips <think> blocks', () => {
        expect(filterResponseText('<think>reasoning</think>Hello')).toBe('Hello');
    });

    it('strips <thought> blocks', () => {
        expect(filterResponseText('<thought>reasoning</thought>Hello')).toBe('Hello');
    });

    it('strips <activated_skill> blocks', () => {
        const input =
            '<activated_skill name="todo-tracker"><instructions>do stuff</instructions></activated_skill>\nHello';
        expect(filterResponseText(input)).toBe('Hello');
    });

    it('strips multiple meta-tags', () => {
        const input =
            '<think>think1</think>\n<activated_skill name="x"><instructions/></activated_skill>\nActual reply';
        expect(filterResponseText(input)).toBe('Actual reply');
    });

    it('collapses excess blank lines', () => {
        const input = 'Hello\n\n\n\nWorld';
        expect(filterResponseText(input)).toBe('Hello\n\nWorld');
    });

    it('returns trimmed plain text unchanged', () => {
        expect(filterResponseText('Hello, world!')).toBe('Hello, world!');
    });

    it('returns empty string for response that is only meta-tags', () => {
        expect(filterResponseText('<think>only thoughts</think>')).toBe('');
    });

    it('does not strip <reply> tags (deprecated, no longer extracted)', () => {
        const input =
            "I'll now check the calendar.\nReading digest...\n<reply>☀️ 天気は晴れ、予定なし</reply>\nUpdating state...";
        expect(filterResponseText(input)).toContain('<reply>');
    });
});
