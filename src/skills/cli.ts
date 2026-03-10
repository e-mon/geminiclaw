/**
 * cli.ts — `geminiclaw skill` サブコマンド群。
 *
 * skill list / enable / disable / remove / scan / install / search を提供する。
 * install / search / remove は bunx skills CLI に委譲する。
 *
 * セキュリティ:
 *   - install 時に staging dir でスキャン → danger はブロック、warning はユーザー確認
 *   - enable/disable はリネーム方式（Gemini CLI が enabled フィールドを無視するため）
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Command } from 'commander';
import { getWorkspacePath, loadConfig } from '../config.js';
import {
    cleanupStaging,
    confirmInstall,
    disableSkill,
    enableSkill,
    getSkillDir,
    installSkill,
    listSkills,
    removeSkill,
    skillExists,
} from './manager.js';
import { scanSkill } from './scanner.js';
import type { RiskLevel, SecurityFinding } from './types.js';

const RISK_ICONS: Record<RiskLevel, string> = {
    safe: '\u2705',
    warning: '\u26A0\uFE0F ',
    danger: '\uD83D\uDD34',
};

function printFindings(findings: SecurityFinding[]): void {
    if (findings.length === 0) return;
    process.stdout.write('\nFindings:\n');
    for (const f of findings) {
        const icon = RISK_ICONS[f.severity];
        process.stdout.write(`  ${icon} [${f.severity.toUpperCase()}] ${f.file}:${f.line}\n`);
        process.stdout.write(`     ${f.description}\n`);
        process.stdout.write(`     pattern: /${f.pattern}/\n`);
    }
}

/** ユーザーに Y/N 確認を求める。非 TTY では安全側に倒す（reject）。 */
function askConfirmation(message: string): Promise<boolean> {
    if (!process.stdin.isTTY) return Promise.resolve(false);
    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`${message} [y/N] `, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y');
        });
    });
}

