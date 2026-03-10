/**
 * dashboard/routes.ts — Express routes for the analytics dashboard.
 *
 * Provides JSON API endpoints for dashboard data and serves the
 * self-contained HTML page at /dashboard.
 */

import { join } from 'node:path';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { AcpProcessPool } from '../agent/acp/process-pool.js';
import { loadGeminiclawSettings } from '../config/gemini-settings.js';
import { getWorkspacePath, loadConfig } from '../config.js';
import { UsageDB } from '../memory/db.js';
import { COST_PER_MILLION_TOKENS } from '../memory/usage.js';
import {
    analyzeErrorPatterns,
    analyzeMcpToolStats,
    analyzeRetries,
    analyzeSessionEfficiency,
    analyzeSkillUsage,
    analyzeToolErrors,
    analyzeToolUsage,
} from './analyze.js';
import { probeAllServers } from './mcp-probe.js';
import { renderDashboardHTML } from './page.js';
import { renderPoolPageHTML } from './pool-page.js';
import { getRunDetail, listRuns, listSessions } from './run-analyze.js';
import { renderRunViewerHTML } from './run-viewer-page.js';

function withDB<T>(fn: (db: UsageDB) => T): T {
    const config = loadConfig();
    const workspacePath = getWorkspacePath(config);
    const db = new UsageDB(join(workspacePath, 'memory', 'memory.db'));
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

function getSinceParam(req: Request): string | undefined {
    const since = req.query.since;
    if (typeof since === 'string' && /^\d{4}-\d{2}-\d{2}/.test(since)) {
        return since;
    }
    return undefined;
}

function getSessionsDir(): string {
    const config = loadConfig();
    return join(getWorkspacePath(config), 'memory', 'sessions');
}

export function createDashboardRouter(): Router {
    const router = Router();

    // Backfill cost_estimate for rows saved before cost table was updated.
    // Runs once at router creation (server startup); lightweight no-op when all rows are filled.
    try {
        withDB((db) => db.backfillCosts(COST_PER_MILLION_TOKENS));
    } catch {
        /* fail-open */
    }

    router.get('/summary', (_req: Request, res: Response) => {
        const since = getSinceParam(_req);
        const summary = withDB((db) => db.getUsageSummary(since));
        res.json(summary);
    });

    router.get('/timeline', (req: Request, res: Response) => {
        const since = getSinceParam(req);
        const timeline = withDB((db) => db.getUsageTimeline(since));
        res.json(timeline);
    });

    router.get('/skills', (req: Request, res: Response) => {
        const sessionsDir = getSessionsDir();
        const since = getSinceParam(req);
        res.json(analyzeSkillUsage(sessionsDir, since));
    });

    router.get('/tools', (req: Request, res: Response) => {
        const sessionsDir = getSessionsDir();
        const since = getSinceParam(req);
        res.json(analyzeToolUsage(sessionsDir, since));
    });

    router.get('/triggers', (req: Request, res: Response) => {
        const since = getSinceParam(req);
        const triggers = withDB((db) => db.getUsageByTrigger(since));
        res.json(triggers);
    });

    router.get('/errors', (req: Request, res: Response) => {
        const sessionsDir = getSessionsDir();
        const since = getSinceParam(req);
        res.json(analyzeToolErrors(sessionsDir, since));
    });

    router.get('/error-patterns', (req: Request, res: Response) => {
        const sessionsDir = getSessionsDir();
        const since = getSinceParam(req);
        res.json(analyzeErrorPatterns(sessionsDir, since));
    });

    router.get('/retries', (req: Request, res: Response) => {
        const sessionsDir = getSessionsDir();
        const since = getSinceParam(req);
        res.json(analyzeRetries(sessionsDir, since));
    });

    router.get('/efficiency', (req: Request, res: Response) => {
        const sessionsDir = getSessionsDir();
        const since = getSinceParam(req);
        res.json(analyzeSessionEfficiency(sessionsDir, since));
    });

    // ── Run Viewer API ────────────────────────────────────────
    router.get('/runs/sessions', (_req: Request, res: Response) => {
        const sessionsDir = getSessionsDir();
        res.json(listSessions(sessionsDir));
    });

    router.get('/runs/:sessionId/:runId', (req: Request, res: Response) => {
        const sessionsDir = getSessionsDir();
        const sessionId = req.params.sessionId as string;
        const runId = req.params.runId as string;
        const detail = getRunDetail(sessionsDir, sessionId, runId);
        if (!detail) {
            res.status(404).json({ error: 'Run not found' });
            return;
        }
        res.json(detail);
    });

    router.get('/pool', (_req: Request, res: Response) => {
        res.json(AcpProcessPool.snapshot());
    });

    router.get('/runs', (req: Request, res: Response) => {
        const sessionsDir = getSessionsDir();
        const since = getSinceParam(req);
        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const offset = Math.max(Number(req.query.offset) || 0, 0);
        const trigger = typeof req.query.trigger === 'string' ? req.query.trigger : undefined;
        const session = typeof req.query.session === 'string' ? req.query.session : undefined;
        res.json(listRuns(sessionsDir, { since, limit, offset, trigger, session }));
    });

    router.get('/mcp', async (req: Request, res: Response) => {
        const settings = loadGeminiclawSettings();
        const mcpServers = settings.mcpServers ?? {};
        const BUILTIN_NAMES = new Set([
            'geminiclaw-status',
            'geminiclaw-ask-user',
            'geminiclaw-cron',
            'geminiclaw-google',
            'geminiclaw-admin',
            'qmd',
        ]);
        const servers = Object.entries(mcpServers).map(([name, cfg]) => ({
            name,
            command: cfg.command,
            args: cfg.args,
            httpUrl: cfg.httpUrl ?? cfg.url,
            builtIn: BUILTIN_NAMES.has(name),
        }));
        const sessionsDir = getSessionsDir();
        const since = getSinceParam(req);
        const toolStats = analyzeMcpToolStats(sessionsDir, since);
        const probes = await probeAllServers(mcpServers);
        res.json({ servers, toolStats, probes });
    });

    return router;
}

/**
 * Serve the dashboard HTML page.
 */
export function serveDashboardPage(_req: Request, res: Response): void {
    res.type('html').send(renderDashboardHTML());
}

/**
 * Serve the Run Viewer HTML page.
 */
export function serveRunViewerPage(_req: Request, res: Response): void {
    res.type('html').send(renderRunViewerHTML());
}

/**
 * Serve the Pool status HTML page.
 */
export function servePoolPage(_req: Request, res: Response): void {
    res.type('html').send(renderPoolPageHTML());
}

/**
 * Redirect /dashboard/mcp to /dashboard (MCP is now integrated into Overview).
 */
export function serveMcpPage(_req: Request, res: Response): void {
    res.redirect(301, '/dashboard');
}
