/**
 * vault/encrypted-file.ts — AES-256-GCM encrypted file backend.
 *
 * Key derivation follows Gemini CLI's FileTokenStorage pattern:
 *   - scrypt with a machine-specific salt (hostname + username)
 *   - No master password required — protected by filesystem permissions (0o600)
 *   - Not portable across machines (intentional; forces explicit migration)
 *
 * File layout:
 *   ~/.geminiclaw/vault.enc — JSON object of { key: encryptedValue } pairs
 *   Each entry is independently encrypted so there is no shared IV reuse.
 *
 * This backend is the automatic fallback when the OS keychain is unavailable
 * (e.g. WSL2, headless servers, CI environments).
 */

import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { GEMINICLAW_HOME } from '../config/paths.js';
import type { VaultBackend } from './types.js';

const VAULT_FILE = join(GEMINICLAW_HOME, 'vault.enc');
const ALGORITHM = 'aes-256-gcm';
const SCRYPT_KEYLEN = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Derive a machine-specific 32-byte key deterministically via scrypt. */
function deriveKey(): Buffer {
    // Salt ties the key to this machine; mirrors Gemini CLI's approach.
    // Changing hostname/username effectively rotates the key and invalidates the vault.
    const salt = `geminiclaw-vault-${hostname()}-${userInfo().username}`;
    return crypto.scryptSync('geminiclaw-vault-key', salt, SCRYPT_KEYLEN);
}

interface EncryptedEntry {
    /** Base64-encoded IV (12 bytes). */
    iv: string;
    /** Base64-encoded auth tag (16 bytes). */
    tag: string;
    /** Base64-encoded ciphertext. */
    data: string;
}

type VaultStore = Record<string, EncryptedEntry>;

export class EncryptedFileBackend implements VaultBackend {
    readonly name = 'Encrypted File (AES-256-GCM)';

    private readonly vaultFile: string;

    constructor(vaultFile: string = VAULT_FILE) {
        this.vaultFile = vaultFile;
    }

    async isAvailable(): Promise<boolean> {
        // Encrypted-file always works — it only depends on the filesystem.
        return true;
    }

    async get(key: string): Promise<string | null> {
        const store = this.load();
        const entry = store[key];
        if (!entry) return null;
        return this.decrypt(entry);
    }

    async set(key: string, value: string): Promise<void> {
        const store = this.load();
        store[key] = this.encrypt(value);
        await this.save(store);
    }

    async delete(key: string): Promise<void> {
        const store = this.load();
        const { [key]: _removed, ...rest } = store;
        await this.save(rest);
    }

    async list(): Promise<string[]> {
        return Object.keys(this.load());
    }

    // Internal helpers

    private load(): VaultStore {
        if (!existsSync(this.vaultFile)) return {};
        try {
            return JSON.parse(readFileSync(this.vaultFile, 'utf-8')) as VaultStore;
        } catch {
            // Corrupt file — start fresh rather than crashing
            return {};
        }
    }

    private async save(store: VaultStore): Promise<void> {
        const dir = dirname(this.vaultFile);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(this.vaultFile, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
        // Re-apply permissions in case the file already existed with broader perms
        try {
            await chmod(this.vaultFile, 0o600);
        } catch {
            /* non-fatal */
        }
    }

    private encrypt(plaintext: string): EncryptedEntry {
        const key = deriveKey();
        const iv = crypto.randomBytes(IV_BYTES);
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
        const data = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return {
            iv: iv.toString('base64'),
            tag: tag.toString('base64'),
            data: data.toString('base64'),
        };
    }

    private decrypt(entry: EncryptedEntry): string {
        const key = deriveKey();
        const iv = Buffer.from(entry.iv, 'base64');
        const tag = Buffer.from(entry.tag, 'base64');
        const data = Buffer.from(entry.data, 'base64');
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag.slice(0, TAG_BYTES));
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8');
    }
}
