/**
 * serve.ts — Inngest HTTP endpoint + Express server + Chat SDK webhooks.
 *
 * Startup lifecycle: pool configure, backfill sessions/daily, schedule crons, pre-warm.
 * See also: start.ts (shutdown), process-pool.ts (pool events), turn/index.ts (turn lifecycle).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { serve } from 'inngest/express';
import { AcpProcessPool } from './agent/acp/process-pool.js';
import { getWorkspacePath, loadConfig } from './config.js';
import {
    createDashboardRouter,
    serveDashboardPage,
    serveMcpPage,
    servePoolPage,
    serveRunViewerPage,
} from './dashboard/routes.js';
import { agentRun } from './inngest/agent-run.js';
import { inngest } from './inngest/client.js';
import { cronJobRunner, scheduleAllJobs } from './inngest/cron-scheduler.js';
import { createDailySummaryCron } from './inngest/daily-summary-cron.js';
import { createHeartbeatCron } from './inngest/heartbeat.js';
import { createLogger } from './logger.js';
import { createAdminServer } from './mcp/admin-server.js';
import { detectAccount, resolveGogPath } from './mcp/gog-helpers.js';
import { createGogServer } from './mcp/gog-server.js';
import { UsageDB } from './memory/db.js';
import { getPreviewDir } from './preview.js';
import { vault } from './vault/index.js';

const log = createLogger('server');

// Readiness gate — blocks webhook traffic until Inngest sync completes.
let serverReady = false;
export function markServerReady(): void {
    serverReady = true;
}

export async function createServer(port: number = 3000) {
    // Initialize vault before loadConfig() so $vault: references resolve.
    if (!vault.isInitialized) {
        await vault.init();
    }
    const config = loadConfig();
    const app = express();

    // Inngest step results can be large (many tool calls × trimmed output each).
    // Default 100KB is too small — raise to 10MB.
    app.use(express.json({ limit: '10mb' }));

    const workspacePath = getWorkspacePath(config);

    // QMD MCP — embedded in-process (no separate daemon or proxy).
    // Store is shared across requests; McpServer is created per-request
    // because the SDK only allows one transport per server instance.
    // QMD internal modules aren't in the package exports map — use dynamic import
    // with suppressed TS directive to bypass module resolution.
    // biome-ignore lint/suspicious/noTsIgnore: QMD dist paths not in package exports map
    // @ts-ignore — QMD dist paths not in package exports map
    const { createStore, enableProductionMode } = await import('@tobilu/qmd/dist/store.js');
    // biome-ignore lint/suspicious/noTsIgnore: QMD dist paths not in package exports map
    // @ts-ignore — QMD dist paths not in package exports map
    const { createMcpServer: createQmdMcpServer } = await import('@tobilu/qmd/dist/mcp.js');
    enableProductionMode();
    const qmdStore = createStore();
    app.all('/api/mcp/qmd', async (req, res) => {
        try {
            const server = createQmdMcpServer(qmdStore);
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            transport.onerror = (err) => log.error('qmd MCP transport error', { error: String(err) });
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            await transport.close();
            await server.close();
        } catch (err) {
            log.error('qmd MCP request failed', { error: String(err) });
            if (!res.headersSent) {
                res.status(500).json({ error: 'MCP request failed' });
            }
        }
    });
    log.info('qmd MCP embedded', { documents: qmdStore.getStatus().totalDocuments });

    // Build Docker sandbox image at startup if sandbox is enabled
    if (config.sandbox === true || config.sandbox === 'docker') {
        const { ensureSandboxImage } = await import('./agent/turn/sandbox.js');
        await ensureSandboxImage(workspacePath).catch((err) => {
            log.warn('sandbox image build failed (non-fatal)', { error: String(err).substring(0, 200) });
        });
    }

    const sessionsDir = join(workspacePath, 'memory', 'sessions');
    const summariesDir = join(workspacePath, 'memory', 'summaries');

    // Inngest endpoint — Lane Queue architecture:
    //   agentRun:      unified executor (serialized per sessionId)
    //   heartbeatCron: fires geminiclaw/run event at config.heartbeatIntervalMin interval
    //   cronJobRunner: self-rescheduling cron job runner (event-driven, no polling)
    const heartbeatCron = createHeartbeatCron(config.heartbeatIntervalMin);
    const dailySummaryCron = createDailySummaryCron({
        sessionsDir,
        summariesDir,
        workspacePath,
        model: config.heartbeat.model ?? config.model,
        timezone: config.timezone || undefined,
    });
    app.use(
        '/api/inngest',
        serve({
            client: inngest,
            functions: [agentRun, heartbeatCron, cronJobRunner, dailySummaryCron],
            streaming: 'force',
        }),
    );

    // Chat SDK webhook endpoint — receives Discord interactions and Slack events.
    // Discord Gateway listener forwards events here; Slack sends events directly.
    // The :platform param selects the adapter (e.g. /api/webhooks/discord).
    // Returns 503 until Inngest sync completes so platforms retry automatically.
    app.post('/api/webhooks/:platform', async (req, res) => {
        if (!serverReady) {
            res.status(503).json({ error: 'Server starting up, retry shortly' });
            return;
        }
        try {
            const { getChat } = await import('./channels/chat-setup.js');
            const chat = getChat();
            if (!chat) {
                res.status(503).json({ error: 'Chat SDK not initialized' });
                return;
            }

            const platform = req.params.platform as string;
            const webhookHandler = (chat.webhooks as Record<string, unknown>)[platform] as
                | ((request: Request, options?: { waitUntil?: (task: Promise<unknown>) => void }) => Promise<Response>)
                | undefined;

            if (!webhookHandler) {
                res.status(404).json({ error: `Unknown platform: ${platform}` });
                return;
            }

            // Convert Express request to standard Request for Chat SDK
            const protocol = req.protocol;
            const host = req.get('host') ?? `localhost:${port}`;
            const url = `${protocol}://${host}${req.originalUrl}`;
            const headers = new Headers();
            for (const [key, value] of Object.entries(req.headers)) {
                if (typeof value === 'string') headers.set(key, value);
                else if (Array.isArray(value)) headers.set(key, value.join(', '));
            }

            const webRequest = new Request(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(req.body),
            });

            const response = await webhookHandler(webRequest, {
                waitUntil: (p) => {
                    p.catch((err) => log.error('webhook background task failed', { error: String(err) }));
                },
            });

            // Convert standard Response back to Express response
            res.status(response.status);
            response.headers.forEach((value, key) => {
                res.setHeader(key, value);
            });
            const body = await response.text();
            res.send(body);
        } catch (err) {
            log.error('webhook handler error', { platform: req.params.platform, error: String(err) });
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    // gog MCP — Streamable HTTP endpoint for Google Workspace tools.
    // Runs on host (not inside sandbox) so Keychain/OAuth tokens are accessible.
    // Stateless mode: each request gets a fresh transport+server pair because the
    // SDK throws on transport reuse when sessionIdGenerator is undefined.
    const gogPath = resolveGogPath();
    const gogAccount = config.gogAccount || (gogPath ? detectAccount(gogPath) : undefined);
    app.all('/api/mcp/google', async (req, res) => {
        try {
            const server = createGogServer(workspacePath, gogPath, gogAccount);
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            transport.onerror = (err) => log.error('gog MCP transport error', { error: String(err) });
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            await transport.close();
            await server.close();
        } catch (err) {
            log.error('gog MCP request failed', { error: String(err) });
            if (!res.headersSent) {
                res.status(500).json({ error: 'MCP request failed' });
            }
        }
    });

    // admin MCP — Streamable HTTP endpoint for self-management.
    // Runs on host so it can invoke geminiclaw CLI commands freely.
    app.all('/api/mcp/admin', async (req, res) => {
        try {
            const server = createAdminServer(workspacePath);
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            transport.onerror = (err) => log.error('admin MCP transport error', { error: String(err) });
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            await transport.close();
            await server.close();
        } catch (err) {
            log.error('admin MCP request failed', { error: String(err) });
            if (!res.headersSent) {
                res.status(500).json({ error: 'MCP request failed' });
            }
        }
    });

    // Preview is served on a separate port for origin isolation.
    // See createPreviewServer() below.

    // Dashboard — analytics UI + JSON API
    app.use('/api/dashboard', createDashboardRouter());
    app.get('/dashboard', serveDashboardPage);
    app.get('/dashboard/runs', serveRunViewerPage);
    app.get('/dashboard/pool', servePoolPage);
    app.get('/dashboard/mcp', serveMcpPage);

    // Health check — returns workspace, database, and active-run status
    app.get('/health', (_req, res) => {
        const workspaceExists = existsSync(workspacePath);

        // DB connectivity check
        let dbOk = false;
        try {
            const db = new UsageDB(join(workspacePath, 'memory', 'memory.db'));
            db.getUsageSummary();
            db.close();
            dbOk = true;
        } catch {
            // DB unreachable or workspace not yet initialized
        }

        // Active run check: scan run-progress-*.json files written < 5 min ago
        let isWorking = false;
        let currentToolName: string | undefined;
        try {
            const memoryDir = join(workspacePath, 'memory');
            const progressFiles = readdirSync(memoryDir).filter(
                (f) => f.startsWith('run-progress') && f.endsWith('.json'),
            );

            let latestAge = Infinity;
            for (const file of progressFiles) {
                try {
                    const raw = readFileSync(join(memoryDir, file), 'utf-8').trim();
                    const progress = JSON.parse(raw) as { lastToolUse: string; toolName: string };
                    const age = Date.now() - new Date(progress.lastToolUse).getTime();
                    if (age < latestAge) {
                        latestAge = age;
                        if (age < 5 * 60 * 1000) {
                            isWorking = true;
                            currentToolName = progress.toolName;
                        }
                    }
                } catch {
                    // Skip corrupt progress files
                }
            }
        } catch {
            // No memory directory — not working
        }

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            workspace: {
                exists: workspaceExists,
                path: workspacePath,
            },
            database: { ok: dbOk },
            activeRun: {
                isWorking,
                ...(currentToolName ? { currentTool: currentToolName } : {}),
            },
        });
    });

    // Generate session summaries when ACP processes go idle or get evicted.
    // This replaces the broken inline summary generation in agent-run.ts
    // which couldn't identify the previous session ID correctly.
    AcpProcessPool.configure({
        onSessionEnd: () => {
            import('./agent/session/summary.js')
                .then(({ syncSessionSummaries }) =>
                    syncSessionSummaries({
                        sessionsDir,
                        summariesDir,
                        workspacePath,
                        model: config.sessionSummary.model ?? config.model,
                        templatePath: config.sessionSummary.template,
                        timezone: config.timezone || undefined,
                    }),
                )
                .then(() => import('./memory/qmd.js').then(({ updateQmdIndex }) => updateQmdIndex()))
                .catch((err) => log.warn('session-end sync failed', { error: String(err).substring(0, 200) }));
        },
    });

    // Sync session summaries at startup — generates missing and updates outdated ones.
    // After both syncs complete, re-index QMD so new summaries are searchable.
    const sessionSync = import('./agent/session/summary.js')
        .then(({ syncSessionSummaries }) =>
            syncSessionSummaries({
                sessionsDir,
                summariesDir,
                workspacePath,
                model: config.sessionSummary.model ?? config.model,
                templatePath: config.sessionSummary.template,
                timezone: config.timezone || undefined,
            }),
        )
        .catch((err) => log.warn('session summary sync failed', { error: String(err).substring(0, 200) }));

    // Backfill missing daily summaries for past 7 days.
    const dailyBackfill = import('./agent/session/daily-summary.js')
        .then(({ backfillMissingDailySummaries }) =>
            backfillMissingDailySummaries({
                sessionsDir,
                summariesDir,
                workspacePath,
                model: config.heartbeat.model ?? config.model,
                timezone: config.timezone || undefined,
            }),
        )
        .catch((err) => log.warn('daily session summary sync failed', { error: String(err).substring(0, 200) }));

    // Re-index QMD after all startup syncs complete.
    Promise.all([sessionSync, dailyBackfill])
        .then(() => import('./memory/qmd.js').then(({ updateQmdIndex }) => updateQmdIndex()))
        .catch((err) => log.warn('startup qmd reindex failed', { error: String(err).substring(0, 200) }));

    return { app, port };
}

import type { Server } from 'node:http';

/**
 * Create an isolated Express server for preview files.
 *
 * Runs on a separate port so that agent-generated HTML cannot access
 * the main server's API/dashboard endpoints (origin isolation).
 * CSP headers further restrict script execution.
 */
