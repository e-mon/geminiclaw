/**
 * vault/vault.test.ts — Unit tests for vault backends and the Vault singleton.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EncryptedFileBackend } from './encrypted-file.js';
import { Vault } from './index.js';
import { parseVaultRef, VAULT_REF_PREFIX } from './types.js';

// ── EncryptedFileBackend ──────────────────────────────────────────

describe('EncryptedFileBackend', () => {
    let tmpDir: string;
    let backend: EncryptedFileBackend;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'geminiclaw-vault-test-'));
        backend = new EncryptedFileBackend(join(tmpDir, 'vault.enc'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('is always available', async () => {
        expect(await backend.isAvailable()).toBe(true);
    });

    it('returns null for missing keys', async () => {
        expect(await backend.get('nonexistent')).toBeNull();
    });

    it('stores and retrieves a secret', async () => {
        await backend.set('my-token', 'super-secret-value');
        expect(await backend.get('my-token')).toBe('super-secret-value');
    });

    it('overwrites an existing key', async () => {
        await backend.set('token', 'old-value');
        await backend.set('token', 'new-value');
        expect(await backend.get('token')).toBe('new-value');
    });

    it('deletes a key', async () => {
        await backend.set('token', 'value');
        await backend.delete('token');
        expect(await backend.get('token')).toBeNull();
    });

    it('delete is no-op for missing key', async () => {
        await expect(backend.delete('nonexistent')).resolves.toBeUndefined();
    });

    it('lists stored keys', async () => {
        await backend.set('key-a', 'val-a');
        await backend.set('key-b', 'val-b');
        const keys = await backend.list();
        expect(keys).toContain('key-a');
        expect(keys).toContain('key-b');
    });

    it('list reflects deleted keys', async () => {
        await backend.set('to-delete', 'x');
        await backend.delete('to-delete');
        const keys = await backend.list();
        expect(keys).not.toContain('to-delete');
    });

    it('handles special characters in values', async () => {
        const value = '日本語\n"quotes"\ttabs\0nullbytes';
        await backend.set('special', value);
        expect(await backend.get('special')).toBe(value);
    });

    it('uses a separate encrypted file per instance', async () => {
        const backend2 = new EncryptedFileBackend(join(tmpDir, 'vault2.enc'));
        await backend.set('key', 'value-1');
        await backend2.set('key', 'value-2');
        expect(await backend.get('key')).toBe('value-1');
        expect(await backend2.get('key')).toBe('value-2');
    });
});

// ── parseVaultRef ─────────────────────────────────────────────────

describe('parseVaultRef', () => {
    it('returns key for vault references', () => {
        expect(parseVaultRef(`${VAULT_REF_PREFIX}discord-token`)).toBe('discord-token');
    });

    it('returns null for plain strings', () => {
        expect(parseVaultRef('MTIzNDU2')).toBeNull();
    });

    it('returns null for undefined', () => {
        expect(parseVaultRef(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(parseVaultRef('')).toBeNull();
    });

    it('rejects keys with shell-injection characters', () => {
        expect(parseVaultRef(`${VAULT_REF_PREFIX}; rm -rf /`)).toBeNull();
        expect(parseVaultRef(`${VAULT_REF_PREFIX}key$(whoami)`)).toBeNull();
        expect(parseVaultRef(`${VAULT_REF_PREFIX}key with spaces`)).toBeNull();
        expect(parseVaultRef(`${VAULT_REF_PREFIX}../../../etc/passwd`)).toBeNull();
    });

    it('accepts valid key names', () => {
        expect(parseVaultRef(`${VAULT_REF_PREFIX}discord-token`)).toBe('discord-token');
        expect(parseVaultRef(`${VAULT_REF_PREFIX}SLACK_BOT_TOKEN`)).toBe('SLACK_BOT_TOKEN');
        expect(parseVaultRef(`${VAULT_REF_PREFIX}jina-api-key`)).toBe('jina-api-key');
        expect(parseVaultRef(`${VAULT_REF_PREFIX}key123`)).toBe('key123');
    });

    it('returns null for empty key after prefix', () => {
        expect(parseVaultRef(VAULT_REF_PREFIX)).toBeNull();
    });
});

// ── Vault singleton ───────────────────────────────────────────────

describe('Vault', () => {
    let tmpDir: string;
    let v: Vault;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'geminiclaw-vault-test-'));
        v = new Vault();
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('is not initialized before init()', () => {
        expect(v.isInitialized).toBe(false);
    });

    it('initializes with encrypted-file backend', async () => {
        await v.init({ backend: 'encrypted-file', vaultFile: join(tmpDir, 'vault.enc') });
        expect(v.isInitialized).toBe(true);
        expect(v.backendName).toContain('AES-256-GCM');
    });

    it('getSync returns undefined before init', () => {
        expect(v.getSync('any-key')).toBeUndefined();
    });

    it('resolveSync returns raw value for non-vault strings before init', () => {
        expect(v.resolveSync('plain-token')).toBe('plain-token');
    });

    it('resolveSync returns undefined for vault refs when not initialized', () => {
        // Vault ref present but vault not initialized → undefined (not the raw "$vault:..." string)
        expect(v.resolveSync(`${VAULT_REF_PREFIX}discord-token`)).toBeUndefined();
    });

    it('set/get/delete work after init', async () => {
        await v.init({ backend: 'encrypted-file', vaultFile: join(tmpDir, 'vault.enc') });
        await v.set('test-key', 'secret');
        expect(await v.get('test-key')).toBe('secret');
        await v.delete('test-key');
        expect(await v.get('test-key')).toBeNull();
    });

    it('getSync returns cached value after set', async () => {
        await v.init({ backend: 'encrypted-file', vaultFile: join(tmpDir, 'vault.enc') });
        await v.set('cached-key', 'cached-value');
        expect(v.getSync('cached-key')).toBe('cached-value');
    });

    it('resolveSync resolves vault references after init and set', async () => {
        await v.init({ backend: 'encrypted-file', vaultFile: join(tmpDir, 'vault.enc') });
        await v.set('discord-token', 'MTIzNDU2');
        expect(v.resolveSync(`${VAULT_REF_PREFIX}discord-token`)).toBe('MTIzNDU2');
    });

    it('resolveSync passes through plain values unchanged', async () => {
        await v.init({ backend: 'encrypted-file', vaultFile: join(tmpDir, 'vault.enc') });
        expect(v.resolveSync('plain-value')).toBe('plain-value');
    });

    it('list returns keys after set', async () => {
        await v.init({ backend: 'encrypted-file', vaultFile: join(tmpDir, 'vault.enc') });
        await v.set('a', '1');
        await v.set('b', '2');
        const keys = await v.list();
        expect(keys).toContain('a');
        expect(keys).toContain('b');
    });

    it('throws if get is called before init', async () => {
        await expect(v.get('key')).rejects.toThrow('not been initialized');
    });
});
