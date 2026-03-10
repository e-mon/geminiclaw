/**
 * agent/acp/types.ts — ACP (Agent Communication Protocol) type definitions.
 *
 * JSON-RPC 2.0 over stdio types for `gemini --acp`.
 */

// ── JSON-RPC 2.0 base types ─────────────────────────────────────

export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: unknown;
}

export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number;
    result?: unknown;
    error?: JsonRpcError;
}

export interface JsonRpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: unknown;
}

/** Server-initiated request (has both method and id). */
export interface JsonRpcServerRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: unknown;
}

export interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}

/** Any message received over the ACP stdio channel. */
export type AcpMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

// ── ACP session update types ─────────────────────────────────────

export interface AcpSessionUpdateNotification {
    jsonrpc: '2.0';
    method: 'session/update';
    params: {
        sessionId: string;
        update: AcpSessionUpdate;
    };
}

export type AcpSessionUpdate =
    | AcpAgentMessageChunk
    | AcpToolCall
    | AcpToolCallUpdate
    | AcpThinkingChunk
    | AcpGenericUpdate;

export interface AcpAgentMessageChunk {
    sessionUpdate: 'agent_message_chunk';
    content: { type: 'text'; text: string };
}

export interface AcpToolCall {
    sessionUpdate: 'tool_call';
    toolName: string;
    toolId: string;
    input?: unknown;
}

export interface AcpToolCallUpdate {
    sessionUpdate: 'tool_call_update';
    toolId: string;
    status?: string;
    output?: string;
    error?: string;
}

export interface AcpThinkingChunk {
    sessionUpdate: 'thinking';
    content: { type: 'text'; text: string };
}

export interface AcpGenericUpdate {
    sessionUpdate: string;
    [key: string]: unknown;
}

// ── ACP method params / results ──────────────────────────────────

export interface AcpInitializeParams {
    protocolVersion: number;
    clientCapabilities: {
        fs?: { readTextFile?: boolean; writeTextFile?: boolean };
        terminal?: boolean;
    };
    clientInfo: { name: string; version: string };
}

export interface AcpMcpServerEntry {
    name: string;
    command: string;
    args: string[];
    env: Array<{ name: string; value: string }>;
}

export interface AcpNewSessionParams {
    cwd: string;
    mcpServers?: AcpMcpServerEntry[];
}

export interface AcpNewSessionResult {
    sessionId: string;
    models?: { currentModelId?: string };
}

export interface AcpLoadSessionParams {
    sessionId: string;
    cwd: string;
    mcpServers?: AcpMcpServerEntry[];
}

export interface AcpPromptParams {
    sessionId: string;
    prompt: Array<{ type: 'text'; text: string }>;
}

export interface AcpPromptResult {
    response?: unknown;
}

export interface AcpCancelParams {
    sessionId: string;
}

// ── Permission handling ──────────────────────────────────────────

export interface AcpPermissionRequest {
    method: string;
    id: number;
    params: {
        sessionId: string;
        permission: {
            type: string;
            tool?: string;
            description?: string;
            options?: Array<{ id: string; label: string }>;
        };
    };
}

export interface AcpPermissionResponse {
    outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
}
