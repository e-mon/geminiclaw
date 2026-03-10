/**
 * memory/db.ts — SQLite usage tracking database.
 *
 * Tracks token consumption, run history, and cost estimates.
 * Uses bun:sqlite (Bun's native SQLite binding) instead of better-sqlite3.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database, type DatabaseInstance } from './sqlite.js';

// ── Types ────────────────────────────────────────────────────────

export interface UsageRecord {
    id?: number;
    runId: string;
    timestamp: string;
    model: string;
    trigger: string;
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    cachedTokens: number;
    totalTokens: number;
    durationMs: number;
    costEstimate: number;
}

export interface UsageSummary {
    totalRuns: number;
    totalTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalThinkingTokens: number;
    totalCachedTokens: number;
    totalCost: number;
    byModel: Record<
        string,
        {
            runs: number;
            tokens: number;
            inputTokens: number;
            outputTokens: number;
            thinkingTokens: number;
            cachedTokens: number;
            cost: number;
        }
    >;
}

// ── Database ─────────────────────────────────────────────────────

export class UsageDB {
    private readonly db: DatabaseInstance;

    constructor(dbPath: string) {
        const dir = dirname(dbPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        this.db = new Database(dbPath);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.initTables();
    }

    private initTables(): void {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        model TEXT NOT NULL,
        trigger_type TEXT NOT NULL DEFAULT 'manual',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        thinking_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        cost_estimate REAL NOT NULL DEFAULT 0
      );
    `);

        // Migration: add thinking_tokens column for existing databases
        this.migrate();
    }

    private migrate(): void {
        const columns = this.db.prepare("PRAGMA table_info('usage')").all() as Array<{ name: string }>;
        const hasThinkingTokens = columns.some((c) => c.name === 'thinking_tokens');
        if (!hasThinkingTokens) {
            this.db.exec('ALTER TABLE usage ADD COLUMN thinking_tokens INTEGER NOT NULL DEFAULT 0');
        }
    }

    // ── Usage operations ─────────────────────────────────────────

    saveUsage(record: Omit<UsageRecord, 'id'>): number {
        const stmt = this.db.prepare(`
      INSERT INTO usage (run_id, timestamp, model, trigger_type, input_tokens, output_tokens, thinking_tokens, cached_tokens, total_tokens, duration_ms, cost_estimate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(
            record.runId,
            record.timestamp,
            record.model,
            record.trigger,
            record.inputTokens,
            record.outputTokens,
            record.thinkingTokens,
            record.cachedTokens,
            record.totalTokens,
            record.durationMs,
            record.costEstimate,
        );
        // bun:sqlite returns lastInsertRowid on the query object after run()
        const row = this.db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };
        return row.id;
    }

    /**
     * Recalculate cost_estimate for rows where it is 0 and a cost rate is
     * available in the provided cost table. Returns the number of updated rows.
     */
    backfillCosts(costTable: Record<string, number>): number {
        const CACHED_DISCOUNT = 0.1;
        const rows = this.db
            .prepare(
                `SELECT id, model, input_tokens, output_tokens, thinking_tokens, cached_tokens FROM usage WHERE cost_estimate = 0 AND total_tokens > 0`,
            )
            .all() as Array<{
            id: number;
            model: string;
            input_tokens: number;
            output_tokens: number;
            thinking_tokens: number;
            cached_tokens: number;
        }>;

        const update = this.db.prepare(`UPDATE usage SET cost_estimate = ? WHERE id = ?`);
        let updated = 0;
        for (const row of rows) {
            const rate = costTable[row.model];
            if (!rate) continue;
            const fresh = row.input_tokens - row.cached_tokens;
            const cost =
                ((fresh + row.output_tokens + row.thinking_tokens) / 1_000_000) * rate +
                (row.cached_tokens / 1_000_000) * rate * CACHED_DISCOUNT;
            if (cost > 0) {
                update.run(cost, row.id);
                updated++;
            }
        }
        return updated;
    }

    getUsageSummary(sinceDate?: string): UsageSummary {
        const whereClause = sinceDate ? 'WHERE timestamp >= ?' : '';
        const params = sinceDate ? [sinceDate] : [];

        const total = this.db
            .prepare(
                `
      SELECT COUNT(*) as totalRuns,
             COALESCE(SUM(total_tokens), 0) as totalTokens,
             COALESCE(SUM(input_tokens), 0) as totalInputTokens,
             COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
             COALESCE(SUM(thinking_tokens), 0) as totalThinkingTokens,
             COALESCE(SUM(cached_tokens), 0) as totalCachedTokens,
             COALESCE(SUM(cost_estimate), 0) as totalCost
      FROM usage ${whereClause}
    `,
            )
            .get(...params) as {
            totalRuns: number;
            totalTokens: number;
            totalInputTokens: number;
            totalOutputTokens: number;
            totalThinkingTokens: number;
            totalCachedTokens: number;
            totalCost: number;
        };

        const models = this.db
            .prepare(
                `
      SELECT model,
             COUNT(*) as runs,
             COALESCE(SUM(total_tokens), 0) as tokens,
             COALESCE(SUM(input_tokens), 0) as inputTokens,
             COALESCE(SUM(output_tokens), 0) as outputTokens,
             COALESCE(SUM(thinking_tokens), 0) as thinkingTokens,
             COALESCE(SUM(cached_tokens), 0) as cachedTokens,
             COALESCE(SUM(cost_estimate), 0) as cost
      FROM usage ${whereClause}
      GROUP BY model
    `,
            )
            .all(...params) as Array<{
            model: string;
            runs: number;
            tokens: number;
            inputTokens: number;
            outputTokens: number;
            thinkingTokens: number;
            cachedTokens: number;
            cost: number;
        }>;

        const byModel: UsageSummary['byModel'] = {};
        for (const m of models) {
            byModel[m.model] = {
                runs: m.runs,
                tokens: m.tokens,
                inputTokens: m.inputTokens,
                outputTokens: m.outputTokens,
                thinkingTokens: m.thinkingTokens,
                cachedTokens: m.cachedTokens,
                cost: m.cost,
            };
        }

        return {
            totalRuns: total.totalRuns,
            totalTokens: total.totalTokens,
            totalInputTokens: total.totalInputTokens,
            totalOutputTokens: total.totalOutputTokens,
            totalThinkingTokens: total.totalThinkingTokens,
            totalCachedTokens: total.totalCachedTokens,
            totalCost: total.totalCost,
            byModel,
        };
    }

    // ── Dashboard queries ─────────────────────────────────────────

    /**
     * Daily aggregated usage for timeline charts.
     * Returns rows ordered by date ascending.
     */
    getUsageTimeline(sinceDate?: string): Array<{
        date: string;
        runs: number;
        tokens: number;
        inputTokens: number;
        outputTokens: number;
        thinkingTokens: number;
        cachedTokens: number;
        cost: number;
        durationMs: number;
    }> {
        const whereClause = sinceDate ? 'WHERE timestamp >= ?' : '';
        const params = sinceDate ? [sinceDate] : [];
        return this.db
            .prepare(
                `
                SELECT DATE(timestamp) AS date,
                       COUNT(*)                          AS runs,
                       COALESCE(SUM(total_tokens), 0)    AS tokens,
                       COALESCE(SUM(input_tokens), 0)    AS inputTokens,
                       COALESCE(SUM(output_tokens), 0)   AS outputTokens,
                       COALESCE(SUM(thinking_tokens), 0) AS thinkingTokens,
                       COALESCE(SUM(cached_tokens), 0)   AS cachedTokens,
                       COALESCE(SUM(cost_estimate), 0)   AS cost,
                       COALESCE(SUM(duration_ms), 0)     AS durationMs
                FROM usage ${whereClause}
                GROUP BY DATE(timestamp)
                ORDER BY date ASC
            `,
            )
            .all(...params) as Array<{
            date: string;
            runs: number;
            tokens: number;
            inputTokens: number;
            outputTokens: number;
            thinkingTokens: number;
            cachedTokens: number;
            cost: number;
            durationMs: number;
        }>;
    }

    /**
     * Usage breakdown by trigger type (heartbeat, cron, discord, manual, etc.).
     */
    getUsageByTrigger(sinceDate?: string): Array<{ trigger: string; runs: number; tokens: number; cost: number }> {
        const whereClause = sinceDate ? 'WHERE timestamp >= ?' : '';
        const params = sinceDate ? [sinceDate] : [];
        return this.db
            .prepare(
                `
                SELECT trigger_type AS trigger,
                       COUNT(*)                       AS runs,
                       COALESCE(SUM(total_tokens), 0) AS tokens,
                       COALESCE(SUM(cost_estimate), 0) AS cost
                FROM usage ${whereClause}
                GROUP BY trigger_type
                ORDER BY tokens DESC
            `,
            )
            .all(...params) as Array<{ trigger: string; runs: number; tokens: number; cost: number }>;
    }

    // ── Lifecycle ────────────────────────────────────────────────

    close(): void {
        this.db.close();
    }
}
