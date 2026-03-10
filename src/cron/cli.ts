/**
 * cron/cli.ts — `geminiclaw cron` サブコマンド群。
 *
 * cron list / add / rm を提供する。
 * jobs.json はソースオブトゥルースなので CLI は薄いラッパーに徹する。
 */

import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { getWorkspacePath, loadConfig } from '../config.js';
import { cancelCronJob, fireCronJob, scheduleCronJob } from '../inngest/cron-scheduler.js';
import { addJob, computeInitialNextRun, editJob, listJobs, loadRunLog, removeJob } from './store.js';
import type { CronJob } from './types.js';

/**
 * スケジュール文字列をパースする。
 *
 * 対応フォーマット:
 *   - "every 30m" / "every 2h"  → EverySchedule
 *   - "at 2026-03-01T09:00:00"  → AtSchedule
 *   - "0 9 * * *"               → CronSchedule (5 フィールド)
 */
function parseSchedule(input: string): CronJob['schedule'] {
    const trimmed = input.trim();

    // every Nm / every Nh
    const everyMatch = /^every\s+(\d+)\s*(m|h)$/i.exec(trimmed);
    if (everyMatch) {
        const value = parseInt(everyMatch[1], 10);
        const unit = everyMatch[2].toLowerCase();
        const intervalMin = unit === 'h' ? value * 60 : value;
        return { type: 'every', intervalMin };
    }

    // at <datetime>
    if (/^at\s+/i.test(trimmed)) {
        const datetime = trimmed.replace(/^at\s+/i, '').trim();
        if (Number.isNaN(Date.parse(datetime))) {
            throw new Error(`Invalid datetime: ${datetime}`);
        }
        return { type: 'at', datetime };
    }

    // Assume cron expression (5 fields)
    const fields = trimmed.split(/\s+/);
    if (fields.length === 5) {
        return { type: 'cron', expression: trimmed };
    }

    throw new Error(
        `Cannot parse schedule: "${trimmed}"\n` +
            'Formats: "every 30m", "every 2h", "at 2026-03-01T09:00", "0 9 * * *"',
    );
}

function formatSchedule(job: CronJob): string {
    const s = job.schedule;
    switch (s.type) {
        case 'at':
            return `at ${s.datetime}`;
        case 'every':
            return s.intervalMin >= 60 && s.intervalMin % 60 === 0
                ? `every ${s.intervalMin / 60}h`
                : `every ${s.intervalMin}m`;
        case 'cron':
            return s.expression;
    }
}

/**
 * `geminiclaw cron` コマンドツリーを構築して返す。
 */
