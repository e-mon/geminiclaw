/**
 * cli/commands/vault.ts — Secret management commands.
 *
 * Subcommands:
 *   geminiclaw vault set <key>      — Store a secret (prompts for value)
 *   geminiclaw vault get <key>      — Print a secret to stdout
 *   geminiclaw vault list           — List all stored keys
 *   geminiclaw vault delete <key>   — Remove a secret
 *   geminiclaw vault status         — Show which backend is active
 *
 * Security note: `vault get` prints to stdout intentionally for scripting.
 * Users should be aware that the terminal may log history. Pipe to clipboard
 * or use `vault get <key> | pbcopy` to avoid shell history exposure.
 */

import * as readline from 'node:readline';
import type { Command } from 'commander';
import { loadConfig } from '../../config.js';
import { vault } from '../../vault/index.js';

/** Prompt for a secret value without echoing to terminal. */
function promptSecret(prompt: string): Promise<string> {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        // Mute echo by overriding _writeToOutput (readline internal, but stable)
        (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string): void => {
            // Allow the prompt itself to be printed, but suppress typed chars
            if (!s.includes(prompt)) return;
            process.stdout.write(s);
        };

        rl.question(prompt, (value) => {
            process.stdout.write('\n'); // Move past the hidden input line
            rl.close();
            resolve(value);
        });
    });
}

async function initVault(): Promise<void> {
    if (vault.isInitialized) return;
    const config = loadConfig();
    await vault.init(config.vault);
}

export function registerVaultCommand(program: Command): void {
    const vaultCmd = program.command('vault').description('Manage secrets in the GeminiClaw vault');

    // vault set <key>
    vaultCmd
        .command('set <key>')
        .description('Store a secret (prompts for value without echo)')
        .action(async (key: string) => {
            await initVault();
            const value = await promptSecret(`Enter value for "${key}": `);
            if (!value) {
                process.stderr.write('Error: empty value; secret not stored.\n');
                process.exit(1);
            }
            await vault.set(key, value);
            process.stdout.write(`Vault: stored "${key}" in ${vault.backendName}\n`);
        });

    // vault get <key>
    vaultCmd
        .command('get <key>')
        .description('Print a secret value to stdout')
        .action(async (key: string) => {
            await initVault();
            const value = await vault.get(key);
            if (value === null) {
                process.stderr.write(`Vault: key "${key}" not found.\n`);
                process.exit(1);
            }
            process.stdout.write(`${value}\n`);
        });

    // vault list
    vaultCmd
        .command('list')
        .description('List all stored secret keys (no values)')
        .action(async () => {
            await initVault();
            const keys = await vault.list();
            if (keys.length === 0) {
                process.stdout.write('Vault is empty.\n');
            } else {
                for (const key of keys) {
                    process.stdout.write(`  ${key}\n`);
                }
            }
        });

    // vault delete <key>
    vaultCmd
        .command('delete <key>')
        .description('Remove a secret from the vault')
        .action(async (key: string) => {
            await initVault();
            await vault.delete(key);
            process.stdout.write(`Vault: deleted "${key}"\n`);
        });

    // vault status
    vaultCmd
        .command('status')
        .description('Show which backend is active and how many secrets are stored')
        .action(async () => {
            await initVault();
            const keys = await vault.list();
            process.stdout.write(`Backend : ${vault.backendName}\n`);
            process.stdout.write(`Secrets : ${keys.length}\n`);
            if (keys.length > 0) {
                process.stdout.write(`Keys    : ${keys.join(', ')}\n`);
            }
        });

    // vault migrate — convenience helper to move a plaintext token into vault
    vaultCmd
        .command('migrate <config-key> <vault-key>')
        .description(
            'Read a plaintext token from config.json and move it to vault\n' +
                'Example: geminiclaw vault migrate channels.discord.token discord-token',
        )
        .action(async (configKey: string, vaultKey: string) => {
            await initVault();
            const config = loadConfig();

            // Resolve dotted config key path (e.g. "channels.discord.token")
            const parts = configKey.split('.');
            let current: unknown = config;
            for (const part of parts) {
                if (current === null || typeof current !== 'object') {
                    process.stderr.write(`Error: config key "${configKey}" not found.\n`);
                    process.exit(1);
                }
                current = (current as Record<string, unknown>)[part];
            }

            const value = typeof current === 'string' ? current : undefined;
            if (!value) {
                process.stderr.write(`Error: config.${configKey} is not a string or is already a vault reference.\n`);
                process.exit(1);
            }
            if (value.startsWith('$vault:')) {
                process.stderr.write(`Info: config.${configKey} is already a vault reference: ${value}\n`);
                process.exit(0);
            }

            await vault.set(vaultKey, value);
            process.stdout.write(
                `Vault: stored "${vaultKey}" (${vault.backendName})\n` +
                    `\nNext: update config.json — set channels.discord.token to "$vault:${vaultKey}"\n` +
                    `Run: geminiclaw config-show to view current config\n`,
            );
        });
}
