/**
 * workspace.ts — Workspace management.
 *
 * Manages ~/.geminiclaw/workspace/ directory structure, template syncing,
 * and path accessors. Templates always come from getEmbeddedTemplates()
 * which resolves to filesystem paths in dev and $bunfs/ paths in compiled binary.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Cron } from 'croner';
// NOTE: workspace → context-builder dependency is intentional for init-time GEMINI.md generation.
// context-builder does NOT import workspace, so no circular dependency exists.
import { ContextBuilder } from './agent/context-builder.js';
import { getEmbeddedTemplates } from './embedded-templates.js';

// Files the user is expected to customize — never overwrite without explicit opt-in.
const PROTECTED = new Set(['MEMORY.md', 'USER.md', 'SOUL.md', 'HEARTBEAT.md']);

export type SyncStatus = 'created' | 'updated' | 'skipped' | 'protected' | 'merged' | 'conflict';

export interface SyncResult {
    path: string;
    status: SyncStatus;
    /** Unified diff of the change (empty for skipped/protected). */
    diff?: string;
}

// ── Workspace ────────────────────────────────────────────────────

export class Workspace {
    readonly root: string;

    constructor(root: string) {
        this.root = root;
    }

    /**
     * Initialize workspace: create directories and write templates.
     */
    static async create(workspacePath: string): Promise<Workspace> {
        mkdirSync(join(workspacePath, 'memory', 'sessions'), { recursive: true });
        mkdirSync(join(workspacePath, '.gemini', 'skills'), { recursive: true });
        mkdirSync(join(workspacePath, 'runs'), { recursive: true });

        // Write templates (writeIfMissing — never overwrite on init)
        const templates = getEmbeddedTemplates();
        for (const [relPath, content] of Object.entries(templates)) {
            const dest = join(workspacePath, relPath);
            if (!existsSync(dest)) {
                mkdirSync(dirname(dest), { recursive: true });
                writeFileSync(dest, content, 'utf-8');
            }
        }

        // BOOTSTRAP.md — write only on first-ever init (not included in templates to prevent re-creation)
        const bootstrapDest = join(workspacePath, 'BOOTSTRAP.md');
        if (!existsSync(bootstrapDest)) {
            const templateDir = resolve(import.meta.dirname ?? '.', '..', 'templates');
            const bootstrapSrc = join(templateDir, 'BOOTSTRAP.md');
            if (existsSync(bootstrapSrc)) {
                writeFileSync(bootstrapDest, readFileSync(bootstrapSrc, 'utf-8'), 'utf-8');
            }
        }

        // Write static GEMINI.md if it doesn't exist yet.
        const builder = new ContextBuilder(workspacePath);
        if (!builder.geminiMdExists()) {
            await builder.writeStaticGeminiMd();
        }

        // Register cron jobs from skill cron.json templates (only if jobs.json doesn't exist yet)
        Workspace.registerSkillCronJobs(workspacePath, templates);

        return new Workspace(workspacePath);
    }

    /**
     * Compare workspace files against templates and report sync status.
     *
     * With `diff: true`, includes unified diffs for outdated/missing files.
     */
    static syncStatus(
        workspacePath: string,
        options?: { diff?: boolean },
    ): Array<{ path: string; status: 'up-to-date' | 'outdated' | 'protected' | 'missing'; diff?: string }> {
        const includeDiff = options?.diff ?? false;
        const templates = getEmbeddedTemplates();
        const results: Array<{
            path: string;
            status: 'up-to-date' | 'outdated' | 'protected' | 'missing';
            diff?: string;
        }> = [];

        for (const [relPath, content] of Object.entries(templates)) {
            const dest = join(workspacePath, relPath);
            const filename = relPath.split('/').pop() ?? relPath;

            if (PROTECTED.has(filename)) {
                results.push({ path: relPath, status: 'protected' });
                continue;
            }
            if (!existsSync(dest)) {
                results.push({
                    path: relPath,
                    status: 'missing',
                    ...(includeDiff && { diff: Workspace.unifiedDiff('', content, relPath) }),
                });
                continue;
            }
            const current = readFileSync(dest, 'utf-8');
            const same = current === content;
            results.push({
                path: relPath,
                status: same ? 'up-to-date' : 'outdated',
                ...(includeDiff && !same && { diff: Workspace.unifiedDiff(current, content, relPath) }),
            });
        }

        return results;
    }

