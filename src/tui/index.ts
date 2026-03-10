/**
 * tui/index.ts — startTui() entry point (pi-tui implementation).
 */

import type { EventEmitter } from 'node:events';

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
    const { startRunApp } = await import('./pi/run-app.js');
    return startRunApp({
        emitter: options.emitter,
        defaultModel: options.defaultModel,
        trigger: options.trigger,
    });
}
