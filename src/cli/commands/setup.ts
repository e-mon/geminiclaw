/**
 * cli/commands/setup.ts — Interactive CLI wizard using @clack/prompts.
 *
 * Secrets are collected via masked prompts and stored in the vault.
 * SOUL.md generation is delegated to the bootstrap flow (first agent conversation).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import type { Command } from 'commander';
import {
    type ChannelEntry,
    fetchDiscordChannels,
    fetchSlackChannels,
    fetchTelegramChats,
    pollForTelegramChat,
} from '../../channels/list-channels.js';
import { CONFIG_PATH, type Config, getGeminiBin, getWorkspacePath, loadConfig, patchConfigFile } from '../../config.js';
import { vault } from '../../vault/index.js';
import { VAULT_REF_PREFIX } from '../../vault/types.js';
import { initializeWorkspace } from './init.js';

/** Guard: if user pressed Ctrl-C, exit cleanly. */
function exitIfCancelled<T>(value: T | symbol): asserts value is T {
    if (p.isCancel(value)) {
        p.cancel('Setup cancelled.');
        process.exit(0);
    }
}

/**
 * Store a secret in the vault and write a `$vault:` reference to config.json.
 * Returns true if a secret was actually stored.
 */
async function storeSecretInVault(
    raw: Record<string, unknown>,
    configDotPath: string,
    vaultKey: string,
): Promise<boolean> {
    const parts = configDotPath.split('.');
    let current: Record<string, unknown> = raw;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i] as string;
        if (typeof current[part] !== 'object' || current[part] === null) {
            current[part] = {};
        }
        current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1] as string] = `${VAULT_REF_PREFIX}${vaultKey}`;
    return true;
}

/* ------------------------------------------------------------------ */
/*  Step: Language preference                                         */
/* ------------------------------------------------------------------ */

async function stepLanguage(): Promise<void> {
    const lang = await p.select({
        message: 'Preferred language for agent responses?',
        options: [
            { value: 'en', label: 'English' },
            { value: 'ja', label: 'Japanese' },
            { value: 'zh', label: 'Chinese' },
            { value: 'ko', label: 'Korean' },
        ],
    });
    exitIfCancelled(lang);

    patchConfigFile({ language: lang });
    p.log.success(`Language: ${lang}`);
}

/* ------------------------------------------------------------------ */
/*  Connection tests                                                  */
/* ------------------------------------------------------------------ */

type ConnectionTestResult = { ok: true; message: string } | { ok: false; error: string };

async function testDiscordToken(token: string): Promise<ConnectionTestResult> {
    try {
        const resp = await fetch('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: `Bot ${token}` },
        });
        if (!resp.ok) return { ok: false, error: `Discord API ${resp.status}: unauthorized` };
        const data = (await resp.json()) as { username?: string; id?: string };
        return { ok: true, message: `Connected as ${data.username} (${data.id})` };
    } catch (err) {
        return { ok: false, error: `Connection failed: ${err instanceof Error ? err.message : String(err)}` };
    }
}

async function testSlackToken(token: string): Promise<ConnectionTestResult> {
    try {
        const resp = await fetch('https://slack.com/api/auth.test', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) return { ok: false, error: `Slack API HTTP ${resp.status}` };
        const data = (await resp.json()) as { ok: boolean; error?: string; user?: string; team?: string };
        if (!data.ok) return { ok: false, error: `Slack auth failed: ${data.error ?? 'unknown'}` };
        return { ok: true, message: `Connected as ${data.user} in ${data.team}` };
    } catch (err) {
        return { ok: false, error: `Connection failed: ${err instanceof Error ? err.message : String(err)}` };
    }
}