    /**
     * Sync all template files to workspace, overwriting when content differs.
     *
     * Protected files are skipped by default. With `force: true`, protected files
     * are 3-way merged using the last-synced template as base, preserving user edits.
     */
    static syncTemplates(options: {
        workspacePath: string;
        dryRun?: boolean;
        force?: boolean;
        /** @deprecated Use `force` instead. */
        includeProtected?: boolean;
    }): SyncResult[] {
        const { workspacePath, dryRun = false, force = false, includeProtected = false } = options;
        const useForce = force || includeProtected;
        const templates = getEmbeddedTemplates();
        const baseDir = join(workspacePath, '.gemini', '.template-base');
        const results: SyncResult[] = [];

        for (const [relPath, content] of Object.entries(templates)) {
            const dest = join(workspacePath, relPath);
            const filename = relPath.split('/').pop() ?? relPath;

            if (PROTECTED.has(filename)) {
                if (!useForce) {
                    results.push({ path: relPath, status: 'protected' });
                    continue;
                }

                // 3-way merge for protected files
                const basePath = join(baseDir, filename);
                const existed = existsSync(dest);

                if (!existed) {
                    if (!dryRun) {
                        mkdirSync(dirname(dest), { recursive: true });
                        writeFileSync(dest, content, 'utf-8');
                        Workspace.saveTemplateBase(baseDir, filename, content);
                    }
                    results.push({
                        path: relPath,
                        status: 'created',
                        diff: Workspace.unifiedDiff('', content, relPath),
                    });
                    continue;
                }

                const current = readFileSync(dest, 'utf-8');
                if (current === content) {
                    if (!dryRun) Workspace.saveTemplateBase(baseDir, filename, content);
                    results.push({ path: relPath, status: 'skipped' });
                    continue;
                }

                if (!existsSync(basePath)) {
                    if (!dryRun) Workspace.saveTemplateBase(baseDir, filename, content);
                    const mergeResult = Workspace.threeWayMerge(current, current, content);
                    const status: SyncStatus = mergeResult.conflict ? 'conflict' : 'merged';
                    if (!mergeResult.conflict && !dryRun) {
                        writeFileSync(dest, mergeResult.content, 'utf-8');
                    }
                    results.push({
                        path: relPath,
                        status,
                        diff: Workspace.unifiedDiff(current, mergeResult.content, relPath),
                    });
                    continue;
                }

                const base = readFileSync(basePath, 'utf-8');
                const mergeResult = Workspace.threeWayMerge(base, current, content);

                if (!dryRun) {
                    writeFileSync(dest, mergeResult.content, 'utf-8');
                    Workspace.saveTemplateBase(baseDir, filename, content);
                }

                results.push({
                    path: relPath,
                    status: mergeResult.conflict ? 'conflict' : 'merged',
                    diff: Workspace.unifiedDiff(current, mergeResult.content, relPath),
                });
                continue;
            }

            const existed = existsSync(dest);
            const oldContent = existed ? readFileSync(dest, 'utf-8') : '';
            const changed = !existed || oldContent !== content;

            if (changed) {
                if (!dryRun) {
                    mkdirSync(dirname(dest), { recursive: true });
                    writeFileSync(dest, content, 'utf-8');
                }
                results.push({
                    path: relPath,
                    status: existed ? 'updated' : 'created',
                    diff: Workspace.unifiedDiff(oldContent, content, relPath),
                });
            } else {
                results.push({ path: relPath, status: 'skipped' });
            }
        }

        return results;
    }

