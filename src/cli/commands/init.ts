/**
 * cli/commands/init.ts — Initialize workspace and git repository.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import {
    CONFIG_PATH,
    type Config,
    ConfigSchema,
    type GeminiSettings,
    getMcpDir,
    getWorkspacePath,
    loadConfig,
    loadGeminiclawSettings,
    patchConfigFile,
    saveGeminiclawSettings,
} from '../../config.js';
import { Workspace } from '../../workspace.js';

/**
 * Core workspace initialization logic, reusable by setup command.
 *
 * Creates workspace directories, copies templates, registers MCP servers,
 * and migrates legacy memories.
 */
export async function initializeWorkspace(config: Config): Promise<void> {
    const workspacePath = getWorkspacePath(config);

    await Workspace.create(workspacePath);

    // Save default config if not exists
    if (!existsSync(CONFIG_PATH)) {
        patchConfigFile(ConfigSchema.parse({}));
    }

    // Save GeminiClaw-specific MCP settings to ~/.geminiclaw/settings.json.
    const mcpDir = getMcpDir();
    const gcSettings: GeminiSettings = loadGeminiclawSettings();
    gcSettings.mcpServers ??= {};

    // Status MCP server
    const tz = config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    gcSettings.mcpServers['geminiclaw-status'] = {
        command: 'node',
        args: [join(mcpDir, 'status-serve.js')],
        env: { TIMEZONE: tz },
    };

    // Clean up legacy memory MCP server
    delete gcSettings.mcpServers['geminiclaw-memory'];

    // Ask User MCP server
    gcSettings.mcpServers['geminiclaw-ask-user'] = {
        command: 'node',
        args: [join(mcpDir, 'ask-user-serve.js')],
        env: { GEMINICLAW_WORKSPACE: workspacePath },
    };

    // Cron MCP server
    gcSettings.mcpServers['geminiclaw-cron'] = {
        command: 'node',
        args: [join(mcpDir, 'cron-serve.js')],
        env: { GEMINICLAW_WORKSPACE: workspacePath },
    };

    // Google Workspace (gog CLI) — served via host HTTP, not as a spawned process.
    // This avoids sandbox Keychain issues: gog runs on the host with full OAuth access.
    const serverPort = config.port ?? 3000;
    gcSettings.mcpServers.qmd = {
        httpUrl: `http://localhost:${serverPort}/api/mcp/qmd`,
    };
    gcSettings.mcpServers['geminiclaw-google'] = {
        httpUrl: `http://localhost:${serverPort}/api/mcp/google`,
    };

    // Admin MCP — served via host HTTP for self-management commands.
    gcSettings.mcpServers['geminiclaw-admin'] = {
        httpUrl: `http://localhost:${serverPort}/api/mcp/admin`,
    };

    // agent-browser is now a Gemini skill (not MCP) — clean up legacy entry
    delete gcSettings.mcpServers['agent-browser'];

    saveGeminiclawSettings(gcSettings);

    // Clean up geminiclaw-related entries from ~/.gemini/settings.json
    const geminiSettingsPath = join(process.env.HOME ?? '~', '.gemini', 'settings.json');
    if (existsSync(geminiSettingsPath)) {
        try {
            const globalSettings = JSON.parse(readFileSync(geminiSettingsPath, 'utf-8')) as Record<string, unknown>;
            const mcp = (globalSettings.mcpServers ?? {}) as Record<string, unknown>;
            delete mcp['geminiclaw-memory'];
            delete mcp['geminiclaw-status'];
            delete mcp['geminiclaw-ask-user'];
            delete mcp['geminiclaw-cron'];
            delete mcp['agent-browser'];
            delete mcp['geminiclaw-google'];
            delete mcp['geminiclaw-admin'];
            delete mcp['ask-user-poc'];
            globalSettings.mcpServers = mcp;
            writeFileSync(geminiSettingsPath, `${JSON.stringify(globalSettings, null, 2)}\n`);
        } catch {
            /* ignore */
        }
    }

    // Download QMD models and register memory collection (last — heaviest step)
    setupQmdIndex(workspacePath);
}

/** Download QMD models and register the memory collection. */
function setupQmdIndex(workspacePath: string): void {
    const qmdDir = dirname(dirname(fileURLToPath(import.meta.resolve('@tobilu/qmd'))));
    const qmdEntrypoint = join(qmdDir, 'dist', 'qmd.js');

    try {
        execFileSync('node', [qmdEntrypoint, 'pull'], {
            stdio: 'pipe',
            timeout: 300_000,
        });
    } catch {}

    const memoryDir = join(workspacePath, 'memory');
    try {
        execFileSync('node', [qmdEntrypoint, 'collection', 'remove', 'geminiclaw'], {
            stdio: 'ignore',
            timeout: 10_000,
        });
    } catch {
        // Collection may not exist yet
    }
    try {
        execFileSync(
            'node',
            [qmdEntrypoint, 'collection', 'add', memoryDir, '--name', 'geminiclaw', '--mask', '**/*.md'],
            {
                stdio: 'pipe',
                timeout: 30_000,
            },
        );
    } catch {}
}

export function registerInitCommand(program: Command): void {
    program
        .command('init')
        .description('Initialize workspace and git repository')
        .action(async () => {
            const config = loadConfig();
            await initializeWorkspace(config);
        });
}
