#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startCronServer } from './cron-server.js';

const workspace = process.env.GEMINICLAW_WORKSPACE ?? join(homedir(), '.geminiclaw', 'workspace');

let timezone = process.env.TIMEZONE ?? '';
if (!timezone) {
    const configPath = join(homedir(), '.geminiclaw', 'config.json');
    if (existsSync(configPath)) {
        try {
            const data = JSON.parse(readFileSync(configPath, 'utf-8'));
            timezone = data.timezone ?? '';
        } catch {
            // fall through to system default
        }
    }
}

startCronServer(workspace, timezone || undefined).catch((err: unknown) => {
    process.stderr.write(`cron-server error: ${String(err)}\n`);
    process.exit(1);
});
