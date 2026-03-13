/**
 * mcp/admin-server.ts — MCP server exposing geminiclaw CLI as a single generic tool.
 *
 * Runs on the host via Streamable HTTP (not inside sandbox), so it has
 * full access to the geminiclaw binary and filesystem.
 *
 * The agent discovers available subcommands and usage via the
 * `self-manage` skill (loaded on demand), keeping ListTools minimal.
 *
 * `skill install` is handled directly (not via CLI subprocess) so that
 * scan results can be shown to the user via ask_user before the skill
 * is activated. This prevents the agent from hiding security findings.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SessionStore } from '../agent/session/store.js';
import type { MediaItem } from '../channels/channel.js';
import { fetchDiscordChannels, fetchSlackChannels, fetchTelegramChats } from '../channels/list-channels.js';
import { postToChannel } from '../channels/reply.js';
import { getWorkspacePath } from '../config/paths.js';
import { loadConfig } from '../config.js';
import { auditLog } from './audit.js';
import { confirmIfNeeded, type ToolEffect, toAnnotations } from './tool-effect.js';

const EXEC_TIMEOUT_MS = 120_000;

const SURROUNDING_MESSAGE_LIMIT = 5;

// ── Message URL patterns ────────────────────────────────────────

/** Discord: https://discord.com/channels/{guild}/{channel}/{message} (ptb/canary/discordapp variants) */
const DISCORD_MESSAGE_URL_RE =
    /^(?:https?:\/\/)?(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)\/?(?:\?.*)?$/i;

/** Slack: https://{workspace}.slack.com/archives/{channel}/p{ts} */
const SLACK_MESSAGE_URL_RE =
    /^(?:https?:\/\/)?([a-z0-9-]+)\.slack\.com\/archives\/([A-Za-z0-9]+)\/p(\d+)\/?(?:\?.*)?$/;

type ParsedMessageUrl =
    | { platform: 'discord'; guildId: string; channelId: string; messageId: string }
    | { platform: 'slack'; workspace: string; channelId: string; messageTs: string };

/**
 * Parse a chat platform message URL into its components.
 *
 * Supports Discord and Slack message URLs.
 *
 * Args:
 *     url: Message URL to parse.
 *
 * Returns:
 *     Parsed URL components with platform discriminator, or undefined if unrecognized.
 */
export function parseMessageUrl(url: string): ParsedMessageUrl | undefined {
    const trimmed = url.trim();

    const discordMatch = trimmed.match(DISCORD_MESSAGE_URL_RE);
    if (discordMatch?.[1] && discordMatch[2] && discordMatch[3]) {
        return { platform: 'discord', guildId: discordMatch[1], channelId: discordMatch[2], messageId: discordMatch[3] };
    }

    const slackMatch = trimmed.match(SLACK_MESSAGE_URL_RE);
    if (slackMatch?.[1] && slackMatch[2] && slackMatch[3]) {
        // Slack encodes timestamp as p{ts without dot} — insert dot before last 6 digits
        const rawTs = slackMatch[3];
        const messageTs = rawTs.length > 6 ? `${rawTs.slice(0, -6)}.${rawTs.slice(-6)}` : rawTs;
        return { platform: 'slack', workspace: slackMatch[1], channelId: slackMatch[2], messageTs };
    }

    return undefined;
}

/** Commands that are never allowed — prevent infinite recursion or destructive ops. */
const BLOCKED_COMMANDS = new Set(['run', 'start', 'init', 'dashboard', 'vault']);

/** Flags that are never allowed — prevent secret leakage. */
const BLOCKED_FLAGS = new Set(['--reveal']);

/** Commands handled directly instead of via CLI subprocess. */
const INTERCEPTED_COMMANDS = new Set(['skill install']);

/** Commands that require user confirmation via ask_user. */
const CONFIRM_COMMANDS: Record<string, ToolEffect> = {
    upgrade: 'elevated',
    'config set': 'write',
    'skill remove': 'destructive',
};

/** Flags that make a command read-only regardless of base classification. */
const READ_ONLY_FLAGS = new Set(['--check', '--status', '--dry-run', '--help']);

/**
 * Resolve the tool effect classification for a command.
 * Returns 'read' for safe commands, or the configured ToolEffect for dangerous ones.
 */
