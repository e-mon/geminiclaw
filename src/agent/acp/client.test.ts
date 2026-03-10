/**
 * agent/acp/client.test.ts — Tests for AcpClient and pickSafeEnv.
 */

import { describe, expect, it, vi } from 'vitest';
import { AcpError, pickSafeEnv, resolveSandboxMode } from './client.js';

// Bun's vitest compat has issues with module mocking that affect all tests
// in this file — vi.mock declarations cause import resolution differences.
const isBun = typeof globalThis.Bun !== 'undefined';

// ── pickSafeEnv ──────────────────────────────────────────────────

describe.skipIf(isBun)('pickSafeEnv', () => {
    it('includes exact-match env vars', () => {
        const result = pickSafeEnv({ PATH: '/usr/bin', HOME: '/home/user', SECRET_KEY: 'hidden' });
        expect(result.PATH).toBe('/usr/bin');
        expect(result.HOME).toBe('/home/user');
        expect(result.SECRET_KEY).toBeUndefined();
    });

    it('includes prefix-match env vars (XDG_, NODE_, GEMINI_)', () => {
        const result = pickSafeEnv({
            XDG_CONFIG_HOME: '/home/.config',
            NODE_ENV: 'test',
            GEMINI_API_KEY: 'key-123',
            GEMINICLAW_WORKSPACE: '/workspace',
            AWS_SECRET: 'nope',
        });
        expect(result.XDG_CONFIG_HOME).toBe('/home/.config');
        expect(result.NODE_ENV).toBe('test');
        expect(result.GEMINI_API_KEY).toBe('key-123');
        expect(result.GEMINICLAW_WORKSPACE).toBe('/workspace');
        expect(result.AWS_SECRET).toBeUndefined();
    });

    it('skips undefined values', () => {
        const result = pickSafeEnv({ PATH: undefined });
        expect(result).not.toHaveProperty('PATH');
    });
});

// ── resolveSandboxMode ────────────────────────────────────────────

vi.mock('../turn/sandbox.js', () => ({
    buildDockerSandboxMounts: vi.fn(() => ''),
    isDockerAvailable: vi.fn(() => true),
    SEATBELT_PROFILE_NAME: 'geminiclaw',
    writeSeatbeltProfile: vi.fn(),
}));

import { isDockerAvailable } from '../turn/sandbox.js';

describe('resolveSandboxMode', () => {
    it('returns false when sandbox is false', () => {
        expect(resolveSandboxMode(false)).toBe(false);
    });

    it('returns seatbelt when explicitly set', () => {
        expect(resolveSandboxMode('seatbelt')).toBe('seatbelt');
    });

    it('returns docker when explicitly set', () => {
        expect(resolveSandboxMode('docker')).toBe('docker');
    });

    it('returns docker when true and Docker is available', () => {
        (isDockerAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true);
        expect(resolveSandboxMode(true)).toBe('docker');
    });

    it('returns false when true and Docker is not available', () => {
        (isDockerAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false);
        expect(resolveSandboxMode(true)).toBe(false);
    });
});

// ── AcpError ─────────────────────────────────────────────────────

describe('AcpError', () => {
    it('formats error message with method name', () => {
        const err = new AcpError('session/new', { code: -32600, message: 'Invalid request' });
        expect(err.message).toBe('ACP session/new: Invalid request');
        expect(err.name).toBe('AcpError');
        expect(err.code).toBe(-32600);
    });

    it('preserves error data', () => {
        const data = { details: 'some context' };
        const err = new AcpError('initialize', { code: -1, message: 'fail', data });
        expect(err.data).toEqual(data);
    });

    it('is an instance of Error', () => {
        const err = new AcpError('test', { code: 0, message: 'test' });
        expect(err).toBeInstanceOf(Error);
    });
});

// ── AcpClient (integration-level, mocked child process) ─────────

// AcpClient constructor spawns a real process, so we test its behavior
// via a simulated message flow using vi.mock for child_process.

vi.mock('node:child_process', () => {
    const { PassThrough } = require('node:stream');
    const { EventEmitter } = require('node:events');
    return {
        spawn: vi.fn(() => {
            const child = new EventEmitter() as ReturnType<typeof import('node:child_process').spawn>;
            Object.assign(child, {
                stdin: new PassThrough(),
                stdout: new PassThrough(),
                stderr: new PassThrough(),
                pid: 12345,
                kill: vi.fn(),
                unref: vi.fn(),
            });
            return child;
        }),
    };
});