async function testTelegramToken(token: string): Promise<ConnectionTestResult> {
    try {
        const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
        if (!resp.ok) return { ok: false, error: `Telegram API ${resp.status}: unauthorized` };
        const data = (await resp.json()) as {
            ok: boolean;
            description?: string;
            result?: { username?: string; first_name?: string };
        };
        if (!data.ok) return { ok: false, error: `Telegram auth failed: ${data.description ?? 'unknown'}` };
        const name = data.result?.username ?? data.result?.first_name ?? 'unknown';
        return { ok: true, message: `Connected as @${name}` };
    } catch (err) {
        // Sanitize: Telegram embeds the token in the URL path
        const msg = err instanceof Error ? err.message.replace(/bot[^/]+\//g, 'bot[REDACTED]/') : String(err);
        return { ok: false, error: `Connection failed: ${msg}` };
    }
}

/**
 * Run a connection test with a spinner. Returns the success message or null on failure.
 */
async function runConnectionTest(
    testFn: (token: string) => Promise<ConnectionTestResult>,
    token: string,
    platform: string,
): Promise<string | null> {
    const s = p.spinner();
    s.start(`Testing ${platform} connection...`);
    const result = await testFn(token);
    if (!result.ok) {
        s.stop(`${platform}: ${result.error}`);
        return null;
    }
    s.stop(result.message);
    return result.message;
}

interface TokenPromptConfig {
    message: string;
    validate?: (v: string | undefined) => string | undefined;
}

/**
 * Prompt for a token, test the connection, and retry on failure.
 * Returns the validated token, or empty string if skipped.
 */
async function collectAndTestToken(
    prompt: TokenPromptConfig,
    testFn: (token: string) => Promise<ConnectionTestResult>,
    platform: string,
): Promise<string> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const token = await p.password({
            message: prompt.message,
            mask: '*',
            validate: prompt.validate,
        });
        exitIfCancelled(token);

        if (!token) return '';

        const ok = await runConnectionTest(testFn, token, platform);
        if (ok) return token;

        const action = await p.select({
            message: `${platform} connection test failed. What would you like to do?`,
            options: [
                { value: 'retry', label: 'Re-enter token' },
                { value: 'skip', label: 'Skip', hint: 'Save current token anyway' },
            ],
        });
        exitIfCancelled(action);

        if (action === 'skip') return token;
        // action === 'retry' → loop continues
    }
}

/* ------------------------------------------------------------------ */
/*  Step: Discord config                                              */
/* ------------------------------------------------------------------ */

async function stepDiscord(): Promise<boolean> {
    const enable = await p.confirm({
        message: 'Enable Discord integration?',
        initialValue: false,
    });
    exitIfCancelled(enable);
    if (!enable) return false;

    p.note(
        [
            '1. Create a Bot at https://discord.com/developers/applications',
            '2. Copy the Bot Token',
            '3. Enable Privileged Gateway Intents:',
            '   - MESSAGE CONTENT INTENT',
            '   - SERVER MEMBERS INTENT',
            '   - PRESENCE INTENT (optional)',
            '4. In OAuth2 URL Generator, select bot + applications.commands scope',
            '   Bot Permissions: Send Messages, Read Message History,',
            '   Add Reactions, Attach Files, Use Slash Commands',
        ].join('\n'),
        'Discord Bot Setup',
    );

    const token = await collectAndTestToken({ message: 'Discord Bot Token' }, testDiscordToken, 'Discord');

    if (token) {
        await vault.set('discord-token', token);
        patchConfigFile({
            channels: { discord: { enabled: true, token: `${VAULT_REF_PREFIX}discord-token` } },
        });
        p.log.success('Discord: enabled, token saved to vault.');
    } else {
        patchConfigFile({ channels: { discord: { enabled: true } } });
        p.log.warn('Discord: enabled without token. Run `geminiclaw setup --step discord` to add it later.');
    }
    return true;
}

/** Parse a "platform:channelId" value, splitting only on the first colon. */
function parseHomeValue(value: string): { channel: string; channelId: string } {
    const idx = value.indexOf(':');
    if (idx === -1) throw new Error(`Invalid channel value (expected "platform:id"): ${value}`);
    return { channel: value.slice(0, idx), channelId: value.slice(idx + 1) };
}

interface EnabledAdapters {
    discord?: boolean;
    slack?: boolean;
    telegram?: boolean;
}

/**
 * Unified home channel selection. The home channel is the agent's primary
 * destination for bootstrap greetings, heartbeat results, and cron fallback.
 * Home is mandatory — if only one channel is available, it is auto-selected.
 *
 * When called from the full wizard, `enabled` restricts channel loading to
 * only the adapters the user enabled in this session. When called standalone
 * (`--step home`), all enabled adapters with tokens are loaded.
 */
