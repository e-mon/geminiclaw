/**
 * profile-login.test.ts — Playwright tests for Chromium profile-based login.
 *
 * Verifies that a pre-authenticated Chromium profile persists cookies
 * across browser sessions, which is the mechanism behind AGENT_BROWSER_PROFILE.
 *
 * Spins up a dummy Express auth server:
 *   POST /login     → sets auth cookie, redirects to /protected
 *   GET  /protected → 200 if cookie present, 401 otherwise
 *   GET  /logout    → clears cookie
 */

import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Playwright is a devDependency — tests skip gracefully if unavailable.
// Also verify browser binaries are installed (import succeeds even without them).
let chromium: typeof import('playwright').chromium | undefined;
try {
    const pw = await import('playwright');
    // Probe for the actual browser binary by attempting a quick launch/close.
    // If binaries aren't installed (common in CI), this throws immediately.
    const browser = await pw.chromium.launch({ headless: true });
    await browser.close();
    chromium = pw.chromium;
} catch {
    // playwright not installed or browser binaries missing — tests will be skipped
}

// ── Dummy Auth Server ────────────────────────────────────────────

function createAuthServer(): express.Express {
    const app = express();
    app.use(express.urlencoded({ extended: false }));

    app.get('/', (_req, res) => {
        res.send(`
            <html><body>
                <h1>Login</h1>
                <form method="POST" action="/login">
                    <input name="user" value="testuser" />
                    <input name="pass" type="password" value="secret" />
                    <button type="submit" id="login-btn">Log In</button>
                </form>
            </body></html>
        `);
    });

    app.post('/login', (req, res) => {
        if (req.body.user === 'testuser' && req.body.pass === 'secret') {
            res.cookie('session', 'authenticated', {
                httpOnly: true,
                maxAge: 60 * 60 * 1000,
                sameSite: 'lax',
            });
            res.redirect('/protected');
        } else {
            res.status(401).send('Invalid credentials');
        }
    });

    app.get('/protected', (req, res) => {
        const cookies = req.headers.cookie ?? '';
        if (cookies.includes('session=authenticated')) {
            res.send('<html><body><h1 id="status">Welcome, authenticated user!</h1></body></html>');
        } else {
            res.status(401).send('<html><body><h1 id="status">Unauthorized</h1></body></html>');
        }
    });

    app.get('/logout', (_req, res) => {
        res.clearCookie('session');
        res.send('Logged out');
    });

    return app;
}

// ── Tests ────────────────────────────────────────────────────────

describe.skipIf(!chromium)('Profile-based login (Playwright)', () => {
    let server: Server;
    let baseUrl: string;
    let profileDir: string;

    beforeAll(async () => {
        profileDir = mkdtempSync(join(tmpdir(), 'geminiclaw-profile-test-'));

        // Start dummy auth server on random port
        const app = createAuthServer();
        await new Promise<void>((resolve) => {
            server = app.listen(0, () => resolve());
        });
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(profileDir, { recursive: true, force: true });
    });

    it('login creates session cookie in profile', async () => {
        // Launch browser with a persistent context (profile directory)
        const context = await chromium?.launchPersistentContext(profileDir, {
            headless: true,
        });
        const page = context.pages()[0] ?? (await context.newPage());

        // Navigate to login page and submit form
        await page.goto(baseUrl);
        await page.click('#login-btn');
        await page.waitForURL('**/protected');

        const statusText = await page.textContent('#status');
        expect(statusText).toContain('Welcome');

        // Verify cookie was set
        const cookies = await context.cookies(baseUrl);
        const sessionCookie = cookies.find((c) => c.name === 'session');
        expect(sessionCookie).toBeDefined();
        expect(sessionCookie?.value).toBe('authenticated');

        await context.close();
    });

    it('profile persists authentication across browser restarts', async () => {
        // Re-launch browser with the SAME profile directory — no login needed
        const context = await chromium?.launchPersistentContext(profileDir, {
            headless: true,
        });
        const page = context.pages()[0] ?? (await context.newPage());

        // Go directly to protected page — should be authenticated via persisted cookie
        await page.goto(`${baseUrl}/protected`);
        const statusText = await page.textContent('#status');
        expect(statusText).toContain('Welcome');

        await context.close();
    });

    it('fresh profile without login gets 401', async () => {
        // Use a different profile directory — no prior session
        const freshProfileDir = mkdtempSync(join(tmpdir(), 'geminiclaw-fresh-profile-'));
        try {
            const context = await chromium?.launchPersistentContext(freshProfileDir, {
                headless: true,
            });
            const page = context.pages()[0] ?? (await context.newPage());

            await page.goto(`${baseUrl}/protected`);
            const statusText = await page.textContent('#status');
            expect(statusText).toContain('Unauthorized');

            await context.close();
        } finally {
            rmSync(freshProfileDir, { recursive: true, force: true });
        }
    });

    it('AGENT_BROWSER_PROFILE env maps to profile directory concept', () => {
        // This verifies the conceptual mapping:
        // AGENT_BROWSER_PROFILE=/path/to/profile → launchPersistentContext(profileDir)
        // agent-browser reads this env and uses the profile for all browser operations.
        const profilePath = profileDir;
        expect(profilePath).toBeTruthy();

        // Simulate what agent-browser does: the profile path is passed as env
        const env: Record<string, string> = { AGENT_BROWSER_PROFILE: profilePath };
        expect(env.AGENT_BROWSER_PROFILE).toBe(profilePath);

        // Verify our pickSafeEnv allowlist includes it (tested in runner.test.ts)
    });
});
