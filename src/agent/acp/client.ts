/**
 * agent/acp/client.ts — JSON-RPC over stdio client for Gemini CLI ACP.
 *
 * Wraps `gemini --acp` as a persistent child process.
 * Handles request/response matching, server-initiated requests (permissions,
 * fs operations), and session update notifications.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { loadConfig } from '../../config/io.js';
import { getGeminiBin } from '../../config/paths.js';
import { createLogger } from '../../logger.js';
import {
    buildDockerSandboxMounts,
    isDockerAvailable,
    SEATBELT_PROFILE_NAME,
    writeSeatbeltProfile,
} from '../turn/sandbox.js';
import type {
    AcpInitializeParams,
    AcpLoadSessionParams,
    AcpMcpServerEntry,
    AcpMessage,
    AcpNewSessionParams,
    AcpNewSessionResult,
    AcpPromptParams,
    AcpPromptPart,
    AcpSessionUpdate,
    JsonRpcError,
    JsonRpcResponse,
} from './types.js';

const log = createLogger('acp-client');

// ── Sandbox mode ────────────────────────────────────────────────

/** Sandbox configuration: boolean for auto-detect, or explicit mode string. */
export type SandboxMode = boolean | 'seatbelt' | 'docker';

/**
 * Resolve sandbox configuration to a concrete mode.
 *   - false → disabled
 *   - true  → auto-detect: Docker if available, disabled with warning otherwise
 *   - 'seatbelt' / 'docker' → explicit
 */
export function resolveSandboxMode(sandbox: SandboxMode): 'seatbelt' | 'docker' | false {
    if (sandbox === false) return false;
    if (sandbox === 'seatbelt') return 'seatbelt';
    if (sandbox === 'docker') return 'docker';
    // sandbox === true → auto-detect: Docker if available
    if (isDockerAvailable()) return 'docker';
    log.warn('Docker not available — sandbox disabled. Install Docker or OrbStack for sandboxed execution.');
    return false;
}

// ── Env allowlist ────────────────────────────────────────────────

/** Exact env var names or prefixes (ending with `_`) forwarded to the Gemini subprocess. */
const SPAWN_ENV_ALLOWLIST: readonly string[] = [
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'TERM_PROGRAM',
    'TMPDIR',
    'XDG_', // prefix — matches XDG_CONFIG_HOME etc.
    'NODE_',
    'NPM_',
    'NVM_',
    'AGENT_BROWSER_',
    'GEMINI_',
    'GEMINICLAW_',
    'NO_COLOR',
    'FORCE_COLOR',
    'CLICOLOR',
];

/** Build a sanitized env object for the Gemini subprocess. */
export function pickSafeEnv(sourceEnv?: Record<string, string | undefined>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(sourceEnv ?? process.env)) {
        if (value === undefined) continue;
        const allowed = SPAWN_ENV_ALLOWLIST.some((entry) =>
            entry.endsWith('_') ? key.startsWith(entry) : key === entry,
        );
        if (allowed) result[key] = value;
    }
    // Enable agent-browser native Rust/CDP backend (faster, no Playwright dependency)
    result.AGENT_BROWSER_NATIVE = '1';
    // Skip keychain availability test inside sandbox — avoids macOS
    // "Keychain not found" dialog and falls back to encrypted file storage.
    result.GEMINI_FORCE_FILE_STORAGE = 'true';

    return result;
}

// ── Types ────────────────────────────────────────────────────────

export type SessionUpdateHandler = (sessionId: string, update: AcpSessionUpdate) => void;

interface PendingRequest {
    resolve: (msg: JsonRpcResponse) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    method: string;
    timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 900_000; // 15 minutes for long-running prompts

// ── AcpClient ────────────────────────────────────────────────────

export class AcpClient {
    private child: ChildProcess;
    private rl: ReturnType<typeof createInterface>;
    private pending = new Map<number, PendingRequest>();
    private nextId = 1;
    private _closed = false;
    private onSessionUpdate?: SessionUpdateHandler;
    /** ID of the currently active session/prompt request (for timeout extension). */
    private activePromptId: number | undefined;
    /** Resolved workspace directory — used to restrict fs handler paths. */
    private readonly workspaceDir: string;
    /** Stable identifier propagated to child MCP servers via env for IPC scoping. */
    readonly runId: string;