    /**
     * Scan skill templates for cron.json files and register them in jobs.json.
     * Only runs when jobs.json doesn't exist yet (first-time workspace init).
     */
    private static registerSkillCronJobs(workspacePath: string, templates: Record<string, string>): void {
        const jobsPath = join(workspacePath, 'cron', 'jobs.json');
        if (existsSync(jobsPath)) return;

        const cronTemplates = Object.entries(templates).filter(([p]) => p.endsWith('/cron.json'));
        if (cronTemplates.length === 0) return;

        const jobs: Array<Record<string, unknown>> = [];
        const now = new Date();

        for (const [, content] of cronTemplates) {
            try {
                const tmpl = JSON.parse(content) as Record<string, unknown>;
                // Compute initial nextRunAt
                const schedule = tmpl.schedule as
                    | { type: string; intervalMin?: number; expression?: string }
                    | undefined;
                const tz = tmpl.timezone as string | undefined;
                let nextRunAt: string | undefined;
                if (schedule?.type === 'every' && schedule.intervalMin) {
                    nextRunAt = new Date(now.getTime() + schedule.intervalMin * 60_000).toISOString();
                } else if (schedule?.type === 'cron' && schedule.expression) {
                    const next = new Cron(schedule.expression, { timezone: tz }).nextRun(now);
                    if (next) nextRunAt = next.toISOString();
                }

                const job = {
                    ...tmpl,
                    id: `job-${randomUUID().slice(0, 8)}`,
                    createdAt: now.toISOString(),
                    ...(nextRunAt && { nextRunAt }),
                };

                jobs.push(job);
            } catch {
                // Skip malformed cron.json
            }
        }

        if (jobs.length > 0) {
            const dir = dirname(jobsPath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(jobsPath, JSON.stringify(jobs, null, 2), 'utf-8');
        }
    }

    /** Save template content as the merge base for next sync. */
    private static saveTemplateBase(baseDir: string, filename: string, content: string): void {
        mkdirSync(baseDir, { recursive: true });
        writeFileSync(join(baseDir, filename), content, 'utf-8');
    }

    /**
     * 3-way merge using `git merge-file`.
     * Returns merged content and whether conflicts occurred.
     */
    private static threeWayMerge(
        base: string,
        current: string,
        incoming: string,
    ): { content: string; conflict: boolean } {
        const tmp = join(tmpdir(), `geminiclaw-merge-${Date.now()}`);
        mkdirSync(tmp, { recursive: true });

        const baseTmp = join(tmp, 'base');
        const currentTmp = join(tmp, 'current');
        const incomingTmp = join(tmp, 'incoming');

        writeFileSync(baseTmp, base, 'utf-8');
        writeFileSync(currentTmp, current, 'utf-8');
        writeFileSync(incomingTmp, incoming, 'utf-8');

        try {
            // git merge-file modifies currentTmp in-place. Exit code 0 = clean, >0 = conflicts.
            execFileSync('git', [
                'merge-file',
                '-L',
                'workspace',
                '-L',
                'base',
                '-L',
                'template',
                currentTmp,
                baseTmp,
                incomingTmp,
            ]);
            return { content: readFileSync(currentTmp, 'utf-8'), conflict: false };
        } catch {
            // git merge-file exits with >0 on conflict but still writes the merged file
            const merged = existsSync(currentTmp) ? readFileSync(currentTmp, 'utf-8') : current;
            return { content: merged, conflict: true };
        } finally {
            try {
                rmSync(tmp, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
        }
    }

    get memoryDir(): string {
        return join(this.root, 'memory');
    }

    get sessionsDir(): string {
        return join(this.root, 'memory', 'sessions');
    }

    get skillsDir(): string {
        return join(this.root, '.gemini', 'skills');
    }

    /**
     * Generate a unified diff between two strings using `git diff --no-index`.
     * Returns empty string if contents are identical or diff generation fails.
     */
    static unifiedDiff(oldContent: string, newContent: string, label: string): string {
        if (oldContent === newContent) return '';

        const tmp = join(tmpdir(), `geminiclaw-diff-${Date.now()}`);
        mkdirSync(tmp, { recursive: true });

        const oldPath = join(tmp, 'old');
        const newPath = join(tmp, 'new');
        writeFileSync(oldPath, oldContent, 'utf-8');
        writeFileSync(newPath, newContent, 'utf-8');

        try {
            // git diff --no-index exits 1 when files differ — that's expected
            const output = execFileSync(
                'git',
                [
                    'diff',
                    '--no-index',
                    '--color=always',
                    '-u',
                    `--dst-prefix=b/${label}/`,
                    `--src-prefix=a/${label}/`,
                    oldPath,
                    newPath,
                ],
                { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
            );
            return output;
        } catch (err: unknown) {
            // Exit code 1 = files differ (normal), output is in stdout
            if (
                err &&
                typeof err === 'object' &&
                'stdout' in err &&
                typeof (err as { stdout: unknown }).stdout === 'string'
            ) {
                return (err as { stdout: string }).stdout;
            }
            return '';
        } finally {
            try {
                rmSync(tmp, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
        }
    }
}