async function stepHome(enabled?: EnabledAdapters): Promise<void> {
    const config = loadConfig();

    interface HomeOption {
        value: string;
        label: string;
        hint?: string;
    }
    const allOptions: HomeOption[] = [];

    const shouldLoad = (adapter: keyof EnabledAdapters, configEnabled: boolean): boolean =>
        enabled ? !!enabled[adapter] && configEnabled : configEnabled;

    // --- Discord ---
    if (shouldLoad('discord', config.channels.discord.enabled) && config.channels.discord.token) {
        const s = p.spinner();
        s.start('Fetching Discord channels...');
        const channels = await fetchDiscordChannels(config.channels.discord.token);
        s.stop('Discord channels loaded.');
        for (const ch of channels) {
            allOptions.push({
                value: `discord:${ch.id}`,
                label: `Discord #${ch.name}`,
                hint: ch.group,
            });
        }
    }

    // --- Slack ---
    if (shouldLoad('slack', config.channels.slack.enabled) && config.channels.slack.token) {
        const s = p.spinner();
        s.start('Fetching Slack channels...');
        const channels = await fetchSlackChannels(config.channels.slack.token);
        s.stop('Slack channels loaded.');
        for (const ch of channels) {
            allOptions.push({
                value: `slack:${ch.id}`,
                label: `Slack #${ch.name}`,
            });
        }
    }

    // --- Telegram ---
    if (shouldLoad('telegram', config.channels.telegram.enabled) && config.channels.telegram.botToken) {
        const s = p.spinner();
        s.start('Fetching Telegram chats...');
        const chats = await fetchTelegramChats(config.channels.telegram.botToken);

        if (chats.length === 0) {
            s.stop('No Telegram chats found.');

            // Polling loop with retry/abort
            let discovered = false;
            while (!discovered) {
                p.note(
                    'Send a message to your bot in Telegram, then wait for auto-detection.',
                    'Telegram Chat Discovery',
                );
                const s2 = p.spinner();
                s2.start('Waiting for Telegram message... (2 min timeout)');
                const chat = await pollForTelegramChat(config.channels.telegram.botToken, 120_000);
                if (chat) {
                    s2.stop('Telegram chat discovered!');
                    allOptions.push({
                        value: `telegram:${chat.id}`,
                        label: `Telegram ${chat.name}`,
                        hint: chat.group,
                    });
                    discovered = true;
                } else {
                    s2.stop('No message received.');
                    const action = await p.select({
                        message: 'Telegram chat not detected. What would you like to do?',
                        options: [
                            { value: 'retry', label: 'Retry', hint: 'Wait another 2 minutes' },
                            { value: 'manual', label: 'Enter chat ID manually' },
                            { value: 'skip', label: 'Skip', hint: 'Use another channel as home' },
                        ],
                    });
                    exitIfCancelled(action);

                    if (action === 'skip') {
                        discovered = true;
                    } else if (action === 'manual') {
                        const manual = await p.text({
                            message: 'Telegram chat ID (e.g. -1001234567890)',
                            placeholder: '-1001234567890',
                            validate: (v) => {
                                if (!v) return 'Chat ID is required';
                                if (!/^-?\d+$/.test(v)) return 'Chat ID must be a number (e.g. -1001234567890)';
                                return undefined;
                            },
                        });
                        exitIfCancelled(manual);
                        allOptions.push({
                            value: `telegram:${manual}`,
                            label: `Telegram ${manual}`,
                        });
                        discovered = true;
                    }
                    // action === 'retry' → loop continues
                }
            }
        } else {
            s.stop('Telegram chats loaded.');
            for (const ch of chats) {
                allOptions.push({
                    value: `telegram:${ch.id}`,
                    label: `Telegram ${ch.name}`,
                    hint: ch.group,
                });
            }
        }
    }

    // --- Selection ---
    if (allOptions.length === 0) {
        p.log.warn('No channels available. Enable a channel first, then run: geminiclaw setup --step home');
        return;
    }

    if (allOptions.length === 1) {
        const only = allOptions[0] as HomeOption;
        const { channel, channelId } = parseHomeValue(only.value);
        patchConfigFile({ home: { channel, channelId } });
        p.log.success(`Home → ${only.label} (auto-selected)`);
        return;
    }

    const selected = await p.select({
        message: 'Which channel should the agent call home?',
        options: allOptions,
    });
    exitIfCancelled(selected);

    const { channel, channelId } = parseHomeValue(selected as string);
    patchConfigFile({ home: { channel, channelId } });
    const label = allOptions.find((o) => o.value === selected);
    p.log.success(`Home → ${label?.label ?? selected}`);
}

/* ------------------------------------------------------------------ */
/*  Step: Slack config                                                */
/* ------------------------------------------------------------------ */