    /** Expose child PID for process-group cleanup on exit. */
    get pid(): number | undefined {
        return this.child.pid;
    }

    constructor(cwd: string, env?: Record<string, string>, model?: string, sandbox: SandboxMode = true) {
        this.workspaceDir = resolve(cwd);
        this.runId = randomUUID();
        const safeEnv = { ...pickSafeEnv(), ...env, GEMINICLAW_RUN_ID: this.runId };

        const geminiArgs = ['--acp', '--yolo'];
        if (model) geminiArgs.push('--model', model);

        const resolvedSandbox = resolveSandboxMode(sandbox);
        let spawnCmd: string;
        let spawnArgs: string[];

        if (resolvedSandbox === 'seatbelt') {
            ({ cmd: spawnCmd, args: spawnArgs } = buildSeatbeltEnv(cwd, geminiArgs, safeEnv));
        } else if (resolvedSandbox === 'docker') {
            ({ cmd: spawnCmd, args: spawnArgs } = buildDockerEnv(cwd, geminiArgs, safeEnv));
        } else {
            spawnCmd = getGeminiBin();
            spawnArgs = geminiArgs;
        }

        this.child = spawn(spawnCmd, spawnArgs, {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: safeEnv,
            // Create a new process group so we can kill the entire tree
            detached: true,
        });
        // Allow the parent to exit without waiting for this child
        this.child.unref();

        // biome-ignore lint/style/noNonNullAssertion: stdout is guaranteed by stdio: ['pipe', 'pipe', 'pipe']
        this.rl = createInterface({ input: this.child.stdout! });
        this.rl.on('line', (line) => {
            this.handleLine(line);
        });
        this.child.stderr?.on('data', (data: Buffer) => {
            log.warn('ACP stderr', { data: data.toString().trim().substring(0, 500) });
        });
        this.child.on('close', (code) => {
            log.warn('ACP process closed', { code, pending: this.pending.size });
            this._closed = true;
            this.rejectAllPending(`ACP process closed unexpectedly (code=${code})`);
        });
        this.child.on('error', (err) => {
            log.error('ACP process error', { error: err.message });
            this._closed = true;
            this.rejectAllPending(`ACP process error: ${err.message}`);
        });
    }

    get closed(): boolean {
        return this._closed;
    }

    // ── Message handling ─────────────────────────────────────────

    private handleLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) return;

        let msg: AcpMessage;
        try {
            msg = JSON.parse(trimmed);
        } catch {
            return;
        }

        // Response to a client request (has id, no method)
        if ('id' in msg && msg.id != null && !('method' in msg) && ('result' in msg || 'error' in msg)) {
            const id = msg.id as number;
            const entry = this.pending.get(id);
            if (entry) {
                this.pending.delete(id);
                clearTimeout(entry.timer);
                log.info('ACP response', { id, hasError: !!('error' in msg && msg.error) });
                entry.resolve(msg as JsonRpcResponse);
            } else {
                log.warn('ACP response for unknown id', { id });
            }
            return;
        }

        // Server-initiated request (has both method and id) — auto-handle
        if ('method' in msg && 'id' in msg && msg.id != null) {
            this.handleServerRequest(msg as { method: string; id: number; params?: unknown });
            return;
        }

        // Notification (has method, no id)
        if ('method' in msg && !('id' in msg && msg.id != null)) {
            this.handleNotification(msg as { method: string; params?: unknown });
            return;
        }