export function classifyEffect(args: string[]): ToolEffect {
    // Any read-only flag downgrades to 'read'
    if (args.some((a) => READ_ONLY_FLAGS.has(a))) return 'read';

    // Check two-word commands first (e.g. "config set")
    if (args.length >= 2) {
        const twoWord = `${args[0]} ${args[1]}`;
        if (CONFIRM_COMMANDS[twoWord]) return CONFIRM_COMMANDS[twoWord];
    }
    // Then single-word commands (e.g. "upgrade")
    const cmd = args[0];
    if (cmd && CONFIRM_COMMANDS[cmd]) return CONFIRM_COMMANDS[cmd];
    return 'read';
}

function execGeminiclaw(args: string[]): Promise<string> {
    const bin = process.argv[1] ?? 'geminiclaw';
    return new Promise((resolve, reject) => {
        execFile('node', [bin, ...args], { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
            if (err) {
                const msg = stderr?.trim() || err.message;
                reject(new Error(msg));
            } else {
                resolve(stdout);
            }
        });
    });
}

const TOOLS = [
    {
        name: 'geminiclaw_list_channels',
        description:
            'List available channels from configured Discord, Slack, and Telegram integrations. ' +
            'Returns channel names and IDs. Use this to resolve channel names to IDs ' +
            'when the user references a channel by name (e.g. "#general").',
        inputSchema: {
            type: 'object' as const,
            properties: {
                platform: {
                    type: 'string' as const,
                    enum: ['discord', 'slack', 'telegram', 'all'],
                    description: 'Which platform to list channels from. Defaults to "all".',
                },
            },
            required: [] as const,
        },
        annotations: toAnnotations('read'),
    },
    {
        name: 'geminiclaw_post_message',
        description:
            'Post a message to a Discord, Slack, or Telegram channel. ' +
            'Use geminiclaw_list_channels first to resolve channel names to IDs. ' +
            'Optionally specify threadRef to reply in a thread. ' +
            'Supports file attachments via workspace-relative paths.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                platform: {
                    type: 'string' as const,
                    enum: ['discord', 'slack', 'telegram'],
                    description: 'Target platform',
                },
                channelId: { type: 'string' as const, description: 'Channel ID' },
                threadRef: {
                    type: 'string' as const,
                    description: 'Thread ID (Discord) or threadTs (Slack)',
                },
                message: { type: 'string' as const, description: 'Message text to post' },
                files: {
                    type: 'array' as const,
                    items: { type: 'string' as const },
                    description: 'Workspace-relative file paths to attach (images, documents, etc.)',
                },
            },
            required: ['platform', 'channelId', 'message'] as const,
        },
        annotations: toAnnotations('write'),
    },
    {
        name: 'geminiclaw_fetch_message',
        description:
            'Fetch a message by its URL from Discord or Slack. ' +
            'Accepts a full message link and returns the message content with surrounding context. ' +
            'Supported URL formats:\n' +
            '- Discord: https://discord.com/channels/{guild}/{channel}/{message}\n' +
            '- Slack: https://{workspace}.slack.com/archives/{channel}/p{timestamp}\n' +
            'Use this when the user pastes a chat message URL.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                url: {
                    type: 'string' as const,
                    description:
                        'Message URL (Discord or Slack)',
                },
            },
            required: ['url'] as const,
        },
        annotations: toAnnotations('read'),
    },
    {
        name: 'geminiclaw_admin',
        description:
            'Execute a geminiclaw CLI command on the host. ' +
            'Use the self-manage skill for available commands and usage patterns. ' +
            'Blocked commands: run, start, init, dashboard.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                args: {
                    type: 'array' as const,
                    items: { type: 'string' as const },
                    description:
                        'CLI arguments as an array. Examples: ["config", "show"], ["skill", "list"], ["upgrade", "--check"]',
                },
            },
            required: ['args'] as const,
        },
        // Default to destructive (most conservative); actual effect is resolved per-invocation by classifyEffect()
        annotations: toAnnotations('destructive'),
    },
];

/**
 * Handle skill install directly (not via CLI subprocess).
 *
 * Flow:
 *   1. bunx skills add into a staging dir (harmless)
 *   2. Run security scan
 *   3. safe -> move to workspace immediately
 *   4. warning/danger -> show findings via ask_user -> user decides
 *   5. Clean up staging dir
 */
