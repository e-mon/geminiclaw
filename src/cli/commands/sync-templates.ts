/**
 * cli/commands/sync-templates.ts — Sync template files to workspace.
 */

import type { Command } from 'commander';
import { ContextBuilder } from '../../agent/context-builder.js';
import { getWorkspacePath, loadConfig } from '../../config/index.js';
import { Workspace } from '../../workspace.js';

export function registerSyncTemplatesCommand(program: Command): void {
    program
        .command('sync-templates')
        .description('Sync template files to workspace (protects MEMORY.md, USER.md, SOUL.md, HEARTBEAT.md)')
        .option('--status', 'Show sync status without applying changes')
        .option('--dry-run', 'Preview changes without applying them')
        .option('--force', '3-way merge protected files (preserves user edits, applies template changes)')
        .action(async (options) => {
            const config = loadConfig();
            const workspacePath = getWorkspacePath(config);

            // --status: show diff between templates and workspace, then exit
            if (options.status) {
                const results = Workspace.syncStatus(workspacePath);
                const outdated = results.filter((r) => r.status === 'outdated');
                const missing = results.filter((r) => r.status === 'missing');
                const upToDate = results.filter((r) => r.status === 'up-to-date');

                for (const r of results) {
                    const icon =
                        r.status === 'outdated'
                            ? '~ '
                            : r.status === 'missing'
                              ? '+ '
                              : r.status === 'protected'
                                ? '! '
                                : '  ';
                    process.stdout.write(`${icon}${r.path}  (${r.status})\n`);
                }

                process.stdout.write(
                    `\nStatus: ${upToDate.length} up-to-date, ${outdated.length} outdated, ${missing.length} missing\n`,
                );
                if (outdated.length > 0 || missing.length > 0) {
                    process.stdout.write('Run `geminiclaw sync-templates` to apply updates.\n');
                }
                return;
            }

            const results = Workspace.syncTemplates({
                workspacePath,
                dryRun: options.dryRun,
                force: options.force,
            });

            const prefix = options.dryRun ? '[dry-run] ' : '';
            for (const r of results) {
                const icon =
                    r.status === 'created'
                        ? '+ '
                        : r.status === 'updated'
                          ? '~ '
                          : r.status === 'merged'
                            ? 'M '
                            : r.status === 'conflict'
                              ? 'C '
                              : r.status === 'protected'
                                ? '! '
                                : '  ';
                process.stdout.write(`${icon}${prefix}${r.path}  (${r.status})\n`);
            }

            const created = results.filter((r) => r.status === 'created').length;
            const updated = results.filter((r) => r.status === 'updated').length;
            const merged = results.filter((r) => r.status === 'merged').length;
            const conflicts = results.filter((r) => r.status === 'conflict').length;
            const skipped = results.filter((r) => r.status === 'skipped').length;
            const protected_ = results.filter((r) => r.status === 'protected').length;

            const parts = [`+${created} created`, `~${updated} updated`];
            if (merged > 0) parts.push(`M${merged} merged`);
            if (conflicts > 0) parts.push(`C${conflicts} conflict`);
            parts.push(`${skipped} unchanged`);
            if (protected_ > 0) parts.push(`${protected_} protected (use --force to merge)`);

            process.stdout.write(`\n${options.dryRun ? 'Would apply' : 'Applied'}: ${parts.join(', ')}\n`);

            if (conflicts > 0) {
                process.stdout.write(
                    '\n⚠  Conflicts detected — search for <<<<<<< in the affected files and resolve manually.\n',
                );
            }

            // Regenerate static GEMINI.md after template sync (picks up new AGENTS.md etc.)
            const changed = created > 0 || updated > 0 || merged > 0;
            if (!options.dryRun && changed) {
                const builder = new ContextBuilder(workspacePath);
                await builder.writeStaticGeminiMd({
                    timezone: config.timezone || undefined,
                    autonomyLevel: config.autonomyLevel,
                    language: config.language,
                });
                process.stdout.write('Regenerated GEMINI.md\n');
            }
        });
}
