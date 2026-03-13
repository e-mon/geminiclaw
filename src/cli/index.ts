/**
 * cli/index.ts — Thin CLI router.
 *
 * Each command is registered from its own module. This file only
 * sets up Commander and dispatches to the correct command handler.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { buildCronCommand } from '../cron/cli.js';
import { buildSkillCommand } from '../skills/cli.js';
import { vault } from '../vault/index.js';
import { registerBrowserCommand } from './commands/browser.js';
import { registerConfigCommand } from './commands/config-show.js';
import { registerDashboardCommand } from './commands/dashboard.js';
import { registerHeartbeatCommand } from './commands/heartbeat.js';
import { registerInitCommand } from './commands/init.js';
import { registerRunCommand } from './commands/run.js';
import { registerSandboxCommand } from './commands/sandbox.js';
import { registerSessionCommand } from './commands/session.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerStartCommand } from './commands/start.js';
import { registerStatusCommand } from './commands/status.js';
import { registerSyncTemplatesCommand } from './commands/sync-templates.js';
import { registerUpgradeCommand } from './commands/upgrade.js';
import { registerVaultCommand } from './commands/vault.js';

const program = new Command();

// Read version from package.json (resolved relative to dist/cli/index.js → project root)
const cliDir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(cliDir, '..', '..', 'package.json'), 'utf-8')) as { version: string };
program.name('geminiclaw').description('Autonomous agent orchestrator powered by Gemini CLI').version(pkg.version);

// Initialize vault before any command runs so $vault: references resolve in loadConfig().
// vault.init() reads config.json directly (no env dependency) and preloads secrets into cache.
program.hook('preAction', async () => {
    if (!vault.isInitialized) {
        await vault.init();
    }
});

registerBrowserCommand(program);
registerInitCommand(program);
registerStartCommand(program);
registerRunCommand(program);
registerSessionCommand(program);
registerStatusCommand(program);
registerConfigCommand(program);
registerSetupCommand(program);
registerSandboxCommand(program);
registerSyncTemplatesCommand(program);
registerUpgradeCommand(program);
registerDashboardCommand(program);
registerHeartbeatCommand(program);
registerVaultCommand(program);

program.addCommand(buildCronCommand());
program.addCommand(buildSkillCommand());
// Show help when no command is given (default Commander behavior is silent exit)
if (process.argv.length <= 2) {
    program.outputHelp();
    process.stderr.write('\n  New here? Run geminiclaw setup to get started.\n\n');
} else {
    program.parse();
}
