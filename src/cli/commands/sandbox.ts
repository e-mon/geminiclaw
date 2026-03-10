/**
 * cli/commands/sandbox.ts — Docker sandbox image management commands.
 */

import type { Command } from 'commander';
import { getWorkspacePath, loadConfig } from '../../config.js';

export function registerSandboxCommand(program: Command): void {
    const sandbox = program.command('sandbox').description('Manage the Docker sandbox image');

    sandbox
        .command('rebuild')
        .description('Force rebuild the Docker sandbox image (ignores cache)')
        .action(async () => {
            const { isDockerAvailable, ensureSandboxImage } = await import('../../agent/turn/sandbox.js');

            if (!isDockerAvailable()) {
                process.stderr.write('Error: Docker is not available. Install Docker or OrbStack.\n');
                process.exit(1);
            }

            const config = loadConfig();
            const workspacePath = getWorkspacePath(config);

            // Delete the hash file to force rebuild
            const { existsSync, unlinkSync } = await import('node:fs');
            const { join } = await import('node:path');
            const { GEMINICLAW_HOME } = await import('../../config/paths.js');
            const hashFile = join(GEMINICLAW_HOME, '.sandbox-image-hash');
            if (existsSync(hashFile)) {
                unlinkSync(hashFile);
            }

            await ensureSandboxImage(workspacePath);
            process.stdout.write('Sandbox image rebuilt successfully.\n');
        });

    sandbox
        .command('status')
        .description('Show sandbox image status')
        .action(async () => {
            const { isDockerAvailable } = await import('../../agent/turn/sandbox.js');
            const { existsSync, readFileSync } = await import('node:fs');
            const { join } = await import('node:path');
            const { GEMINICLAW_HOME } = await import('../../config/paths.js');
            const { execSync } = await import('node:child_process');

            const dockerOk = isDockerAvailable();
            process.stdout.write(`Docker: ${dockerOk ? 'available' : 'not found'}\n`);

            if (!dockerOk) return;

            // Check image
            try {
                const result = execSync('docker images -q geminiclaw-sandbox', {
                    encoding: 'utf-8',
                    timeout: 10_000,
                });
                const imageId = result.trim();
                if (imageId) {
                    process.stdout.write(`Image: geminiclaw-sandbox (${imageId.substring(0, 12)})\n`);
                } else {
                    process.stdout.write('Image: not built\n');
                }
            } catch {
                process.stdout.write('Image: unknown (docker query failed)\n');
            }

            // Check hash
            const hashFile = join(GEMINICLAW_HOME, '.sandbox-image-hash');
            if (existsSync(hashFile)) {
                const hash = readFileSync(hashFile, 'utf-8').trim();
                process.stdout.write(`Dockerfile hash: ${hash}\n`);
            } else {
                process.stdout.write('Dockerfile hash: none (will rebuild on next start)\n');
            }
        });
}
