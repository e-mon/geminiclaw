/**
 * vault/index.ts — Vault singleton with "init once, sync access" pattern.
 *
 * Problem: loadConfig() is synchronous with 25+ call sites.
 *   Making it async would require a massive refactor.
 *
 * Solution:
 *   1. Call `await vault.init()` once at process startup (before any loadConfig call)
 *   2. All secrets are preloaded into an in-memory cache
 *   3. `vault.getSync(key)` reads from cache — fully synchronous, safe anywhere
 *
 * Backend auto-detection order (when backend = 'auto'):
 *   1. @napi-rs/keyring available and roundtrip passes → KeyringBackend
 *   2. Fallback → EncryptedFileBackend (always works)
 *
 * WSL2 note: @napi-rs/keyring does not reliably work in WSL2 without
 * additional setup (GCM bridge). Most WSL2 users will fall through to
 * EncryptedFileBackend, which provides equivalent protection to ZeroClaw.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GEMINICLAW_HOME } from '../config/paths.js';
import { EncryptedFileBackend } from './encrypted-file.js';
import { ExternalCommandBackend } from './external-command.js';
import { KeyringBackend } from './keyring.js';
import { parseVaultRef, type VaultBackend, type VaultConfig } from './types.js';

export type { VaultBackend, VaultConfig } from './types.js';
export { parseVaultRef, VAULT_REF_PREFIX } from './types.js';

/** Default vault config path within ~/.geminiclaw/config.json (read inline to avoid circular dep). */
const VAULT_CONFIG_KEY = 'vault';

function loadVaultConfig(): VaultConfig {
    try {
        const raw = readFileSync(join(GEMINICLAW_HOME, 'config.json'), 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const vc = (parsed[VAULT_CONFIG_KEY] ?? {}) as Partial<VaultConfig>;
        return {
            backend: vc.backend ?? 'auto',
            command: vc.command,
            setCommand: vc.setCommand,
        };
    } catch {
        return { backend: 'auto' };
    }
}

/**
 * Extended config accepted by createBackend — includes testing overrides
 * not exposed in the public VaultConfig schema.
 */
interface CreateBackendOptions extends VaultConfig {
    /** Override the vault file path (used in tests). Default: ~/.geminiclaw/vault.enc */
    vaultFile?: string;
}

async function createBackend(config: CreateBackendOptions): Promise<VaultBackend> {
    switch (config.backend) {
        case 'keyring': {
            const kb = new KeyringBackend();
            if (!(await kb.isAvailable())) {
                throw new Error('Vault: keyring backend requested but @napi-rs/keyring is not available');
            }
            return kb;
        }
        case 'encrypted-file':
            return new EncryptedFileBackend(config.vaultFile);

        case 'command': {
            if (!config.command) throw new Error('Vault: backend="command" requires a "command" field in config');
            return new ExternalCommandBackend(config.command, config.setCommand);
        }
        default: {
            const keyring = new KeyringBackend();
            if (await keyring.isAvailable()) return keyring;
            return new EncryptedFileBackend(config.vaultFile);
        }
    }
}

export class Vault {
    private backend: VaultBackend | null = null;
    private cache: Map<string, string> = new Map();
    private initialized = false;

    /**
     * Initialize the vault: select backend and preload all secrets into memory.
     * Must be called once at process startup before any getSync() calls.
     *
     * @param config - Vault configuration. Accepts an optional `vaultFile` override
     *   for the encrypted-file backend (useful in tests).
     */
    async init(config?: VaultConfig & { vaultFile?: string }): Promise<void> {
        if (this.initialized) return;
        const vc = config ?? loadVaultConfig();
        this.backend = await createBackend(vc);

        // Preload all secrets so getSync() is always fast and synchronous
        const backend = this.backend;
        try {
            const keys = await backend.list();
            await Promise.all(
                keys.map(async (key) => {
                    const value = await backend.get(key);
                    if (value !== null) this.cache.set(key, value);
                }),
            );
        } catch (err) {
            process.stderr.write(`[vault] warning: failed to preload vault cache: ${String(err)}\n`);
        }
        this.initialized = true;
    }

    /**
     * Synchronous cache lookup for use inside loadConfig().
     * Returns undefined if the vault has not been initialized or the key is absent.
     */
    getSync(key: string): string | undefined {
        return this.cache.get(key);
    }

    /**
     * Resolve a config value: if it is a vault reference ("$vault:<key>"),
     * return the resolved secret; otherwise return the original value as-is.
     * Falls back to the env var if the key is not in vault.
     *
     * Designed to be called inside loadConfig() for each secret field.
     */
    resolveSync(value: string | undefined): string | undefined {
        if (!value) return value;
        const vaultKey = parseVaultRef(value);
        if (vaultKey === null) return value;
        return this.cache.get(vaultKey) ?? undefined;
    }

    /** Async get — bypasses cache for fresh reads after init. */
    async get(key: string): Promise<string | null> {
        return this.requireBackend().get(key);
    }

    /** Store a secret and update the in-memory cache. */
    async set(key: string, value: string): Promise<void> {
        await this.requireBackend().set(key, value);
        this.cache.set(key, value);
    }

    /** Remove a secret from storage and cache. */
    async delete(key: string): Promise<void> {
        await this.requireBackend().delete(key);
        this.cache.delete(key);
    }

    /** List all stored secret keys (no values). */
    async list(): Promise<string[]> {
        return this.requireBackend().list();
    }

    /** Which backend is active (for `geminiclaw vault status`). */
    get backendName(): string {
        return this.backend?.name ?? 'not initialized';
    }

    /** Whether init() has been called successfully. */
    get isInitialized(): boolean {
        return this.initialized;
    }

    private requireBackend(): VaultBackend {
        if (!this.initialized || !this.backend) {
            throw new Error('Vault has not been initialized. Call vault.init() first.');
        }
        return this.backend;
    }
}

/**
 * Process-wide vault singleton.
 *
 * Usage:
 *   // At startup (before loadConfig):
 *   await vault.init();
 *
 *   // Inside loadConfig or synchronous code:
 *   const token = vault.resolveSync(config.channels.discord.token);
 */
export const vault = new Vault();
