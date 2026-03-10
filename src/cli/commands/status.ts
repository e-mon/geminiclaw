/**
 * cli/commands/status.ts — Show agent status and recent activity.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { SessionStore } from '../../agent/session/store.js';
import { getWorkspacePath, loadConfig } from '../../config.js';

interface ProgressSignal {
    lastToolUse: string;
    toolName: string;
    sessionId?: string;
}

interface SessionEntry {
    timestamp: string;
    trigger: string;
    title?: string;
    tokens: { total: number; input: number; output: number };
}

function formatAge(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1_000)}s ago`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    return `${Math.round(ms / 3_600_000)}h ago`;
}

export function registerStatusCommand(program: Command): void {
    program
        .command('status')
        .description('Show agent status and recent activity')
        .action(() => {
            const config = loadConfig();
            const workspacePath = getWorkspacePath(config);

            if (!existsSync(workspacePath)) {
                process.stdout.write('Workspace not initialized. Run `geminiclaw init` first.\n');
                return;
            }

            const memoryDir = join(workspacePath, 'memory');

            // --- Active run check ---
            process.stdout.write('=== Active Run ===\n');
            let hasActiveRun = false;
            try {
                const progressFiles = readdirSync(memoryDir).filter(
                    (f) => f.startsWith('run-progress') && f.endsWith('.json'),
                );

                for (const file of progressFiles) {
                    try {
                        const raw = readFileSync(join(memoryDir, file), 'utf-8').trim();
                        const progress = JSON.parse(raw) as ProgressSignal;
                        const age = Date.now() - new Date(progress.lastToolUse).getTime();

                        if (age < 5 * 60_000) {
                            hasActiveRun = true;
                            const sessionLabel =
                                progress.sessionId ?? file.replace('run-progress-', '').replace('.json', '');
                            process.stdout.write(
                                `  🟢 Running (${formatAge(age)}) — tool: ${progress.toolName}, session: ${sessionLabel}\n`,
                            );
                        }
                    } catch {
                        // Skip corrupt progress files
                    }
                }
            } catch {
                // No memory directory
            }

            if (!hasActiveRun) {
                process.stdout.write('  Idle\n');
            }

            // --- Lock file check ---
            const lockFile = join(workspacePath, '.geminiclaw.lock');
            if (existsSync(lockFile)) {
                try {
                    const lockAge = Date.now() - statSync(lockFile).mtimeMs;
                    process.stdout.write(`  ⚠ Lock file present (${formatAge(lockAge)})\n`);
                } catch {
                    process.stdout.write('  ⚠ Lock file present\n');
                }
            }

            // --- Recent sessions ---
            process.stdout.write('\n=== Recent Sessions ===\n');
            const sessionsDir = resolve(workspacePath, 'memory', 'sessions');
            if (!existsSync(sessionsDir)) {
                process.stdout.write('  No sessions found.\n');
            } else {
                const store = new SessionStore(sessionsDir);
                const files = readdirSync(sessionsDir)
                    .filter((f) => f.endsWith('.jsonl'))
                    .sort()
                    .reverse()
                    .slice(0, 5);

                if (files.length === 0) {
                    process.stdout.write('  No sessions found.\n');
                } else {
                    for (const file of files) {
                        try {
                            const sessionId = file.replace('.jsonl', '');
                            const entries = store.loadAll(sessionId);
                            if (entries.length === 0) continue;

                            const first = entries[0] as SessionEntry;
                            const last = entries.at(-1) as SessionEntry;
                            const totalTokens = entries.reduce((sum, e) => sum + e.tokens.total, 0);
                            const title = store.getTitle(sessionId) ?? '';
                            const date = first.timestamp.substring(0, 10);
                            const time = first.timestamp.substring(11, 16);
                            const endTime = last.timestamp.substring(11, 16);

                            process.stdout.write(
                                `  ${date} ${time}-${endTime}  ${first.trigger.padEnd(10)} ${String(entries.length).padStart(3)} turns  ${String(totalTokens).padStart(7)} tok\n`,
                            );
                            if (title) {
                                process.stdout.write(`    └─ ${title}\n`);
                            }
                        } catch {
                            // Skip unreadable session files
                        }
                    }
                }
            }

            // --- Workspace info ---
            process.stdout.write('\n=== Workspace ===\n');
            process.stdout.write(`  Path: ${workspacePath}\n`);

            // Cron jobs count
            const cronFile = join(workspacePath, 'cron', 'jobs.json');
            if (existsSync(cronFile)) {
                try {
                    const jobs = JSON.parse(readFileSync(cronFile, 'utf-8')) as unknown[];
                    process.stdout.write(`  Cron jobs: ${jobs.length}\n`);
                } catch {
                    // Skip
                }
            }

            // DB status
            const dbPath = join(memoryDir, 'memory.db');
            if (existsSync(dbPath)) {
                const dbSize = statSync(dbPath).size;
                const sizeLabel =
                    dbSize < 1_048_576 ? `${Math.round(dbSize / 1024)} KB` : `${(dbSize / 1_048_576).toFixed(1)} MB`;
                process.stdout.write(`  Database: ${sizeLabel}\n`);
            }

            process.stdout.write('\n');
        });
}
