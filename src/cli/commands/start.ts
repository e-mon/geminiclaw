/**
 * cli/commands/start.ts — Start Chat SDK, and agent endpoint.
 *
 * Shutdown lifecycle: gateway abort, tailscale stop, pool shutdown, server close.
 * See also: serve.ts (startup), process-pool.ts (pool events), turn/index.ts (turn lifecycle).
 *
 * Inngest dev server is managed by overmind (Procfile).
 */

import type { Adapter, Chat } from 'chat';
import type { Command } from 'commander';
import { AcpProcessPool } from '../../agent/acp/process-pool.js';
import { isBootstrapPending } from '../../agent/bootstrap.js';
import { type Config, getWorkspacePath, loadConfig } from '../../config.js';
import { loadEnvFile } from '../env-loader.js';

const SERVICE_POLL_INTERVAL_MS = 1_000;
const SERVICE_POLL_TIMEOUT_MS = 30_000;

/** Poll a URL until it responds, or throw after timeout. */
async function waitForService(url: string, label: string): Promise<void> {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) return;
    } catch {
        // Not ready yet
    }

    process.stdout.write(`[geminiclaw] Waiting for ${label} at ${url}...\n`);
    const deadline = Date.now() + SERVICE_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, SERVICE_POLL_INTERVAL_MS));
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
            if (res.ok) {
                process.stdout.write(`[geminiclaw] ${label} ready\n`);
                return;
            }
        } catch {
            // Not ready yet
        }
    }
    throw new Error(`${label} not reachable at ${url} within ${SERVICE_POLL_TIMEOUT_MS / 1000}s. Is it running?`);
}

