/**
 * agent/acp/index.ts — Barrel export for the ACP module.
 */

export { AcpClient, AcpError, pickSafeEnv } from './client.js';
export { AcpEventMapper, synthesizeResultEvent } from './event-mapper.js';
export { AcpProcessPool } from './process-pool.js';
export { type SpawnGeminiAcpOptions, spawnGeminiAcp } from './runner.js';
export type {
    AcpMcpServerEntry,
    AcpSessionUpdate,
    JsonRpcError,
    JsonRpcNotification,
    JsonRpcRequest,
    JsonRpcResponse,
} from './types.js';