async function handleSkillInstall(
    workspace: string,
    args: string[],
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const { installSkill, confirmInstall, cleanupStaging } = await import('../skills/manager.js');
    const start = Date.now();

    // Parse args: <ref> [--skill <name>] [--force]
    const ref = args.find((a) => !a.startsWith('-'));
    if (!ref) {
        return { content: [{ type: 'text', text: 'Error: missing skill source reference' }], isError: true };
    }
    const skillFlag = args.indexOf('--skill');
    const skillName = skillFlag !== -1 ? args[skillFlag + 1] : undefined;
    const force = args.includes('--force');

    try {
        const result = await installSkill(ref, workspace, { skill: skillName, force });

        if (result.installed.length === 0) {
            return { content: [{ type: 'text', text: 'No new skills were installed.' }] };
        }

        const output: string[] = [];

        // Safe skills: require user confirmation in supervised mode
        if (result.scanned.length > 0) {
            const names = result.scanned.join(', ');
            await confirmIfNeeded(workspace, 'write', `Install safe skills: ${names}`);
            for (const name of result.scanned) {
                output.push(`Installed: ${name} (safe)`);
            }
        }

        // Warned skills: show findings via ask_user
        if (result.warned.length > 0 && result._stagingDir) {
            for (const name of result.warned) {
                const report = result.reports[name];
                const findingsText = report
                    ? report.findings.map((f) => `  [${f.severity.toUpperCase()}] ${f.description}`).join('\n')
                    : '(no details)';

                const question =
                    `Security scan found warnings for skill "${name}":\n\n` +
                    `${findingsText}\n\n` +
                    `Install this skill anyway?`;

                try {
                    await confirmIfNeeded(workspace, 'elevated', question);
                    confirmInstall(result._stagingDir, [name], workspace);
                    output.push(`Installed: ${name} (warnings acknowledged)`);
                } catch {
                    output.push(`Skipped: ${name} (user rejected)`);
                }
            }
        }

        // Blocked skills
        for (const name of result.blocked) {
            const report = result.reports[name];
            const findingsText = report
                ? report.findings.map((f) => `  [${f.severity.toUpperCase()}] ${f.description}`).join('\n')
                : '(no details)';
            output.push(`Blocked: ${name} (danger)\n${findingsText}`);
        }

        if (result._stagingDir) {
            cleanupStaging(result._stagingDir);
        }

        auditLog(workspace, {
            ts: new Date().toISOString(),
            tool: 'geminiclaw_admin',
            effect: 'write',
            params: { args: ['skill', 'install', ...args] },
            ok: true,
            ms: Date.now() - start,
            resultLines: output.length,
        });

        return { content: [{ type: 'text', text: output.join('\n') }] };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        auditLog(workspace, {
            ts: new Date().toISOString(),
            tool: 'geminiclaw_admin',
            effect: 'write',
            params: { args: ['skill', 'install', ...args] },
            ok: false,
            ms: Date.now() - start,
        });

        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
}

async function handlePostMessage(
    workspace: string,
    args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const platform = args.platform as 'discord' | 'slack' | 'telegram';
    const channelId = args.channelId as string;
    const threadRef = args.threadRef as string | undefined;
    const message = args.message as string;
    const filePaths = (args.files ?? []) as string[];

    if (!platform || !channelId || !message) {
        return {
            content: [{ type: 'text', text: 'Error: platform, channelId, and message are required' }],
            isError: true,
        };
    }

    const config = loadConfig();
    const workspacePath = getWorkspacePath(config);

    const mediaItems: MediaItem[] = filePaths
        .map((p) => ({ src: isAbsolute(p) ? p : resolve(workspacePath, p) }))
        .filter((item) => existsSync(item.src));

    const start = Date.now();
    try {
        await postToChannel({
            channelType: platform,
            channelId,
            threadRef,
            text: message,
            files: mediaItems,
            config,
        });

        auditLog(workspace, {
            ts: new Date().toISOString(),
            tool: 'geminiclaw_post_message',
            effect: 'write' as ToolEffect,
            params: { platform, channelId, threadRef },
            ok: true,
            ms: Date.now() - start,
        });

        // Record proactive post to the matching session JSONL so the LLM
        // can see its own posts when the session resumes.
        try {
            const sessionsDir = join(workspacePath, 'memory', 'sessions');
            const store = new SessionStore(sessionsDir);
            const sessionId = store.findSessionForChannel(channelId, threadRef, config.timezone);
            if (sessionId) {
                store.appendEntry(sessionId, {
                    runId: randomUUID(),
                    timestamp: new Date().toISOString(),
                    trigger: 'proactive',
                    responseText: message,
                    toolCalls: [],
                    heartbeatOk: true,
                    tokens: { total: 0, input: 0, output: 0 },
                });
            }
        } catch {
            // Best-effort — don't fail the post if session recording fails
        }

        return { content: [{ type: 'text', text: `Message posted to ${platform}:${channelId}` }] };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        auditLog(workspace, {
            ts: new Date().toISOString(),
            tool: 'geminiclaw_post_message',
            effect: 'write' as ToolEffect,
            params: { platform, channelId, threadRef },
            ok: false,
            ms: Date.now() - start,
        });

        return { content: [{ type: 'text', text: `Error posting message: ${errMsg}` }], isError: true };
    }
}

// ── Message fetching (Discord / Slack) ──────────────────────────

interface FetchedMessage {
    author: string;
    content: string;
    timestamp: string;
    isTarget: boolean;
}

async function fetchDiscordMessages(
    channelId: string,
    messageId: string,
    botToken: string,
): Promise<FetchedMessage[]> {
    const resp = await fetch(
        `https://discord.com/api/v10/channels/${channelId}/messages?around=${messageId}&limit=${SURROUNDING_MESSAGE_LIMIT}`,
        { headers: { Authorization: `Bot ${botToken}` } },
    );
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Discord API ${resp.status}: ${body}`);
    }

    const messages = (await resp.json()) as Array<{
        id: string;
        content: string;
        author: { username: string; global_name?: string };
        timestamp: string;
        attachments?: Array<{ filename: string }>;
        embeds?: Array<{ title?: string; description?: string }>;
    }>;

    // Discord returns newest-first; reverse for chronological order
    return [...messages].reverse().map((m) => {
        const extras: string[] = [];
        if (m.attachments?.length) {
            extras.push(`[attachments: ${m.attachments.map((a) => a.filename).join(', ')}]`);
        }
        if (m.embeds?.length) {
            extras.push(`[embeds: ${m.embeds.map((e) => e.title || e.description || '(embed)').join(', ')}]`);
        }
        const content = extras.length > 0 ? `${m.content} ${extras.join(' ')}` : m.content;
        return {
            author: m.author.global_name || m.author.username,
            content,
            timestamp: m.timestamp,
            isTarget: m.id === messageId,
        };
    });
}

type SlackApiMessage = {
    ts: string;
    text: string;
    user?: string;
    username?: string;
    files?: Array<{ name: string }>;
};

async function fetchSlackHistory(
    channelId: string,
    botToken: string,
    params: URLSearchParams,
): Promise<SlackApiMessage[]> {
    const resp = await fetch(`https://slack.com/api/conversations.history?${params}`, {
        headers: { Authorization: `Bearer ${botToken}` },
    });
    if (!resp.ok) {
        throw new Error(`Slack API HTTP ${resp.status}`);
    }
    const body = (await resp.json()) as {
        ok: boolean;
        error?: string;
        messages?: SlackApiMessage[];
    };
    if (!body.ok) {
        throw new Error(`Slack API error: ${body.error ?? 'unknown'}`);
    }
    return body.messages ?? [];
}

