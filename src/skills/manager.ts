/**
 * manager.ts — Skill management.
 *
 * bundled skills: {workspace}/.gemini/skills/
 * external skills: {workspace}/.agents/skills/ (via bunx skills CLI)
 *
 * Gemini CLI natively searches both paths.
 *
 * Security:
 *   - install uses staging dir approach (TOCTOU prevention)
 *   - enable/disable uses rename approach (Gemini CLI ignores the enabled frontmatter field)
 */

import { execFile } from 'node:child_process';
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSkill } from './scanner.js';
import type { SecurityReport, SkillFrontmatter } from './types.js';

const SKILL_FILENAME = 'SKILL.md';
const SKILL_DISABLED_SUFFIX = '.disabled';

/** Only allow safe skill names — alphanumeric, hyphens, underscores. */
const SAFE_SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function validateSkillName(name: string): void {
    if (!name || !SAFE_SKILL_NAME_RE.test(name)) {
        throw new Error(
            `Invalid skill name: "${name}". Only alphanumeric characters, hyphens, and underscores are allowed.`,
        );
    }
}

function parseFrontmatter(content: string, name: string): SkillFrontmatter {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) {
        return { name, description: '', enabled: true };
    }

    const raw = match[1];
    const result: Partial<SkillFrontmatter> = { name };

    for (const line of raw.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;

        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();

        switch (key) {
            case 'name':
                result.name = value;
                break;
            case 'description':
                result.description = value;
                break;
            case 'enabled':
                result.enabled = value === 'true';
                break;
            case 'source':
                if (value === 'bundled' || value === 'installed' || value === 'external') {
                    result.source = value;
                }
                break;
            case 'installedAt':
                result.installedAt = value;
                break;
            case 'sourceRef':
                result.sourceRef = value;
                break;
        }
    }

    return {
        name: result.name ?? name,
        description: result.description ?? '',
        enabled: result.enabled ?? true,
        ...(result.source !== undefined && { source: result.source }),
        ...(result.installedAt !== undefined && { installedAt: result.installedAt }),
        ...(result.sourceRef !== undefined && { sourceRef: result.sourceRef }),
    };
}

/** bundled skills directory */
function bundledSkillsDir(workspaceDir: string): string {
    return join(workspaceDir, '.gemini', 'skills');
}

/** external skills directory (bunx skills CLI) */
function externalSkillsDir(workspaceDir: string): string {
    return join(workspaceDir, '.agents', 'skills');
}

/**
 * Common helper to read skills from a directory.
 * Includes disabled skills (SKILL.md.disabled).
 */
function readSkillsFromDir(dir: string, source: 'bundled' | 'external'): SkillFrontmatter[] {
    if (!existsSync(dir)) return [];

    const entries = readdirSync(dir, { withFileTypes: true });
    const skills: SkillFrontmatter[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirPath = join(dir, entry.name);

        // Disabled skills
        const disabledPath = join(dirPath, SKILL_FILENAME + SKILL_DISABLED_SUFFIX);
        if (existsSync(disabledPath)) {
            const content = readFileSync(disabledPath, 'utf-8');
            const fm = parseFrontmatter(content, entry.name);
            fm.source = source;
            fm.enabled = false;
            skills.push(fm);
            continue;
        }

        const skillMdPath = join(dirPath, SKILL_FILENAME);
        if (!existsSync(skillMdPath)) continue;

        const content = readFileSync(skillMdPath, 'utf-8');
        const fm = parseFrontmatter(content, entry.name);
        fm.source ??= source;
        skills.push(fm);
    }

    return skills;
}

/**
 * Return a list of all bundled + external skills.
 */
export async function listSkills(workspaceDir: string): Promise<SkillFrontmatter[]> {
    const bundled = readSkillsFromDir(bundledSkillsDir(workspaceDir), 'bundled');
    const external = readSkillsFromDir(externalSkillsDir(workspaceDir), 'external');

    // Bundled skills take precedence for same-name conflicts
    const bundledNames = new Set(bundled.map((s) => s.name));
    const deduped = external.filter((s) => !bundledNames.has(s.name));

    return [...bundled, ...deduped];
}

/**
 * Enable a skill (rename SKILL.md.disabled to SKILL.md).
 * Uses rename approach because Gemini CLI ignores the enabled frontmatter field.
 */
