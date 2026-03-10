/**
 * upgrade/merge.ts — LLM-powered template merge utility.
 *
 * Uses Gemini CLI (via ACP) to intelligently merge upstream
 * template changes with user-customized workspace files, preserving
 * local modifications while incorporating new features and fixes.
 */

import { spawnGeminiAcp } from '../agent/acp/runner.js';

// ── Types ────────────────────────────────────────────────────────

export interface MergeOptions {
    templateContent: string;
    workspaceContent: string;
    filename: string;
    /** Model to use (e.g. 'gemini-2.0-flash'). Passed as -m flag. */
    model: string;
    /** Working directory for spawnGemini. */
    cwd: string;
}

export interface MergeResult {
    merged: string;
    summary: string;
}

// ── Prompts ──────────────────────────────────────────────────────

const MERGE_PROMPT_TEMPLATE = `You are a file merge assistant. You are merging a template file update into a user-customized workspace file.

## Rules
1. Preserve ALL user customizations (added sections, modified text, custom rules)
2. Incorporate NEW content from the template (new sections, new instructions, structural improvements)
3. When the template REMOVES content, remove it from the merged result unless the user has modified that section
4. When the template MODIFIES content, prefer the template's version for structural/formatting changes, but keep user's content additions
5. Maintain consistent formatting and style with the template
6. Do NOT add any commentary or explanation — output ONLY the merged file content

## File: {filename}

### UPSTREAM TEMPLATE (new version):
\`\`\`
{template}
\`\`\`

### USER'S WORKSPACE (current, may contain customizations):
\`\`\`
{workspace}
\`\`\`

### MERGED RESULT:
Output the merged file content below. Do NOT wrap in code fences.`;

const SUMMARY_PROMPT_TEMPLATE = `Briefly summarize (1-2 sentences in Japanese) the changes made during this merge. Focus on what was added/changed from the template and what user customizations were preserved.

File: {filename}

Template (new):
\`\`\`
{template}
\`\`\`

Workspace (old):
\`\`\`
{workspace}
\`\`\`

Merged result:
\`\`\`
{merged}
\`\`\`

Summary:`;

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Run a prompt through Gemini CLI and return the response text.
 * Mirrors the makeSummarizeFn pattern in run-turn.ts.
 */
async function runPrompt(prompt: string, model: string, cwd: string): Promise<string> {
    const result = await spawnGeminiAcp({
        cwd,
        trigger: 'manual',
        prompt,
        model,
    });
    return result.responseText;
}

// ── Merge ────────────────────────────────────────────────────────

/**
 * Merge a template file with a user-customized workspace file using LLM.
 *
 * Spawns Gemini CLI for the merge prompt, so no API key management is needed —
 * the CLI handles authentication via its own credential chain.
 *
 * @throws {Error} On Gemini CLI spawn failure or empty response.
 */
export async function mergeTemplateFile(opts: MergeOptions): Promise<MergeResult> {
    const mergePrompt = MERGE_PROMPT_TEMPLATE.replace('{filename}', opts.filename)
        .replace('{template}', opts.templateContent)
        .replace('{workspace}', opts.workspaceContent);

    const merged = await runPrompt(mergePrompt, opts.model, opts.cwd);
    if (!merged.trim()) {
        throw new Error(`LLM returned empty merge result for ${opts.filename}`);
    }

    // Best-effort summary — don't fail the merge if summary generation fails
    let summary = 'マージ完了';
    try {
        const summaryPrompt = SUMMARY_PROMPT_TEMPLATE.replace('{filename}', opts.filename)
            .replace('{template}', opts.templateContent)
            .replace('{workspace}', opts.workspaceContent)
            .replace('{merged}', merged);
        summary = await runPrompt(summaryPrompt, opts.model, opts.cwd);
    } catch {
        // Summary is optional — proceed with default
    }

    return { merged: merged.trim(), summary: summary.trim() || 'マージ完了' };
}
