/**
 * eval/runner.ts — EvalRunner orchestrates real Gemini CLI executions.
 *
 * For each task it:
 *   1. Creates an isolated temp workspace directory
 *   2. Copies workspace seed files (HEARTBEAT.md, MEMORY.md, src/) from base
 *   3. Builds GEMINI.md via ContextBuilder
 *   4. Runs spawnGemini with the task prompt
 *   5. Scores the RunResult with Scorer
 *   6. Persists the EvalResult as JSON
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnGeminiAcp } from '../agent/acp/runner.js';
import type { AcpMcpServerEntry } from '../agent/acp/types.js';
import { ContextBuilder } from '../agent/context-builder.js';
import { loadGeminiclawSettings, type McpServerConfig } from '../config/gemini-settings.js';
import { score } from './scorer.js';
import type { EvalResult, EvalTask } from './types.js';

// ── EvalRunner ────────────────────────────────────────────────────

export class EvalRunner {
    /**
     * @param baseWorkspacePath - The real geminiclaw workspace to seed from.
     *                            Source files (HEARTBEAT.md, MEMORY.md, src/)
     *                            are copied into each task's temp workspace.
     * @param resultsDir        - Directory to write EvalResult JSON files.
     *                            Defaults to ~/.geminiclaw/eval-results/.
     */
    constructor(
        private readonly baseWorkspacePath: string,
        private readonly resultsDir: string = join(process.env.HOME ?? '~', '.geminiclaw', 'eval-results'),
    ) {}

    /**
     * Run an eval task end-to-end.
     *
     * Creates a temp workspace, runs Gemini CLI, scores the output, and
     * persists the result. The temp workspace is NOT cleaned up here so
     * callers can inspect outputs; callers are responsible for cleanup.
     *
     * @returns EvalResult with score, criteriaResults, and raw RunResult.
     */
    async run(task: EvalTask): Promise<EvalResult> {
        const startMs = Date.now();

        // Create isolated workspace for this task
        const taskWorkspace = mkdtempSync(join(tmpdir(), `geminiclaw-eval-${task.id}-`));

        // Seed the workspace with base files the agent will need
        this.seedWorkspace(taskWorkspace);

        // Write static GEMINI.md (eval doesn't use session context)
        const builder = new ContextBuilder(taskWorkspace);
        await builder.writeStaticGeminiMd();

        // Build MCP server entries from geminiclaw settings
        const settings = loadGeminiclawSettings();
        const mcpServers: AcpMcpServerEntry[] = settings.mcpServers
            ? Object.entries(settings.mcpServers).map(([name, cfg]: [string, McpServerConfig]) => ({
                  name,
                  command: cfg.command,
                  args: cfg.args,
                  env: cfg.env ? Object.entries(cfg.env).map(([k, v]) => ({ name: k, value: v })) : undefined,
                  cwd: cfg.cwd,
              }))
            : [];

        // Run via ACP protocol.
        // eval では低いツール上限でコスト・時間を抑える。
        const debugFile = join(this.resultsDir, `debug-${task.id}.jsonl`);
        const runResult = await spawnGeminiAcp({
            cwd: taskWorkspace,
            trigger: 'manual',
            prompt: task.prompt,
            maxToolIterations: 50,
            debugFile,
            mcpServers,
        });

        // Score the result
        const scoreResult = score(runResult, task.criteria, taskWorkspace);

        const evalResult: EvalResult = {
            taskId: task.id,
            ...scoreResult,
            runResult,
            evalDurationMs: Date.now() - startMs,
        };

        // Persist to results directory
        this.saveResult(evalResult);

        return evalResult;
    }

    /**
     * Seed a fresh temp workspace with files the agent needs to operate.
     * Copies HEARTBEAT.md, MEMORY.md, SOUL.md, USER.md, src/ and .gemini/skills/
     * from the base workspace. Missing files are silently skipped.
     */
    private seedWorkspace(taskWorkspace: string): void {
        const filesToCopy = ['HEARTBEAT.md', 'MEMORY.md', 'SOUL.md', 'USER.md'];
        for (const file of filesToCopy) {
            const src = join(this.baseWorkspacePath, file);
            if (existsSync(src)) {
                cpSync(src, join(taskWorkspace, file));
            }
        }

        // Copy src/ so the agent can read geminiclaw source files
        const srcDir = join(this.baseWorkspacePath, 'src');
        if (existsSync(srcDir)) {
            cpSync(srcDir, join(taskWorkspace, 'src'), { recursive: true });
        }

        // Copy .gemini/skills/ so the agent can activate_skill
        const skillsDir = join(this.baseWorkspacePath, '.gemini', 'skills');
        if (existsSync(skillsDir)) {
            const dest = join(taskWorkspace, '.gemini', 'skills');
            mkdirSync(dest, { recursive: true });
            cpSync(skillsDir, dest, { recursive: true });
        }
    }

    /**
     * Persist an EvalResult as a timestamped JSON file.
     */
    private saveResult(result: EvalResult): void {
        mkdirSync(this.resultsDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${timestamp}-${result.taskId}.json`;
        writeFileSync(join(this.resultsDir, filename), `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
    }
}

/**
 * Format an EvalResult as a human-readable summary string.
 */
export function formatEvalResult(result: EvalResult): string {
    const lines: string[] = [];
    const pct = (result.score * 100).toFixed(0);
    const status = result.passed ? '✅ PASSED' : '❌ FAILED';

    lines.push(`${status}  ${result.taskId}  (score: ${pct}%)`);
    lines.push(
        `  Duration: ${(result.evalDurationMs / 1000).toFixed(1)}s  tools: ${result.runResult.toolCalls.length}`,
    );
    lines.push(`  Criteria:`);

    for (const cr of result.criteriaResults) {
        const icon = cr.passed ? '  ✓' : '  ✗';
        lines.push(`${icon} ${cr.criterion}`);
        if (!cr.passed) {
            lines.push(`      ${cr.details}`);
        }
    }

    return lines.join('\n');
}
