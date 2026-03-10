#!/usr/bin/env node

/**
 * mcp/gog-serve.ts — stdio entrypoint for the gog MCP server.
 *
 * Env:
 *   GEMINICLAW_WORKSPACE — workspace root (required)
 *   GOG_ACCOUNT          — default gog --account value (optional)
 */

import { detectAccount, resolveGogPath } from './gog-helpers.js';
import { startGogServer } from './gog-server.js';

const workspace = process.env.GEMINICLAW_WORKSPACE ?? '';
if (!workspace) {
    process.stderr.write('[gog-server] GEMINICLAW_WORKSPACE not set\n');
    process.exit(1);
}

const gogPath = resolveGogPath();
const account = process.env.GOG_ACCOUNT || (gogPath ? detectAccount(gogPath) : undefined);

startGogServer(workspace, gogPath, account).catch((err: unknown) => {
    process.stderr.write(`[gog-server] fatal: ${String(err)}\n`);
    process.exit(1);
});
