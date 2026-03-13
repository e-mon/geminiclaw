/**
 * cli/commands/browser.ts — Browser auth state management for agent-browser.
 *
 * Uses agent-browser native mode (Rust/CDP) with `--headed` for login.
 * Google login is blocked by automation detection (#271),
 * but other sites (Amazon, GitHub, etc.) work fine.
 *
 * Subcommands:
 *   geminiclaw browser login [url]  — Open headed browser, login, save state
 *   geminiclaw browser status       — Show auth state & MCP registration status
 *   geminiclaw browser reset        — Delete saved auth state
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { BROWSER_STATE_PATH } from '../../config.js';

const DEFAULT_LOGIN_URL = 'about:blank';

function waitForEnter(prompt: string): Promise<void> {
    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        rl.question(prompt, () => {
            rl.close();
            resolve();
        });
    });
}

/** Run an agent-browser command synchronously, returning success. */
function abRun(args: string[]): boolean {
    const result = spawnSync('agent-browser', args, { stdio: 'inherit' });
    if (result.error) {
        const err = result.error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
            process.stderr.write('agent-browser not found. Install it with: bun i -g agent-browser\n');
        } else {
            process.stderr.write(`agent-browser error: ${err.message}\n`);
        }
        return false;
    }
    return result.status === 0;
}

export function registerBrowserCommand(program: Command): void {
    const browserCmd = program
        .command('browser')
        .description('Manage agent-browser auth state for authenticated sessions');

    browserCmd
        .command('login [url]')
        .description('Open headed browser for manual login; saves auth state')
        .action(async (url?: string) => {
            const targetUrl = url ?? DEFAULT_LOGIN_URL;

            // Stop existing daemon so --headed takes effect
            spawnSync('agent-browser', ['--native', 'close'], { stdio: 'ignore' });

            process.stderr.write(`Opening ${targetUrl} in headed browser...\n`);
            process.stderr.write('Note: Google login is not supported due to automation detection restrictions\n\n');

            if (!abRun(['--native', '--headed', 'open', targetUrl])) {
                process.exit(1);
            }

            await waitForEnter('Press Enter when login is complete...');

            process.stderr.write('\nSaving auth state...\n');
            if (!abRun(['state', 'save', BROWSER_STATE_PATH])) {
                process.stderr.write('Failed to save state.\n');
                process.exit(1);
            }

            spawnSync('agent-browser', ['--native', 'close'], { stdio: 'ignore' });

            process.stderr.write(`\nSaved to: ${BROWSER_STATE_PATH}\n`);
            process.stderr.write('Auth state will be automatically restored on the next agent run.\n');
        });

    browserCmd
        .command('status')
        .description('Show auth state file and MCP registration status')
        .action(() => {
            const stateExists = existsSync(BROWSER_STATE_PATH);
            process.stdout.write(`State    : ${stateExists ? BROWSER_STATE_PATH : '(not found)'}\n`);
            if (stateExists) {
                const stat = statSync(BROWSER_STATE_PATH);
                process.stdout.write(`Size     : ${stat.size} bytes\n`);
                process.stdout.write(`Modified : ${stat.mtime.toISOString()}\n`);
            }

            process.stdout.write(`Mode     : skill (not MCP)\n`);
        });

    browserCmd
        .command('reset')
        .description('Delete saved auth state')
        .action(() => {
            if (!existsSync(BROWSER_STATE_PATH)) {
                process.stderr.write('Auth state file does not exist.\n');
                return;
            }
            rmSync(BROWSER_STATE_PATH, { force: true });
            process.stderr.write(`Deleted: ${BROWSER_STATE_PATH}\n`);
        });
}
