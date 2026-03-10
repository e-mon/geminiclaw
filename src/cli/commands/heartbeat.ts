/**
 * cli/commands/heartbeat.ts — Manually kick a heartbeat run.
 */

import type { Command } from 'commander';
import { getWorkspacePath, loadConfig } from '../../config.js';

export function registerHeartbeatCommand(program: Command): void {
    program
        .command('heartbeat')
        .description('Manually trigger a heartbeat run')
        .option('--sync', 'Run synchronously instead of queuing via Inngest')
        .option('-m, --model <model>', 'Model to use')
        .action(async (options) => {
            const config = loadConfig();
            const prompt =
                'Run checks according to HEARTBEAT.md. If nothing requires attention, reply with exactly HEARTBEAT_OK.';

            if (options.sync) {
                const { runAgentTurn } = await import('../../agent/turn/index.js');
                const workspacePath = getWorkspacePath(config);
                const sessionId = `cron:heartbeat`;
                const model = options.model ?? config.heartbeat.model ?? config.model;

                process.stderr.write('Heartbeat running (sync)...\n');
                const result = await runAgentTurn({
                    sessionId,
                    trigger: 'heartbeat',
                    workspacePath,
                    model,
                    timezone: config.timezone || undefined,
                    autonomyLevel: config.autonomyLevel,
                    maxToolIterations: config.maxToolIterations,
                    prompt,
                    sandbox: config.sandbox,
                });

                if (result.responseText) {
                    process.stdout.write(`${result.responseText}\n`);
                }
                if (result.error) {
                    process.stderr.write(`Error: ${result.error}\n`);
                    process.exitCode = 1;
                }
            } else {
                const { inngest } = await import('../../inngest/client.js');
                await inngest.send({
                    name: 'geminiclaw/run',
                    data: {
                        sessionId: 'cron:heartbeat',
                        trigger: 'heartbeat',
                        prompt,
                    },
                });
                process.stderr.write('Heartbeat event fired via Inngest.\n');
            }
        });
}