export function buildCronCommand(): Command {
    const cron = new Command('cron').description('Cron job management');

    // ── cron list ─────────────────────────────────────────────────
    cron.command('list')
        .alias('ls')
        .description('List all scheduled jobs')
        .action(() => {
            const config = loadConfig();
            const workspacePath = getWorkspacePath(config);
            const jobs = listJobs(workspacePath);

            if (jobs.length === 0) {
                process.stdout.write('No cron jobs.\n');
                return;
            }

            const idWidth = Math.max(...jobs.map((j) => j.id.length), 4);
            const nameWidth = Math.max(...jobs.map((j) => j.name.length), 6);
            const schedWidth = Math.max(...jobs.map((j) => formatSchedule(j).length), 10);

            const header = `${'ID'.padEnd(idWidth)}  ${'NAME'.padEnd(nameWidth)}  ${'SCHEDULE'.padEnd(schedWidth)}  STATUS    NEXT RUN`;
            process.stdout.write(`${header}\n`);
            process.stdout.write(`${'─'.repeat(header.length)}\n`);

            for (const j of jobs) {
                const status = j.enabled ? 'enabled ' : 'disabled';
                const tz = j.timezone || config.timezone || undefined;
                const next = j.nextRunAt
                    ? new Date(j.nextRunAt).toLocaleString('ja-JP', tz ? { timeZone: tz } : undefined)
                    : '—';
                const sched = formatSchedule(j);
                process.stdout.write(
                    `${j.id.padEnd(idWidth)}  ${j.name.padEnd(nameWidth)}  ${sched.padEnd(schedWidth)}  ${status}  ${next}\n`,
                );
            }
        });

    // ── cron add ──────────────────────────────────────────────────
    cron.command('add')
        .description('Add a new cron job')
        .requiredOption('-n, --name <name>', 'Job name')
        .requiredOption('-s, --schedule <schedule>', 'Schedule: "every 30m", "at 2026-...", "0 9 * * *"')
        .requiredOption('-p, --prompt <prompt>', 'Prompt to execute')
        .option('--tz <timezone>', 'IANA timezone (defaults to config)')
        .option('--model <model>', 'Override model for this job (e.g. gemini-2.5-flash)')
        .option('--delete-after-run', 'Auto-delete job after run (default: true for at)')
        .option('--no-delete-after-run', 'Keep job after run even if one-shot')
        .option('--reply-channel <channel>', 'Reply channel type: discord or slack')
        .option('--reply-channel-id <id>', 'Reply channel ID')
        .action(
            async (options: {
                name: string;
                schedule: string;
                prompt: string;
                tz?: string;
                model?: string;
                deleteAfterRun?: boolean;
                replyChannel?: string;
                replyChannelId?: string;
            }) => {
                const config = loadConfig();
                const workspacePath = getWorkspacePath(config);
                const tz = options.tz ?? config.timezone;

                let schedule: CronJob['schedule'];
                try {
                    schedule = parseSchedule(options.schedule);
                } catch (err) {
                    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
                    process.exit(1);
                }

                const job: CronJob = {
                    id: `job-${randomUUID().slice(0, 8)}`,
                    name: options.name,
                    schedule,
                    prompt: options.prompt,
                    enabled: true,
                    timezone: tz,
                    model: options.model,
                    deleteAfterRun: options.deleteAfterRun,
                    createdAt: new Date().toISOString(),
                };

                if (options.replyChannel && options.replyChannelId) {
                    job.reply = {
                        channel: options.replyChannel as 'discord' | 'slack',
                        channelId: options.replyChannelId,
                    };
                }

                computeInitialNextRun(job, new Date(), tz);
                addJob(workspacePath, job);

                // Schedule in Inngest (best-effort; server may not be running)
                await scheduleCronJob(job).catch((err) => {
                    process.stderr.write(
                        `Warning: Inngest scheduling failed (server may not be running): ${err instanceof Error ? err.message : String(err)}\n`,
                    );
                });

                process.stdout.write(`✅ Added job: ${job.id} (${job.name})\n`);
                process.stdout.write(`   Schedule: ${formatSchedule(job)}\n`);
                process.stdout.write(`   Next run: ${job.nextRunAt ?? '—'}\n`);
            },
        );

    // ── cron rm ───────────────────────────────────────────────────
    cron.command('rm')
        .description('Remove a cron job')
        .argument('<id>', 'Job ID')
        .action(async (id: string) => {
            const config = loadConfig();
            const workspacePath = getWorkspacePath(config);
            const removed = removeJob(workspacePath, id);
            if (removed) {
                // Cancel the sleeping Inngest run (best-effort)
                await cancelCronJob(id).catch((err) => {
                    process.stderr.write(
                        `Warning: Inngest cancel failed: ${err instanceof Error ? err.message : String(err)}\n`,
                    );
                });
                process.stdout.write(`🗑  Removed job: ${id}\n`);
            } else {
                process.stderr.write(`Error: Job not found: ${id}\n`);
                process.exit(1);
            }
        });

    // ── cron edit ─────────────────────────────────────────────────
    cron.command('edit')
        .description('Edit an existing cron job')
        .argument('<id>', 'Job ID')
        .option('-n, --name <name>', 'Update job name')
        .option('-s, --schedule <schedule>', 'Update schedule')
        .option('-p, --prompt <prompt>', 'Update prompt')
        .option('--tz <timezone>', 'Update timezone')
        .option('--model <model>', 'Update model override')
        .option('--enable', 'Enable (resume) the job')
        .option('--disable', 'Disable (pause) the job')
        .option('--delete-after-run', 'Enable auto-delete after run')
        .option('--no-delete-after-run', 'Disable auto-delete after run')
        .action(
            async (
                id: string,
                options: {
                    name?: string;
                    schedule?: string;
                    prompt?: string;
                    tz?: string;
                    model?: string;
                    enable?: boolean;
                    disable?: boolean;
                    deleteAfterRun?: boolean;
                },
            ) => {
                const config = loadConfig();
                const workspacePath = getWorkspacePath(config);

                const patch: Partial<CronJob> = {};
                if (options.name) patch.name = options.name;
                if (options.prompt) patch.prompt = options.prompt;
                if (options.tz) patch.timezone = options.tz;
                if (options.model !== undefined) patch.model = options.model || undefined;
                if (options.deleteAfterRun !== undefined) patch.deleteAfterRun = options.deleteAfterRun;
                if (options.enable) patch.enabled = true;
                if (options.disable) patch.enabled = false;

                if (options.schedule) {
                    try {
                        patch.schedule = parseSchedule(options.schedule);
                    } catch (err) {
                        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
                        process.exit(1);
                    }
                }

                // Recompute nextRunAt when schedule changes or job is re-enabled
                const needsNextRun = options.schedule || options.enable;
                if (needsNextRun) {
                    // Use the new schedule if provided, otherwise load current job's schedule
                    const scheduleForCalc =
                        patch.schedule ?? listJobs(workspacePath).find((j) => j.id === id)?.schedule;
                    if (scheduleForCalc) {
                        const tmpJob = { schedule: scheduleForCalc } as CronJob;
                        computeInitialNextRun(tmpJob, new Date(), options.tz ?? config.timezone);
                        patch.nextRunAt = tmpJob.nextRunAt;
                    }
                }

                const updated = editJob(workspacePath, id, patch);
                if (!updated) {
                    process.stderr.write(`Error: Job not found: ${id}\n`);
                    process.exit(1);
                }

                // Reschedule in Inngest when schedule or enabled state changed
                const needsReschedule = options.schedule || options.enable || options.disable;
                if (needsReschedule) {
                    await cancelCronJob(id).catch((err) => {
                        process.stderr.write(
                            `Warning: Inngest cancel failed: ${err instanceof Error ? err.message : String(err)}\n`,
                        );
                    });
                    if (updated.enabled) {
                        await scheduleCronJob(updated).catch((err) => {
                            process.stderr.write(
                                `Warning: Inngest scheduling failed: ${err instanceof Error ? err.message : String(err)}\n`,
                            );
                        });
                    }
                }

                process.stdout.write(`✅ Updated job: ${id} (${updated.name})\n`);
                if (options.schedule) {
                    process.stdout.write(`   Schedule: ${formatSchedule(updated)}\n`);
                    process.stdout.write(`   Next run: ${updated.nextRunAt ?? '—'}\n`);
                }
            },
        );

    // ── cron run ──────────────────────────────────────────────────
    cron.command('run')
        .description('Manually fire a cron job immediately')
        .argument('<id>', 'Job ID')
        .action(async (id: string) => {
            const config = loadConfig();
            const workspacePath = getWorkspacePath(config);
            const jobs = listJobs(workspacePath);
            const job = jobs.find((j) => j.id === id);
            if (!job) {
                process.stderr.write(`Error: Job not found: ${id}\n`);
                process.exit(1);
            }

            try {
                await fireCronJob(job, config, workspacePath);
                process.stdout.write(`🚀 Fired job: ${id} (${job.name})\n`);
            } catch (err) {
                process.stderr.write(
                    `Error: Failed to fire job: ${err instanceof Error ? err.message : String(err)}\n`,
                );
                process.exit(1);
            }
        });

    // ── cron runs ─────────────────────────────────────────────────
    cron.command('runs')
        .description('Show run history for a cron job')
        .argument('<id>', 'Job ID')
        .option('-l, --limit <n>', 'Number of entries to show', '20')
        .action((id: string, options: { limit: string }) => {
            const config = loadConfig();
            const workspacePath = getWorkspacePath(config);
            const limit = parseInt(options.limit, 10);
            const entries = loadRunLog(workspacePath, id, limit);

            if (entries.length === 0) {
                process.stdout.write(`No run history for job: ${id}\n`);
                return;
            }

            const tz = config.timezone || undefined;
            process.stdout.write(`Run history for ${id} (last ${entries.length}):\n\n`);
            for (const e of entries) {
                const time = new Date(e.timestamp).toLocaleString('ja-JP', tz ? { timeZone: tz } : undefined);
                const reason = e.reason ? ` — ${e.reason}` : '';
                process.stdout.write(`  ${time}  ${e.status}${reason}\n`);
            }
        });

    return cron;
}
