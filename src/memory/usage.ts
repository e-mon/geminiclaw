/**
 * memory/usage.ts — Usage tracking and cost calculation.
 *
 * Wraps UsageDB's usage table with cost estimation
 * based on model pricing tables.
 */

import type { RunResult } from '../agent/runner.js';
import type { UsageDB, UsageSummary } from './db.js';

// ── Cost Calculation ─────────────────────────────────────────────

/** Gemini API cached tokens cost 10% of the standard input rate. */
const CACHED_TOKEN_DISCOUNT = 0.1;

/** Hardcoded cost per million tokens by model. Update when new models are released. */
export const COST_PER_MILLION_TOKENS: Record<string, number> = {
    'gemini-3.1-pro-preview': 2.5,
    'gemini-3-pro-preview': 1.25,
    'gemini-3-flash-preview': 0.15,
    'auto-gemini-3': 0.15,
    'gemini-2.5-flash': 0.15,
    'gemini-2.5-flash-lite': 0.075,
    'gemini-2.5-pro': 1.25,
    'gemini-2.0-flash': 0.1,
};

/**
 * Calculate estimated cost for a RunResult based on model pricing.
 *
 * Separates non-cached input, cached input (10% of rate), output, and thinking
 * tokens. Thinking tokens are billed at the same rate as output tokens.
 */
export function estimateCost(result: RunResult, costTable: Record<string, number> = COST_PER_MILLION_TOKENS): number {
    const rate = costTable[result.model] ?? 0;
    const { input, output, thinking, cached } = result.tokens;
    const freshInput = input - cached;
    return ((freshInput + output + thinking) / 1_000_000) * rate + (cached / 1_000_000) * rate * CACHED_TOKEN_DISCOUNT;
}

// ── Usage Tracker ────────────────────────────────────────────────

export class UsageTracker {
    constructor(
        private db: UsageDB,
        private costTable: Record<string, number> = COST_PER_MILLION_TOKENS,
    ) {}

    /**
     * Save a RunResult's usage data to the database.
     */
    saveRecord(result: RunResult): number {
        const costEstimate = estimateCost(result, this.costTable);

        return this.db.saveUsage({
            runId: result.runId,
            timestamp: result.timestamp.toISOString(),
            model: result.model,
            trigger: result.trigger,
            inputTokens: result.tokens.input,
            outputTokens: result.tokens.output,
            thinkingTokens: result.tokens.thinking,
            cachedTokens: result.tokens.cached,
            totalTokens: result.tokens.total,
            durationMs: result.durationMs,
            costEstimate,
        });
    }

    /**
     * Get usage summary for a time period.
     */
    getSummary(sinceDate?: string): UsageSummary {
        return this.db.getUsageSummary(sinceDate);
    }

    /**
     * Get today's usage summary.
     */
    getTodaySummary(): UsageSummary {
        const today = `${new Date().toISOString().substring(0, 10)}T00:00:00Z`;
        return this.getSummary(today);
    }

    /**
     * Get this month's usage summary.
     */
    getMonthSummary(): UsageSummary {
        const month = `${new Date().toISOString().substring(0, 7)}-01T00:00:00Z`;
        return this.getSummary(month);
    }

    /**
     * Format usage summary for CLI display.
     */
    static formatSummary(summary: UsageSummary, label: string = 'Usage'): string {
        const lines: string[] = [];
        lines.push(`${label}:`);
        lines.push(`  Runs: ${summary.totalRuns}`);
        const thinkPart =
            summary.totalThinkingTokens > 0 ? `, think: ${summary.totalThinkingTokens.toLocaleString()}` : '';
        lines.push(
            `  Tokens: ${summary.totalTokens.toLocaleString()} (in: ${summary.totalInputTokens.toLocaleString()}, out: ${summary.totalOutputTokens.toLocaleString()}${thinkPart}, cached: ${summary.totalCachedTokens.toLocaleString()})`,
        );
        lines.push(`  Est. Cost: $${summary.totalCost.toFixed(4)}`);

        if (Object.keys(summary.byModel).length > 0) {
            lines.push('  By Model:');
            for (const [model, data] of Object.entries(summary.byModel)) {
                const modelThink = data.thinkingTokens > 0 ? `, think: ${data.thinkingTokens.toLocaleString()}` : '';
                lines.push(
                    `    ${model}: ${data.runs} runs, ${data.tokens.toLocaleString()} tokens (in: ${data.inputTokens.toLocaleString()}, out: ${data.outputTokens.toLocaleString()}${modelThink}, cached: ${data.cachedTokens.toLocaleString()}), $${data.cost.toFixed(4)}`,
                );
            }
        }

        return lines.join('\n');
    }
}