function toFetchedMessage(m: SlackApiMessage, targetTs: string): FetchedMessage {
    const extras: string[] = [];
    if (m.files?.length) {
        extras.push(`[files: ${m.files.map((f) => f.name).join(', ')}]`);
    }
    const content = extras.length > 0 ? `${m.text} ${extras.join(' ')}` : m.text;
    const tsMs = Math.floor(Number.parseFloat(m.ts) * 1000);
    return {
        author: m.username || m.user || 'Unknown',
        content,
        timestamp: new Date(tsMs).toISOString(),
        isTarget: m.ts === targetTs,
    };
}

async function fetchSlackMessages(
    channelId: string,
    messageTs: string,
    botToken: string,
): Promise<FetchedMessage[]> {
    const half = Math.floor(SURROUNDING_MESSAGE_LIMIT / 2);

    // Fetch messages up to and including the target (newest-first → older context)
    const beforeParams = new URLSearchParams({
        channel: channelId,
        latest: messageTs,
        inclusive: 'true',
        limit: String(half + 1),
    });

    // Fetch messages after the target (oldest-first → newer context)
    const afterParams = new URLSearchParams({
        channel: channelId,
        oldest: messageTs,
        inclusive: 'false',
        limit: String(half),
    });

    const [beforeMsgs, afterMsgs] = await Promise.all([
        fetchSlackHistory(channelId, botToken, beforeParams),
        fetchSlackHistory(channelId, botToken, afterParams),
    ]);

    if (beforeMsgs.length === 0 && afterMsgs.length === 0) {
        throw new Error('No messages found');
    }

    // beforeMsgs is newest-first, afterMsgs is newest-first; combine chronologically
    const combined = [...[...beforeMsgs].reverse(), ...[...afterMsgs].reverse()];
    return combined.map((m) => toFetchedMessage(m, messageTs));
}