        // Unhandled message — log for debugging
        log.warn('unhandled ACP message', { keys: Object.keys(msg).join(','), snippet: trimmed.substring(0, 200) });
    }

    private handleServerRequest(msg: { method: string; id: number; params?: unknown }): void {
        const method = msg.method;

        // Handle permission requests — auto-grant all (--yolo equivalent).
        // ask_user is handled via file-based IPC (MCP tool writes pending,
        // runner polls and emits event), not through ACP permission flow.
        if (method.includes('permission') || method === 'requestPermission') {
            const params = msg.params as Record<string, unknown> | undefined;

            // Auto-grant all permissions.
            // ACP SDK v0.34+ requires { outcome: "selected", optionId } format.
            const options = params?.options as Array<Record<string, unknown>> | undefined;
            if (options && options.length > 0) {
                const allowOption = options.find((o) => String(o.kind ?? '').includes('allow'));
                const optionId = (allowOption?.optionId ?? options[0]?.optionId) as string;
                this.reply(msg.id, { outcome: { outcome: 'selected', optionId } });
            }
            return;
        }

        // Handle fs/readTextFile (supports optional line offset and limit)
        if (method.includes('readTextFile') || method.includes('read_text_file')) {
            const params = msg.params as Record<string, unknown> | undefined;
            const fsPath = params?.path as string | undefined;
            try {
                if (!fsPath || !this.isPathAllowed(fsPath)) {
                    log.warn('readTextFile blocked — path outside workspace', { path: fsPath });
                    this.reply(msg.id, { content: '' });
                    return;
                }
                let content = readFileSync(fsPath, 'utf-8');
                const startLine = typeof params?.line === 'number' ? params.line : undefined;
                const limitLines = typeof params?.limit === 'number' ? params.limit : undefined;
                if (startLine != null || limitLines != null) {
                    const lines = content.split('\n');
                    const start = startLine != null ? Math.max(0, startLine - 1) : 0;
                    const end = limitLines != null ? start + limitLines : lines.length;
                    content = lines.slice(start, end).join('\n');
                }
                this.reply(msg.id, { content });
            } catch {
                this.reply(msg.id, { content: '' });
            }
            return;
        }

        // Handle fs/writeTextFile
        if (method.includes('writeTextFile') || method.includes('write_text_file')) {
            const params = msg.params as Record<string, unknown> | undefined;
            const fsPath = params?.path as string | undefined;
            const content = params?.content as string | undefined;
            try {
                if (!fsPath || !this.isPathAllowed(fsPath)) {
                    log.warn('writeTextFile blocked — path outside workspace', { path: fsPath });
                    this.reply(msg.id, {});
                    return;
                }
                writeFileSync(fsPath, content ?? '', 'utf-8');
                this.reply(msg.id, {});
            } catch {
                this.reply(msg.id, {});
            }
            return;
        }

        // Default: empty response
        this.reply(msg.id, {});
    }

    private handleNotification(msg: { method: string; params?: unknown }): void {
        if (msg.method === 'session/update') {
            const params = msg.params as { sessionId?: string; update?: AcpSessionUpdate } | undefined;
            if (params?.sessionId && params?.update && this.onSessionUpdate) {
                this.onSessionUpdate(params.sessionId, params.update);
            }
        }
    }

    // ── Path validation ─────────────────────────────────────────

    /**
     * Check whether a filesystem path is within the workspace directory.
     * Resolves symlinks via realpathSync for existing paths, falls back to
     * resolve() for paths that don't exist yet (e.g. new files being written).
     */
    private isPathAllowed(fsPath: string): boolean {
        try {
            let resolved: string;
            if (existsSync(fsPath)) {
                // Existing path — fully resolve symlinks
                resolved = realpathSync(fsPath);
            } else {
                // New path — resolve the nearest existing ancestor to catch
                // symlinks in parent dirs (e.g. workspace/symlink-to-etc/newfile)
                let dir = resolve(dirname(fsPath));
                while (!existsSync(dir)) {
                    const parent = dirname(dir);
                    if (parent === dir) break; // filesystem root
                    dir = parent;
                }
                const realDir = existsSync(dir) ? realpathSync(dir) : dir;
                const tail = resolve(fsPath).slice(resolve(dir).length);
                resolved = realDir + tail;
            }
            return resolved.startsWith(`${this.workspaceDir}/`) || resolved === this.workspaceDir;
        } catch {
            return false;
        }
    }

    // ── Pending cleanup ────────────────────────────────────────────

    /** Reject all pending requests with the given reason. */
    private rejectAllPending(reason: string): void {
        for (const [_id, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(reason));
        }
        this.pending.clear();
    }

    // ── Low-level send/reply ─────────────────────────────────────

    private send(method: string, params?: unknown, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<JsonRpcResponse> {
        if (this._closed) {
            return Promise.reject(new Error('ACP client is closed'));
        }

        const id = this.nextId++;
        log.info('ACP send', { method, id, pending: this.pending.size });
        return new Promise<JsonRpcResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    log.error('ACP timeout', {
                        method,
                        id,
                        timeoutMs,
                        closed: this._closed,
                        pid: this.child.pid,
                        killed: this.child.killed,
                        stdinWritable: this.child.stdin?.writable ?? false,
                    });
                    reject(new Error(`ACP timeout: ${method} (id=${id}, ${timeoutMs}ms)`));
                }
            }, timeoutMs);

            this.pending.set(id, { resolve, reject, timer, method, timeoutMs });
            const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });
            this.child.stdin?.write(`${payload}\n`);
        });
    }

    private reply(id: number, result: unknown): void {
        if (this._closed) return;
        const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
        log.info('ACP reply', { id, snippet: payload.substring(0, 200) });
        const ok = this.child.stdin?.write(`${payload}\n`);
        if (!ok) {
            log.warn('ACP reply backpressure', { id });
        }
    }

    // ── High-level API ───────────────────────────────────────────

    async initialize(): Promise<void> {
        const params: AcpInitializeParams = {
            protocolVersion: 1,
            clientCapabilities: {
                fs: { readTextFile: true, writeTextFile: true },
                terminal: false,
            },
            clientInfo: { name: 'geminiclaw', version: '1.0.0' },
        };
        const resp = await this.send('initialize', params, 30_000);
        if (resp.error) {
            throw new AcpError('initialize', resp.error);
        }
        const agentInfo = (resp.result as Record<string, unknown>)?.agentInfo as
            | { name?: string; version?: string }
            | undefined;
        log.info('ACP initialized', {
            agentName: agentInfo?.name,
            agentVersion: agentInfo?.version,
        });
    }

    async newSession(cwd: string, mcpServers: AcpMcpServerEntry[] = []): Promise<AcpNewSessionResult> {
        const params: AcpNewSessionParams = { cwd, mcpServers };
        const resp = await this.send('session/new', params, 60_000);
        if (resp.error) {
            throw new AcpError('session/new', resp.error);
        }
        const result = resp.result as AcpNewSessionResult;
        log.info('ACP session created', {
            sessionId: result.sessionId.substring(0, 8),
            model: result.models?.currentModelId,
        });
        return result;
    }

    async loadSession(
        sessionId: string,
        cwd: string,
        mcpServers: AcpMcpServerEntry[] = [],
    ): Promise<string | undefined> {
        const params: AcpLoadSessionParams = { sessionId, cwd, mcpServers };
        const resp = await this.send('session/load', params, 60_000);
        if (resp.error) {
            throw new AcpError('session/load', resp.error);
        }
        const result = resp.result as { models?: { currentModelId?: string } } | undefined;
        log.info('ACP session loaded', {
            sessionId: sessionId.substring(0, 8),
            model: result?.models?.currentModelId,
        });
        return result?.models?.currentModelId;
    }

    /**
     * Send a prompt to a session. Notifications are delivered via the
     * onSessionUpdate handler registered with `setUpdateHandler()`.
     *
     * Returns when the prompt response arrives (i.e. the model is done).
     */
    async prompt(
        sessionId: string,
        text: string,
        options?: { parts?: AcpPromptPart[]; timeoutMs?: number },
    ): Promise<JsonRpcResponse> {
        const promptParts: AcpPromptPart[] = options?.parts
            ? [{ type: 'text', text }, ...options.parts]
            : [{ type: 'text', text }];
        const params: AcpPromptParams = { sessionId, prompt: promptParts };
        const ms = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.activePromptId = this.nextId; // peek at the ID that send() will use
        try {
            return await this.send('session/prompt', params, ms);
        } finally {
            this.activePromptId = undefined;
        }
    }

    /**
     * Switch the model on an existing session without respawning.
     *
     * Uses the `unstable_setSessionModel` ACP method (v0.35+).
     * Falls back gracefully if the method is unavailable.
     */
    async setSessionModel(sessionId: string, modelId: string): Promise<void> {
        const resp = await this.send('unstable_setSessionModel', { sessionId, modelId }, 30_000);
        if (resp.error) {
            throw new Error(`setSessionModel failed: ${resp.error.message}`);
        }
    }

    /**
     * Reset the timeout timer for the active prompt request.
     * Call this when tool activity is detected to prevent killing
     * a session that is still actively working.
     */
    extendPromptTimeout(durationMs?: number): void {
        const id = this.activePromptId;
        if (id == null) {
            log.warn('extendPromptTimeout: no activePromptId', { pid: this.child.pid });
            return;
        }
        const entry = this.pending.get(id);
        if (!entry) {
            log.warn('extendPromptTimeout: no pending entry', { id, pid: this.child.pid });
            return;
        }

        const ms = durationMs ?? entry.timeoutMs;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
            if (this.pending.has(id)) {
                this.pending.delete(id);
                log.error('ACP timeout', {
                    method: entry.method,
                    id,
                    timeoutMs: ms,
                    closed: this._closed,
                    pid: this.child.pid,
                    killed: this.child.killed,
                    stdinWritable: this.child.stdin?.writable ?? false,
                });
                entry.reject(new Error(`ACP timeout: ${entry.method} (id=${id}, ${ms}ms)`));
            }
        }, ms);
    }

    /**
     * Cancel the active prompt in a session.
     *
     * ACP protocol defines session/cancel as a **notification** (no id, no response).
     * The agent aborts its AbortController, causing the prompt to resolve with
     * `stopReason: "cancelled"`.
     */
    cancel(sessionId: string): void {
        if (this._closed) return;
        const payload = JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
        log.info('ACP cancel (notification)', { sessionId: sessionId.substring(0, 8) });
        this.child.stdin?.write(`${payload}\n`);
    }

    /** Register a handler for session update notifications. */
    setUpdateHandler(handler: SessionUpdateHandler | undefined): void {
        this.onSessionUpdate = handler;
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        this.rejectAllPending('ACP client closing');

        this.child.stdin?.end();

        await new Promise<void>((resolve) => {
            const pid = this.child.pid;

            // Kill entire process group (negative PID) to clean up MCP children
            const killGroup = (signal: NodeJS.Signals): void => {
                try {
                    if (pid) process.kill(-pid, signal);
                } catch {
                    // Process group may already be dead
                }
                try {
                    this.child.kill(signal);
                } catch {
                    // Process may already be dead
                }
            };

            // SIGTERM immediately, SIGKILL after 2 seconds as fallback
            killGroup('SIGTERM');

            const killTimer = setTimeout(() => {
                killGroup('SIGKILL');
                resolve();
            }, 2_000);

            this.child.on('close', () => {
                clearTimeout(killTimer);
                resolve();
            });
        });
    }

    /** Synchronous force-kill for use in process exit handlers. */
    forceKill(): void {
        if (this._closed) return;
        this._closed = true;
        const pid = this.child.pid;
        try {
            if (pid) process.kill(-pid, 'SIGKILL');
        } catch {
            // Already dead
        }
        try {
            this.child.kill('SIGKILL');
        } catch {
            // Already dead
        }
    }
}

