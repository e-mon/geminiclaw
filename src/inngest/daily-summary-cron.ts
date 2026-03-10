/**
 * inngest/daily-summary-cron.ts — Daily summary cron trigger.
 *
 * Fires at 23:30 local time every day to generate the daily summary and heartbeat activity log.
 * Uses the configured IANA timezone via Inngest's TZ= prefix so "today" matches the user's calendar.
 * Runs independently of the heartbeat pipeline — even if heartbeat is down,
 * the daily summary will still be generated.
 */

import { generateDailySummary, generateHeartbeatActivityLog, todayInTimezone } from '../agent/session/daily-summary.js';
import { SessionStore } from '../agent/session/store.js';
import { syncSessionSummaries } from '../agent/session/summary.js';
import { createLogger } from '../logger.js';
import { inngest } from './client.js';

const log = createLogger('daily-summary-cron');

/**
 * Create the daily summary cron function.
 * Called at server startup to register with Inngest.
 */
export function createDailySummaryCron(params: {
    sessionsDir: string;
    summariesDir: string;
    workspacePath: string;
    model: string;
    /** IANA timezone, e.g. "Asia/Tokyo". Empty/undefined = UTC. */
    timezone?: string;
}) {
    // Inngest supports TZ= prefix in cron expressions for timezone-aware scheduling.
    const tzPrefix = params.timezone ? `TZ=${params.timezone} ` : '';
    const cronExpression = `${tzPrefix}30 23 * * *`;

    return inngest.createFunction(
        { id: 'daily-summary-cron', name: 'Daily Summary Generator' },
        { cron: cronExpression },
        async ({ step }) => {
            const result = await step.run('generate-daily-summary', async () => {
                const today = todayInTimezone(params.timezone);
                log.info('generating daily summary', { date: today, timezone: params.timezone });

                const commonParams = {
                    dateStr: today,
                    sessionsDir: params.sessionsDir,
                    summariesDir: params.summariesDir,
                    workspacePath: params.workspacePath,
                    model: params.model,
                    timezone: params.timezone,
                };
                await generateHeartbeatActivityLog(commonParams);
                const outputPath = await generateDailySummary(commonParams);

                // Truncate heartbeat JSONL — entries before today are now in the summary
                const store = new SessionStore(params.sessionsDir);
                const truncated = store.truncateBefore('cron:heartbeat', today, params.timezone);

                // Backfill session summaries for completed sessions
                // (channel/DM sessions from previous days + idle thread sessions)
                const summaryCount = await syncSessionSummaries({
                    sessionsDir: params.sessionsDir,
                    summariesDir: params.summariesDir,
                    workspacePath: params.workspacePath,
                    model: params.model,
                    includeTodaySessions: true,
                    timezone: params.timezone,
                });

                // Re-index QMD so the new summaries are searchable
                const { updateQmdIndex } = await import('../memory/qmd.js');
                await updateQmdIndex();

                return { date: today, outputPath: outputPath ?? null, truncated, sessionSummaries: summaryCount };
            });

            return result;
        },
    );
}
