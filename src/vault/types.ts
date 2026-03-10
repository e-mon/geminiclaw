/**
 * vault/types.ts — Core types for the GeminiClaw vault (secret storage).
 *
 * Design goals:
 *   - Pluggable backends (OS keychain, encrypted file, external CLI)
 *   - Config values reference secrets by name ("$vault:discord-token")
 *     rather than embedding the actual value; loadConfig() resolves these
 *     at startup via a pre-initialized Vault singleton
 *   - Backend auto-selection mirrors Gemini CLI's HybridTokenStorage pattern
 */

/** Pluggable backend interface for storing and retrieving secrets. */
export interface VaultBackend {
    /**
     * Retrieve a secret by key.
     * Returns null if the key does not exist.
     */
    get(key: string): Promise<string | null>;

    /** Store or overwrite a secret. */
    set(key: string, value: string): Promise<void>;

    /** Remove a secret. No-op if the key does not exist. */
    delete(key: string): Promise<void>;

    /** List all stored keys (metadata only, no values). */
    list(): Promise<string[]>;

    /**
     * Perform an actual roundtrip test to verify this backend is functional.
     * Implementations should write, read, and delete a temporary test key.
     */
    isAvailable(): Promise<boolean>;

    /** Human-readable name for display in `geminiclaw vault status`. */
    readonly name: string;
}

/**
 * Which backend to use for secret storage.
 *   - 'auto'           : Try keyring → encrypted-file (default)
 *   - 'keyring'        : OS native keychain only (macOS Keychain, GNOME Keyring, Windows Credential Manager)
 *   - 'encrypted-file' : AES-256-GCM encrypted file, machine-specific key derivation
 *   - 'command'        : Delegate to an external CLI (pass, op, age, …)
 */
export type VaultBackendType = 'auto' | 'keyring' | 'encrypted-file' | 'command';

/** Vault configuration stored in ~/.geminiclaw/config.json under the "vault" key. */
export interface VaultConfig {
    /** Which backend to prefer. Default: 'auto'. */
    backend: VaultBackendType;
    /**
     * Shell command template for the 'command' backend.
     * Use {key} as a placeholder for the secret name.
     * Example: "pass show geminiclaw/{key}"
     */
    command?: string;
    /**
     * Shell command template for writing a secret (stdin = value).
     * Example: "pass insert --force geminiclaw/{key}"
     * If omitted, the 'command' backend is read-only.
     */
    setCommand?: string;
}

/**
 * Prefix used to mark config.json values that should be resolved from vault
 * at runtime rather than stored in plaintext.
 *
 * Example:
 *   { "channels": { "discord": { "token": "$vault:discord-token" } } }
 */
export const VAULT_REF_PREFIX = '$vault:';

/** Vault keys must be alphanumeric with hyphens/underscores only. */
const VAULT_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Check whether a config value is a vault reference.
 * Returns the vault key if valid, otherwise null.
 *
 * Key names are restricted to `[a-zA-Z0-9_-]+` to prevent shell injection
 * when used with ExternalCommandBackend.
 */
export function parseVaultRef(value: string | undefined): string | null {
    if (!value?.startsWith(VAULT_REF_PREFIX)) return null;
    const key = value.slice(VAULT_REF_PREFIX.length);
    if (!key || !VAULT_KEY_PATTERN.test(key)) return null;
    return key;
}