// ── Sandbox ─────────────────────────────────────────────────────

interface SpawnCommand {
    cmd: string;
    args: string[];
}

/**
 * Build the spawn command for macOS Seatbelt sandboxed execution.
 *
 * Uses Gemini CLI's official --sandbox flag. Requires patch 3
 * (ACP sandbox stdin bypass) so that readStdin() is skipped in ACP mode
 * and the JSON-RPC stream passes through to the sandboxed child intact.
 *
 * The custom profile must exist at ~/.gemini/sandbox-macos-{profile}.sb
 * (written by writeSeatbeltProfile in turn/sandbox.ts).
 */
function buildSeatbeltEnv(_cwd: string, geminiArgs: string[], env: Record<string, string>): SpawnCommand {
    if (platform() !== 'darwin') {
        throw new Error('Seatbelt sandbox requires macOS. Use sandbox: "docker" or sandbox: false on Linux.');
    }

    // Verify patch 3 (ACP sandbox stdin bypass) is applied.
    // Without it, Gemini CLI's readStdin() consumes JSON-RPC messages
    // before entering the sandbox, causing a deadlock.
    assertSandboxPatchApplied();

    // Write the Seatbelt profile before spawning
    writeSeatbeltProfile();

    // Tell Gemini CLI to use our custom seatbelt profile
    env.SEATBELT_PROFILE = SEATBELT_PROFILE_NAME;
    geminiArgs.push('--sandbox');

    log.info('seatbelt sandbox enabled (official --sandbox)', { profile: SEATBELT_PROFILE_NAME });
    return { cmd: getGeminiBin(), args: geminiArgs };
}