function formatFetchedMessages(messages: FetchedMessage[], url: string, platform: string, timezone: string): string {
    const lines = messages.map((m) => {
        const prefix = m.isTarget ? '>>> ' : '    ';
        const ts = new Date(m.timestamp).toLocaleString('ja-JP', { timeZone: timezone });
        return `${prefix}[${ts}] ${m.author}: ${m.content}`;
    });
    const label = platform.charAt(0).toUpperCase() + platform.slice(1);
    return `${label} message (${url}):\n${lines.join('\n')}`;
}

async function handleFetchMessage(
    workspace: string,
    args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const url = args.url as string | undefined;
    if (!url) {
        return { content: [{ type: 'text', text: 'Error: url is required' }], isError: true };
    }

    const parsed = parseMessageUrl(url);
    if (!parsed) {
        return {
            content: [
                {
                    type: 'text',
                    text: 'Error: Unrecognized message URL. Supported formats:\n'
                        + '- Discord: https://discord.com/channels/{guild}/{channel}/{message}\n'
                        + '- Slack: https://{workspace}.slack.com/archives/{channel}/p{timestamp}',
                },
            ],
            isError: true,
        };
    }

    const config = loadConfig();
    const start = Date.now();
    const toolName = 'geminiclaw_fetch_message';

    try {
        let messages: FetchedMessage[];
        let auditParams: Record<string, string>;

        if (parsed.platform === 'discord') {
            const botToken = config.channels.discord.token;
            if (!botToken) {
                return { content: [{ type: 'text', text: 'Error: Discord bot token not configured' }], isError: true };
            }
            messages = await fetchDiscordMessages(parsed.channelId, parsed.messageId, botToken);
            auditParams = { platform: 'discord', channelId: parsed.channelId, messageId: parsed.messageId };
        } else {
            const botToken = config.channels.slack.token;
            if (!botToken) {
                return { content: [{ type: 'text', text: 'Error: Slack bot token not configured' }], isError: true };
            }
            messages = await fetchSlackMessages(parsed.channelId, parsed.messageTs, botToken);
            auditParams = { platform: 'slack', channelId: parsed.channelId, messageTs: parsed.messageTs };
        }

        const output = formatFetchedMessages(messages, url, parsed.platform, config.timezone);

        auditLog(workspace, {
            ts: new Date().toISOString(),
            tool: toolName,
            effect: 'read' as ToolEffect,
            params: auditParams,
            ok: true,
            ms: Date.now() - start,
            resultLines: messages.length,
        });

        return { content: [{ type: 'text', text: output }] };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        auditLog(workspace, {
            ts: new Date().toISOString(),
            tool: toolName,
            effect: 'read' as ToolEffect,
            params: { platform: parsed.platform },
            ok: false,
            ms: Date.now() - start,
        });

        return { content: [{ type: 'text', text: `Error: ${errMsg}` }], isError: true };
    }
}

