/**
 * tui/interactive.ts — startInteractiveTui() entry point (pi-tui implementation).
 */

import type { EventEmitter } from 'node:events';
import { suppressLogs } from '../logger.js';

export interface InteractiveTuiOptions {
    emitter: EventEmitter;
    defaultModel: string;
    sessionId: string;
    trigger: string;
    workspacePath: string;
    onUserMessage: (message: string) => void;
}

export interface InteractiveTuiHandle {
    waitUntilExit: () => Promise<void>;
}

export async function startInteractiveTui(options: InteractiveTuiOptions): Promise<InteractiveTuiHandle> {
    suppressLogs(true);
    const { startInteractiveApp } = await import('./pi/interactive-app.js');
    const handle = await startInteractiveApp(options);
    return {
        waitUntilExit: async () => {
            await handle.waitUntilExit();
            suppressLogs(false);
        },
    };
}