/**
 * Verify that Gemini CLI's sandbox stdin bypass patch is applied.
 * Checks for `!argv.acp` or `!argv.experimentalAcp` guard in the readStdin block.
 */
function assertSandboxPatchApplied(): void {
    try {
        // getGeminiBin() resolves to dist/index.js via symlink; target is dist/src/gemini.js
        const distDir = dirname(realpathSync(getGeminiBin()));
        const targetPath = join(distDir, 'src', 'gemini.js');
        const content = readFileSync(targetPath, 'utf-8');
        if (content.includes('isTTY && !argv.acp') || content.includes('isTTY && !argv.experimentalAcp')) return; // patched
    } catch {
        return; // can't verify — proceed optimistically
    }
    throw new Error(
        'Gemini CLI sandbox patch not applied. ' +
            'ACP + --sandbox will deadlock without it.\n' +
            'Run: bun install (patches are applied automatically via bun patch)',
    );
}

/**
 * Build the spawn command for Docker sandboxed execution.
 *
 * Gemini CLI re-execs itself inside the Docker container. The entire
 * CLI process (including MCP server spawning) runs inside the sandbox.
 * GeminiClaw paths are bind-mounted via SANDBOX_MOUNTS.
 *
 * The patched Gemini CLI binary is not installed inside the container —
 * it is bind-mounted from the host and exposed in PATH via SANDBOX_ENV.
 */