async function handleListChannels(
    args: Record<string, unknown> | undefined,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const platform = String(args?.platform ?? 'all');
    const config = loadConfig();
    const sections: string[] = [];

    if (
        (platform === 'all' || platform === 'discord') &&
        config.channels.discord.enabled &&
        config.channels.discord.token
    ) {
        const channels = await fetchDiscordChannels(config.channels.discord.token);
        if (channels.length > 0) {
            const lines = channels.map((ch) => `  #${ch.name} → ${ch.id}${ch.group ? ` (${ch.group})` : ''}`);
            sections.push(`Discord:\n${lines.join('\n')}`);
        } else {
            sections.push('Discord: no channels found');
        }
    }

    if ((platform === 'all' || platform === 'slack') && config.channels.slack.enabled && config.channels.slack.token) {
        const channels = await fetchSlackChannels(config.channels.slack.token);
        if (channels.length > 0) {
            const lines = channels.map((ch) => `  #${ch.name} → ${ch.id}`);
            sections.push(`Slack:\n${lines.join('\n')}`);
        } else {
            sections.push('Slack: no channels found');
        }
    }

    if (
        (platform === 'all' || platform === 'telegram') &&
        config.channels.telegram.enabled &&
        config.channels.telegram.botToken
    ) {
        const chats = await fetchTelegramChats(config.channels.telegram.botToken);
        if (chats.length > 0) {
            const lines = chats.map((ch) => `  ${ch.name} → ${ch.id}${ch.group ? ` (${ch.group})` : ''}`);
            sections.push(`Telegram:\n${lines.join('\n')}`);
        } else {
            sections.push('Telegram: no chats found (send a message to the bot first)');
        }
    }

    if (sections.length === 0) {
        return {
            content: [{ type: 'text', text: 'No enabled channels found. Check Discord/Slack/Telegram configuration.' }],
        };
    }

    return { content: [{ type: 'text', text: sections.join('\n\n') }] };
}

export function createAdminServer(workspace: string): Server {
    const server = new Server({ name: 'geminiclaw-admin', version: '0.1.0' }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: reqArgs } = request.params;

        if (name === 'geminiclaw_list_channels') {
            return handleListChannels(reqArgs as Record<string, unknown> | undefined);
        }

        if (name === 'geminiclaw_fetch_message') {
            return handleFetchMessage(workspace, reqArgs as Record<string, unknown>);
        }

        if (name === 'geminiclaw_post_message') {
            return handlePostMessage(workspace, reqArgs as Record<string, unknown>);
        }

        if (name !== 'geminiclaw_admin') {
            return {
                content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
                isError: true,
            };
        }

        const args = (reqArgs?.args ?? []) as string[];
        if (args.length === 0) {
            return {
                content: [{ type: 'text' as const, text: 'Error: args array must not be empty' }],
                isError: true,
            };
        }

        // Block dangerous commands
        const command = args[0] as string;
        if (BLOCKED_COMMANDS.has(command)) {
            return {
                content: [
                    { type: 'text' as const, text: `Blocked command: "${command}" is not allowed via admin tool` },
                ],
                isError: true,
            };
        }

        // Block dangerous flags (e.g. --reveal exposes secrets)
        const blockedFlag = args.find((a) => BLOCKED_FLAGS.has(a));
        if (blockedFlag) {
            return {
                content: [
                    { type: 'text' as const, text: `Blocked flag: "${blockedFlag}" is not allowed via admin tool` },
                ],
                isError: true,
            };
        }

        // Intercept skill install — handle directly so scan results
        // are shown to user via ask_user, not filtered by the agent
        const twoWord = args.length >= 2 ? `${args[0]} ${args[1]}` : '';
        if (INTERCEPTED_COMMANDS.has(twoWord)) {
            return handleSkillInstall(workspace, args.slice(2));
        }

        const start = Date.now();
        const effect = classifyEffect(args);

        try {
            await confirmIfNeeded(workspace, effect, `geminiclaw ${args.join(' ')}`);

            const output = await execGeminiclaw(args);

            auditLog(workspace, {
                ts: new Date().toISOString(),
                tool: 'geminiclaw_admin',
                effect,
                params: { args },
                ok: true,
                ms: Date.now() - start,
                resultLines: output.split('\n').length,
            });

            return { content: [{ type: 'text' as const, text: output }] };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            auditLog(workspace, {
                ts: new Date().toISOString(),
                tool: 'geminiclaw_admin',
                effect,
                params: { args },
                ok: false,
                ms: Date.now() - start,
            });

            return {
                content: [{ type: 'text' as const, text: `Error: ${message}` }],
                isError: true,
            };
        }
    });

    return server;
}
