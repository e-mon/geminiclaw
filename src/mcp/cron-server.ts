/**
 * mcp/cron-server.ts — MCP server exposing geminiclaw_cron_add / geminiclaw_cron_list / geminiclaw_cron_remove.
 *
 * Provides a programmatic interface for cron job management so the agent
 * doesn't directly write to cron/jobs.json via file tools.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../config.js';
import { addJob, computeInitialNextRun, editJob, listJobs, loadRunLog, removeJob } from '../cron/store.js';
import type { CronJob } from '../cron/types.js';
import { cancelCronJob, fireCronJob, scheduleCronJob } from '../inngest/cron-scheduler.js';
import { createLogger } from '../logger.js';

const log = createLogger('cron-server');

const TOOLS = [
    {
        name: 'geminiclaw_cron_add',
        description:
            'Register a new cron job. Returns a summary of the registered job. ' +
            'IMPORTANT: Before calling this tool, you MUST use geminiclaw_ask_user to show the user ' +
            'the job details and get their approval.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                id: {
                    type: 'string',
                    description: 'Unique job ID (e.g. "job-cloudflare-check")',
                },
                name: {
                    type: 'string',
                    description: 'Human-readable job name',
                },
                schedule: {
                    type: 'object',
                    description:
                        'Schedule object. One of: { type: "at", datetime: "ISO8601" } | ' +
                        '{ type: "every", intervalMin: number } | ' +
                        '{ type: "cron", expression: "5-field cron" }',
                },
                prompt: {
                    type: 'string',
                    description: 'Self-contained prompt for the agent (must include all context)',
                },
                timezone: {
                    type: 'string',
                    description: 'IANA timezone (e.g. "Asia/Tokyo"). Optional.',
                },
                reply: {
                    type: 'object',
                    description: 'Reply destination: { channel: "discord"|"slack", channelId: "..." }. Optional.',
                },
                model: {
                    type: 'string',
                    description: 'Override model for this job (e.g. "gemini-2.5-flash"). Optional.',
                },
                deleteAfterRun: {
                    type: 'boolean',
                    description: 'Auto-delete job after run. Default: true for at, false for every/cron.',
                },
            },
            required: ['id', 'name', 'schedule', 'prompt'],
        },
    },
    {
        name: 'geminiclaw_cron_list',
        description: 'List all registered cron jobs with their status.',
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
    {
        name: 'geminiclaw_cron_remove',
        description: 'Remove a cron job by its ID.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                id: {
                    type: 'string',
                    description: 'The job ID to remove',
                },
            },
            required: ['id'],
        },
    },
    {
        name: 'geminiclaw_cron_edit',
        description: 'Update fields of an existing cron job.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                id: { type: 'string', description: 'Job ID to update' },
                name: { type: 'string', description: 'New job name' },
                schedule: { type: 'object', description: 'New schedule object' },
                prompt: { type: 'string', description: 'New prompt' },
                timezone: { type: 'string', description: 'New IANA timezone' },
                model: { type: 'string', description: 'New model override' },
                enabled: { type: 'boolean', description: 'Enable (true) or disable/pause (false) the job' },
                deleteAfterRun: { type: 'boolean', description: 'Auto-delete after run' },
            },
            required: ['id'],
        },
    },
    {
        name: 'geminiclaw_cron_run',
        description: 'Manually fire a cron job immediately.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                id: { type: 'string', description: 'Job ID to fire' },
            },
            required: ['id'],
        },
    },
    {
        name: 'geminiclaw_cron_runs',
        description: 'Show run history for a cron job.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                id: { type: 'string', description: 'Job ID' },
                limit: { type: 'number', description: 'Max entries to return (default: 20)' },
            },
            required: ['id'],
        },
    },
];

function formatSchedule(schedule: CronJob['schedule']): string {
    switch (schedule.type) {
        case 'at':
            return `一回限り: ${schedule.datetime}`;
        case 'every':
            return `${schedule.intervalMin}分ごと`;
        case 'cron':
            return `cron: ${schedule.expression}`;
    }
}

function formatJobSummary(job: CronJob): string {
    const lines = [
        `ID: ${job.id}`,
        `名前: ${job.name}`,
        `スケジュール: ${formatSchedule(job.schedule)}`,
        `プロンプト: ${job.prompt.length > 200 ? `${job.prompt.substring(0, 200)}...` : job.prompt}`,
        `タイムゾーン: ${job.timezone ?? '(デフォルト)'}`,
        `モデル: ${job.model ?? '(デフォルト)'}`,
        `次回実行: ${job.nextRunAt ?? '(未設定)'}`,
        `返信先: ${job.reply ? `${job.reply.channel} (${job.reply.channelId})` : '(デフォルト)'}`,
        `自動削除: ${job.deleteAfterRun != null ? (job.deleteAfterRun ? 'はい' : 'いいえ') : '(デフォルト)'}`,
        `有効: ${job.enabled ? 'はい' : 'いいえ'}`,
    ];
    return lines.join('\n');
}

export function createCronServer(workspace: string, timezone?: string): Server {
    const server = new Server({ name: 'geminiclaw-cron', version: '0.1.0' }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const params = (args ?? {}) as Record<string, unknown>;

        switch (name) {
            case 'geminiclaw_cron_add': {
                const id = String(params.id ?? '');
                const jobName = String(params.name ?? '');
                const schedule = params.schedule as CronJob['schedule'];
                const prompt = String(params.prompt ?? '');

                if (!id || !jobName || !schedule || !prompt) {
                    return {
                        content: [{ type: 'text' as const, text: 'Error: id, name, schedule, prompt are required' }],
                        isError: true,
                    };
                }

                // Check for duplicate ID
                const existing = listJobs(workspace);
                if (existing.some((j) => j.id === id)) {
                    return {
                        content: [{ type: 'text' as const, text: `Error: Job with id "${id}" already exists` }],
                        isError: true,
                    };
                }

                const now = new Date();
                const job: CronJob = {
                    id,
                    name: jobName,
                    schedule,
                    prompt,
                    enabled: true,
                    timezone: params.timezone ? String(params.timezone) : undefined,
                    model: params.model ? String(params.model) : undefined,
                    deleteAfterRun: params.deleteAfterRun != null ? Boolean(params.deleteAfterRun) : undefined,
                    reply: params.reply as CronJob['reply'],
                    createdAt: now.toISOString(),
                };

                computeInitialNextRun(job, now, timezone);
                addJob(workspace, job);

                // Schedule the job in Inngest (best-effort; MCP server may not have Inngest connectivity)
                scheduleCronJob(job).catch((err) =>
                    log.warn('failed to schedule job in Inngest', { jobId: job.id, error: String(err) }),
                );

                const summary = formatJobSummary(job);
                return {
                    content: [{ type: 'text' as const, text: `✅ ジョブを登録しました:\n\n${summary}` }],
                };
            }

            case 'geminiclaw_cron_list': {
                const jobs = listJobs(workspace);
                if (jobs.length === 0) {
                    return {
                        content: [{ type: 'text' as const, text: '登録されたジョブはありません。' }],
                    };
                }
                const text = jobs.map((j) => formatJobSummary(j)).join('\n\n---\n\n');
                return {
                    content: [{ type: 'text' as const, text: `${jobs.length}件のジョブ:\n\n${text}` }],
                };
            }

            case 'geminiclaw_cron_remove': {
                const id = String(params.id ?? '');
                if (!id) {
                    return {
                        content: [{ type: 'text' as const, text: 'Error: id is required' }],
                        isError: true,
                    };
                }
                const removed = removeJob(workspace, id);
                if (!removed) {
                    return {
                        content: [{ type: 'text' as const, text: `Error: Job "${id}" not found` }],
                        isError: true,
                    };
                }

                // Cancel the sleeping Inngest run (best-effort)
                cancelCronJob(id).catch((err) =>
                    log.warn('failed to cancel job in Inngest', { jobId: id, error: String(err) }),
                );

                return {
                    content: [{ type: 'text' as const, text: `✅ ジョブ "${id}" を削除しました。` }],
                };
            }

            case 'geminiclaw_cron_edit': {
                const id = String(params.id ?? '');
                if (!id) {
                    return { content: [{ type: 'text' as const, text: 'Error: id is required' }], isError: true };
                }
                const patch: Partial<CronJob> = {};
                if (params.name) patch.name = String(params.name);
                if (params.prompt) patch.prompt = String(params.prompt);
                if (params.timezone) patch.timezone = String(params.timezone);
                if (params.model !== undefined) patch.model = params.model ? String(params.model) : undefined;
                if (params.enabled !== undefined) patch.enabled = Boolean(params.enabled);
                if (params.deleteAfterRun !== undefined) patch.deleteAfterRun = Boolean(params.deleteAfterRun);
                if (params.schedule) patch.schedule = params.schedule as CronJob['schedule'];

                // Recompute nextRunAt when schedule changes or job is re-enabled
                const isReEnable = params.enabled === true;
                if (params.schedule || isReEnable) {
                    const scheduleForCalc =
                        (patch.schedule as CronJob['schedule']) ??
                        listJobs(workspace).find((j) => j.id === id)?.schedule;
                    if (scheduleForCalc) {
                        const tmpJob = { schedule: scheduleForCalc } as CronJob;
                        computeInitialNextRun(tmpJob, new Date(), timezone);
                        patch.nextRunAt = tmpJob.nextRunAt;
                    }
                }

                const updated = editJob(workspace, id, patch);
                if (!updated) {
                    return {
                        content: [{ type: 'text' as const, text: `Error: Job "${id}" not found` }],
                        isError: true,
                    };
                }

                // Reschedule in Inngest when schedule or enabled state changed
                const needsReschedule = params.schedule || params.enabled !== undefined;
                if (needsReschedule) {
                    cancelCronJob(id).catch((err) =>
                        log.warn('failed to cancel job in Inngest', { jobId: id, error: String(err) }),
                    );
                    if (updated.enabled) {
                        scheduleCronJob(updated).catch((err) =>
                            log.warn('failed to reschedule job in Inngest', { jobId: id, error: String(err) }),
                        );
                    }
                }

                return {
                    content: [
                        { type: 'text' as const, text: `✅ ジョブを更新しました:\n\n${formatJobSummary(updated)}` },
                    ],
                };
            }

            case 'geminiclaw_cron_run': {
                const id = String(params.id ?? '');
                if (!id) {
                    return { content: [{ type: 'text' as const, text: 'Error: id is required' }], isError: true };
                }
                const jobs = listJobs(workspace);
                const job = jobs.find((j) => j.id === id);
                if (!job) {
                    return {
                        content: [{ type: 'text' as const, text: `Error: Job "${id}" not found` }],
                        isError: true,
                    };
                }
                try {
                    const config = loadConfig();
                    await fireCronJob(job, config, workspace);
                    return { content: [{ type: 'text' as const, text: `🚀 ジョブ "${id}" を手動実行しました。` }] };
                } catch (err) {
                    return {
                        content: [
                            {
                                type: 'text' as const,
                                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                            },
                        ],
                        isError: true,
                    };
                }
            }

            case 'geminiclaw_cron_runs': {
                const id = String(params.id ?? '');
                if (!id) {
                    return { content: [{ type: 'text' as const, text: 'Error: id is required' }], isError: true };
                }
                const limit = typeof params.limit === 'number' ? params.limit : 20;
                const entries = loadRunLog(workspace, id, limit);
                if (entries.length === 0) {
                    return { content: [{ type: 'text' as const, text: `ジョブ "${id}" の実行履歴はありません。` }] };
                }
                const lines = entries.map((e) => {
                    const time = new Date(e.timestamp).toISOString();
                    const reason = e.reason ? ` — ${e.reason}` : '';
                    return `${time}  ${e.status}${reason}`;
                });
                return {
                    content: [
                        { type: 'text' as const, text: `実行履歴 (${entries.length}件):\n\n${lines.join('\n')}` },
                    ],
                };
            }

            default:
                return {
                    content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
                    isError: true,
                };
        }
    });

    return server;
}

export async function startCronServer(workspace: string, timezone?: string): Promise<void> {
    const server = createCronServer(workspace, timezone);
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
