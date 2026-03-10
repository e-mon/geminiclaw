/**
 * manager.ts — スキル管理。
 *
 * bundled skills: {workspace}/.gemini/skills/
 * external skills: {workspace}/.agents/skills/ (bunx skills CLI 経由)
 *
 * Gemini CLI は両方のパスをネイティブに検索する。
 *
 * セキュリティ:
 *   - install は staging dir 方式（TOCTOU 防止）
 *   - enable/disable はリネーム方式（Gemini CLI が enabled フィールドを無視するため）
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
 * ディレクトリ内のスキルを読み取る共通ヘルパー。
 * disabled 状態（SKILL.md.disabled）のスキルも含める。
 */
function readSkillsFromDir(dir: string, source: 'bundled' | 'external'): SkillFrontmatter[] {
    if (!existsSync(dir)) return [];

    const entries = readdirSync(dir, { withFileTypes: true });
    const skills: SkillFrontmatter[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirPath = join(dir, entry.name);

        // disabled 状態のスキル
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
 * bundled + external スキルの一覧を返す。
 */
export async function listSkills(workspaceDir: string): Promise<SkillFrontmatter[]> {
    const bundled = readSkillsFromDir(bundledSkillsDir(workspaceDir), 'bundled');
    const external = readSkillsFromDir(externalSkillsDir(workspaceDir), 'external');

    // 同名スキルは bundled が優先
    const bundledNames = new Set(bundled.map((s) => s.name));
    const deduped = external.filter((s) => !bundledNames.has(s.name));

    return [...bundled, ...deduped];
}

/**
 * スキルを有効化する（SKILL.md.disabled → SKILL.md にリネーム）。
 * Gemini CLI は enabled フロントマターを無視するため、リネーム方式で制御する。
 */
export async function enableSkill(name: string, workspaceDir: string): Promise<void> {
    validateSkillName(name);

    for (const dir of [bundledSkillsDir(workspaceDir), externalSkillsDir(workspaceDir)]) {
        const disabledPath = join(dir, name, SKILL_FILENAME + SKILL_DISABLED_SUFFIX);
        if (existsSync(disabledPath)) {
            renameSync(disabledPath, join(dir, name, SKILL_FILENAME));
            return;
        }
        // 既に有効な場合は何もしない
        if (existsSync(join(dir, name, SKILL_FILENAME))) return;
    }

    throw new Error(`Skill not found: ${name}`);
}

/**
 * スキルを無効化する（SKILL.md → SKILL.md.disabled にリネーム）。
 * Gemini CLI のグロブ（SKILL.md / *\/SKILL.md）にマッチしなくなる。
 */
export async function disableSkill(name: string, workspaceDir: string): Promise<void> {
    validateSkillName(name);

    for (const dir of [bundledSkillsDir(workspaceDir), externalSkillsDir(workspaceDir)]) {
        const skillMdPath = join(dir, name, SKILL_FILENAME);
        if (existsSync(skillMdPath)) {
            renameSync(skillMdPath, join(dir, name, SKILL_FILENAME + SKILL_DISABLED_SUFFIX));
            return;
        }
        // 既に無効な場合は何もしない
        if (existsSync(join(dir, name, SKILL_FILENAME + SKILL_DISABLED_SUFFIX))) return;
    }

    throw new Error(`Skill not found: ${name}`);
}

/**
 * スキルを削除する。external スキルは bunx skills remove に委譲。
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
 * 外部スキルをインストールする（staging dir 方式）。
 *
 * 1. 一時ディレクトリに bunx skills add を実行（TOCTOU 防止）
 * 2. staging 上でセキュリティスキャン実行
 * 3. safe → workspace に移動
 *    warning → findings を返す（CLI 層でユーザー確認）
 *    danger → staging を削除
 * 4. skills-lock.json を workspace にコピー
 */
export async function installSkill(
    ref: string,
    workspaceDir: string,
    options?: { force?: boolean; skipScan?: boolean; skill?: string },
): Promise<InstallResult> {
    const stagingDir = mkdtempSync(join(tmpdir(), 'geminiclaw-skill-'));

    try {
        // staging に bunx skills add を実行
        const addArgs = ['add', ref, '--agent', 'gemini-cli', '-y'];
        if (options?.skill) {
            addArgs.push('--skill', options.skill);
        }
        await execNpxSkills(addArgs, stagingDir);

        // staging の .agents/skills/ から新スキルを検出
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
            // スキャンなし: staging → workspace に直接移動
            moveSkillsToWorkspace(stagingSkillsDir, newSkills, workspaceDir);
            copyLockFile(stagingDir, workspaceDir);
            return { installed: newSkills, scanned: [], warned: [], blocked: [], reports: {} };
        }

        // セキュリティスキャン
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
                // warning: CLI 層でユーザー確認を仰ぐため、結果を返す
                warned.push(name);
            } else {
                scanned.push(name);
            }
        }

        // safe + force 時の danger + ユーザー確認済み warned → workspace に移動
        // warned は CLI 層で確認後に confirmInstall() で移動する
        const toMove = [...scanned, ...(options?.force ? blocked : [])];
        if (toMove.length > 0) {
            moveSkillsToWorkspace(stagingSkillsDir, toMove, workspaceDir);
        }

        if (toMove.length > 0 || warned.length > 0) {
            copyLockFile(stagingDir, workspaceDir);
        }

        return { installed: newSkills, scanned, warned, blocked, reports, _stagingDir: stagingDir };
    } catch (err) {
        // エラー時は staging を確実にクリーンアップ
        rmSync(stagingDir, { recursive: true, force: true });
        throw err;
    }
}

/**
 * warning スキルのユーザー確認後に呼び出し、staging → workspace に移動する。
 */
export function confirmInstall(stagingDir: string, skillNames: string[], workspaceDir: string): void {
    const stagingSkillsDir = join(stagingDir, '.agents', 'skills');
    moveSkillsToWorkspace(stagingSkillsDir, skillNames, workspaceDir);
}

/**
 * staging のクリーンアップ。install 完了後に呼び出す。
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
    /** staging dir パス。warned スキルの確認後に confirmInstall() で使用。 */
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

/** staging → workspace の .agents/skills/ にスキルディレクトリを移動する。 */
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

/** staging の skills-lock.json を workspace にコピー（マージ）。 */
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
        // ロックファイルのマージ失敗は致命的ではない
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