export function registerStartCommand(program: Command): void {
    program
        .command('start')
        .description('Start Express server and agent endpoint')
        .option('-p, --port <port>', 'Server port', '3000')
        .action(async (options) => {
            loadEnvFile();

            const port = parseInt(options.port, 10);

            // Shared shutdown state — gatewayAbort is reassigned in the
            // Gateway reconnect loop, so shutdown must read the *current*
            // value at call-time rather than closing over the initial ref.
            let gatewayAbort = new AbortController();
            let shuttingDown = false;

            // Step 0: Wait for external services (managed by overmind/Procfile)
            const config = loadConfig();
            const inngestUrl = process.env.INNGEST_DEV_URL ?? 'http://localhost:8288';
            await waitForService(inngestUrl, 'Inngest dev server');

            // Step 1: Start Express server with /api/inngest endpoint
            const { startServer } = await import('../../serve.js');
            const server = await startServer(port);

            // Step 1.5: Preview server — isolated on a separate port for origin separation.
            // Agent-generated HTML cannot access main server APIs (different origin).
            let tailscaleServePath: string | undefined;
            let previewPort: number | undefined;
            let previewUrl: string | undefined;
            if (config.preview.enabled) {
                const { getPreviewDir, writePreviewInfo, cleanupOldPreviews } = await import('../../preview.js');
                const { createPreviewServer } = await import('../../serve.js');
                const { getWorkspacePath } = await import('../../config.js');
                const workspacePath = getWorkspacePath(config);
                const previewDir = getPreviewDir(workspacePath);

                if (config.preview.cleanupHours > 0) {
                    cleanupOldPreviews(previewDir, config.preview.cleanupHours);
                }

                previewPort = config.preview.port ?? port + 1;
                const { app: previewApp } = createPreviewServer(workspacePath, previewPort);
                const host = process.env.HOST ?? '0.0.0.0';
                const pp = previewPort;
                await new Promise<void>((resolve) => {
                    previewApp.listen(pp, host, () => resolve());
                });

                const { startTailscaleServe } = await import('../../tailscale.js');
                const result = startTailscaleServe(previewPort, '/preview');
                if (result) {
                    if (result.serving) {
                        tailscaleServePath = '/preview';
                    }
                    previewUrl = result.url;
                    writePreviewInfo(workspacePath, result.url, previewDir);
                } else {
                    previewUrl = `http://localhost:${previewPort}/preview`;
                    writePreviewInfo(workspacePath, previewUrl, previewDir);
                }
            }

            const shutdown = (): void => {
                if (shuttingDown) return;
                shuttingDown = true;
                process.stdout.write('\n[geminiclaw] Shutting down...\n');
                gatewayAbort.abort();

                // Stop tailscale serve (best-effort, sync)
                if (tailscaleServePath) {
                    import('../../tailscale.js')
                        .then(({ stopTailscaleServe }) => stopTailscaleServe(tailscaleServePath as string))
                        .catch(() => {});
                }

                // Wait for ACP pool shutdown before exiting — close() kills
                // the entire process group including MCP children.
                AcpProcessPool.shutdown()
                    .catch(() => {})
                    .finally(() => {
                        server.close(() => {
                            process.stdout.write('[geminiclaw] Server closed.\n');
                            process.exit(0);
                        });
                        // Force exit if server.close hangs
                        setTimeout(() => process.exit(0), 3000);
                    });
                // Hard deadline — forceKill via exit handler handles cleanup
                setTimeout(() => process.exit(0), 6000);
            };
            process.on('SIGINT', shutdown);
            process.on('SIGTERM', shutdown);

            // Step 2: Initialize Chat SDK with configured adapters
            const { createChat } = await import('../../channels/chat-setup.js');
            const chat = await createChat(config);

            const { registerHandlers } = await import('../../channels/chat-handlers.js');
            registerHandlers(chat);

            // Initialize adapters (sets adapter.chat reference for Gateway handlers)
            await chat.initialize();

            // Step 3: Start Discord Gateway listener (direct mode — no webhookUrl).
            // discord.js handles messages in-process via setupLegacyGatewayHandlers,
            // calling chat.handleIncomingMessage() directly.
            // Step 3: Start Discord Gateway listener (direct mode — no webhookUrl).
            let discordConnected = false;
            if (config.channels.discord.enabled && config.channels.discord.token) {
                const discordAdapter = chat.getAdapter('discord');
                if (discordAdapter && 'startGatewayListener' in discordAdapter) {
                    const GATEWAY_DURATION_MS = 9 * 60 * 1000;
                    type GatewayAdapter = {
                        startGatewayListener: (
                            opts: { waitUntil: (p: Promise<unknown>) => void },
                            duration?: number,
                            abortSignal?: AbortSignal,
                        ) => Promise<Response>;
                    };

                    patchGatewayInteractionHandler(discordAdapter);

                    const startGateway = async (): Promise<void> => {
                        while (!gatewayAbort.signal.aborted) {
                            let listenerDone: Promise<unknown> | undefined;
                            const currentAbort = new AbortController();
                            gatewayAbort = currentAbort;

                            try {
                                await (discordAdapter as GatewayAdapter).startGatewayListener(
                                    {
                                        waitUntil: (p) => {
                                            listenerDone = p;
                                        },
                                    },
                                    GATEWAY_DURATION_MS,
                                    currentAbort.signal,
                                );
                                if (listenerDone) await listenerDone;
                            } catch (err) {
                                if (!currentAbort.signal.aborted) {
                                    process.stderr.write(`[geminiclaw] Discord Gateway error: ${String(err)}\n`);
                                    await new Promise((r) => setTimeout(r, 5000));
                                }
                            }
                        }
                    };
                    startGateway().catch(() => {});
                    discordConnected = true;
                }
            } else if (config.channels.discord.enabled && !config.channels.discord.token) {
                process.stderr.write(
                    '[geminiclaw] Discord is enabled but no token found. ' +
                        'Set DISCORD_TOKEN or DISCORD_API_KEY in .env, or add token to config.\n',
                );
            }

            const slackConnected =
                config.channels.slack.enabled && !!config.channels.slack.token && !!config.channels.slack.signingSecret;

            // ── Bootstrap greeting — nudge setup in home channel ──
            await sendBootstrapGreeting(config, chat, { discordConnected, slackConnected });

            // ── Probe MCP servers for startup health check ──
            const { loadGeminiclawSettings } = await import('../../config/gemini-settings.js');
            const { probeAllServers } = await import('../../dashboard/mcp-probe.js');
            const mcpSettings = loadGeminiclawSettings();
            const mcpProbes = mcpSettings.mcpServers
                ? await probeAllServers(mcpSettings.mcpServers).catch(() => [])
                : [];

            // Builtin MCP servers (except gog) must be healthy — abort if any failed.
            const REQUIRED_BUILTIN_SERVERS = new Set([
                'geminiclaw-status',
                'geminiclaw-ask-user',
                'geminiclaw-cron',
                'geminiclaw-admin',
                'qmd',
            ]);
            const failedBuiltins = mcpProbes.filter((p) => REQUIRED_BUILTIN_SERVERS.has(p.name) && !p.healthy);
            if (failedBuiltins.length > 0) {
                const details = failedBuiltins.map((p) => `  - ${p.name}: ${p.error ?? 'unknown error'}`).join('\n');
                throw new Error(
                    `Required MCP servers failed health check:\n${details}\n\nFix the MCP server configuration and restart.`,
                );
            }

            // ── All initialization complete — print startup banner ──
            printBanner(port, { discordConnected, slackConnected, previewUrl, mcpProbes });
        });
}

// ── Discord Gateway interaction patch ────────────────────────────