export function createPreviewServer(
    workspacePath: string,
    previewPort: number,
): { app: express.Express; port: number } {
    const previewApp = express();
    const previewDir = getPreviewDir(workspacePath);

    // CSP — agent-generated HTML may contain trusted inline scripts
    // (e.g. translate-preview toggle) and external resources from the
    // original article (images, stylesheets, fonts, embedded iframes).
    previewApp.use((_req, res, next) => {
        res.setHeader(
            'Content-Security-Policy',
            "default-src 'none'; script-src 'self' 'unsafe-inline' http: https:; img-src * data: blob:; style-src 'self' 'unsafe-inline' http: https:; font-src * data:; frame-src http: https:; media-src * data: blob:",
        );
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        next();
    });

    previewApp.use('/preview', express.static(previewDir, { dotfiles: 'deny' }));

    return { app: previewApp, port: previewPort };
}

/**
 * Poll the Inngest dev server until it has synced function definitions.
 * Inngest syncs by calling PUT on the app's /api/inngest endpoint.
 * We detect this by querying the Inngest dev server's GraphQL API
 * and checking that our functions are registered.
 */
async function waitForInngestSync(_appPort: number): Promise<void> {
    const inngestUrl = process.env.INNGEST_DEV_URL ?? 'http://localhost:8288';
    const MAX_ATTEMPTS = 30;
    const INTERVAL_MS = 1000;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        try {
            const res = await fetch(`${inngestUrl}/v0/gql`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: '{ functions { id } }' }),
            });
            if (res.ok) {
                const body = (await res.json()) as { data?: { functions?: unknown[] } };
                const count = body.data?.functions?.length ?? 0;
                if (count > 0) {
                    log.info('inngest-sync-ready', { functions: count, waitMs: i * INTERVAL_MS });
                    return;
                }
            }
        } catch {
            // Inngest dev server not ready yet
        }
        await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
    log.warn('inngest-sync-timeout', { maxAttempts: MAX_ATTEMPTS });
}

