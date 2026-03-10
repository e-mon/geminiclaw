#!/usr/bin/env node

import { homedir } from 'node:os';
import { join } from 'node:path';
import { clearStaleFiles } from '../agent/ask-user-state.js';
import { startAskUserServer } from './ask-user-server.js';

const workspace = process.env.GEMINICLAW_WORKSPACE ?? join(homedir(), '.geminiclaw', 'workspace');

// Clean up leftover pending/answer files from crashed runs
clearStaleFiles(workspace);

startAskUserServer(workspace).catch((err: unknown) => {
    process.stderr.write(`ask-user-server error: ${String(err)}\n`);
    process.exit(1);
});
