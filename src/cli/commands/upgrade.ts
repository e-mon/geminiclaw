/**
 * cli/commands/upgrade.ts — Upgrade GeminiClaw codebase + template sync.
 *
 * Phases:
 *   1. git pull origin main (or develop with --dev) → rebuild
 *   2. geminiclaw sync-templates --force (via rebuilt binary)
 */

import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { Command } from 'commander';
import { getWorkspacePath, loadConfig } from '../../config/index.js';
import { pullAndRebuild } from '../../upgrade/updater.js';

function resolveRepoDir(): string {
    return join(import.meta.dirname ?? '.', '..', '..', '..');
}

export function registerUpgradeCommand(program: Command): void {
    program
        .command('upgrade')
        .description('Update GeminiClaw to latest and sync templates')
        .option('--dev', 'Track develop branch instead of main')
        .action(async (options: { dev?: boolean }) => {
            const config = loadConfig();
            const repoDir = resolveRepoDir();

            // Phase 1: Pull and rebuild
            const result = await pullAndRebuild(repoDir, !!options.dev);

            if (result.previousCommit === result.newCommit) {
                process.stdout.write(`Already up to date (${result.branch} @ ${result.newCommit})\n\n`);
            } else {
                process.stdout.write(
                    `Updated: ${result.previousVersion} (${result.previousCommit}) → ${result.newVersion} (${result.newCommit}) [${result.branch}]\n\n`,
                );
            }

            // Phase 2: Template sync via rebuilt binary
            try {
                execSync('geminiclaw sync-templates --force', {
                    cwd: getWorkspacePath(config),
                    stdio: 'inherit',
                });
            } catch {
                process.stderr.write('\n⚠  Template sync failed. Run `geminiclaw sync-templates --force` manually.\n');
            }

            process.stdout.write('\nIf services were running, restart with: task stop && task start -- -d\n');
        });
}