export async function enableSkill(name: string, workspaceDir: string): Promise<void> {
    validateSkillName(name);

    for (const dir of [bundledSkillsDir(workspaceDir), externalSkillsDir(workspaceDir)]) {
        const disabledPath = join(dir, name, SKILL_FILENAME + SKILL_DISABLED_SUFFIX);
        if (existsSync(disabledPath)) {
            renameSync(disabledPath, join(dir, name, SKILL_FILENAME));
            return;
        }
        // Already enabled — no-op
        if (existsSync(join(dir, name, SKILL_FILENAME))) return;
    }

    throw new Error(`Skill not found: ${name}`);
}

/**
 * Disable a skill (rename SKILL.md to SKILL.md.disabled).
 * No longer matches Gemini CLI's glob (SKILL.md / *\/SKILL.md).
 */
export async function disableSkill(name: string, workspaceDir: string): Promise<void> {
    validateSkillName(name);

    for (const dir of [bundledSkillsDir(workspaceDir), externalSkillsDir(workspaceDir)]) {
        const skillMdPath = join(dir, name, SKILL_FILENAME);
        if (existsSync(skillMdPath)) {
            renameSync(skillMdPath, join(dir, name, SKILL_FILENAME + SKILL_DISABLED_SUFFIX));
            return;
        }
        // Already disabled — no-op
        if (existsSync(join(dir, name, SKILL_FILENAME + SKILL_DISABLED_SUFFIX))) return;
    }

    throw new Error(`Skill not found: ${name}`);
}

/**
 * Remove a skill. External skills are delegated to bunx skills remove.
 */
export async function removeSkill(name: string, workspaceDir: string): Promise<void> {
    validateSkillName(name);

    const extDir = join(externalSkillsDir(workspaceDir), name);
    if (existsSync(extDir)) {
        await execNpxSkills(['remove', '--skill', name, '--agent', 'gemini-cli', '-y'], workspaceDir);
        if (existsSync(extDir)) {
            rmSync(extDir, { recursive: true, force: true });
        }
        return;
    }

    const bundledDir = join(bundledSkillsDir(workspaceDir), name);
    if (!existsSync(bundledDir)) {
        throw new Error(`Skill not found: ${name}`);
    }
    rmSync(bundledDir, { recursive: true, force: true });
}

/**
 * Install external skills (staging dir approach).
 *
 * 1. Run bunx skills add in a temporary directory (TOCTOU prevention)
 * 2. Run security scan on the staging directory
 * 3. safe: move to workspace
 *    warning: return findings (CLI layer handles user confirmation)
 *    danger: delete staging
 * 4. Copy skills-lock.json to workspace
 */
export async function installSkill(
    ref: string,
    workspaceDir: string,
    options?: { force?: boolean; skipScan?: boolean; skill?: string },
): Promise<InstallResult> {
    const stagingDir = mkdtempSync(join(tmpdir(), 'geminiclaw-skill-'));

    try {
        // Run bunx skills add in the staging directory
        const addArgs = ['add', ref, '--agent', 'gemini-cli', '-y'];
        if (options?.skill) {
            addArgs.push('--skill', options.skill);
        }
        await execNpxSkills(addArgs, stagingDir);

        // Detect new skills from staging .agents/skills/
        const stagingSkillsDir = join(stagingDir, '.agents', 'skills');
        if (!existsSync(stagingSkillsDir)) {
            return { installed: [], scanned: [], warned: [], blocked: [], reports: {} };
        }

        const newSkills = readdirSync(stagingSkillsDir).filter((name) => {
            const p = join(stagingSkillsDir, name, SKILL_FILENAME);
            return existsSync(p);
        });

        if (newSkills.length === 0) {
            return { installed: [], scanned: [], warned: [], blocked: [], reports: {} };
        }

        if (options?.skipScan) {
            // No scan: move directly from staging to workspace
            moveSkillsToWorkspace(stagingSkillsDir, newSkills, workspaceDir);
            copyLockFile(stagingDir, workspaceDir);
            return { installed: newSkills, scanned: [], warned: [], blocked: [], reports: {} };
        }

        // Security scan
        const scanned: string[] = [];
        const warned: string[] = [];
        const blocked: string[] = [];
        const reports: Record<string, SecurityReport> = {};

        for (const name of newSkills) {
            const skillDir = join(stagingSkillsDir, name);
            const report = await scanSkill(skillDir, {
                skipLlm: true,
                workspacePath: workspaceDir,
            });
            reports[name] = report;

            if (report.riskLevel === 'danger' && !options?.force) {
                blocked.push(name);
            } else if (report.riskLevel === 'warning') {
                // warning: return results for CLI layer to prompt user confirmation
                warned.push(name);
            } else {
                scanned.push(name);
            }
        }

        // Move safe + forced danger + confirmed warned skills to workspace
        // Warned skills are moved via confirmInstall() after CLI layer confirmation
        const toMove = [...scanned, ...(options?.force ? blocked : [])];
        if (toMove.length > 0) {
            moveSkillsToWorkspace(stagingSkillsDir, toMove, workspaceDir);
        }

        if (toMove.length > 0 || warned.length > 0) {
            copyLockFile(stagingDir, workspaceDir);
        }

        return { installed: newSkills, scanned, warned, blocked, reports, _stagingDir: stagingDir };
    } catch (err) {
        // Ensure staging is cleaned up on error
        rmSync(stagingDir, { recursive: true, force: true });
        throw err;
    }
}

