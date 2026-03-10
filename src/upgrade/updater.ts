/**
 * upgrade/updater.ts — Codebase update logic.
 *
 * Simple git pull + rebuild. Default target is `main`, `--dev` pulls `develop`.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';

const DEFAULT_BRANCH = 'main';
const DEV_BRANCH = 'develop';

export interface UpgradeResult {
    previousVersion: string;
    previousCommit: string;
    newVersion: string;
    newCommit: string;
    branch: string;
}

function readPackageVersion(repoDir: string): string {
    try {
        const pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf-8')) as { version: string };
        return pkg.version;
    } catch {
        return 'unknown';
    }
}

/**
 * Pull the latest code from origin and rebuild.
 *
 * Steps:
 *   1. git fetch origin
 *   2. git checkout <branch>
 *   3. git pull origin <branch>
 *   4. bun install && bun run build && bun link
 */
export async function pullAndRebuild(repoDir: string, dev: boolean): Promise<UpgradeResult> {
    const git = simpleGit(repoDir);
    const branch = dev ? DEV_BRANCH : DEFAULT_BRANCH;

    const previousVersion = readPackageVersion(repoDir);
    const prevLog = await git.log({ maxCount: 1 });
    const previousCommit = prevLog.latest?.hash.substring(0, 7) ?? 'unknown';

    // Remember current branch for rollback
    const status = await git.status();
    const previousRef = status.current ?? prevLog.latest?.hash ?? 'HEAD';

    try {
        await git.fetch(['origin']);
        await git.checkout(branch);
        await git.pull('origin', branch);

        // Rebuild
        execSync('bun install', { cwd: repoDir, stdio: 'inherit' });
        execSync('bun run build', { cwd: repoDir, stdio: 'inherit' });
        execSync('bun link', { cwd: repoDir, stdio: 'inherit' });

        const newVersion = readPackageVersion(repoDir);
        const newLog = await git.log({ maxCount: 1 });
        const newCommit = newLog.latest?.hash.substring(0, 7) ?? 'unknown';

        return { previousVersion, previousCommit, newVersion, newCommit, branch };
    } catch (err) {
        // Best-effort rollback
        try {
            await git.checkout(previousRef);
        } catch {
            // ignore
        }
        throw err;
    }
}