async function stepSlack(): Promise<boolean> {
    const enable = await p.confirm({
        message: 'Enable Slack integration?',
        initialValue: false,
    });
    exitIfCancelled(enable);
    if (!enable) return false;

    p.note(
        [
            '1. Create an App at https://api.slack.com/apps',
            '2. Copy the Bot Token (xoxb-...) and Signing Secret',
            '3. Enable Event Subscriptions and subscribe to:',
            '   app_mention, message.channels, message.groups, message.im',
            '4. Add Bot Token Scopes under OAuth & Permissions:',
            '   chat:write, channels:history, channels:read, reactions:write,',
            '   app_mentions:read, im:history, files:read, files:write',
            '',
            'Full guide: https://docs.openclaw.ai/channels/slack',
        ].join('\n'),
        'Slack App Setup',
    );

    const token = await collectAndTestToken(
        {
            message: 'Slack Bot Token (xoxb-...)',
            validate: (v) => {
                if (!v) return undefined;
                return v.startsWith('xoxb-') ? undefined : 'Token must start with xoxb-';
            },
        },
        testSlackToken,
        'Slack',
    );

    if (!token) {
        patchConfigFile({ channels: { slack: { enabled: true } } });
        p.log.warn('Slack: enabled without credentials. Run `geminiclaw setup --step slack` to add them later.');
        return true;
    }

    const signingSecret = await p.password({
        message: 'Slack Signing Secret',
        mask: '*',
    });
    exitIfCancelled(signingSecret);

    await vault.set('slack-bot-token', token);
    const patch: Record<string, unknown> = { enabled: true, token: `${VAULT_REF_PREFIX}slack-bot-token` };

    if (signingSecret) {
        await vault.set('slack-signing-secret', signingSecret);
        patch.signingSecret = `${VAULT_REF_PREFIX}slack-signing-secret`;
    }

    patchConfigFile({ channels: { slack: patch } });
    p.log.success('Slack: enabled, credentials saved to vault.');
    return true;
}

/* ------------------------------------------------------------------ */
/*  Step: Telegram config                                             */
/* ------------------------------------------------------------------ */

async function stepTelegram(): Promise<boolean> {
    const enable = await p.confirm({
        message: 'Enable Telegram integration?',
        initialValue: false,
    });
    exitIfCancelled(enable);
    if (!enable) return false;

    p.note(
        [
            '1. Open @BotFather on Telegram and send /newbot',
            '2. Follow the prompts to create your bot and copy the token',
            '3. (Optional) Send /setprivacy → Disable if you want the bot to see group messages',
            '4. Add the bot to your chat/group and send it a message',
        ].join('\n'),
        'Telegram Bot Setup',
    );

    const token = await collectAndTestToken({ message: 'Telegram Bot Token' }, testTelegramToken, 'Telegram');

    if (token) {
        await vault.set('telegram-bot-token', token);
        patchConfigFile({
            channels: { telegram: { enabled: true, botToken: `${VAULT_REF_PREFIX}telegram-bot-token` } },
        });
        p.log.success('Telegram: enabled, token saved to vault.');
    } else {
        patchConfigFile({ channels: { telegram: { enabled: true } } });
        p.log.warn('Telegram: enabled without token. Run `geminiclaw setup --step telegram` to add it later.');
    }
    return true;
}

/* ------------------------------------------------------------------ */
/*  Step: Google Workspace (gog)                                      */
/* ------------------------------------------------------------------ */

async function stepGoogle(): Promise<void> {
    const enable = await p.confirm({
        message: 'Enable Google Workspace integration (Gmail, Calendar, Drive)?',
        initialValue: false,
    });
    exitIfCancelled(enable);
    if (!enable) return;

    // Check if gog CLI is installed
    const gogCheck = spawnSync('which', ['gog'], { encoding: 'utf-8', timeout: 5000 });
    if (gogCheck.status !== 0) {
        p.note(
            [
                'gog CLI is not installed. Run the setup script:',
                '  bash scripts/setup-gog.sh',
                '',
                'This will create a Google Cloud project, enable APIs,',
                'and guide you through OAuth setup.',
                '',
                'Or install manually:',
                '  brew install steipete/tap/gogcli',
                '  See: https://github.com/steipete/gog#setup',
                '',
                'After setup, run:',
                '  geminiclaw setup --step gog',
            ].join('\n'),
            'gog CLI Setup Required',
        );
        return;
    }

    // List authenticated accounts
    const authResult = spawnSync('gog', ['auth', 'list'], { encoding: 'utf-8', timeout: 10_000 });
    const accounts = (authResult.stdout ?? '')
        .trim()
        .split('\n')
        .map((line) => line.split('\t')[0]?.trim())
        .filter((a): a is string => !!a && a.includes('@'));

    if (accounts.length === 0) {
        p.note(
            [
                'No gog accounts found. Run the setup script:',
                '  bash scripts/setup-gog.sh',
                '',
                'Or set up manually:',
                '  gog auth credentials ~/Downloads/client_secret_*.json',
                '  gog auth add YOUR_EMAIL@gmail.com',
                '',
                'Then run:',
                '  geminiclaw setup --step gog',
            ].join('\n'),
            'gog Authentication Required',
        );
        return;
    }

    let account: string;
    if (accounts.length === 1) {
        account = accounts[0] as string;
        p.log.info(`Using gog account: ${account}`);
    } else {
        const selected = await p.select({
            message: 'Which Google account should the agent use?',
            options: accounts.map((a) => ({ value: a, label: a })),
        });
        exitIfCancelled(selected);
        account = selected;
    }

    patchConfigFile({ gogAccount: account });
    p.log.success(`Google Workspace: ${account}`);
}

