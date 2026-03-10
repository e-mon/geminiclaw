/**
 * vault/external-command.ts — External CLI delegation backend.
 *
 * Delegates secret storage to any external tool via shell commands.
 * Useful for users who already manage secrets with pass, op (1Password),
 * age, or similar tools.
 *
 * Configuration example (in ~/.geminiclaw/config.json):
 *   {
 *     "vault": {
 *       "backend": "command",
 *       "command": "pass show geminiclaw/{key}",
 *       "setCommand": "pass insert --force geminiclaw/{key}"
 *     }
 *   }
 *
 * The {key} placeholder is replaced with the actual secret name.
 * For setCommand, the secret value is piped to stdin.
 * If setCommand is omitted, this backend is read-only.
 */

import { execFileSync } from 'node:child_process';
import type { VaultBackend } from './types.js';

/** Allowlist of characters permitted in vault key names. */
const SAFE_KEY_RE = /^[a-zA-Z0-9_.\-/]+$/;

/**
 * Parse a command template into a binary and argument list.
 *
 * Splits on whitespace and substitutes `{key}` in each argument.
 * Uses `execFileSync` (no shell) to prevent command injection.
 */
function parseCommand(template: string, key: string): { binary: string; args: string[] } {
    const parts = template.split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
        throw new Error('ExternalCommandBackend: command template is empty');
    }
    const binary = parts[0] as string;
    const args = parts.slice(1).map((p) => p.replaceAll('{key}', key));
    return { binary, args };
}

export class ExternalCommandBackend implements VaultBackend {
    readonly name: string;

    constructor(
        /** Command template for reading a secret. {key} is substituted with the key name. */
        private readonly readCmd: string,
        /**
         * Command template for writing a secret.
         * Value is passed via stdin. If undefined, set() throws.
         */
        private readonly writeCmd?: string,
    ) {
        this.name = `External Command (${readCmd.split(' ')[0] ?? 'unknown'})`;
    }

    async isAvailable(): Promise<boolean> {
        // The backend is available if the underlying binary exists.
        const binary = this.readCmd.split(' ')[0] as string;
        try {
            execFileSync('which', [binary], { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }

    async get(key: string): Promise<string | null> {
        validateKey(key);
        const { binary, args } = parseCommand(this.readCmd, key);
        try {
            const output = execFileSync(binary, args, {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            return output.trim() || null;
        } catch {
            // Non-zero exit typically means the key doesn't exist
            return null;
        }
    }

    async set(key: string, value: string): Promise<void> {
        if (!this.writeCmd) {
            throw new Error(`ExternalCommandBackend: no setCommand configured; cannot write "${key}"`);
        }
        validateKey(key);
        const { binary, args } = parseCommand(this.writeCmd, key);
        execFileSync(binary, args, {
            encoding: 'utf-8',
            input: value,
            stdio: ['pipe', 'ignore', 'pipe'],
        });
    }

    async delete(key: string): Promise<void> {
        // Deletion is not universally supported by external tools.
        // Users who need it should configure a dedicated deleteCommand or do it manually.
        throw new Error(
            `ExternalCommandBackend: delete is not supported. ` +
                `Manually remove "${key}" from your password manager.`,
        );
    }

    async list(): Promise<string[]> {
        // External CLIs have no common list interface; return empty rather than guess.
        // Users can still use their native tool to list entries.
        return [];
    }
}

/** Reject key names that could be used for shell injection. */
function validateKey(key: string): void {
    if (!key || !SAFE_KEY_RE.test(key)) {
        throw new Error(`ExternalCommandBackend: invalid key "${key}". ` + `Keys must match ${SAFE_KEY_RE.source}`);
    }
}