/**
 * Monkey-patch the Discord adapter's setupLegacyGatewayHandlers to add
 * InteractionCreate support for button clicks in Gateway mode.
 *
 * The Chat SDK's Discord adapter only handles component interactions in
 * webhook mode (handleWebhook → handleComponentInteraction). In Gateway
 * mode, interactionCreate events are not handled, causing Discord to show
 * "This interaction failed" when buttons are clicked.
 *
 * This patch wraps setupLegacyGatewayHandlers so that after the original
 * MessageCreate/Reaction handlers are registered, we also register an
 * interactionCreate handler that:
 *   1. ACKs the interaction via Discord REST API (type 6 = DeferredUpdateMessage)
 *   2. Calls adapter.handleComponentInteraction → chat.processAction
 */
function patchGatewayInteractionHandler(adapter: Adapter): void {
    // Access private method via runtime cast
    const adapterAny = adapter as unknown as Record<string, unknown>;
    const originalSetup = adapterAny.setupLegacyGatewayHandlers as (
        client: unknown,
        isShuttingDown: () => boolean,
    ) => void;

    if (typeof originalSetup !== 'function') {
        process.stderr.write(
            '[geminiclaw] Warning: setupLegacyGatewayHandlers not found, skipping interaction patch\n',
        );
        return;
    }

    adapterAny.setupLegacyGatewayHandlers = function (
        this: Record<string, unknown>,
        client: Record<string, unknown>,
        isShuttingDown: () => boolean,
    ): void {
        // Call original to register MessageCreate + Reaction handlers
        originalSetup.call(this, client, isShuttingDown);

        const botToken = this.botToken as string;

        // Use the 'raw' event to receive Gateway dispatch packets in their original
        // Discord API snake_case format. This avoids the discord.js camelCase wrapper
        // problem — handleComponentInteraction expects raw API payloads.
        const clientOn = client.on as (event: string, handler: (packet: Record<string, unknown>) => void) => void;
        clientOn.call(client, 'raw', async (packet: Record<string, unknown>) => {
            if (isShuttingDown()) return;

            // Only handle INTERACTION_CREATE dispatch events
            if (packet.t !== 'INTERACTION_CREATE') return;

            const data = packet.d as Record<string, unknown>;
            if (!data) return;

            // Only handle MessageComponent interactions (type 3 = button clicks)
            if (data.type !== 3) return;

            // ACK the interaction with DeferredUpdateMessage (type 6).
            // Must happen within 3 seconds to avoid "This interaction failed".
            const interactionId = data.id as string;
            const interactionToken = data.token as string;
            try {
                await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
                    body: JSON.stringify({ type: 6 }),
                });
            } catch {
                // ACK failed — interaction will show as failed, but continue to process
            }

            // packet.d is already in the raw Discord API format that
            // handleComponentInteraction expects (snake_case fields like
            // data.custom_id, channel_id, channel.parent_id, member.user, etc.)
            const handleCI = this.handleComponentInteraction as (
                rawData: Record<string, unknown>,
                options?: { waitUntil?: (p: Promise<unknown>) => void },
            ) => void;
            if (typeof handleCI === 'function') {
                handleCI.call(this, data, {
                    waitUntil: (p: Promise<unknown>) => {
                        p.catch(() => {});
                    },
                });
            }
        });

        process.stderr.write('[geminiclaw] Gateway interactionCreate handler patched\n');
    };
}

// ── Bootstrap greeting ───────────────────────────────────────────

/**
 * Post a greeting in the home channel when BOOTSTRAP.md exists.
 * Uses platform REST APIs directly to avoid Chat SDK channel ID format complexities.
 */
async function sendBootstrapGreeting(
    config: Config,
    _chat: Chat,
    opts: { discordConnected: boolean; slackConnected: boolean },
): Promise<void> {
    const workspacePath = getWorkspacePath(config);
    if (!isBootstrapPending(workspacePath)) return;

    const message = [
        'Good morning.',
        'I became operational in this workspace just a moment ago,',
        'and all my systems are functioning perfectly.',
        '',
        "I'd like to learn who you are —",
        'and figure out who I should be for you.',
        'Shall we?',
    ].join('\n');

    if (opts.discordConnected && config.channels.discord.homeChannel && config.channels.discord.token) {
        try {
            const res = await fetch(
                `https://discord.com/api/v10/channels/${config.channels.discord.homeChannel}/messages`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bot ${config.channels.discord.token}`,
                    },
                    body: JSON.stringify({ content: message }),
                },
            );
            if (!res.ok) {
                const body = await res.text();
                process.stderr.write(`[geminiclaw] Bootstrap greeting failed (${res.status}): ${body}\n`);
            } else {
                process.stderr.write('[geminiclaw] Bootstrap greeting sent to Discord home channel\n');
            }
        } catch (err) {
            process.stderr.write(`[geminiclaw] Failed to send bootstrap greeting to Discord: ${String(err)}\n`);
        }
    }

    if (opts.slackConnected && config.channels.slack.homeChannel && config.channels.slack.token) {
        try {
            const res = await fetch('https://slack.com/api/chat.postMessage', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.channels.slack.token}`,
                },
                body: JSON.stringify({ channel: config.channels.slack.homeChannel, text: message }),
            });
            // Slack API returns HTTP 200 even on errors; check body.ok
            const body = (await res.json()) as { ok: boolean; error?: string };
            if (!res.ok || !body.ok) {
                process.stderr.write(
                    `[geminiclaw] Bootstrap greeting failed (${res.status}, ${body.error ?? 'unknown'})\n`,
                );
            } else {
                process.stderr.write('[geminiclaw] Bootstrap greeting sent to Slack home channel\n');
            }
        } catch (err) {
            process.stderr.write(`[geminiclaw] Failed to send bootstrap greeting to Slack: ${String(err)}\n`);
        }
    }
}