/* ------------------------------------------------------------------ */
/*  Step: Timezone                                                    */
/* ------------------------------------------------------------------ */

const COMMON_TIMEZONES = [
    'Asia/Tokyo',
    'Asia/Shanghai',
    'Asia/Seoul',
    'Asia/Singapore',
    'Asia/Kolkata',
    'Europe/London',
    'Europe/Berlin',
    'Europe/Paris',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'Pacific/Honolulu',
    'Pacific/Auckland',
    'Australia/Sydney',
] satisfies string[];

async function stepTimezone(): Promise<void> {
    const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const options = COMMON_TIMEZONES.map((tz) => ({
        value: tz,
        label: tz,
        hint: tz === systemTz ? 'system default' : undefined,
    }));

    // Put system default first if it's in the list, otherwise add it
    const systemInList = options.find((o) => o.value === systemTz);
    if (!systemInList) {
        options.unshift({ value: systemTz, label: systemTz, hint: 'system default' });
    } else {
        const idx = options.indexOf(systemInList);
        options.splice(idx, 1);
        options.unshift(systemInList);
    }

    options.push({ value: '__other__', label: 'Other...', hint: 'enter IANA timezone manually' });

    let tz = await p.select({
        message: 'Timezone',
        options,
        initialValue: systemTz,
    });
    exitIfCancelled(tz);

    if (tz === '__other__') {
        const custom = await p.text({
            message: 'Timezone (IANA format, e.g. Asia/Tokyo)',
            placeholder: systemTz,
            defaultValue: systemTz,
        });
        exitIfCancelled(custom);
        tz = custom || systemTz;
    }

    patchConfigFile({ timezone: tz });
    p.log.success(`Timezone: ${tz}`);
}

/* ------------------------------------------------------------------ */
/*  Step: Secrets                                                     */
/* ------------------------------------------------------------------ */

