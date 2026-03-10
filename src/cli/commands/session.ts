/**
 * cli/commands/session.ts — Session management CLI commands.
 *
 * Provides subcommands for listing sessions and generating summaries.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { SessionStore } from '../../agent/session/store.js';
import { getWorkspacePath, loadConfig } from '../../config.js';

/** Session ID format — must match SessionStore.getFilePath validation. */
const SESSION_ID_PATTERN = /^[\w][\w.:-]*$/;

export function registerSessionCommand(program: Command): void {
    const session = program.command('session').description('Session management commands');

    session
        .command('list')
        .description('List sessions')
        .option('--date <date>', 'Filter by date (YYYY-MM-DD)')
        .action((opts: { date?: string }) => {
            const config = loadConfig();
            const workspacePath = getWorkspacePath(config);
            const sessionsDir = resolve(workspacePath, 'memory', 'sessions');

            if (!existsSync(sessionsDir)) {
                process.stdout.write('No sessions found.\n');
                return;
            }

            const files = readdirSync(sessionsDir)
                .filter((f) => f.endsWith('.jsonl'))
                .sort()
                .reverse();

            if (files.length === 0) {
                process.stdout.write('No sessions found.\n');
                return;
            }

            const store = new SessionStore(sessionsDir);

            for (const file of files) {
                const sessionId = file.replace('.jsonl', '');
                const entries = store.loadAll(sessionId);
                if (entries.length === 0) continue;

                const firstEntry = entries[0];
                const lastEntry = entries[entries.length - 1];
                if (!firstEntry || !lastEntry) continue;

                const date = firstEntry.timestamp.substring(0, 10);

                // Apply date filter if specified
                if (opts.date && date !== opts.date) continue;

                const title = store.getTitle(sessionId) ?? '';
                const totalTokens = entries.reduce((sum, e) => sum + e.tokens.total, 0);
                const inputTokens = entries.reduce((sum, e) => sum + e.tokens.input, 0);
                const outputTokens = entries.reduce((sum, e) => sum + e.tokens.output, 0);
                const thinkingTokens = entries.reduce((sum, e) => sum + (e.tokens.thinking ?? 0), 0);
                const cachedTokens = entries.reduce((sum, e) => sum + (e.tokens.cached ?? 0), 0);
                const trigger = firstEntry.trigger;

                const time = firstEntry.timestamp.substring(11, 16);
                const endTime = lastEntry.timestamp.substring(11, 16);

                const breakdown = `in:${inputTokens} out:${outputTokens}${thinkingTokens > 0 ? ` think:${thinkingTokens}` : ''}${cachedTokens > 0 ? ` cached:${cachedTokens}` : ''}`;
                process.stdout.write(
                    `${date} ${time}-${endTime}  ${trigger.padEnd(10)} ${String(entries.length).padStart(3)} turns  ${String(totalTokens).padStart(7)} tok  (${breakdown})  ${sessionId}\n`,
                );
                if (title) {
                    process.stdout.write(`  └─ ${title}\n`);
                }
            }
        });

    session
        .command('summary <sessionId>')
        .description('Generate a summary for a session')
        .option('--model <model>', 'Override model for summary generation')
        .action(async (sessionId: string, opts: { model?: string }) => {
            // Early validation — prevents path traversal and matches SessionStore's check
            if (!SESSION_ID_PATTERN.test(sessionId)) {
                process.stderr.write(`Invalid session ID: ${sessionId}\n`);
                process.exit(1);
            }

            const config = loadConfig();
            const workspacePath = getWorkspacePath(config);
            const sessionsDir = resolve(workspacePath, 'memory', 'sessions');
            const summariesDir = resolve(workspacePath, 'memory', 'summaries');

            // Verify session exists
            const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
            if (!existsSync(sessionFile)) {
                process.stderr.write(`Session not found: ${sessionId}\n`);
                process.stderr.write(`Expected file: ${sessionFile}\n`);
                process.exit(1);
            }

            process.stdout.write(`Generating summary for session: ${sessionId}...\n`);

            const { generateSessionSummary } = await import('../../agent/session/summary.js');
            const outputPath = await generateSessionSummary({
                sessionId,
                sessionsDir,
                summariesDir,
                workspacePath,
                model: opts.model ?? config.sessionSummary.model ?? config.model,
                templatePath: config.sessionSummary.template,
                timezone: config.timezone || undefined,
            });

            if (outputPath) {
                process.stdout.write(`Summary written to: ${outputPath}\n`);
            } else {
                process.stdout.write('No meaningful entries to summarize.\n');
            }
        });

    session
        .command('daily')
        .description('Generate a daily summary for a given date')
        .option('--date <date>', 'Target date (YYYY-MM-DD)')
        .option('--model <model>', 'Override model for summary generation')
        .action(async (opts: { date?: string; model?: string }) => {
            const config = loadConfig();
            const timezone = config.timezone || undefined;

            // Default to today in configured timezone
            const { todayInTimezone } = await import('../../agent/session/daily-summary.js');
            const dateStr = opts.date ?? todayInTimezone(timezone);

            const datePattern = /^\d{4}-\d{2}-\d{2}$/;
            if (!datePattern.test(dateStr)) {
                process.stderr.write(`Invalid date format: ${dateStr} (expected YYYY-MM-DD)\n`);
                process.exit(1);
            }

            const workspacePath = getWorkspacePath(config);
            const sessionsDir = resolve(workspacePath, 'memory', 'sessions');
            const summariesDir = resolve(workspacePath, 'memory', 'summaries');
            const model = opts.model ?? config.heartbeat.model ?? config.model;

            process.stdout.write(`Generating daily summary for ${dateStr}...\n`);

            const { generateDailySummary, generateHeartbeatActivityLog } = await import(
                '../../agent/session/daily-summary.js'
            );
            const commonParams = { dateStr, sessionsDir, summariesDir, workspacePath, model, timezone };
            await generateHeartbeatActivityLog(commonParams);
            const outputPath = await generateDailySummary(commonParams);

            if (outputPath) {
                process.stdout.write(`Daily summary written to: ${outputPath}\n`);
            } else {
                process.stdout.write('Daily summary already exists or no activity found.\n');
            }
        });
}
