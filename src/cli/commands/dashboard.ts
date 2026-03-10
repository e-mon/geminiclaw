/**
 * cli/commands/dashboard.ts — Open GeminiClaw dashboard or Inngest dev server in browser.
 */

import type { Command } from 'commander';

export function registerDashboardCommand(program: Command): void {
    program
        .command('dashboard')
        .description('Open GeminiClaw dashboard in browser')
        .option('--inngest', 'Open Inngest dev server dashboard instead')
        .option('-p, --port <port>', 'Server port', '3000')
        .action(async (opts: { inngest?: boolean; port: string }) => {
            const open = (await import('open')).default;
            if (opts.inngest) {
                const inngestUrl = process.env.INNGEST_DEV_URL ?? 'http://localhost:8288';
                await open(inngestUrl);
            } else {
                await open(`http://localhost:${opts.port}/dashboard`);
            }
        });
}
