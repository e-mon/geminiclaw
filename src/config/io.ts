/**
 * config/io.ts — Config file loading and saving.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vault } from '../vault/index.js';
import { CONFIG_PATH, getWorkspacePath } from './paths.js';
import { type Config, ConfigSchema, WORKSPACE_CONFIG_FILENAME, WorkspaceConfigSchema } from './schema.js';

/**
 * Load config from disk, or return defaults.
 *
 * Merge order (later overrides earlier):
 *   1. Defaults (from Zod schema)
 *   2. ~/.geminiclaw/config.json  — user config (secrets live here as $vault: refs or plaintext)
 *   3. {workspace}/config.json    — agent-writable behavioral overrides
 *   4. Vault secrets              — resolved from vault if value starts with "$vault:"
 *   5. Environment variables      — for secrets not in file or vault
 *
 * Environment variable fallbacks:
 *   DISCORD_TOKEN or DISCORD_API_KEY → channels.discord.token
 *   SLACK_BOT_TOKEN                  → channels.slack.token
 *   SLACK_SIGNING_SECRET             → channels.slack.signingSecret
 *
 * Legacy migration (pre-Zod parse):
 *   - Old `notifications: { enabled, method }` → stripped (new format: `{ channel, channelId }`)
 *   - Old `channels.*.homeChannel` → `home: { channel, channelId }`
 *   - Old `heartbeat.notifications.*.{ enabled, channelId }` → `notifications: { channel, channelId }`
 *
 * Vault usage: call `await vault.init()` before `loadConfig()` to enable resolution.
 * If vault is not initialized, $vault: references are left as-is (undefined after parse).
 */
export function loadConfig(configPath: string = CONFIG_PATH): Config {
    let json: unknown = {};
    if (existsSync(configPath)) {
        try {
            json = JSON.parse(readFileSync(configPath, 'utf-8'));
        } catch (err) {
            process.stderr.write(`[geminiclaw] warning: failed to parse ${configPath}: ${String(err)}\n`);
        }
    }

    // Migrate legacy config formats before Zod parse.
    // If any migration fires, the updated JSON is written back to disk
    // so old keys are cleaned up permanently.
    if (typeof json === 'object' && json !== null) {
        const obj = json as Record<string, unknown>;
        if (migrateLegacyConfig(obj)) {
            try {
                writeFileSync(configPath, `${JSON.stringify(obj, null, 2)}\n`, {
                    encoding: 'utf-8',
                    mode: 0o600,
                });
            } catch (err) {
                process.stderr.write(`[geminiclaw] warning: failed to write migrated config: ${String(err)}\n`);
            }
        }
    }

    // Track which keys the user explicitly set in their config file.
    // Workspace overrides should not clobber user-explicit values.
    const userExplicitKeys = new Set(typeof json === 'object' && json !== null ? Object.keys(json) : []);

    const config = ConfigSchema.parse(json);

    // Apply workspace config overrides — agent can self-modify these fields.
    // Only override fields that the user did NOT explicitly set in their config.
    const workspacePath = getWorkspacePath(config);
    const wsConfigPath = join(workspacePath, WORKSPACE_CONFIG_FILENAME);
    if (existsSync(wsConfigPath)) {
        try {
            const wsJson = JSON.parse(readFileSync(wsConfigPath, 'utf-8'));
            const ws = WorkspaceConfigSchema.parse(wsJson);
            if (ws.autonomyLevel !== undefined && !userExplicitKeys.has('autonomyLevel'))
                config.autonomyLevel = ws.autonomyLevel;
            if (ws.heartbeatIntervalMin !== undefined && !userExplicitKeys.has('heartbeatIntervalMin'))
                config.heartbeatIntervalMin = ws.heartbeatIntervalMin;
            if (ws.maxToolIterations !== undefined && !userExplicitKeys.has('maxToolIterations'))
                config.maxToolIterations = ws.maxToolIterations;
            if (ws.sessionIdleMinutes !== undefined && !userExplicitKeys.has('sessionIdleMinutes'))
                config.sessionIdleMinutes = ws.sessionIdleMinutes;
            if (ws.discord?.respondInChannels !== undefined) {
                config.channels.discord.respondInChannels = ws.discord.respondInChannels;
            }
            if (ws.slack?.respondInChannels !== undefined) {
                config.channels.slack.respondInChannels = ws.slack.respondInChannels;
            }
            if (ws.telegram?.respondInChannels !== undefined) {
                config.channels.telegram.respondInChannels = ws.telegram.respondInChannels;
            }
        } catch (err) {
            process.stderr.write(
                `[geminiclaw] warning: failed to parse workspace config ${wsConfigPath}: ${String(err)}\n`,
            );
        }
    }

    // Merge home channel into its platform's respondInChannels (deduplicated)
    if (config.home) {
        const { channel, channelId } = config.home;
        const platformConfig = config.channels[channel];
        if (platformConfig && !platformConfig.respondInChannels.includes(channelId)) {
            platformConfig.respondInChannels = [channelId, ...platformConfig.respondInChannels];
        }
    }

    // Resolve $vault: references — requires vault.init() to have been called first.
    // If the vault is not initialized, resolveSync() is a no-op and returns the raw value.
    config.channels.discord.token = vault.resolveSync(config.channels.discord.token);
    config.channels.telegram.botToken = vault.resolveSync(config.channels.telegram.botToken);
    config.channels.slack.token = vault.resolveSync(config.channels.slack.token);
    config.channels.slack.signingSecret = vault.resolveSync(config.channels.slack.signingSecret);

    // Resolve $vault: references in sandboxEnv
    for (const key of Object.keys(config.sandboxEnv)) {
        const resolved = vault.resolveSync(config.sandboxEnv[key]);
        if (resolved !== undefined) {
            config.sandboxEnv[key] = resolved;
        } else {
            // Vault key not found — remove to avoid leaking the $vault: ref into the container
            delete config.sandboxEnv[key];
        }
    }
    // GEMINICLAW_MODEL env var overrides config.model (useful for Procfile/overmind)
    const envModel = process.env.GEMINICLAW_MODEL;
    if (envModel) {
        config.model = envModel;
    }

    // Apply env var fallbacks — env takes precedence only when token is absent from file and vault
    const discordToken = process.env.DISCORD_TOKEN ?? process.env.DISCORD_API_KEY;
    if (discordToken && !config.channels.discord.token) {
        config.channels.discord.token = discordToken;
    }

    const slackToken = process.env.SLACK_BOT_TOKEN;
    if (slackToken && !config.channels.slack.token) {
        config.channels.slack.token = slackToken;
    }

    const slackSecret = process.env.SLACK_SIGNING_SECRET;
    if (slackSecret && !config.channels.slack.signingSecret) {
        config.channels.slack.signingSecret = slackSecret;
    }

    return config;
}

