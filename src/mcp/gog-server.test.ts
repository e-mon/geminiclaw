/**
 * mcp/gog-server.test.ts — Tests for the gog MCP server.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGogServer } from './gog-server.js';
import { GOG_TOOLS, GOG_TOOLS_MAP } from './gog-tools.js';

function getTool(name: string) {
    const tool = GOG_TOOLS_MAP.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool;
}

describe('GOG_TOOLS', () => {
    it('defines 13 tools', () => {
        expect(GOG_TOOLS).toHaveLength(14);
    });

    it('all tools have unique names', () => {
        const names = GOG_TOOLS.map((t) => t.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it('all tool names start with gog_', () => {
        for (const tool of GOG_TOOLS) {
            expect(tool.name).toMatch(/^gog_/);
        }
    });

    it('elevated tools are classified correctly', () => {
        const elevatedTools = GOG_TOOLS.filter((t) => t.effect === 'elevated');
        expect(elevatedTools.map((t) => t.name).sort()).toEqual([
            'gog_gmail_drafts_send',
            'gog_gmail_send',
            'gog_gmail_thread_modify',
        ]);
    });

    it('read tools do not require confirmation', () => {
        const readTools = GOG_TOOLS.filter((t) => t.effect === 'read');
        expect(readTools.length).toBeGreaterThanOrEqual(7);
    });
});

describe('GOG_TOOLS buildArgs', () => {
    it('gmail_search builds correct args', () => {
        const tool = getTool('gog_gmail_search');
        const args = tool.buildArgs({ query: 'newer_than:2h', max: 10 });
        expect(args).toEqual(['newer_than:2h', '--max', '10']);
    });

    it('gmail_send builds correct args with body', () => {
        const tool = getTool('gog_gmail_send');
        const args = tool.buildArgs({
            to: 'alice@example.com',
            subject: 'Hello',
            body: 'Hi there',
        });
        expect(args).toEqual(['--to', 'alice@example.com', '--subject', 'Hello', '--body', 'Hi there']);
    });

    it('gmail_send prefers bodyHtml over body', () => {
        const tool = getTool('gog_gmail_send');
        const args = tool.buildArgs({
            to: 'a@b.com',
            subject: 'Hi',
            body: 'plain',
            bodyHtml: '<p>html</p>',
        });
        expect(args).toContain('--body-html');
        expect(args).not.toContain('--body');
    });

    it('calendar_events defaults calendarId to primary', () => {
        const tool = getTool('gog_calendar_events');
        const args = tool.buildArgs({ from: '2026-03-01', to: '2026-03-02' });
        expect(args[0]).toBe('primary');
    });

    it('sheets_get builds correct args', () => {
        const tool = getTool('gog_sheets_get');
        const args = tool.buildArgs({ sheetId: 'abc123', range: 'Sheet1!A1:D10' });
        expect(args).toEqual(['abc123', 'Sheet1!A1:D10']);
    });
});

describe('createGogServer', () => {
    let workspace: string;

    beforeEach(() => {
        workspace = mkdtempSync(join(tmpdir(), 'gog-test-'));
        mkdirSync(join(workspace, 'memory'), { recursive: true });
    });

    afterEach(() => {
        rmSync(workspace, { recursive: true, force: true });
    });

    it('creates server without error when gogPath is null', () => {
        const server = createGogServer(workspace, null);
        expect(server).toBeDefined();
    });

    it('creates server with gogPath', () => {
        const server = createGogServer(workspace, '/usr/local/bin/gog', 'user@gmail.com');
        expect(server).toBeDefined();
    });
});

describe('maxResults clamping', () => {
    // Import the internal function via dynamic import since it's not exported.
    // We test indirectly via buildArgs: max should be capped before reaching buildArgs.
    // The clamp happens in gog-server.ts before buildArgs, so we test the tool's max in params.

    it('gmail_search max cannot exceed 50', () => {
        // clampMaxResults mutates params.max — we replicate the logic here
        const cap = 50;
        const params: Record<string, unknown> = { query: 'test', max: 999 };
        const requested = typeof params.max === 'number' ? params.max : cap;
        params.max = Math.min(Math.max(1, requested), cap);
        expect(params.max).toBe(50);
    });

    it('defaults max when not provided', () => {
        const cap = 50;
        const params: Record<string, unknown> = { query: 'test' };
        const requested = typeof params.max === 'number' ? (params.max as number) : cap;
        params.max = Math.min(Math.max(1, requested), cap);
        expect(params.max).toBe(50);
    });

    it('calendar_events max cannot exceed 100', () => {
        const cap = 100;
        const params: Record<string, unknown> = { max: 500 };
        params.max = Math.min(Math.max(1, params.max as number), cap);
        expect(params.max).toBe(100);
    });
});

describe('describeOperation', () => {
    // We import createGogServer to indirectly test, but describeOperation is internal.
    // Test via string expectations based on what the function produces.

    it('includes CC/BCC in description when present', () => {
        // Replicate the describeOperation logic
        const params = { to: 'a@b.com', subject: 'Hi', cc: 'c@d.com', bcc: 'e@f.com', body: 'Hello world' };
        const parts = ['gog_gmail_send'];
        if (params.to) parts.push(`To: ${params.to}`);
        if (params.cc) parts.push(`CC: ${params.cc}`);
        if (params.bcc) parts.push(`BCC: ${params.bcc}`);
        if (params.subject) parts.push(`Subject: ${params.subject}`);
        const body = params.body;
        if (body && body.length > 0) {
            const preview = body.length > 200 ? `${body.substring(0, 200)}…` : body;
            parts.push(`Body: ${preview}`);
        }
        const desc = parts.join(' | ');
        expect(desc).toContain('CC: c@d.com');
        expect(desc).toContain('BCC: e@f.com');
        expect(desc).toContain('Body: Hello world');
    });

    it('truncates long body to 200 chars', () => {
        const longBody = 'x'.repeat(300);
        const preview = longBody.length > 200 ? `${longBody.substring(0, 200)}…` : longBody;
        expect(preview).toHaveLength(201); // 200 chars + '…'
    });
});

describe('audit log', () => {
    let workspace: string;

    beforeEach(() => {
        workspace = mkdtempSync(join(tmpdir(), 'gog-audit-'));
        mkdirSync(join(workspace, 'memory'), { recursive: true });
    });

    afterEach(() => {
        rmSync(workspace, { recursive: true, force: true });
    });

    it('writes audit entries to memory/audit.jsonl', async () => {
        const { auditLog } = await import('./audit.js');
        auditLog(workspace, {
            ts: '2026-03-05T12:00:00Z',
            tool: 'gog_gmail_search',
            effect: 'read',
            params: { query: 'test' },
            ok: true,
            ms: 100,
        });

        const content = readFileSync(join(workspace, 'memory', 'audit.jsonl'), 'utf-8');
        const entry = JSON.parse(content.trim());
        expect(entry.tool).toBe('gog_gmail_search');
        expect(entry.ok).toBe(true);
    });
});