async function collectSecrets(): Promise<void> {
    let raw: Record<string, unknown> = {};
    if (existsSync(CONFIG_PATH)) {
        try {
            raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
        } catch {
            raw = {};
        }
    }

    const channels = (raw.channels ?? {}) as Record<string, Record<string, unknown>>;
    const discord = (channels.discord ?? {}) as Record<string, unknown>;
    const slack = (channels.slack ?? {}) as Record<string, unknown>;
    const telegram = (channels.telegram ?? {}) as Record<string, unknown>;
    // Build the list of secrets to collect based on enabled channels
    interface SecretEntry {
        label: string;
        hint: string;
        configDotPath: string;
        vaultKey: string;
        validate?: (v: string) => string | undefined;
    }
    const entries: SecretEntry[] = [];

    if (discord.enabled === true && !discord.token) {
        entries.push({
            label: 'Discord Bot Token',
            hint: 'Discord Developer Portal → Bot → Token',
            configDotPath: 'channels.discord.token',
            vaultKey: 'discord-token',
        });
    }

    if (telegram.enabled === true && !telegram.botToken) {
        entries.push({
            label: 'Telegram Bot Token',
            hint: '@BotFather → /newbot → Token',
            configDotPath: 'channels.telegram.botToken',
            vaultKey: 'telegram-bot-token',
        });
    }

    if (slack.enabled === true) {
        if (!slack.token) {
            entries.push({
                label: 'Slack Bot Token',
                hint: 'OAuth & Permissions → Bot User OAuth Token (xoxb-...)',
                configDotPath: 'channels.slack.token',
                vaultKey: 'slack-bot-token',
                validate: (v) => (v.startsWith('xoxb-') ? undefined : 'Token must start with xoxb-'),
            });
        }
        if (!slack.signingSecret) {
            entries.push({
                label: 'Slack Signing Secret',
                hint: 'Basic Information → App Credentials → Signing Secret',
                configDotPath: 'channels.slack.signingSecret',
                vaultKey: 'slack-signing-secret',
            });
        }
    }

    if (entries.length === 0) {
        p.log.info('No secrets to configure.');
        return;
    }

    p.log.info('Tokens are encrypted and stored in the vault. Only references are saved to config.json.');
    p.log.info('Press Enter with empty input to skip.');

    let changed = false;

    for (const entry of entries) {
        const value = await p.password({
            message: `${entry.label}`,
            mask: '*',
            validate: (v) => {
                if (!v) return undefined; // allow empty = skip
                return entry.validate?.(v);
            },
        });
        exitIfCancelled(value);

        if (value) {
            await vault.set(entry.vaultKey, value);
            await storeSecretInVault(raw, entry.configDotPath, entry.vaultKey);
            changed = true;
            p.log.success(`${entry.label}: Saved to vault.`);
        } else {
            p.log.warn(`${entry.label}: Skipped.`);
        }
    }

    if (changed) {
        const dir = CONFIG_PATH.replace(/[/\\][^/\\]+$/, '');
        if (!existsSync(dir)) {
            const { mkdirSync } = await import('node:fs');
            mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    }
}

/* ------------------------------------------------------------------ */
/*  Step: Heartbeat notifications                                     */
/* ------------------------------------------------------------------ */

/** Convert shared ChannelEntry[] to clack select options. */
function toChannelOptions(channels: ChannelEntry[]): { value: string; label: string; hint?: string }[] {
    return channels.map((ch) => ({
        value: ch.id,
        label: `#${ch.name}`,
        hint: ch.group,
    }));
}

/**
 * Configure notification destinations for background jobs (heartbeat + cron).
 * Channel notifications receive completion notices for both heartbeat and cron runs.
 * Desktop notifications only fire on heartbeat alerts.
 */
async function stepHeartbeatNotifications(): Promise<void> {
    const config = loadConfig();

    p.note(
        [
            'Background jobs (heartbeat & cron) post brief completion notices here.',
            'Examples:',
            '  ✅ Heartbeat OK',
            '  ⚠️ Heartbeat Alert — calendar conflict detected ...',
            '  ✅ Cron done: daily-briefing',
            '  ⚠️ Cron failed: market-analysis — rate limit exceeded ...',
            '',
            "Full results are sent separately to each job's reply channel.",
        ].join('\n'),
        'Job Notifications',
    );

    // Collect all enabled platform channels for notification target selection
    const allOptions: { value: string; label: string }[] = [];

    if (config.channels.discord.enabled && config.channels.discord.token) {
        const s = p.spinner();
        s.start('Fetching Discord channels...');
        const channels = await fetchDiscordChannels(config.channels.discord.token);
        s.stop('Discord channels loaded.');
        for (const ch of toChannelOptions(channels)) {
            allOptions.push({ value: `discord:${ch.value}`, label: `Discord ${ch.label}` });
        }
    }

    if (config.channels.slack.enabled && config.channels.slack.token) {
        const s = p.spinner();
        s.start('Fetching Slack channels...');
        const channels = await fetchSlackChannels(config.channels.slack.token);
        s.stop('Slack channels loaded.');
        for (const ch of toChannelOptions(channels)) {
            allOptions.push({ value: `slack:${ch.value}`, label: `Slack ${ch.label}` });
        }
    }

    if (config.channels.telegram.enabled && config.channels.telegram.botToken) {
        const telegramChats = await fetchTelegramChats(config.channels.telegram.botToken);
        for (const ch of telegramChats) {
            allOptions.push({ value: `telegram:${ch.id}`, label: `Telegram ${ch.name}` });
        }
    }

    if (allOptions.length > 0) {
        const selected = await p.select({
            message: 'Notification channel for background jobs (heartbeat & cron)?',
            options: [{ value: '__skip__', label: 'Skip', hint: 'No channel notifications' }, ...allOptions],
        });
        exitIfCancelled(selected);

        if (selected !== '__skip__') {
            const parsed = parseHomeValue(selected as string);
            patchConfigFile({ notifications: parsed });
            const label = allOptions.find((o) => o.value === selected);
            p.log.success(`Job notifications → ${label?.label ?? selected}`);
        }
    } else {
        p.log.warn('No channels available. Skipping channel notifications.');
    }

    // --- Desktop ---
    const enableDesktop = await p.confirm({
        message: 'Enable desktop notifications for heartbeat alerts?',
        initialValue: true,
    });
    exitIfCancelled(enableDesktop);
    patchConfigFile({ heartbeat: { desktop: enableDesktop } });

    if (enableDesktop) {
        p.log.success('Desktop notifications: enabled');
    }
}

/* ------------------------------------------------------------------ */
/*  Step: Summary                                                     */
/* ------------------------------------------------------------------ */

function isSoulConfigured(workspacePath: string): boolean {
    const soulPath = join(workspacePath, 'SOUL.md');
    if (!existsSync(soulPath)) return false;
    // Template SOUL.md contains `<!-- ... -->` placeholder comments.
    // If they're still present, the user hasn't customized it yet.
    const content = readFileSync(soulPath, 'utf-8');
    return !content.includes('<!--');
}

function printSummary(config: Config, workspacePath: string): void {
    const soulConfigured = isSoulConfigured(workspacePath);
    const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const check = (ok: boolean): string => (ok ? '\x1b[32m✔\x1b[0m' : '\x1b[2m—\x1b[0m');

    // Build job notification summary
    const notifParts: string[] = [];
    if (config.heartbeat.desktop) notifParts.push('desktop (alerts)');
    if (config.notifications) {
        notifParts.push(`${config.notifications.channel} #${config.notifications.channelId}`);
    }
    const notifSummary = notifParts.length > 0 ? notifParts.join(' + ') : 'none';

    // Home summary
    const homeSummary = config.home ? `${config.home.channel} #${config.home.channelId}` : 'not set';

    p.note(
        [
            `Workspace     ${workspacePath}`,
            `Language      ${config.language}`,
            `SOUL.md       ${check(soulConfigured)} ${soulConfigured ? 'configured' : 'not set (auto-generated on first conversation)'}`,
            `Discord       ${check(config.channels.discord.enabled)} ${config.channels.discord.enabled ? 'enabled' : 'disabled'}`,
            `Slack         ${check(config.channels.slack.enabled)} ${config.channels.slack.enabled ? 'enabled' : 'disabled'}`,
            `Telegram      ${check(config.channels.telegram.enabled)} ${config.channels.telegram.enabled ? 'enabled' : 'disabled'}`,
            `Google        ${check(!!config.gogAccount)} ${config.gogAccount || 'not configured'}`,
            `Timezone      ${config.timezone || systemTz}`,
            `Home          ${check(!!config.home)} ${homeSummary}`,
            `Notifications ${check(notifParts.length > 0)} ${notifSummary}`,
        ].join('\n'),
        'Setup Summary',
    );

    p.log.info('Next steps:');
    p.log.step('  task start         Start all services');
    p.log.step('  geminiclaw run     Run a one-shot task');
}

/* ------------------------------------------------------------------ */
/*  Main wizard                                                       */
/* ------------------------------------------------------------------ */

/**
 * Run the setup wizard: init -> language -> SOUL.md -> channels -> timezone -> memory -> secrets -> summary.
 *
 * Exported so `run.ts` can call it for first-run auto-setup.
 */
/** Minimum required Gemini CLI version. */
const MIN_GEMINI_VERSION = '0.31.0';

/**
 * Parse a semver-ish version string ("0.31.0", "1.2.3-beta") into comparable parts.
 * Returns null if unparseable.
 */
function parseSemver(raw: string): [number, number, number] | null {
    const m = raw.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function semverGte(a: [number, number, number], b: [number, number, number]): boolean {
    for (let i = 0; i < 3; i++) {
        if ((a[i] as number) > (b[i] as number)) return true;
        if ((a[i] as number) < (b[i] as number)) return false;
    }
    return true; // equal
}

/**
 * Verify Gemini CLI is installed and meets the minimum version requirement.
 * Exits with a helpful error message if not.
 */
function checkGeminiCli(): void {
    const result = spawnSync(getGeminiBin(), ['--version'], { encoding: 'utf-8', timeout: 10_000 });
    if (result.error || result.status !== 0) {
        p.log.error('Gemini CLI not found. Please install it:');
        p.log.step('  bun i -g @google/gemini-cli');
        process.exit(1);
    }

    const output = (result.stdout ?? '').trim();
    // `gemini --version` outputs something like "0.31.0" or "Gemini CLI v0.31.0"
    const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
    if (!versionMatch) {
        p.log.warn(`Could not detect Gemini CLI version: ${output}`);
        return;
    }

    const installed = parseSemver(versionMatch[1] as string);
    const required = parseSemver(MIN_GEMINI_VERSION) as [number, number, number];
    if (installed && !semverGte(installed, required)) {
        p.log.error(`Gemini CLI ${versionMatch[1]} is too old (>= ${MIN_GEMINI_VERSION} required).`);
        p.log.step('  bun i -g @google/gemini-cli');
        process.exit(1);
    }

    p.log.success(`Gemini CLI ${versionMatch[1]}`);
}

export async function runSetupWizard(workspacePath: string): Promise<void> {
    p.intro('GeminiClaw Setup');

    // Preflight: check Gemini CLI version
    checkGeminiCli();

    // Step 1: Language preference
    await stepLanguage();

    // SOUL.md is now generated during bootstrap (first agent conversation)

    // Step 2: Discord
    const discordEnabled = await stepDiscord();

    // Step 3: Slack
    const slackEnabled = await stepSlack();

    // Step 4: Telegram
    const telegramEnabled = await stepTelegram();

    // Step 5: Google Workspace
    await stepGoogle();

    // Step 6: Timezone
    await stepTimezone();

    // Step 7: Home channel selection (only for adapters enabled in this session)
    if (process.stdin.isTTY) {
        await stepHome({ discord: discordEnabled, slack: slackEnabled, telegram: telegramEnabled });
    }

    // Step 8: Initialize workspace, register MCP servers, download memory search models.
    // This is the heaviest step — QMD model download (~500MB) runs on first setup.
    const freshConfig = loadConfig();
    const initSpinner = p.spinner();
    initSpinner.start('Setting up workspace and MCP servers...');
    await initializeWorkspace(freshConfig);
    initSpinner.stop('Workspace initialized, MCP servers registered, memory search models ready.');

    // Summary
    printSummary(freshConfig, workspacePath);

    // Mark setup as complete
    patchConfigFile({ setupCompleted: true });

    p.outro('Setup complete!');
}

/** Available step names for `--step`. */
const STEP_RUNNERS: Record<string, () => Promise<unknown>> = {
    language: stepLanguage,
    discord: stepDiscord,
    slack: stepSlack,
    telegram: stepTelegram,
    home: () => stepHome(),
    gog: stepGoogle,
    timezone: stepTimezone,
    secrets: collectSecrets,
    notifications: stepHeartbeatNotifications,
};

/** Steps that modify MCP server config and require re-initialization afterward. */
const STEPS_NEEDING_REINIT = new Set(['discord', 'slack', 'telegram', 'gog', 'secrets']);

export function registerSetupCommand(program: Command): void {
    program
        .command('setup')
        .description('Run interactive setup wizard')
        .option('--check', 'Check setup status without launching the wizard')
        .option(
            '--step <name>',
            'Run a single setup step (language, discord, slack, telegram, home, gog, timezone, secrets, notifications)',
        )
        .action(async (options) => {
            const config = loadConfig();

            if (options.check) {
                const workspacePath = getWorkspacePath(config);
                const checks = {
                    setupCompleted: config.setupCompleted,
                    workspaceExists: existsSync(workspacePath),
                    configExists: existsSync(CONFIG_PATH),
                    soulMdExists: existsSync(join(workspacePath, 'SOUL.md')),
                    language: config.language,
                    memoryBackend: 'qmd',
                    discordEnabled: config.channels.discord.enabled,
                    discordTokenSet: !!config.channels.discord.token,
                    slackEnabled: config.channels.slack.enabled,
                    slackTokenSet: !!config.channels.slack.token,
                    telegramEnabled: config.channels.telegram.enabled,
                    telegramTokenSet: !!config.channels.telegram.botToken,
                    gogAccount: config.gogAccount || null,
                    timezone: config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
                    home: config.home ?? null,
                };
                process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
                return;
            }

            if (options.step) {
                const runner = STEP_RUNNERS[options.step as string];
                if (!runner) {
                    p.log.error(`Unknown step: ${options.step}. Available: ${Object.keys(STEP_RUNNERS).join(', ')}`);
                    process.exit(1);
                }
                const stepName = options.step as string;
                p.intro(`GeminiClaw Setup — ${stepName}`);
                await runner();
                if (STEPS_NEEDING_REINIT.has(stepName)) {
                    const freshConfig = loadConfig();
                    const s = p.spinner();
                    s.start('Updating MCP server config...');
                    await initializeWorkspace(freshConfig);
                    s.stop('MCP servers updated.');
                }
                p.outro('Done.');
                return;
            }

            const workspacePath = getWorkspacePath(config);
            await runSetupWizard(workspacePath);
        });
}
