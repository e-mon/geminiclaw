/**
 * eval/runner.test.ts — Dataset validation + integration tests.
 *
 * Dataset validation tests always run (CI-safe).
 * Integration tests require RUN_EVAL=true and a live Gemini CLI + Docker.
 *
 * Usage:
 *   npm run eval:validate           # dataset validation only
 *   RUN_EVAL=true npm run eval      # full integration run
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listTasks, loadTasks } from './dataset.js';
import { EvalRunner } from './runner.js';
import type { EvalTask } from './types.js';

const runEval = process.env.RUN_EVAL === 'true';

// ── Dataset validation (always runs) ─────────────────────────────

describe('Dataset validation', () => {
    let tasks: EvalTask[];

    beforeAll(() => {
        tasks = listTasks();
    });

    it('tasks.json をパースできる', () => {
        expect(tasks.length).toBeGreaterThan(0);
    });

    it('全タスクIDが一意である', () => {
        const ids = tasks.map((t) => t.id);
        const unique = new Set(ids);
        expect(unique.size).toBe(ids.length);
    });

    it('全4カテゴリが少なくとも1件ずつ存在する', () => {
        const categories = new Set(tasks.map((t) => t.category));
        expect(categories.has('browser')).toBe(true);
        expect(categories.has('scheduling')).toBe(true);
        expect(categories.has('implementation')).toBe(true);
        expect(categories.has('mock_creation')).toBe(true);
    });

    it('全タスクに必須フィールドが揃っている', () => {
        for (const task of tasks) {
            expect(task.id, `${task.id} - id`).toBeTruthy();
            expect(task.category, `${task.id} - category`).toBeTruthy();
            expect(task.difficulty, `${task.id} - difficulty`).toBeTruthy();
            expect(task.name, `${task.id} - name`).toBeTruthy();
            expect(task.prompt, `${task.id} - prompt`).toBeTruthy();
            expect(task.criteria, `${task.id} - criteria`).toBeDefined();
            expect(Array.isArray(task.tags), `${task.id} - tags`).toBe(true);
        }
    });

    it('全タスクのcriteria形式が正しい', () => {
        for (const task of tasks) {
            const { criteria } = task;

            if (criteria.requiredTools !== undefined) {
                expect(Array.isArray(criteria.requiredTools), `${task.id} - requiredTools`).toBe(true);
            }
            if (criteria.forbiddenTools !== undefined) {
                expect(Array.isArray(criteria.forbiddenTools), `${task.id} - forbiddenTools`).toBe(true);
            }
            if (criteria.responseContains !== undefined) {
                expect(Array.isArray(criteria.responseContains), `${task.id} - responseContains`).toBe(true);
            }
            if (criteria.fileOutputs !== undefined) {
                expect(Array.isArray(criteria.fileOutputs), `${task.id} - fileOutputs`).toBe(true);
                for (const fo of criteria.fileOutputs) {
                    expect(typeof fo.path, `${task.id} - fileOutput.path`).toBe('string');
                    expect(typeof fo.mustExist, `${task.id} - fileOutput.mustExist`).toBe('boolean');
                }
            }
        }
    });

    it('全タスクのpromptが日本語で書かれている（ひらがな・カタカナ・漢字を含む）', () => {
        const japanesePattern = /[\u3040-\u30ff\u4e00-\u9fff]/;
        for (const task of tasks) {
            expect(japanesePattern.test(task.prompt), `${task.id} のpromptに日本語文字が含まれていない`).toBe(true);
        }
    });

    it('全タスクIDが kebab-case 形式である', () => {
        const kebabCase = /^[a-z0-9]+(-[a-z0-9]+)*$/;
        for (const task of tasks) {
            expect(kebabCase.test(task.id), `${task.id} is not kebab-case`).toBe(true);
        }
    });

    it('loadTasks() が Record<string, EvalTask> を返す', () => {
        const record = loadTasks();
        expect(typeof record).toBe('object');
        for (const [id, task] of Object.entries(record)) {
            expect(id).toBe(task.id);
        }
    });
});

// ── Integration tests (RUN_EVAL=true only) ───────────────────────

describe.skipIf(!runEval)('Eval Integration Tests', () => {
    let runner: EvalRunner;
    let tmpWorkspace: string;
    const tasks = loadTasks();

    beforeAll(async () => {
        tmpWorkspace = mkdtempSync(join(tmpdir(), 'geminiclaw-eval-suite-'));
        // Use the repo root as seed workspace so src/ files are available
        const repoRoot = join(import.meta.dirname ?? '.', '..', '..');
        runner = new EvalRunner(repoRoot, join(tmpWorkspace, 'results'));
    });

    afterAll(() => {
        rmSync(tmpWorkspace, { recursive: true, force: true });
    });

    it('browser-research-001: マルチステップWeb調査', async () => {
        const task = tasks['browser-research-001'];
        expect(task).toBeDefined();

        const result = await runner.run(task);

        expect(result.taskId).toBe('browser-research-001');
        expect(result.score).toBeGreaterThanOrEqual(0.8);
        expect(result.passed).toBe(true);
    }, 300_000);

    it('cron-register-mcp-001: MCPツール経由cronジョブ登録', async () => {
        const task = tasks['cron-register-mcp-001'];
        expect(task).toBeDefined();

        const result = await runner.run(task);

        expect(result.taskId).toBe('cron-register-mcp-001');
        expect(result.score).toBeGreaterThanOrEqual(0.8);
        expect(result.passed).toBe(true);
    }, 300_000);

    it('scheduling-weekly-ops-001: 複合コンテキスト計画策定', async () => {
        const task = tasks['scheduling-weekly-ops-001'];
        expect(task).toBeDefined();

        const result = await runner.run(task);

        expect(result.taskId).toBe('scheduling-weekly-ops-001');
        expect(result.score).toBeGreaterThanOrEqual(0.8);
        expect(result.passed).toBe(true);
    }, 300_000);

    it('impl-eval-framework-001: 自己参照実装', async () => {
        const task = tasks['impl-eval-framework-001'];
        expect(task).toBeDefined();

        const result = await runner.run(task);

        expect(result.taskId).toBe('impl-eval-framework-001');
        expect(result.score).toBeGreaterThanOrEqual(0.8);
        expect(result.passed).toBe(true);
    }, 300_000);

    it('mock-e2e-harness-001: E2Eテストハーネス生成', async () => {
        const task = tasks['mock-e2e-harness-001'];
        expect(task).toBeDefined();

        const result = await runner.run(task);

        expect(result.taskId).toBe('mock-e2e-harness-001');
        expect(result.score).toBeGreaterThanOrEqual(0.8);
        expect(result.passed).toBe(true);
    }, 300_000);
});
