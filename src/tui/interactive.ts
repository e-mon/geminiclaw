/**
 * tui/interactive.ts — startInteractiveTui() entry point (pi-tui implementation).
 */

import type { EventEmitter } from 'node:events';

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
    const { startInteractiveApp } = await import('./pi/interactive-app.js');
    return startInteractiveApp(options);
}
