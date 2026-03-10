/**
 * agent/turn/helpers.ts — DI wiring, settings injection, and utility functions.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadGeminiclawSettings, type McpServerConfig } from '../../config.js';
import { resolveSandboxMode } from '../acp/client.js';
import { spawnGeminiAcp } from '../acp/runner.js';
import type { AcpMcpServerEntry } from '../acp/types.js';
import type { TriggerType } from '../runner.js';
import type { FlushDeps } from '../session/index.js';

/** Sanitize a session ID for use in filenames. */
export function sanitizeForFilename(sessionId: string): string {
    return sessionId.replace(/[:/\\]/g, '_');
}

/**
 * Convert geminiclaw settings MCP config to ACP mcpServers format (command-based only).
 *
 * URL-based MCP servers (e.g. qmd, gog) are written to .gemini/settings.json
 * by ensureGeminiSettings() and are not included here.
 */
export function buildAcpMcpServers(): AcpMcpServerEntry[] {
    const settings = loadGeminiclawSettings();
    if (!settings.mcpServers) return [];

    const config = loadConfig();
    const globalEnv: Array<{ name: string; value: string }> = [];
    if (config.autonomyLevel !== 'autonomous') {
        globalEnv.push({ name: 'GEMINICLAW_AUTONOMY_LEVEL', value: config.autonomyLevel });
    }

    return Object.entries(settings.mcpServers)
        .filter((entry): entry is [string, McpServerConfig & { command: string }] => !!entry[1].command)
        .map(([name, cfg]) => ({
            name,
            command: cfg.command,
            args: cfg.args ?? [],
            env: [...(cfg.env ? Object.entries(cfg.env).map(([k, v]) => ({ name: k, value: v })) : []), ...globalEnv],
        }));
}

/**
 * Write .gemini/settings.json with url-based MCP entries and non-MCP settings.
 *
 * Command-based MCP servers are injected via ACP session/new params.
 * URL-based servers (e.g. gog via Streamable HTTP) are written here so
 * Gemini CLI connects to them directly.
 */
export function ensureGeminiSettings(workspacePath: string): void {
    const geminiDir = join(workspacePath, '.gemini');
    mkdirSync(geminiDir, { recursive: true });

    const settingsPath = join(geminiDir, 'settings.json');
    const appSettings = loadGeminiclawSettings();

    let existing: Record<string, unknown> = {};
    try {
        existing = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
        // File doesn't exist or is invalid — start fresh
    }

    // Preserve url-based MCP entries (served by host HTTP, e.g. gog).
    // Command-based entries are injected via ACP session/new params instead.
    // When running inside Docker sandbox, rewrite localhost URLs to
    // host.docker.internal so the container can reach the host server.
    const config = loadConfig();
    const isDocker = resolveSandboxMode(config.sandbox ?? true) === 'docker';
    const appMcpServers = appSettings.mcpServers ?? {};
    const urlBasedServers: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(appMcpServers)) {
        if (!cfg.command && (cfg.url || cfg.httpUrl)) {
            const rewritten = { ...cfg };
            if (isDocker) {
                if (rewritten.url) rewritten.url = rewriteLocalhostForDocker(rewritten.url);
                if (rewritten.httpUrl) rewritten.httpUrl = rewriteLocalhostForDocker(rewritten.httpUrl);
            }
            urlBasedServers[name] = rewritten;
        }
    }
    if (Object.keys(urlBasedServers).length > 0) {
        existing.mcpServers = urlBasedServers;
    } else {
        delete existing.mcpServers;
    }

    // Remove legacy tools.exclude (deprecated in Gemini CLI, removed in 1.0).
    // Equivalent deny rules are now in .gemini/policies/geminiclaw.toml.
    delete (existing as Record<string, unknown>).tools;

    ensureGeminiPolicies(geminiDir);

    if (appSettings.thinkingBudget !== undefined) {
        existing.thinkingBudget = appSettings.thinkingBudget;
    }
    existing.thinkingLevel = appSettings.thinkingLevel ?? 'high';

    const experimental = (existing.experimental ?? {}) as Record<string, unknown>;
    experimental.enableAgents = true;
    existing.experimental = experimental;

    writeFileSync(settingsPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf-8');
}