/**
 * Migrate legacy config formats in-place.
 *
 * Returns true if any migration was applied (caller should persist to disk).
 *
 * Migrations:
 *   1. Old `notifications: { enabled, method }` → deleted (new: `{ channel, channelId }`)
 *   2. `channels.*.homeChannel` → `home: { channel, channelId }`, old key deleted
 *   3. `heartbeat.notifications.*.{ enabled, channelId }` → `notifications`, old key deleted
 */
function migrateLegacyConfig(obj: Record<string, unknown>): boolean {
    let migrated = false;

    // 1. Strip legacy top-level `notifications` (old format: { enabled, method })
    const notif = obj.notifications;
    if (notif && typeof notif === 'object' && notif !== null && !('channel' in notif)) {
        delete obj.notifications;
        migrated = true;
    }

    // 2. Migrate legacy per-platform homeChannel → top-level `home`
    if (!obj.home) {
        const channels = obj.channels as Record<string, Record<string, unknown>> | undefined;
        if (channels) {
            for (const platform of ['discord', 'slack', 'telegram'] as const) {
                const ch = channels[platform];
                if (ch?.enabled && typeof ch.homeChannel === 'string' && ch.homeChannel) {
                    obj.home = { channel: platform, channelId: ch.homeChannel };
                    migrated = true;
                    break;
                }
            }
        }
    }

    // Clean up homeChannel keys from all platforms regardless of which was picked
    const channels = obj.channels as Record<string, Record<string, unknown>> | undefined;
    if (channels) {
        for (const platform of ['discord', 'slack', 'telegram']) {
            if (channels[platform] && 'homeChannel' in channels[platform]) {
                delete channels[platform].homeChannel;
                migrated = true;
            }
        }
    }

    // 3. Migrate legacy heartbeat.notifications → top-level `notifications`
    const hb = obj.heartbeat as Record<string, unknown> | undefined;
    const hbNotif = hb?.notifications as Record<string, Record<string, unknown>> | undefined;
    if (hbNotif) {
        if (!obj.notifications) {
            for (const platform of ['discord', 'slack', 'telegram'] as const) {
                const ch = hbNotif[platform];
                if (ch?.enabled && typeof ch.channelId === 'string' && ch.channelId) {
                    obj.notifications = { channel: platform, channelId: ch.channelId };
                    break;
                }
            }
        }
        delete hb?.notifications;
        migrated = true;
    }

    return migrated;
}

/**
 * Recursively merge source into target, preserving existing nested keys.
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
    for (const key of Object.keys(source)) {
        const sv = source[key];
        const tv = target[key];
        if (isPlainObject(sv) && isPlainObject(tv)) {
            deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
        } else {
            target[key] = sv;
        }
    }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Patch specific fields in config.json without loading the full Config object.
 *
 * This avoids the saveConfig(loadConfig()) anti-pattern where vault-resolved
 * secrets get written back to disk in plaintext. Only the raw JSON is read
 * and the specified fields are merged in.
 */
export function patchConfigFile(patch: Record<string, unknown>, configPath: string = CONFIG_PATH): void {
    const dir = join(configPath, '..');
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    let raw: Record<string, unknown> = {};
    if (existsSync(configPath)) {
        try {
            raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        } catch {
            raw = {};
        }
    }

    deepMerge(raw, patch);
    writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
}