function buildDockerEnv(cwd: string, geminiArgs: string[], env: Record<string, string>): SpawnCommand {
    // Patch 3 (ACP sandbox stdin bypass) is required for Docker sandbox too
    assertSandboxPatchApplied();

    env.GEMINI_SANDBOX = 'docker';
    env.SANDBOX_MOUNTS = buildDockerSandboxMounts(cwd);

    // Always use the pre-built geminiclaw-sandbox image (ensureSandboxImage builds it at startup)
    env.GEMINI_SANDBOX_IMAGE = 'geminiclaw-sandbox';

    // Gemini CLI's entrypoint runs `gemini` inside the container, but our custom
    // image doesn't have it installed globally. The patched gemini-cli lives in
    // GeminiClaw's node_modules (bind-mounted via SANDBOX_MOUNTS). Add its .bin
    // directory to SANDBOX_ENV so the container PATH includes it.
    // Use dirname of getGeminiBin() directly (not realpathSync) to preserve
    // the node_modules/.bin/ symlink directory rather than the resolved target.
    const geminiBinDir = dirname(resolve(getGeminiBin()));
    const sandboxEnvParts = [
        `PATH=/usr/local/share/npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${geminiBinDir}`,
    ];

    // Inject user-configured sandbox env vars (vault-resolved in loadConfig).
    // SANDBOX_ENV is comma-separated KEY=VALUE pairs passed as --env to docker run.
    const config = loadConfig();
    for (const [key, value] of Object.entries(config.sandboxEnv)) {
        sandboxEnvParts.push(`${key}=${value}`);
    }
    env.SANDBOX_ENV = sandboxEnvParts.join(',');

    log.info('docker sandbox enabled', {
        image: env.GEMINI_SANDBOX_IMAGE,
        geminiBinDir,
        mountCount: env.SANDBOX_MOUNTS.split(',').length,
        sandboxEnvCount: Object.keys(config.sandboxEnv).length,
    });

    return { cmd: getGeminiBin(), args: geminiArgs };
}

// ── Error ────────────────────────────────────────────────────────

export class AcpError extends Error {
    readonly code: number;
    readonly data?: unknown;

    constructor(method: string, error: JsonRpcError) {
        super(`ACP ${method}: ${error.message}`);
        this.name = 'AcpError';
        this.code = error.code;
        this.data = error.data;
    }
}
