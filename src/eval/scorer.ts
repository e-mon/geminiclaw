/**
 * eval/scorer.ts — Criteria-based scoring for EvalTask results.
 *
 * Each criterion is evaluated independently and contributes equally to the
 * final score. score = passedCriteria / totalCriteria.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from '../agent/runner.js';
import type { CriteriaResult, EvalCriteria, EvalResult, FileOutputCriteria } from './types.js';

// ── Individual criterion checkers ────────────────────────────────

function checkRequiredTools(requiredTools: string[], runResult: RunResult): CriteriaResult[] {
    return requiredTools.map((toolName) => {
        const used = runResult.toolCalls.some((tc) => tc.name === toolName);
        return {
            criterion: `requiredTools:${toolName}`,
            passed: used,
            details: used
                ? `Tool "${toolName}" was used`
                : `Tool "${toolName}" was NOT used (used: ${runResult.toolCalls.map((tc) => tc.name).join(', ') || 'none'})`,
        };
    });
}

function checkForbiddenTools(forbiddenTools: string[], runResult: RunResult): CriteriaResult[] {
    return forbiddenTools.map((toolName) => {
        const used = runResult.toolCalls.some((tc) => tc.name === toolName);
        return {
            criterion: `forbiddenTools:${toolName}`,
            passed: !used,
            details: used
                ? `Forbidden tool "${toolName}" WAS used`
                : `Forbidden tool "${toolName}" was correctly not used`,
        };
    });
}

function checkResponseContains(strings: string[], responseText: string): CriteriaResult[] {
    return strings.map((s) => {
        const found = responseText.includes(s);
        return {
            criterion: `responseContains:${s}`,
            passed: found,
            details: found ? `Response contains "${s}"` : `Response does NOT contain "${s}"`,
        };
    });
}

function checkResponseContainsAny(strings: string[], responseText: string): CriteriaResult {
    const found = strings.some((s) => responseText.includes(s));
    return {
        criterion: `responseContainsAny:[${strings.join(', ')}]`,
        passed: found,
        details: found
            ? `Response contains at least one of the required strings`
            : `Response contains NONE of: ${strings.join(', ')}`,
    };
}

function checkResponseNotContains(strings: string[], responseText: string): CriteriaResult[] {
    return strings.map((s) => {
        const found = responseText.includes(s);
        return {
            criterion: `responseNotContains:${s}`,
            passed: !found,
            details: !found ? `Response correctly does not contain "${s}"` : `Response unexpectedly contains "${s}"`,
        };
    });
}

function checkFileOutput(criteria: FileOutputCriteria, workspaceDir: string): CriteriaResult[] {
    const results: CriteriaResult[] = [];
    const fullPath = join(workspaceDir, criteria.path);

    // mustExist check
    const exists = existsSync(fullPath);
    results.push({
        criterion: `fileExists:${criteria.path}`,
        passed: exists === criteria.mustExist,
        details: exists ? `File "${criteria.path}" exists` : `File "${criteria.path}" does NOT exist`,
    });

    // Skip content checks if file doesn't exist
    if (!exists) return results;

    const content = readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');

    // contains checks
    if (criteria.contains) {
        for (const s of criteria.contains) {
            const found = content.includes(s);
            results.push({
                criterion: `fileContains:${criteria.path}:${s}`,
                passed: found,
                details: found ? `"${criteria.path}" contains "${s}"` : `"${criteria.path}" does NOT contain "${s}"`,
            });
        }
    }

    // minLines check
    if (criteria.minLines !== undefined) {
        const nonEmptyLines = lines.filter((l) => l.trim().length > 0).length;
        const passed = nonEmptyLines >= criteria.minLines;
        results.push({
            criterion: `fileMinLines:${criteria.path}:${criteria.minLines}`,
            passed,
            details: passed
                ? `"${criteria.path}" has ${nonEmptyLines} non-empty lines (≥ ${criteria.minLines})`
                : `"${criteria.path}" has only ${nonEmptyLines} non-empty lines (required ≥ ${criteria.minLines})`,
        });
    }

    // matchesRegex checks
    if (criteria.matchesRegex) {
        for (const pattern of criteria.matchesRegex) {
            const regex = new RegExp(pattern);
            const matched = regex.test(content);
            results.push({
                criterion: `fileMatchesRegex:${criteria.path}:${pattern}`,
                passed: matched,
                details: matched
                    ? `"${criteria.path}" matches regex /${pattern}/`
                    : `"${criteria.path}" does NOT match regex /${pattern}/`,
            });
        }
    }

    return results;
}

// ── Main scorer ───────────────────────────────────────────────────

/**
 * Score a RunResult against EvalCriteria.
 *
 * @param runResult    - The result of running the agent.
 * @param criteria     - The criteria to evaluate against.
 * @param workspaceDir - Absolute path to the task workspace directory used
 *                       as the base for fileOutputs path resolution.
 * @returns            Partial EvalResult fields (passed, score, criteriaResults).
 */
export function score(
    runResult: RunResult,
    criteria: EvalCriteria,
    workspaceDir: string,
): Pick<EvalResult, 'passed' | 'score' | 'criteriaResults'> {
    const criteriaResults: CriteriaResult[] = [];

    if (criteria.requiredTools?.length) {
        criteriaResults.push(...checkRequiredTools(criteria.requiredTools, runResult));
    }

    if (criteria.forbiddenTools?.length) {
        criteriaResults.push(...checkForbiddenTools(criteria.forbiddenTools, runResult));
    }

    if (criteria.responseContains?.length) {
        criteriaResults.push(...checkResponseContains(criteria.responseContains, runResult.responseText));
    }

    if (criteria.responseContainsAny?.length) {
        criteriaResults.push(checkResponseContainsAny(criteria.responseContainsAny, runResult.responseText));
    }

    if (criteria.responseNotContains?.length) {
        criteriaResults.push(...checkResponseNotContains(criteria.responseNotContains, runResult.responseText));
    }

    if (criteria.fileOutputs?.length) {
        for (const fileOutput of criteria.fileOutputs) {
            criteriaResults.push(...checkFileOutput(fileOutput, workspaceDir));
        }
    }

    const total = criteriaResults.length;
    const passed = criteriaResults.filter((r) => r.passed).length;
    const scoreValue = total > 0 ? passed / total : 1.0;

    return {
        passed: passed === total,
        score: scoreValue,
        criteriaResults,
    };
}
