/**
 * eval/dataset.ts — Load and validate the eval task dataset.
 *
 * Reads eval/tasks.json and returns a typed, validated map of tasks.
 * Throws descriptive errors if the JSON shape is invalid.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalTask, TaskCategory } from './types.js';

// ── Constants ────────────────────────────────────────────────────

const VALID_CATEGORIES: readonly TaskCategory[] = ['browser', 'scheduling', 'implementation', 'mock_creation'];

const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

// ── Validation ───────────────────────────────────────────────────

function assertString(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`Field "${field}" must be a non-empty string, got: ${JSON.stringify(value)}`);
    }
}

function assertArray(value: unknown, field: string): asserts value is unknown[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`Field "${field}" must be an array, got: ${JSON.stringify(value)}`);
    }
}

function validateTask(raw: unknown, index: number): EvalTask {
    if (typeof raw !== 'object' || raw === null) {
        throw new TypeError(`Task at index ${index} must be an object`);
    }

    const task = raw as Record<string, unknown>;

    assertString(task.id, `tasks[${index}].id`);
    assertString(task.category, `tasks[${index}].category`);
    assertString(task.difficulty, `tasks[${index}].difficulty`);
    assertString(task.name, `tasks[${index}].name`);
    assertString(task.description, `tasks[${index}].description`);
    assertString(task.prompt, `tasks[${index}].prompt`);

    if (!VALID_CATEGORIES.includes(task.category as TaskCategory)) {
        throw new TypeError(
            `tasks[${index}].category must be one of ${VALID_CATEGORIES.join(', ')}, got: "${task.category}"`,
        );
    }

    if (!VALID_DIFFICULTIES.includes(task.difficulty as (typeof VALID_DIFFICULTIES)[number])) {
        throw new TypeError(
            `tasks[${index}].difficulty must be one of ${VALID_DIFFICULTIES.join(', ')}, got: "${task.difficulty}"`,
        );
    }

    if (typeof task.criteria !== 'object' || task.criteria === null) {
        throw new TypeError(`tasks[${index}].criteria must be an object`);
    }

    assertArray(task.tags, `tasks[${index}].tags`);

    return task as unknown as EvalTask;
}

// ── Loader ───────────────────────────────────────────────────────

/**
 * Load all eval tasks from the tasks.json dataset.
 *
 * @param datasetPath - Absolute path to tasks.json. Defaults to the canonical
 *                      eval/tasks.json relative to this module.
 * @returns Record mapping task ID → EvalTask.
 * @throws TypeError  If the JSON is malformed or any task fails validation.
 * @throws Error      If task IDs are not unique.
 */
export function loadTasks(datasetPath?: string): Record<string, EvalTask> {
    const resolvedPath = datasetPath ?? join(import.meta.dirname ?? '.', '..', '..', 'eval', 'tasks.json');

    const raw = JSON.parse(readFileSync(resolvedPath, 'utf-8')) as unknown;

    if (!Array.isArray(raw)) {
        throw new TypeError('tasks.json root must be a JSON array');
    }

    const tasks: Record<string, EvalTask> = {};

    for (let i = 0; i < raw.length; i++) {
        const task = validateTask(raw[i], i);

        if (tasks[task.id]) {
            throw new Error(`Duplicate task ID: "${task.id}" (indices ${i} and earlier)`);
        }

        tasks[task.id] = task;
    }

    return tasks;
}

/**
 * Return all tasks as an ordered array.
 */
export function listTasks(datasetPath?: string): EvalTask[] {
    return Object.values(loadTasks(datasetPath));
}
