/**
 * vault/keyring.ts — OS native keychain backend via @napi-rs/keyring.
 *
 * @napi-rs/keyring is the modern replacement for the archived node-keytar:
 *   - Rust-based via NAPI-RS (no deprecated build tools)
 *   - Supports macOS Keychain, GNOME Keyring, Windows Credential Manager
 *   - Does NOT reliably support WSL2 (falls through to EncryptedFileBackend)
 *   - API is 100% node-keytar compatible
 *
 * Key list support: @napi-rs/keyring has no native list() API, so we maintain
 * a JSON manifest stored under a dedicated keyring entry.
 */

import crypto from 'node:crypto';
import type { VaultBackend } from './types.js';

const SERVICE_NAME = 'geminiclaw';
const MANIFEST_ACCOUNT = '__vault_manifest__';
const AVAILABILITY_TEST_KEY = '__vault_availability_test__';

/** Dynamic import type for @napi-rs/keyring — optional peer dependency. */
type KeyringModule = {
    Entry: new (
        service: string,
        account: string,
    ) => {
        getPassword(): string | null;
        setPassword(password: string): void;
        deletePassword(): boolean;
    };
};

export class KeyringBackend implements VaultBackend {
    readonly name = 'OS Keychain (@napi-rs/keyring)';

    private mod: KeyringModule | null = null;

    /** Lazy-load @napi-rs/keyring so the package is an optional dependency. */
    private async load(): Promise<KeyringModule | null> {
        if (this.mod) return this.mod;
        try {
            // Dynamic import avoids hard dep; falls through when package is not installed.
            // TypeScript cannot resolve the type at compile time — use Function() to bypass.
            const imp = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<unknown>;
            this.mod = (await imp('@napi-rs/keyring')) as KeyringModule;
            return this.mod;
        } catch {
            return null;
        }
    }

    async isAvailable(): Promise<boolean> {
        const kr = await this.load();
        if (!kr) return false;
        try {
            const testValue = crypto.randomBytes(8).toString('hex');
            const entry = new kr.Entry(SERVICE_NAME, AVAILABILITY_TEST_KEY);
            entry.setPassword(testValue);
            const retrieved = entry.getPassword();
            entry.deletePassword();
            return retrieved === testValue;
        } catch {
            return false;
        }
    }

    async get(key: string): Promise<string | null> {
        const kr = await this.load();
        if (!kr) return null;
        try {
            const entry = new kr.Entry(SERVICE_NAME, key);
            return entry.getPassword();
        } catch {
            return null;
        }
    }

    async set(key: string, value: string): Promise<void> {
        const kr = await this.load();
        if (!kr) throw new Error('KeyringBackend: @napi-rs/keyring is not available');
        const entry = new kr.Entry(SERVICE_NAME, key);
        entry.setPassword(value);
        await this.addToManifest(kr, key);
    }

    async delete(key: string): Promise<void> {
        const kr = await this.load();
        if (!kr) return;
        try {
            const entry = new kr.Entry(SERVICE_NAME, key);
            entry.deletePassword();
        } catch {
            /* ignore if key doesn't exist */
        }
        await this.removeFromManifest(kr, key);
    }

    async list(): Promise<string[]> {
        const kr = await this.load();
        if (!kr) return [];
        return this.readManifest(kr);
    }

    // Manifest helpers — stored as JSON array in a dedicated keyring entry

    private readManifest(kr: KeyringModule): string[] {
        try {
            const entry = new kr.Entry(SERVICE_NAME, MANIFEST_ACCOUNT);
            const raw = entry.getPassword();
            if (!raw) return [];
            return JSON.parse(raw) as string[];
        } catch {
            return [];
        }
    }

    private async addToManifest(kr: KeyringModule, key: string): Promise<void> {
        const keys = this.readManifest(kr);
        if (!keys.includes(key)) {
            keys.push(key);
            const entry = new kr.Entry(SERVICE_NAME, MANIFEST_ACCOUNT);
            entry.setPassword(JSON.stringify(keys));
        }
    }

    private async removeFromManifest(kr: KeyringModule, key: string): Promise<void> {
        const keys = this.readManifest(kr).filter((k) => k !== key);
        const entry = new kr.Entry(SERVICE_NAME, MANIFEST_ACCOUNT);
        if (keys.length === 0) {
            try {
                entry.deletePassword();
            } catch {
                /* ok */
            }
        } else {
            entry.setPassword(JSON.stringify(keys));
        }
    }
}
