/**
 * eval/eval-command.ts — `geminiclaw eval` subcommand implementation.
 *
 * Subcommands:
 *   eval list                    Print all tasks with metadata
 *   eval run --task <id>         Run a single task
 *   eval run --all               Run all tasks sequentially
 *   eval report                  Show the most recent eval result JSON
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { GEMINICLAW_HOME, getWorkspacePath, loadConfig } from '../config.js';
import { listTasks, loadTasks } from './dataset.js';
import { EvalRunner } from './runner.js';
import type { EvalResult } from './types.js';

// ── Helpers ───────────────────────────────────────────────────────

const RESULTS_DIR = join(GEMINICLAW_HOME, 'eval-results');

function loadLatestResult(): EvalResult | null {
    if (!existsSync(RESULTS_DIR)) return null;

    const files = readdirSync(RESULTS_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse();

    if (files.length === 0) return null;

    return JSON.parse(readFileSync(join(RESULTS_DIR, files[0]), 'utf-8')) as EvalResult;
}

function difficultyColor(difficulty: string): string {
    switch (difficulty) {
        case 'hard':
            return chalk.red(difficulty);
        case 'medium':
            return chalk.yellow(difficulty);
        default:
            return chalk.green(difficulty);
    }
}

// ── Command registration ──────────────────────────────────────────

/**
 * Register `eval` and its subcommands onto the root Commander program.
 */
export function registerEvalCommand(program: Command): void {
    const evalCmd = program.command('eval').description('Evaluation dataset management and agent benchmarking');

    // ── eval list ──────────────────────────────────────────────

    evalCmd
        .command('list')
        .description('List all eval tasks')
        .action(() => {
            const tasks = listTasks();

            for (const task of tasks) {
                const _diff = difficultyColor(task.difficulty);
            }
        });

    // ── eval run ───────────────────────────────────────────────

    evalCmd
        .command('run')
        .description('Run one or all eval tasks against a live Gemini CLI')
        .option('--task <id>', 'Run a specific task by ID')
        .option('--all', 'Run all tasks sequentially')
        .action(async (options) => {
            const config = loadConfig();
            const workspacePath = getWorkspacePath(config);

            const runner = new EvalRunner(workspacePath, RESULTS_DIR);
            const tasks = loadTasks();

            const tasksToRun = options.all
                ? Object.values(tasks)
                : options.task
                  ? [tasks[options.task]].filter(Boolean)
                  : [];

            if (tasksToRun.length === 0) {
                process.exitCode = 1;
                return;
            }

            let passed = 0;
            let failed = 0;

            for (const task of tasksToRun) {
                try {
                    const result = await runner.run(task);

                    if (result.passed) {
                        passed++;
                    } else {
                        failed++;
                    }
                } catch (err) {
                    const _msg = err instanceof Error ? err.message : String(err);
                    failed++;
                }
            }

            const total = passed + failed;
            const _pct = total > 0 ? ((passed / total) * 100).toFixed(0) : '0';

            if (failed > 0) {
                process.exitCode = 1;
            }
        });

    // ── eval report ────────────────────────────────────────────

    evalCmd
        .command('report')
        .description('Show the most recent eval result')
        .action(() => {
            const result = loadLatestResult();

            if (!result) {
                return;
            }
        });
}
