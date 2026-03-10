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
import { type ChannelEntry, fetchDiscordChannels, fetchSlackChannels } from '../../channels/list-channels.js';
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
/*  Step: Discord config                                              */
/* ------------------------------------------------------------------ */

async function stepDiscord(): Promise<void> {
    const enable = await p.confirm({
        message: 'Enable Discord integration?',
        initialValue: false,
    });
    exitIfCancelled(enable);
    if (!enable) return;

    p.note(
        [
            '1. Create a Bot at https://discord.com/developers/applications',
            "2. Copy the Bot Token (you'll enter it in the secrets step)",
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

    patchConfigFile({ channels: { discord: { enabled: true } } });
    p.log.success('Discord integration enabled.');
}

/**
 * Select a home channel for Discord after secrets are collected.
 * The home channel is used for bootstrap, heartbeat, and @mention-free responses.
 */
async function stepDiscordHomeChannel(): Promise<void> {
    const config = loadConfig();
    if (!config.channels.discord.enabled || !config.channels.discord.token) return;

    const s = p.spinner();
    s.start('Fetching Discord channels...');
    const channels = await fetchDiscordChannels(config.channels.discord.token);
    s.stop('Discord channels loaded.');

    const options = toChannelOptions(channels);

    if (options.length === 0) {
        p.log.warn('No text channels found. Skipping home channel setup.');
        return;
    }

    const selected = await p.select({
        message: 'Which Discord channel should the agent call home?',
        options: [{ value: '__skip__', label: 'Skip', hint: 'No home channel' }, ...options],
    });
    exitIfCancelled(selected);

    if (selected !== '__skip__') {
        patchConfigFile({ channels: { discord: { homeChannel: selected } } });
        const label = options.find((o) => o.value === selected);
        p.log.success(`Home channel → Discord ${label?.label ?? selected}`);
    }
}

/* ------------------------------------------------------------------ */
/*  Step: Slack config                                                */
/* ------------------------------------------------------------------ */

async function stepSlack(): Promise<void> {
    const enable = await p.confirm({
        message: 'Enable Slack integration?',
        initialValue: false,
    });
    exitIfCancelled(enable);
    if (!enable) return;

    p.note(
        [
            '1. Create an App at https://api.slack.com/apps',
            "2. Copy the Bot Token (xoxb-...) — you'll enter it next",
            '3. Copy the Signing Secret from Basic Information → App Credentials',
            '4. Enable Event Subscriptions and subscribe to:',
            '   app_mention, message.channels, message.groups, message.im',
            '5. Add Bot Token Scopes under OAuth & Permissions:',
            '   chat:write, channels:history, channels:read, reactions:write,',
            '   app_mentions:read, im:history, files:read, files:write',
            '',
            'Full guide: https://docs.openclaw.ai/channels/slack',
        ].join('\n'),
        'Slack App Setup',
    );

    patchConfigFile({ channels: { slack: { enabled: true } } });
    p.log.success('Slack integration enabled.');
}

/**
 * Select a home channel for Slack after secrets are collected.
 */
async function stepSlackHomeChannel(): Promise<void> {
    const config = loadConfig();
    if (!config.channels.slack.enabled || !config.channels.slack.token) return;

    const s = p.spinner();
    s.start('Fetching Slack channels...');
    const channels = await fetchSlackChannels(config.channels.slack.token);
    s.stop('Slack channels loaded.');

    const options = toChannelOptions(channels);

    if (options.length === 0) {
        p.log.warn('No channels found. Skipping home channel setup.');
        return;
    }

    const selected = await p.select({
        message: 'Which Slack channel should the agent call home?',
        options: [{ value: '__skip__', label: 'Skip', hint: 'No home channel' }, ...options],
    });
    exitIfCancelled(selected);

    if (selected !== '__skip__') {
        patchConfigFile({ channels: { slack: { homeChannel: selected } } });
        const label = options.find((o) => o.value === selected);
        p.log.success(`Home channel → Slack ${label?.label ?? selected}`);
    }
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

    const raw: Record<string, unknown> = existsSync(CONFIG_PATH)
        ? (JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>)
        : {};

    if (!raw.heartbeat) raw.heartbeat = {};
    const hb = raw.heartbeat as Record<string, unknown>;
    if (!hb.notifications) hb.notifications = {};
    const notif = hb.notifications as Record<string, unknown>;

    let hasChanges = false;

    // --- Discord ---
    if (config.channels.discord.enabled && config.channels.discord.token) {
        const s = p.spinner();
        s.start('Fetching Discord channels...');
        const channels = await fetchDiscordChannels(config.channels.discord.token);
        s.stop('Discord channels loaded.');

        const options = toChannelOptions(channels);

        if (options.length > 0) {
            const selected = await p.select({
                message: 'Notification channel for background jobs (heartbeat & cron)?',
                options: [{ value: '__skip__', label: 'Skip', hint: 'Do not send to Discord' }, ...options],
            });
            exitIfCancelled(selected);

            if (selected !== '__skip__') {
                notif.discord = { enabled: true, channelId: selected };
                hasChanges = true;
                const label = options.find((o) => o.value === selected);
                p.log.success(`Job notifications → Discord ${label?.label ?? selected}`);
            }
        } else {
            p.log.warn('No text channels found in Discord. Skipping.');
        }
    }

    // --- Slack ---
    if (config.channels.slack.enabled && config.channels.slack.token) {
        const s = p.spinner();
        s.start('Fetching Slack channels...');
        const channels = await fetchSlackChannels(config.channels.slack.token);
        s.stop('Slack channels loaded.');

        const options = toChannelOptions(channels);

        if (options.length > 0) {
            const selected = await p.select({
                message: 'Notification channel for background jobs (heartbeat & cron)?',
                options: [{ value: '__skip__', label: 'Skip', hint: 'Do not send to Slack' }, ...options],
            });
            exitIfCancelled(selected);

            if (selected !== '__skip__') {
                notif.slack = { enabled: true, channelId: selected };
                hasChanges = true;
                const label = options.find((o) => o.value === selected);
                p.log.success(`Job notifications → Slack ${label?.label ?? selected}`);
            }
        } else {
            p.log.warn('No channels found in Slack. Skipping.');
        }
    }

    // --- Desktop ---
    const enableDesktop = await p.confirm({
        message: 'Enable desktop notifications for heartbeat alerts?',
        initialValue: true,
    });
    exitIfCancelled(enableDesktop);
    notif.desktop = enableDesktop;
    hasChanges = true;

    if (hasChanges) {
        const dir = CONFIG_PATH.replace(/[/\\][^/\\]+$/, '');
        if (!existsSync(dir)) {
            const { mkdirSync } = await import('node:fs');
            mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    }

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

    // Build job notification summary (heartbeat + cron)
    const notifParts: string[] = [];
    if (config.heartbeat.notifications.desktop) notifParts.push('desktop (alerts)');
    if (config.heartbeat.notifications.discord.enabled && config.heartbeat.notifications.discord.channelId)
        notifParts.push(`Discord #${config.heartbeat.notifications.discord.channelId}`);
    if (config.heartbeat.notifications.slack.enabled && config.heartbeat.notifications.slack.channelId)
        notifParts.push(`Slack #${config.heartbeat.notifications.slack.channelId}`);
    const notifSummary = notifParts.length > 0 ? notifParts.join(' + ') : 'none';

    p.note(
        [
            `Workspace   ${workspacePath}`,
            `Language    ${config.language}`,
            `SOUL.md     ${check(soulConfigured)} ${soulConfigured ? 'configured' : 'not set (auto-generated on first conversation)'}`,
            `Discord     ${check(config.channels.discord.enabled)} ${config.channels.discord.enabled ? 'enabled' : 'disabled'}`,
            `Slack       ${check(config.channels.slack.enabled)} ${config.channels.slack.enabled ? 'enabled' : 'disabled'}`,
            `Google      ${check(!!config.gogAccount)} ${config.gogAccount || 'not configured'}`,
            `Timezone    ${config.timezone || systemTz}`,
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

export async function runSetupWizard(config: Config, workspacePath: string): Promise<void> {
    p.intro('GeminiClaw Setup');

    // Preflight: check Gemini CLI version
    checkGeminiCli();

    // Step 1: Initialize workspace
    const s = p.spinner();
    s.start('Initializing workspace...');
    await initializeWorkspace(config);
    s.stop('Workspace initialized.');

    // Step 2: Language preference
    await stepLanguage();

    // SOUL.md is now generated during bootstrap (first agent conversation)

    // Step 3: Discord
    await stepDiscord();

    // Step 5: Slack
    await stepSlack();

    // Step 6: Google Workspace
    await stepGoogle();

    // Step 7: Timezone
    await stepTimezone();

    // Step 8: Secrets
    if (process.stdin.isTTY) {
        await collectSecrets();
    }

    // Step 9: Home channel selection (requires tokens from step 8)
    if (process.stdin.isTTY) {
        await stepDiscordHomeChannel();
        await stepSlackHomeChannel();
    }

    // Step 10: Job notifications (heartbeat + cron completion notices)
    if (process.stdin.isTTY) {
        await stepHeartbeatNotifications();
    }

    // Re-initialize to register MCP servers with all collected settings
    // (gogAccount, channels, etc. written during the wizard steps above).
    const freshConfig = loadConfig();
    await initializeWorkspace(freshConfig);

    // Summary
    printSummary(freshConfig, workspacePath);

    // Mark setup as complete
    patchConfigFile({ setupCompleted: true });

    p.outro('Setup complete!');
}

/** Available step names for `--step`. */
const STEP_RUNNERS: Record<string, () => Promise<void>> = {
    language: stepLanguage,
    discord: stepDiscord,
    'discord-home': stepDiscordHomeChannel,
    slack: stepSlack,
    'slack-home': stepSlackHomeChannel,
    gog: stepGoogle,
    timezone: stepTimezone,
    secrets: collectSecrets,
    notifications: stepHeartbeatNotifications,
};

/** Steps that modify MCP server config and require re-initialization afterward. */
const STEPS_NEEDING_REINIT = new Set(['discord', 'slack', 'gog', 'secrets']);

export function registerSetupCommand(program: Command): void {
    program
        .command('setup')
        .description('Run interactive setup wizard')
        .option('--check', 'Check setup status without launching the wizard')
        .option(
            '--step <name>',
            'Run a single setup step (language, discord, discord-home, slack, slack-home, gog, timezone, secrets, notifications)',
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
                    gogAccount: config.gogAccount || null,
                    timezone: config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
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
            await runSetupWizard(config, workspacePath);
        });
}
