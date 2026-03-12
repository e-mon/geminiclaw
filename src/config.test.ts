/**
 * config.test.ts — Tests for configuration management.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema, loadConfig, patchConfigFile, WORKSPACE_CONFIG_FILENAME } from './config.js';
import { Vault } from './vault/index.js';
import { VAULT_REF_PREFIX } from './vault/types.js';

describe('ConfigSchema', () => {
    it('provides sensible defaults', () => {
        const config = ConfigSchema.parse({});
        expect(config.model).toBe('auto');
        expect(config.sandbox).toBe(true);
        expect(config.heartbeatIntervalMin).toBe(30);
        expect(config.channels.discord.enabled).toBe(false);
        expect(config.channels.slack.enabled).toBe(false);
        expect(config.heartbeat.desktop).toBe(true);
    });

    it('overrides defaults with provided values', () => {
        const config = ConfigSchema.parse({
            model: 'gemini-2.5-pro',
            sandbox: false,
            heartbeatIntervalMin: 15,
        });
        expect(config.model).toBe('gemini-2.5-pro');
        expect(config.sandbox).toBe(false);
        expect(config.heartbeatIntervalMin).toBe(15);
    });

    it('accepts sandbox string modes', () => {
        expect(ConfigSchema.parse({ sandbox: 'seatbelt' }).sandbox).toBe('seatbelt');
        expect(ConfigSchema.parse({ sandbox: 'docker' }).sandbox).toBe('docker');
        expect(ConfigSchema.parse({ sandbox: true }).sandbox).toBe(true);
        expect(ConfigSchema.parse({ sandbox: false }).sandbox).toBe(false);
    });

    it('rejects invalid sandbox string', () => {
        expect(() => ConfigSchema.parse({ sandbox: 'podman' })).toThrow();
    });

    it('rejects invalid heartbeat interval', () => {
        expect(() => ConfigSchema.parse({ heartbeatIntervalMin: 0 })).toThrow();
        expect(() => ConfigSchema.parse({ heartbeatIntervalMin: -1 })).toThrow();
    });
});

describe('loadConfig / patchConfigFile', () => {
    let tmpDir: string;
    let configPath: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'geminiclaw-test-'));
        configPath = join(tmpDir, 'config.json');
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns defaults when file does not exist', () => {
        const config = loadConfig(configPath);
        expect(config.model).toBe('auto');
    });

    it('loads config from file', () => {
        // Set workspace to tmpDir so loadConfig doesn't pick up the real workspace config
        writeFileSync(configPath, JSON.stringify({ model: 'gemini-2.5-pro', sandbox: false, workspace: tmpDir }));
        const config = loadConfig(configPath);
        expect(config.model).toBe('gemini-2.5-pro');
        expect(config.sandbox).toBe(false);
    });

    it('returns defaults for invalid JSON', () => {
        writeFileSync(configPath, 'not valid json');
        const config = loadConfig(configPath);
        expect(config.model).toBe('auto');
    });

    it('patches and loads round-trip', () => {
        patchConfigFile(
            {
                model: 'gemini-2.5-pro',
                heartbeatIntervalMin: 10,
                workspace: tmpDir,
            },
            configPath,
        );

        const loaded = loadConfig(configPath);
        expect(loaded.model).toBe('gemini-2.5-pro');
        expect(loaded.heartbeatIntervalMin).toBe(10);
    });

    it('deep merges nested keys without clobbering siblings', () => {
        // Set up initial config with discord token
        patchConfigFile({ channels: { discord: { token: 'my-token', enabled: true } } }, configPath);
        // Patch home — should NOT erase channels.discord.token/enabled
        patchConfigFile({ home: { channel: 'discord', channelId: '123456' } }, configPath);

        const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
        expect(raw.channels.discord.token).toBe('my-token');
        expect(raw.channels.discord.enabled).toBe(true);
        expect(raw.home.channel).toBe('discord');
        expect(raw.home.channelId).toBe('123456');
    });

    it('creates directory when patching', () => {
        const deepPath = join(tmpDir, 'sub', 'dir', 'config.json');
        patchConfigFile({ model: 'auto' }, deepPath);

        const raw = readFileSync(deepPath, 'utf-8');
        expect(JSON.parse(raw).model).toBe('auto');
    });

    it('applies workspace config overrides', () => {
        // Use a subdirectory as workspace so config paths don't collide
        const wsDir = join(tmpDir, 'workspace');
        mkdirSync(wsDir, { recursive: true });

        // Global config with workspace pointing to wsDir
        writeFileSync(configPath, JSON.stringify({ workspace: wsDir }));

        // Workspace config with overrides (model is NOT overridable from workspace)
        writeFileSync(
            join(wsDir, WORKSPACE_CONFIG_FILENAME),
            JSON.stringify({
                maxToolIterations: 30,
                autonomyLevel: 'supervised',
            }),
        );

        const config = loadConfig(configPath);
        expect(config.model).toBe('auto'); // workspace cannot override model
        expect(config.maxToolIterations).toBe(30);
        expect(config.autonomyLevel).toBe('supervised');
    });

    it('ignores invalid workspace config', () => {
        const wsDir = join(tmpDir, 'workspace');
        mkdirSync(wsDir, { recursive: true });
        writeFileSync(configPath, JSON.stringify({ workspace: wsDir }));
        writeFileSync(join(wsDir, WORKSPACE_CONFIG_FILENAME), 'not json');

        const config = loadConfig(configPath);
        expect(config.model).toBe('auto'); // default, not overridden
    });

    it('applies env var fallbacks for discord token', () => {
        const original = process.env.DISCORD_TOKEN;
        try {
            process.env.DISCORD_TOKEN = 'test-token-123';
            const config = loadConfig(configPath);
            expect(config.channels.discord.token).toBe('test-token-123');
        } finally {
            if (original !== undefined) {
                process.env.DISCORD_TOKEN = original;
            } else {
                delete process.env.DISCORD_TOKEN;
            }
        }
    });

    it('does not override file-defined token with env var', () => {
        writeFileSync(configPath, JSON.stringify({ channels: { discord: { token: 'file-token' } } }));

        const original = process.env.DISCORD_TOKEN;
        try {
            process.env.DISCORD_TOKEN = 'env-token';
            const config = loadConfig(configPath);
            expect(config.channels.discord.token).toBe('file-token');
        } finally {
            if (original !== undefined) {
                process.env.DISCORD_TOKEN = original;
            } else {
                delete process.env.DISCORD_TOKEN;
            }
        }
    });

    it('applies env var fallbacks for slack token and signingSecret', () => {
        const origToken = process.env.SLACK_BOT_TOKEN;
        const origSecret = process.env.SLACK_SIGNING_SECRET;
        try {
            process.env.SLACK_BOT_TOKEN = 'xoxb-test-slack';
            process.env.SLACK_SIGNING_SECRET = 'signing-secret-123';
            const config = loadConfig(configPath);
            expect(config.channels.slack.token).toBe('xoxb-test-slack');
            expect(config.channels.slack.signingSecret).toBe('signing-secret-123');
        } finally {
            if (origToken !== undefined) process.env.SLACK_BOT_TOKEN = origToken;
            else delete process.env.SLACK_BOT_TOKEN;
            if (origSecret !== undefined) process.env.SLACK_SIGNING_SECRET = origSecret;
            else delete process.env.SLACK_SIGNING_SECRET;
        }
    });

    it('does not override file-defined slack token with env var', () => {
        writeFileSync(
            configPath,
            JSON.stringify({
                channels: { slack: { token: 'file-slack-token', signingSecret: 'file-secret' } },
            }),
        );
        const origToken = process.env.SLACK_BOT_TOKEN;
        const origSecret = process.env.SLACK_SIGNING_SECRET;
        try {
            process.env.SLACK_BOT_TOKEN = 'env-slack-token';
            process.env.SLACK_SIGNING_SECRET = 'env-secret';
            const config = loadConfig(configPath);
            expect(config.channels.slack.token).toBe('file-slack-token');
            expect(config.channels.slack.signingSecret).toBe('file-secret');
        } finally {
            if (origToken !== undefined) process.env.SLACK_BOT_TOKEN = origToken;
            else delete process.env.SLACK_BOT_TOKEN;
            if (origSecret !== undefined) process.env.SLACK_SIGNING_SECRET = origSecret;
            else delete process.env.SLACK_SIGNING_SECRET;
        }
    });

    it('applies DISCORD_API_KEY as fallback when DISCORD_TOKEN is absent', () => {
        const origToken = process.env.DISCORD_TOKEN;
        const origApiKey = process.env.DISCORD_API_KEY;
        try {
            delete process.env.DISCORD_TOKEN;
            process.env.DISCORD_API_KEY = 'api-key-fallback';
            const config = loadConfig(configPath);
            expect(config.channels.discord.token).toBe('api-key-fallback');
        } finally {
            if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
            else delete process.env.DISCORD_TOKEN;
            if (origApiKey !== undefined) process.env.DISCORD_API_KEY = origApiKey;
            else delete process.env.DISCORD_API_KEY;
        }
    });
});

describe('loadConfig with vault resolution (integration)', () => {
    let tmpDir: string;
    let configPath: string;
    let testVault: Vault;

    beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'geminiclaw-vault-cfg-'));
        configPath = join(tmpDir, 'config.json');

        // Create a test vault and seed it with secrets
        testVault = new Vault();
        await testVault.init({ backend: 'encrypted-file', vaultFile: join(tmpDir, 'vault.enc') });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Mock the global vault singleton used by loadConfig()'s io.ts.
     * We replace vault.resolveSync to delegate to our test vault.
     */
    async function mockGlobalVault(): Promise<void> {
        const vaultModule = await import('./vault/index.js');
        vi.spyOn(vaultModule.vault, 'resolveSync').mockImplementation((value: string | undefined) =>
            testVault.resolveSync(value),
        );
    }

    it('resolves $vault: discord token through loadConfig()', async () => {
        await testVault.set('discord-token', 'MTIzNDU2Nzg5');
        writeFileSync(
            configPath,
            JSON.stringify({
                channels: { discord: { token: `${VAULT_REF_PREFIX}discord-token` } },
            }),
        );
        await mockGlobalVault();
        const config = loadConfig(configPath);
        expect(config.channels.discord.token).toBe('MTIzNDU2Nzg5');
    });

    it('resolves $vault: slack token through loadConfig()', async () => {
        await testVault.set('slack-bot-token', 'xoxb-vault-slack');
        writeFileSync(
            configPath,
            JSON.stringify({
                channels: { slack: { token: `${VAULT_REF_PREFIX}slack-bot-token` } },
            }),
        );
        await mockGlobalVault();
        const config = loadConfig(configPath);
        expect(config.channels.slack.token).toBe('xoxb-vault-slack');
    });

    it('resolves $vault: slack signingSecret through loadConfig()', async () => {
        await testVault.set('slack-signing-secret', 'v0=abc123');
        writeFileSync(
            configPath,
            JSON.stringify({
                channels: { slack: { signingSecret: `${VAULT_REF_PREFIX}slack-signing-secret` } },
            }),
        );
        await mockGlobalVault();
        const config = loadConfig(configPath);
        expect(config.channels.slack.signingSecret).toBe('v0=abc123');
    });

    it('vault-resolved token takes precedence over env var fallback', async () => {
        await testVault.set('discord-token', 'vault-resolved');
        writeFileSync(
            configPath,
            JSON.stringify({
                channels: { discord: { token: `${VAULT_REF_PREFIX}discord-token` } },
            }),
        );
        await mockGlobalVault();

        const origEnv = process.env.DISCORD_TOKEN;
        try {
            process.env.DISCORD_TOKEN = 'env-should-not-win';
            const config = loadConfig(configPath);
            // Vault-resolved value wins — env fallback only applies when token is empty
            expect(config.channels.discord.token).toBe('vault-resolved');
        } finally {
            if (origEnv !== undefined) process.env.DISCORD_TOKEN = origEnv;
            else delete process.env.DISCORD_TOKEN;
        }
    });

    it('falls back to env var when vault key is missing', async () => {
        // $vault: ref for a key not stored in vault → resolves to undefined → env fallback kicks in
        writeFileSync(
            configPath,
            JSON.stringify({
                channels: { discord: { token: `${VAULT_REF_PREFIX}missing-key` } },
            }),
        );
        await mockGlobalVault();

        const origEnv = process.env.DISCORD_TOKEN;
        try {
            process.env.DISCORD_TOKEN = 'env-fallback-value';
            const config = loadConfig(configPath);
            expect(config.channels.discord.token).toBe('env-fallback-value');
        } finally {
            if (origEnv !== undefined) process.env.DISCORD_TOKEN = origEnv;
            else delete process.env.DISCORD_TOKEN;
        }
    });

    it('$vault: ref does not leak raw reference string into config', async () => {
        // Key not in vault, no env fallback — should be empty, never the "$vault:..." string
        writeFileSync(
            configPath,
            JSON.stringify({
                channels: { discord: { token: `${VAULT_REF_PREFIX}nonexistent` } },
            }),
        );
        await mockGlobalVault();

        const origEnv = process.env.DISCORD_TOKEN;
        try {
            delete process.env.DISCORD_TOKEN;
            delete process.env.DISCORD_API_KEY;
            const config = loadConfig(configPath);
            // Should be undefined or empty, never the raw "$vault:..." string
            expect(config.channels.discord.token).toBeFalsy();
            if (config.channels.discord.token) {
                expect(config.channels.discord.token).not.toContain(VAULT_REF_PREFIX);
            }
        } finally {
            if (origEnv !== undefined) process.env.DISCORD_TOKEN = origEnv;
            else delete process.env.DISCORD_TOKEN;
        }
    });

    it('plain (non-vault) tokens pass through loadConfig unchanged', async () => {
        writeFileSync(
            configPath,
            JSON.stringify({
                channels: {
                    discord: { token: 'MTIzNDU2Nzg5.plain' },
                    slack: { token: 'xoxb-plain', signingSecret: 'plain-secret' },
                },
            }),
        );
        await mockGlobalVault();
        const config = loadConfig(configPath);
        expect(config.channels.discord.token).toBe('MTIzNDU2Nzg5.plain');
        expect(config.channels.slack.token).toBe('xoxb-plain');
        expect(config.channels.slack.signingSecret).toBe('plain-secret');
    });
});