const GEMINICLAW_POLICY = `# GeminiClaw workspace policy — managed by ensureGeminiSettings()
# Block native ask_user; geminiclaw_ask_user MCP tool is used instead.
[[rule]]
toolName = "ask_user"
decision = "deny"
priority = 100
deny_message = "Use geminiclaw_ask_user MCP tool instead of native ask_user"
`;

/** Write .gemini/policies/geminiclaw.toml (idempotent). */
function ensureGeminiPolicies(geminiDir: string): void {
    const policiesDir = join(geminiDir, 'policies');
    mkdirSync(policiesDir, { recursive: true });
    writeFileSync(join(policiesDir, 'geminiclaw.toml'), GEMINICLAW_POLICY, 'utf-8');
}

/** FlushDeps backed by spawnGeminiAcp — injected into silentMemoryFlush. */
export function makeFlushDeps(_workspacePath: string): FlushDeps {
    return {
        spawnFlush: async (_args, opts) => {
            const result = await spawnGeminiAcp({
                cwd: opts.cwd,
                trigger: opts.trigger as TriggerType,
                maxToolIterations: opts.maxToolIterations,
                model: opts.model,
                mcpServers: buildAcpMcpServers(),
                poolPriority: 'background',
            });
            return { responseText: result.responseText, error: result.error };
        },
    };
}

/** Pattern-match Gemini CLI / ACP errors that indicate context window overflow. */
export function isContextOverflow(error: string | undefined): boolean {
    if (!error) return false;
    const lower = error.toLowerCase();
    return (
        lower.includes('context window') ||
        lower.includes('context length') ||
        lower.includes('token limit') ||
        lower.includes('too long') ||
        lower.includes('max_tokens') ||
        (lower.includes('context') && lower.includes('exceed'))
    );
}

/** Detect ACP session/load failure — the session we tried to resume no longer exists. */
export function isResumeFailure(error: string | undefined): boolean {
    if (!error) return false;
    const lower = error.toLowerCase();
    return lower.includes('session/load') || lower.includes('session not found') || lower.includes('sessionnotfound');
}

/**
 * Detect errors that should NOT be retried via error-informed retry.
 * These are infrastructure-level failures where re-prompting the model
 * with the error message would not help.
 */
export function isNonRetryableError(error: string | undefined): boolean {
    if (!error) return true;
    const lower = error.toLowerCase();
    return (
        lower.includes('acp timeout') ||
        lower.includes('timed out') ||
        lower.includes('pool') ||
        lower.includes('client is closed') ||
        lower.includes('process closed') ||
        lower.includes('process error') ||
        lower.includes('authentication') ||
        lower.includes('api key') ||
        lower.includes('permission denied') ||
        lower.includes('quota') ||
        lower.includes('rate limit')
    );
}

/**
 * Detect garbled or empty model output that should trigger an error-informed retry.
 * Returns a descriptive reason string, or undefined if the response looks valid.
 */
export function detectGarbledResponse(responseText: string | undefined, error: string | undefined): string | undefined {
    // Already has an explicit error — let the error-based retry handle it
    if (error) return undefined;

    const trimmed = (responseText ?? '').trim();

    // Empty response — model produced no visible output
    if (trimmed.length === 0) {
        return 'Empty response from model';
    }

    // Very short output dominated by control characters / non-printable
    if (trimmed.length < 20) {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars in garbled output
        const controlCount = (trimmed.match(/<ctrl\d+>|[\x00-\x08\x0e-\x1f]/g) || []).length;
        if (controlCount > 0) return `Garbled output detected: "${trimmed.substring(0, 50)}"`;
    }

    return undefined;
}

/** Read the last-flushed entry count from a marker file. Returns 0 if absent. */
export function readFlushMarker(path: string): number {
    try {
        const data = JSON.parse(readFileSync(path, 'utf-8')) as { entryCount?: number };
        return data.entryCount ?? 0;
    } catch {
        return 0;
    }
}

/** Write the current entry count to the flush marker file. */
export function writeFlushMarker(path: string, entryCount: number): void {
    try {
        writeFileSync(path, JSON.stringify({ entryCount }), 'utf-8');
    } catch {
        // Non-critical — worst case we flush again next turn
    }
}

/** Rewrite localhost URLs to host.docker.internal for Docker sandbox access. */
function rewriteLocalhostForDocker(url: string): string {
    return url.replace(/\/\/localhost([:/])/g, '//host.docker.internal$1');
}
