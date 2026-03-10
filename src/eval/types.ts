/**
 * eval/types.ts — Evaluation framework type definitions.
 *
 * Defines the data model for eval tasks, scoring criteria, and results.
 */

import type { RunResult } from '../agent/runner.js';

// ── Task definitions ──────────────────────────────────────────────

export type TaskCategory = 'browser' | 'scheduling' | 'implementation' | 'mock_creation';

export interface EvalTask {
    id: string;
    category: TaskCategory;
    difficulty: 'easy' | 'medium' | 'hard';
    name: string;
    description: string;
    /** Japanese prompt sent to the agent. */
    prompt: string;
    criteria: EvalCriteria;
    tags: string[];
}

// ── Criteria ──────────────────────────────────────────────────────

export interface EvalCriteria {
    /** Tool names that must each appear at least once in toolCalls. */
    requiredTools?: string[];
    /** Tool names that must NOT appear in toolCalls. */
    forbiddenTools?: string[];
    /** Strings that must ALL be present in responseText. */
    responseContains?: string[];
    /** At least one of these strings must appear in responseText. */
    responseContainsAny?: string[];
    /** Strings that must NOT appear in responseText. */
    responseNotContains?: string[];
    /** Files that must be produced in the workspace directory. */
    fileOutputs?: FileOutputCriteria[];
}

export interface FileOutputCriteria {
    /** Path relative to the task workspace directory. */
    path: string;
    mustExist: boolean;
    /** File content must include all of these strings. */
    contains?: string[];
    /** File content must match all of these regular expressions. */
    matchesRegex?: string[];
    /** Minimum number of lines — checks implementation completeness. */
    minLines?: number;
}

// ── Results ───────────────────────────────────────────────────────

export interface EvalResult {
    taskId: string;
    passed: boolean;
    /** Fraction of criteria passed: 0.0–1.0 */
    score: number;
    criteriaResults: CriteriaResult[];
    runResult: RunResult;
    evalDurationMs: number;
}

export interface CriteriaResult {
    criterion: string;
    passed: boolean;
    details: string;
}
