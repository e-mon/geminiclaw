/**
 * config/gemini-settings.ts — Gemini CLI settings management and injection.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createLogger } from '../logger.js';
import { GEMINICLAW_HOME, GEMINICLAW_SETTINGS_PATH, getMcpDir } from './paths.js';

const log = createLogger('config');

// ── Schema ───────────────────────────────────────────────────────

const McpServerConfigSchema = z
    .object({
        /** CLI command to spawn (required for command-based MCP servers). */
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
        cwd: z.string().optional(),
        timeout: z.number().optional(),
        trust: z.boolean().optional(),
        includeTools: z.array(z.string()).optional(),
        /** @deprecated Gemini CLI 0.30+: use Policy Engine instead. Still functional but emits a runtime warning. */
        excludeTools: z.array(z.string()).optional(),
        /** SSE transport URL (Gemini CLI `url` field). */
        url: z.string().optional(),
        /** Streamable HTTP transport URL (Gemini CLI `httpUrl` field). */
        httpUrl: z.string().optional(),
    })
    .passthrough();

const ToolsConfigSchema = z
    .object({
        /** @deprecated Gemini CLI 0.30+: use Policy Engine instead. Still functional. */
        exclude: z.array(z.string()).optional(),
    })
    .passthrough();

const GeminiSettingsSchema = z
    .object({
        /**
         * Thinking token budget for Gemini 2.5 models.
         *   -1  : dynamic (model decides, effectively maximum)
         *    0  : thinking disabled
         *   N>0 : fixed token budget
         */
        thinkingBudget: z.number().optional(),
        /**
         * Thinking level for Gemini 3+ models.
         * Controls reasoning depth: minimal → low → medium → high.
         * Defaults to "high" to match Gemini CLI default.
         */
        thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
        mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
        tools: ToolsConfigSchema.optional(),
    })
    .passthrough();

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type GeminiSettings = z.infer<typeof GeminiSettingsSchema>;

// ── Load / Save ──────────────────────────────────────────────────

/**
 * Load geminiclaw-specific Gemini CLI settings from ~/.geminiclaw/settings.json.
 */
export function loadGeminiclawSettings(): GeminiSettings {
    if (!existsSync(GEMINICLAW_SETTINGS_PATH)) return {};
    try {
        const raw = JSON.parse(readFileSync(GEMINICLAW_SETTINGS_PATH, 'utf-8'));
        const settings = GeminiSettingsSchema.parse(raw);
        rewriteBuiltinMcpPaths(settings);
        return settings;
    } catch (err) {
        log.warn('Invalid geminiclaw settings, using defaults', {
            path: GEMINICLAW_SETTINGS_PATH,
            error: String(err).substring(0, 200),
        });
        return {};
    }
}

/**
 * Rewrite builtin command-based MCP server args to use the current dist/mcp/
 * directory. settings.json stores absolute paths from `geminiclaw init`, which
 * break when the repo is moved or renamed. This resolves paths at runtime.
 */
const BUILTIN_MCP_SERVE_FILES: Record<string, string> = {
    'geminiclaw-status': 'status-serve.js',
    'geminiclaw-ask-user': 'ask-user-serve.js',
    'geminiclaw-cron': 'cron-serve.js',
};

function rewriteBuiltinMcpPaths(settings: GeminiSettings): void {
    if (!settings.mcpServers) return;
    const mcpDir = getMcpDir();
    for (const [name, filename] of Object.entries(BUILTIN_MCP_SERVE_FILES)) {
        const cfg: McpServerConfig | undefined = settings.mcpServers[name];
        if (!cfg?.command || !cfg.args?.length) continue;
        // Replace the first arg that ends with the expected filename
        const idx = cfg.args.findIndex((a: string) => a.endsWith(filename));
        if (idx !== -1) {
            cfg.args[idx] = join(mcpDir, filename);
        }
    }
}

/**
 * Save geminiclaw-specific Gemini CLI settings to ~/.geminiclaw/settings.json.
 */
export function saveGeminiclawSettings(settings: GeminiSettings): void {
    if (!existsSync(GEMINICLAW_HOME)) {
        mkdirSync(GEMINICLAW_HOME, { recursive: true });
    }
    writeFileSync(GEMINICLAW_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
}
