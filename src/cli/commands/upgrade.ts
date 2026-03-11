/**
 * cli/commands/upgrade.ts — Upgrade GeminiClaw codebase + template sync.
 *
 * Phases:
 *   1. git pull origin main (or develop with --dev) → rebuild
 *   2. geminiclaw sync-templates --force (via rebuilt binary)
 *
 * --dry-run: fetch only, show incoming commits and template diffs without applying.
 */

import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { Command } from 'commander';
import { simpleGit } from 'simple-git';
import { getWorkspacePath, loadConfig } from '../../config/index.js';
import { pullAndRebuild } from '../../upgrade/updater.js';
import { Workspace } from '../../workspace.js';

const DEFAULT_BRANCH = 'main';
const DEV_BRANCH = 'develop';

function resolveRepoDir(): string {
    return join(import.meta.dirname ?? '.', '..', '..', '..');
}

export function registerUpgradeCommand(program: Command): void {
    program
        .command('upgrade')
        .description('Update GeminiClaw to latest and sync templates')
        .option('--dev', 'Track develop branch instead of main')
        .option('--dry-run', 'Preview incoming changes without applying (fetch + diff)')
        .action(async (options: { dev?: boolean; dryRun?: boolean }) => {
            const config = loadConfig();
            const repoDir = resolveRepoDir();
            const workspacePath = getWorkspacePath(config);
            const branch = options.dev ? DEV_BRANCH : DEFAULT_BRANCH;

            if (options.dryRun) {
                await dryRun(repoDir, workspacePath, branch);
                return;
            }

            // Phase 1: Pull and rebuild
            const result = await pullAndRebuild(repoDir, !!options.dev);

            if (result.previousCommit === result.newCommit) {
                process.stdout.write(`Already up to date (${result.branch} @ ${result.newCommit})\n\n`);
            } else {
                process.stdout.write(
                    `Updated: ${result.previousVersion} (${result.previousCommit}) → ${result.newVersion} (${result.newCommit}) [${result.branch}]\n\n`,
                );
            }

            // Phase 2: Template sync via rebuilt binary (with diff output)
            try {
                execSync('geminiclaw sync-templates --force --diff', {
                    cwd: workspacePath,
                    stdio: 'inherit',
                });
            } catch {
                process.stderr.write('\n⚠  Template sync failed. Run `geminiclaw sync-templates --force` manually.\n');
            }

            process.stdout.write('\nIf services were running, restart with: task stop && task start -- -d\n');
        });
}

/**
 * Dry-run: fetch remote, show incoming commits and template diffs.
 *
 * Uses `git diff` against the remote branch to preview template changes
 * without pulling or rebuilding.
 */
async function dryRun(repoDir: string, workspacePath: string, branch: string): Promise<void> {
    const git = simpleGit(repoDir);

    process.stdout.write(`Fetching origin/${branch}...\n\n`);
    await git.fetch(['origin', branch]);

    // Show incoming commits
    const currentHead = (await git.revparse(['HEAD'])).trim();
    const remoteHead = (await git.revparse([`origin/${branch}`])).trim();

    if (currentHead === remoteHead) {
        process.stdout.write(`Already up to date (${branch} @ ${currentHead.substring(0, 7)})\n`);
    } else {
        process.stdout.write(`Incoming commits (HEAD..origin/${branch}):\n`);
        const log = await git.log({ from: 'HEAD', to: `origin/${branch}` });
        for (const entry of log.all) {
            const short = entry.hash.substring(0, 7);
            process.stdout.write(`  ${short} ${entry.message}\n`);
        }
        process.stdout.write('\n');
    }

    // Show template diffs (remote vs workspace)
    // First, get the list of template files that differ on remote
    let templateDiff: string;
    try {
        templateDiff = execSync(`git diff --color=always HEAD...origin/${branch} -- templates/`, {
            cwd: repoDir,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch {
        templateDiff = '';
    }

    if (templateDiff) {
        process.stdout.write('Template changes (templates/):\n');
        process.stdout.write(`${templateDiff}\n`);
    } else {
        process.stdout.write('No template changes.\n');
    }

    // Also show current sync status (current templates vs workspace)
    const status = Workspace.syncStatus(workspacePath);
    const outdated = status.filter((r) => r.status === 'outdated');
    const missing = status.filter((r) => r.status === 'missing');

    if (outdated.length > 0 || missing.length > 0) {
        process.stdout.write('\nPending workspace sync (current templates vs workspace):\n');
        for (const r of [...outdated, ...missing]) {
            const icon = r.status === 'outdated' ? '~ ' : '+ ';
            process.stdout.write(`  ${icon}${r.path}  (${r.status})\n`);
        }
    }
}