export function buildSkillCommand(): Command {
    const skill = new Command('skill').description('Skill management');

    // ── skill list ────────────────────────────────────────────────
    skill
        .command('list')
        .description('List all installed skills')
        .action(async () => {
            const config = loadConfig();
            const workspacePath = getWorkspacePath(config);
            const skills = await listSkills(workspacePath);

            if (skills.length === 0) {
                process.stdout.write('No skills installed.\n');
                return;
            }

            const nameWidth = Math.max(...skills.map((s) => s.name.length), 10);
            const header = `${'NAME'.padEnd(nameWidth)}  STATUS   SOURCE     DESCRIPTION`;
            process.stdout.write(`${header}\n`);
            process.stdout.write(`${'─'.repeat(header.length)}\n`);

            for (const s of skills) {
                const status = s.enabled ? 'enabled ' : 'disabled';
                const source = (s.source ?? 'unknown').padEnd(9);
                process.stdout.write(`${s.name.padEnd(nameWidth)}  ${status}  ${source}  ${s.description}\n`);
            }
        });

    // ── skill enable ──────────────────────────────────────────────
    skill
        .command('enable')
        .description('Enable a skill')
        .argument('<name>', 'Skill name')
        .action(async (name: string) => {
            const config = loadConfig();
            const workspacePath = getWorkspacePath(config);
            try {
                await enableSkill(name, workspacePath);
                process.stdout.write(`Enabled skill: ${name}\n`);
            } catch (err) {
                process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
                process.exit(1);
            }
        });

    // ── skill disable ─────────────────────────────────────────────
    skill
        .command('disable')
        .description('Disable a skill')
        .argument('<name>', 'Skill name')
        .action(async (name: string) => {
            const config = loadConfig();
            const workspacePath = getWorkspacePath(config);
            try {
                await disableSkill(name, workspacePath);
                process.stdout.write(`Disabled skill: ${name}\n`);
            } catch (err) {
                process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
                process.exit(1);
            }
        });

    // ── skill remove ──────────────────────────────────────────────
    skill
        .command('remove')
        .description('Remove a skill')
        .argument('<name>', 'Skill name')
        .action(async (name: string) => {
            const config = loadConfig();
            const workspacePath = getWorkspacePath(config);
            try {
                await removeSkill(name, workspacePath);
                process.stdout.write(`Removed skill: ${name}\n`);
            } catch (err) {
                process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
                process.exit(1);
            }
        });

    // ── skill scan ────────────────────────────────────────────────
    skill
        .command('scan')
        .description('Security scan an installed skill')
        .argument('<name>', 'Skill name')
        .option('--skip-llm', 'Skip LLM advisory review (static scan only)')
        .option('--model <model>', 'Gemini model for LLM review')
        .action(async (name: string, options: { skipLlm?: boolean; model?: string }) => {
            const config = loadConfig();
            const workspacePath = getWorkspacePath(config);

            if (!skillExists(name, workspacePath)) {
                process.stderr.write(`Error: Skill not found: ${name}\n`);
                process.exit(1);
            }

            const skillDir = getSkillDir(name, workspacePath);
            process.stdout.write(`Scanning skill: ${name}${options.skipLlm ? ' (static only)' : ''}\n`);

            const report = await scanSkill(skillDir, {
                skipLlm: options.skipLlm,
                model: options.model,
                workspacePath,
            });

            const icon = RISK_ICONS[report.riskLevel];
            process.stdout.write(`\n${icon} Risk level: ${report.riskLevel.toUpperCase()}\n`);
            process.stdout.write(`   Scanned at: ${report.scannedAt}\n`);

            printFindings(report.findings);

            if (report.llmAdvisory) {
                process.stdout.write(`\nLLM Advisory (informational only):\n  ${report.llmAdvisory}\n`);
            }

            if (report.riskLevel === 'danger') {
                process.exit(2);
            }
        });

    // ── skill install ─────────────────────────────────────────────
    skill
        .command('install')
        .description('Install skills from an external source (via bunx skills)')
        .argument('<ref>', 'Skill source (e.g. owner/repo, GitHub URL, local path)')
        .option('--force', 'Install even if security scan reports danger')
        .option('--no-scan', 'Skip security scan')
        .option('-y, --yes', 'Skip confirmation prompts for warnings')
        .option('--skill <name>', 'Install a specific skill from the source')
        .action(async (ref: string, options: { force?: boolean; scan?: boolean; yes?: boolean; skill?: string }) => {
            const config = loadConfig();
            const workspacePath = getWorkspacePath(config);

            process.stdout.write(`Installing skills from: ${ref}\n`);

            try {
                const result = await installSkill(ref, workspacePath, {
                    force: options.force,
                    skipScan: options.scan === false,
                    skill: options.skill,
                });

                if (result.installed.length === 0) {
                    process.stdout.write('No new skills were installed.\n');
                    return;
                }

                // safe スキル: 既に workspace に移動済み
                for (const name of result.scanned) {
                    process.stdout.write(`  ${RISK_ICONS.safe} Installed: ${name}\n`);
                }

                // warned スキル: findings を表示してユーザー確認
                if (result.warned.length > 0 && result._stagingDir) {
                    for (const name of result.warned) {
                        const report = result.reports[name];
                        process.stdout.write(`\n${RISK_ICONS.warning} Warnings for skill: ${name}\n`);
                        if (report) printFindings(report.findings);

                        const confirmed = options.yes || (await askConfirmation(`  Install ${name} anyway?`));
                        if (confirmed) {
                            confirmInstall(result._stagingDir, [name], workspacePath);
                            process.stdout.write(`  ${RISK_ICONS.warning} Installed (with warnings): ${name}\n`);
                        } else {
                            process.stdout.write(`  Skipped: ${name}\n`);
                        }
                    }
                }

                // blocked スキル
                for (const name of result.blocked) {
                    const report = result.reports[name];
                    process.stderr.write(`\n${RISK_ICONS.danger} Blocked: ${name}\n`);
                    if (report) printFindings(report.findings);
                }

                if (result.blocked.length > 0) {
                    process.stdout.write('\nUse --force to install blocked skills.\n');
                }

                // staging クリーンアップ
                if (result._stagingDir) {
                    cleanupStaging(result._stagingDir);
                }
            } catch (err) {
                process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
                process.exit(1);
            }
        });

    // ── skill search ──────────────────────────────────────────────
    skill
        .command('search')
        .description('Search for skills (via bunx skills find)')
        .argument('[query]', 'Search query')
        .action((_query?: string) => {
            const args = ['skills', 'find'];
            if (_query) args.push(_query);

            const child = spawn('bunx', args, { stdio: 'inherit' });
            child.on('exit', (code) => process.exit(code ?? 0));
        });

    return skill;
}
