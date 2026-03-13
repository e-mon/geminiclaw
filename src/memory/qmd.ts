/**
 * memory/qmd.ts — QMD index update helper with in-memory semaphore.
 *
 * Ensures only one `qmd update` + `qmd embed` cycle runs at a time within
 * this process. Concurrent callers skip silently — the next scheduled
 * update will pick up changes.
 */

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';

const log = createLogger('qmd');

let updating = false;

/**
 * Resolve the QMD CLI entrypoint via ESM module resolution.
 *
 * import.meta.resolve('@tobilu/qmd') → file:///…/dist/index.js.
 * dirname twice gives the package root, then we append dist/qmd.js.
 * This depends on qmd's internal layout — update if it changes.
 */
export function resolveQmdEntrypoint(): string {
    const qmdDir = dirname(dirname(fileURLToPath(import.meta.resolve('@tobilu/qmd'))));
    return join(qmdDir, 'dist', 'qmd.js');
}

function runQmd(entrypoint: string, subcommand: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        execFile('node', [entrypoint, subcommand], { timeout: timeoutMs }, (err, _stdout, stderr) => {
            if (err) {
                reject(new Error(`qmd ${subcommand} failed: ${stderr || err.message}`));
            } else {
                resolve();
            }
        });
    });
}

/**
 * Run `qmd update` + `qmd embed` to re-index and embed all collections.
 *
 * Uses an in-memory semaphore — if an update is already running,
 * the call resolves immediately (no-op). This avoids concurrent
 * SQLite writes from parallel Inngest lanes.
 */
export async function updateQmdIndex(): Promise<void> {
    if (updating) {
        log.info('qmd update skipped (already running)');
        return;
    }
    updating = true;
    try {
        const entrypoint = resolveQmdEntrypoint();
        await runQmd(entrypoint, 'update', 60_000);
        log.info('qmd update completed');
        await runQmd(entrypoint, 'embed', 120_000);
        log.info('qmd embed completed');
    } finally {
        updating = false;
    }
}