export async function startServer(port: number = 3000): Promise<Server> {
    const { app } = await createServer(port);
    const server = await new Promise<Server>((resolve) => {
        const host = process.env.HOST ?? '0.0.0.0';
        const s = app.listen(port, host, () => resolve(s));
    });

    // Wait for Inngest dev server to sync function definitions before scheduling.
    // Without this, events sent immediately on startup are received but not matched
    // to any function because the sync hasn't completed yet (race condition).
    await waitForInngestSync(port);

    // Recover sleeping cron job runs on startup
    try {
        await scheduleAllJobs();
    } catch (err) {
        log.error('cron startup recovery failed', { error: String(err) });
    }

    // Pre-warm ACP process pool so first agent run avoids cold start.
    // This MUST succeed before marking the server as ready — if the agent
    // process cannot start (e.g. sandbox misconfigured, gemini not found),
    // accepting traffic would result in every run failing immediately.
    const config = loadConfig();
    const workspacePath = getWorkspacePath(config);
    const model = config.model !== 'auto' ? config.model : undefined;
    const poolResult = await AcpProcessPool.acquire(workspacePath, undefined, model);
    await poolResult.client.newSession(workspacePath);
    AcpProcessPool.release(workspacePath, poolResult.client, model);

    markServerReady();

    return server;
}
