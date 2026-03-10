/**
 * agent/acp/event-mapper.test.ts — Tests for ACP → StreamEvent mapping.
 */

import { describe, expect, it } from 'vitest';
import { AcpEventMapper, extractModelVersion, extractUsageMetadata, synthesizeResultEvent } from './event-mapper.js';
import type { AcpAgentMessageChunk, AcpGenericUpdate, AcpToolCall, AcpToolCallUpdate } from './types.js';

/** Helper: create a fresh mapper and map a single update. */
function mapUpdate(update: unknown) {
    const mapper = new AcpEventMapper();
    const result = mapper.map(update as AcpGenericUpdate);
    // Unwrap single-element arrays for simpler assertions
    return Array.isArray(result) ? result[0] : result;
}

describe('AcpEventMapper.map', () => {
    it('maps agent_message_chunk to MessageEvent', () => {
        const update: AcpAgentMessageChunk = {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello!' },
        };
        const event = mapUpdate(update);
        expect(event).not.toBeNull();
        expect(event?.type).toBe('message');
        if (event?.type === 'message') {
            expect(event?.role).toBe('assistant');
            expect(event?.delta).toBe('Hello!');
        }
    });

    it('maps tool_call to ToolUseEvent', () => {
        const update: AcpToolCall = {
            sessionUpdate: 'tool_call',
            toolName: 'web_search',
            toolId: 'tc-1',
            input: { query: 'test' },
        };
        const event = mapUpdate(update);
        expect(event).not.toBeNull();
        expect(event?.type).toBe('tool_use');
        if (event?.type === 'tool_use') {
            expect(event?.tool_name).toBe('web_search');
            expect(event?.tool_id).toBe('tc-1');
            expect(event?.parameters).toEqual({ query: 'test' });
        }
    });

    it('maps tool_call_update to ToolResultEvent', () => {
        // Send tool_call first so the mapper tracks the toolId
        const mapper = new AcpEventMapper();
        mapper.map({
            sessionUpdate: 'tool_call',
            toolName: 'web_search',
            toolId: 'tc-1',
            input: {},
        } as unknown as AcpGenericUpdate);

        const update: AcpToolCallUpdate = {
            sessionUpdate: 'tool_call_update',
            toolId: 'tc-1',
            status: 'success',
            output: 'result data',
        };
        const result = mapper.map(update as unknown as AcpGenericUpdate);
        // With toolId already seen, returns a single ToolResultEvent
        const event = Array.isArray(result) ? result[0] : result;
        expect(event).not.toBeNull();
        expect(event?.type).toBe('tool_result');
        if (event?.type === 'tool_result') {
            expect(event?.tool_id).toBe('tc-1');
            expect(event?.status).toBe('success');
            expect(event?.output).toBe('result data');
        }
    });

    it('maps thinking to ThinkEvent', () => {
        const update = {
            sessionUpdate: 'thinking',
            content: { type: 'text', text: 'let me think...' },
        } as AcpGenericUpdate;
        const event = mapUpdate(update);
        expect(event).not.toBeNull();
        expect(event?.type).toBe('think');
        expect((event as { content: string }).content).toBe('let me think...');
    });

    it('maps error to ErrorEvent', () => {
        const update = {
            sessionUpdate: 'error',
            message: 'Something failed',
            severity: 'error',
        } as AcpGenericUpdate;
        const event = mapUpdate(update);
        expect(event).not.toBeNull();
        expect(event?.type).toBe('error');
        if (event?.type === 'error') {
            expect(event?.message).toBe('Something failed');
        }
    });

    it('returns null for unknown update types', () => {
        const update: AcpGenericUpdate = {
            sessionUpdate: 'turn_complete',
        };
        expect(mapUpdate(update)).toBeNull();
    });

    it('returns null for agent_message_chunk with non-text content', () => {
        const update = {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'image', data: '...' },
        } as unknown as AcpAgentMessageChunk;
        expect(mapUpdate(update)).toBeNull();
    });
});

describe('synthesizeResultEvent', () => {
    it('creates a ResultEvent with given duration', () => {
        const event = synthesizeResultEvent(5000);
        expect(event.type).toBe('result');
        expect(event.status).toBe('success');
        expect(event.stats.duration_ms).toBe(5000);
        expect(event.stats.total_tokens).toBe(0);
    });
});

describe('extractUsageMetadata / extractModelVersion', () => {
    it('extracts usageMetadata from _meta', () => {
        const result = { _meta: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } } };
        const usage = extractUsageMetadata(result);
        expect(usage?.promptTokenCount).toBe(10);
        expect(usage?.candidatesTokenCount).toBe(20);
    });

    it('extracts modelVersion from _meta', () => {
        const result = { _meta: { modelVersion: 'gemini-2.5-flash-preview-04-17' } };
        expect(extractModelVersion(result)).toBe('gemini-2.5-flash-preview-04-17');
    });

    it('returns undefined when _meta is absent', () => {
        expect(extractUsageMetadata({ stopReason: 'end_turn' })).toBeUndefined();
        expect(extractModelVersion({ stopReason: 'end_turn' })).toBeUndefined();
    });

    it('returns undefined for null/undefined result', () => {
        expect(extractModelVersion(undefined)).toBeUndefined();
        expect(extractModelVersion(null)).toBeUndefined();
    });
});