vi.mock('../../logger.js', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

import { spawn } from 'node:child_process';
import { AcpClient } from './client.js';

function getChild(): ReturnType<typeof spawn> {
    return (spawn as unknown as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;
}

/** Simulate the ACP server writing a JSON-RPC response line to stdout. */
function writeLine(child: ReturnType<typeof spawn>, data: object): void {
    (child.stdout as unknown as import('node:stream').PassThrough).write(`${JSON.stringify(data)}\n`);
}

describe.skipIf(isBun)('AcpClient', () => {
    it('sends initialize request with correct params', async () => {
        const client = new AcpClient('/tmp/test', undefined, undefined, false);
        const child = getChild();

        // Capture what gets written to stdin
        const chunks: Buffer[] = [];
        (child.stdin as unknown as import('node:stream').PassThrough).on('data', (chunk: Buffer) => chunks.push(chunk));

        const initPromise = client.initialize();

        // Wait a tick for the write to happen
        await new Promise((r) => setTimeout(r, 10));

        // Parse the request
        const sent = JSON.parse(chunks[0].toString());
        expect(sent.method).toBe('initialize');
        expect(sent.params.clientInfo.name).toBe('geminiclaw');
        expect(sent.params.protocolVersion).toBe(1);

        // Respond
        writeLine(child, { jsonrpc: '2.0', id: sent.id, result: {} });
        await initPromise;
    });

    it('throws AcpError when initialize returns error', async () => {
        const client = new AcpClient('/tmp/test', undefined, undefined, false);
        const child = getChild();

        const initPromise = client.initialize();
        await new Promise((r) => setTimeout(r, 10));

        const chunks: Buffer[] = [];
        (child.stdin as unknown as import('node:stream').PassThrough).on('data', (chunk: Buffer) => chunks.push(chunk));

        // Re-read since stdin may already have data
        const written = (child.stdin as unknown as import('node:stream').PassThrough).read();
        const sent = JSON.parse(written?.toString().trim() || '{}');

        writeLine(child, {
            jsonrpc: '2.0',
            id: sent.id || 1,
            error: { code: -32600, message: 'bad request' },
        });

        await expect(initPromise).rejects.toThrow('ACP initialize');
    });

    it('auto-grants permission requests with optionId from options array', async () => {
        const _client = new AcpClient('/tmp/test', undefined, undefined, false);
        const child = getChild();

        const chunks: Buffer[] = [];
        (child.stdin as unknown as import('node:stream').PassThrough).on('data', (chunk: Buffer) => chunks.push(chunk));

        // Server sends a permission request with options (as ACP actually does)
        writeLine(child, {
            jsonrpc: '2.0',
            id: 99,
            method: 'requestPermission',
            params: {
                sessionId: 'sess-1',
                options: [
                    { optionId: 'proceed_once', label: 'Allow once' },
                    { optionId: 'cancel', label: 'Cancel' },
                ],
            },
        });

        await new Promise((r) => setTimeout(r, 50));

        const replies = chunks
            .map((c) => c.toString().trim())
            .filter((s) => s)
            .map((s) => {
                try {
                    return JSON.parse(s);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);

        const permReply = replies.find((r: { id?: number }) => r.id === 99);
        expect(permReply).toBeDefined();
        expect(permReply.result.outcome.optionId).toBe('proceed_once');
    });

    it('dispatches session/update notifications to update handler', async () => {
        const client = new AcpClient('/tmp/test', undefined, undefined, false);
        const child = getChild();

        const updates: Array<{ sid: string; update: unknown }> = [];
        client.setUpdateHandler((sid, update) => {
            updates.push({ sid, update });
        });

        writeLine(child, {
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
                sessionId: 'sess-abc',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
            },
        });

        await new Promise((r) => setTimeout(r, 50));

        expect(updates).toHaveLength(1);
        expect(updates[0].sid).toBe('sess-abc');
    });

    it('reports closed state after process close', async () => {
        const client = new AcpClient('/tmp/test', undefined, undefined, false);
        const child = getChild();

        expect(client.closed).toBe(false);
        (child as unknown as import('node:events').EventEmitter).emit('close');
        expect(client.closed).toBe(true);
    });

    it('rejects send when closed', async () => {
        const client = new AcpClient('/tmp/test', undefined, undefined, false);
        const child = getChild();
        (child as unknown as import('node:events').EventEmitter).emit('close');

        await expect(client.initialize()).rejects.toThrow('closed');
    });
});