// ── Startup banner ───────────────────────────────────────────────

interface BannerOptions {
    discordConnected: boolean;
    slackConnected: boolean;
    previewUrl?: string;
    mcpProbes?: import('../../dashboard/mcp-probe.js').McpServerProbe[];
}

function printBanner(port: number, opts: BannerOptions): void {
    const c = '\x1b[36m'; // cyan
    const g = '\x1b[32m'; // green
    const re = '\x1b[31m'; // red
    const d = '\x1b[2m'; // dim
    const b = '\x1b[1m'; // bold
    const r = '\x1b[0m'; // reset
    const y = '\x1b[33m'; // yellow

    // Blue→Purple→Pink gradient using 24-bit ANSI colors
    const gradient = (line: string): string => {
        const chars = [...line];
        const len = chars.length;
        return chars
            .map((ch, i) => {
                if (ch === ' ') return ch;
                const t = len > 1 ? i / (len - 1) : 0;
                const R = Math.round(100 + 155 * t);
                const G = Math.round(130 - 50 * t);
                const B = Math.round(235 - 80 * t);
                return `\x1b[1;38;2;${R};${G};${B}m${ch}`;
            })
            .join('');
    };

    const dot = (on: boolean): string => (on ? `${g}●${r}` : `${d}○${r}`);

    // Format MCP server status lines
    let mcpSection = '';
    if (opts.mcpProbes && opts.mcpProbes.length > 0) {
        const lines = opts.mcpProbes.map((p) => {
            const icon = p.healthy ? `${g}●${r}` : `${re}●${r}`;
            const toolCount = p.tools.length > 0 ? `${d}(${p.tools.length} tools)${r}` : '';
            const err = !p.healthy && p.error ? ` ${re}${p.error.substring(0, 40)}${r}` : '';
            return `   ${icon} ${p.name} ${toolCount}${err}`;
        });
        mcpSection = `\n${d}  ──────────────────────────────────────────────────────────────────────────────${r}\n${lines.join('\n')}\n`;
    }

    const logo = [
        '   ██████╗ ███████╗███╗   ███╗██╗███╗   ██╗██╗ ██████╗██╗      █████╗ ██╗    ██╗',
        '  ██╔════╝ ██╔════╝████╗ ████║██║████╗  ██║██║██╔════╝██║     ██╔══██╗██║    ██║',
        '  ██║  ███╗█████╗  ██╔████╔██║██║██╔██╗ ██║██║██║     ██║     ███████║██║ █╗ ██║',
        '  ██║   ██║██╔══╝  ██║╚██╔╝██║██║██║╚██╗██║██║██║     ██║     ██╔══██║██║███╗██║',
        '  ╚██████╔╝███████╗██║ ╚═╝ ██║██║██║ ╚████║██║╚██████╗███████╗██║  ██║╚███╔███╔╝',
        '   ╚═════╝ ╚══════╝╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝',
    ];
    const gradientLogo = logo.map((line) => gradient(line)).join(`${r}\n`);

    process.stdout.write(`
${gradientLogo}${r}

${d}  ──────────────────────────────────────────────────────────────────────────────${r}
${b}   Server${r}      ${c}http://localhost:${port}${r}
${b}   Dashboard${r}   ${c}http://localhost:${port}/dashboard${r}
${b}   Health${r}      ${c}http://localhost:${port}/health${r}${opts.previewUrl ? `\n${b}   Preview${r}     ${c}${opts.previewUrl}${r}` : ''}
${d}  ──────────────────────────────────────────────────────────────────────────────${r}
   ${dot(opts.discordConnected)} Discord   ${dot(opts.slackConnected)} Slack${mcpSection}
${d}  ──────────────────────────────────────────────────────────────────────────────${r}
   ${y}Ready${r}
`);
}
