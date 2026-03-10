#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startStatusServer } from './status-server.js';

let timezone = process.env.TIMEZONE ?? '';

if (!timezone) {
    const configPath = join(process.env.HOME ?? '', '.geminiclaw', 'config.json');
    if (existsSync(configPath)) {
        try {
            const data = JSON.parse(readFileSync(configPath, 'utf-8'));
            timezone = data.timezone ?? '';
        } catch {
            // fall through to system default
        }
    }
}

startStatusServer(timezone).catch((err: unknown) => {
    process.stderr.write(`status-server error: ${String(err)}\n`);
    process.exit(1);
});
