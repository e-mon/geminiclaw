/**
 * tui/index.ts — startTui() entry point (pi-tui implementation).
 */

import type { EventEmitter } from 'node:events';
import { suppressLogs } from '../logger.js';

export interface TuiOptions {
    emitter: EventEmitter;
    prompt: string;
    defaultModel: string;
    trigger: string;
}

export interface TuiHandle {
    waitUntilExit: () => Promise<void>;
}

export async function startTui(options: TuiOptions): Promise<TuiHandle> {
    suppressLogs(true);
    const { startRunApp } = await import('./pi/run-app.js');
    const handle = await startRunApp({
        emitter: options.emitter,
        defaultModel: options.defaultModel,
        trigger: options.trigger,
    });
    return {
        waitUntilExit: async () => {
            await handle.waitUntilExit();
            suppressLogs(false);
        },
    };
}