/**
 * Called after user confirmation for warned skills, moves from staging to workspace.
 */
export function confirmInstall(stagingDir: string, skillNames: string[], workspaceDir: string): void {
    const stagingSkillsDir = join(stagingDir, '.agents', 'skills');
    moveSkillsToWorkspace(stagingSkillsDir, skillNames, workspaceDir);
}

/**
 * Clean up the staging directory. Called after install completes.
 */
export function cleanupStaging(stagingDir: string): void {
    if (existsSync(stagingDir)) {
        rmSync(stagingDir, { recursive: true, force: true });
    }
}

export interface InstallResult {
    installed: string[];
    scanned: string[];
    warned: string[];
    blocked: string[];
    reports: Record<string, SecurityReport>;
    /** Staging dir path. Used by confirmInstall() after warned skill confirmation. */
    _stagingDir?: string;
}

export function skillExists(name: string, workspaceDir: string): boolean {
    validateSkillName(name);
    return !!findSkillMdPath(name, workspaceDir);
}

export function getSkillDir(name: string, workspaceDir: string): string {
    validateSkillName(name);
    const extDir = join(externalSkillsDir(workspaceDir), name);
    if (existsSync(extDir)) return extDir;
    return join(bundledSkillsDir(workspaceDir), name);
}

export function ensureSkillsDir(workspaceDir: string): void {
    const dir = bundledSkillsDir(workspaceDir);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

function findSkillMdPath(name: string, workspaceDir: string): string | null {
    for (const dir of [bundledSkillsDir(workspaceDir), externalSkillsDir(workspaceDir)]) {
        const p = join(dir, name, SKILL_FILENAME);
        if (existsSync(p)) return p;
        const disabled = join(dir, name, SKILL_FILENAME + SKILL_DISABLED_SUFFIX);
        if (existsSync(disabled)) return disabled;
    }
    return null;
}

/** Move skill directories from staging to workspace .agents/skills/. */
function moveSkillsToWorkspace(stagingSkillsDir: string, names: string[], workspaceDir: string): void {
    const targetDir = externalSkillsDir(workspaceDir);
    mkdirSync(targetDir, { recursive: true });

    for (const name of names) {
        const src = join(stagingSkillsDir, name);
        const dest = join(targetDir, name);
        if (existsSync(dest)) {
            rmSync(dest, { recursive: true, force: true });
        }
        cpSync(src, dest, { recursive: true });
    }
}

/** Copy (merge) skills-lock.json from staging to workspace. */
function copyLockFile(stagingDir: string, workspaceDir: string): void {
    const srcLock = join(stagingDir, 'skills-lock.json');
    if (!existsSync(srcLock)) return;

    const destLock = join(workspaceDir, 'skills-lock.json');

    try {
        const stagingLock = JSON.parse(readFileSync(srcLock, 'utf-8')) as { skills?: Record<string, unknown> };
        let merged = stagingLock;

        if (existsSync(destLock)) {
            const existing = JSON.parse(readFileSync(destLock, 'utf-8')) as {
                version: number;
                skills?: Record<string, unknown>;
            };
            merged = {
                ...existing,
                skills: { ...existing.skills, ...stagingLock.skills },
            };
        }

        writeFileSync(destLock, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
    } catch {
        // Lock file merge failure is non-fatal
    }
}

function execNpxSkills(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('bunx', ['skills', ...args], { cwd, timeout: 120_000 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`bunx skills ${args[0]} failed: ${stderr || error.message}`));
                return;
            }
            resolve(stdout);
        });
    });
}
