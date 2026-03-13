/**
 * tui/pi/run-app.ts — Single-run TUI (OpenClaw style).
 *
 * Layout (fills terminal rows):
 *   HeaderComponent    2 rows
 *   ChatLogComponent   dynamic
 *   FooterComponent    2 rows
 */

import type { EventEmitter } from 'node:events';
import { isKeyRelease, isKeyRepeat, Key, matchesKey, ProcessTerminal, TUI } from '@mariozechner/pi-tui';
import type { StreamEvent } from '../../agent/runner.js';
import { ChatLogComponent } from './chat-log.js';
import { DebugOverlayComponent } from './debug-overlay.js';
import { FooterComponent } from './footer.js';
import { HeaderComponent } from './header.js';
import { RunStateManager } from './state-manager.js';

const HEADER_HEIGHT = 2;
const FOOTER_HEIGHT = 2;

export interface RunAppOptions {
    emitter: EventEmitter;
    defaultModel: string;
    trigger: string;
    workspacePath?: string;
}

export interface RunAppHandle {
    waitUntilExit: () => Promise<void>;
}

export async function startRunApp(options: RunAppOptions): Promise<RunAppHandle> {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal);

    const getChatHeight = () => Math.max(4, tui.terminal.rows - HEADER_HEIGHT - FOOTER_HEIGHT);

    const header = new HeaderComponent();
    const chatLog = new ChatLogComponent();
    const footer = new FooterComponent();
    const debugOverlay = new DebugOverlayComponent();

    chatLog.getHeight = getChatHeight;
    chatLog.showStarting = true;
    header.trigger = options.trigger;
    let exitResolve!: (code: number) => void;
    const exitPromise = new Promise<number>((r) => {
        exitResolve = r;
    });
    let exitScheduled = false;
    let debugHandle: ReturnType<typeof tui.showOverlay> | null = null;
    let debugVisible = false;

    const scheduleExit = (code: number, delayMs: number): void => {
        if (exitScheduled) return;
        exitScheduled = true;
        setTimeout(() => {
            tui.stop();
            exitResolve(code);
        }, delayMs);
    };

    const stateManager = new RunStateManager(options.emitter, options.defaultModel, () => {
        const state = stateManager.getState();

        header.model = state.model;
        header.sessionId = state.sessionId;
        header.elapsedMs = state.elapsedMs;
        header.isRunning = state.status === 'running';

        if (state.status !== 'initializing') chatLog.showStarting = false;
        chatLog.setChunks(state.chunks);

        footer.tokens = state.tokens;
        footer.durationMs = state.durationMs;
        footer.model = state.model;

        tui.requestRender();

        if (state.status === 'done') scheduleExit(0, 800);
        if (state.status === 'error') scheduleExit(1, 2000);
    });

    // Tick timer for spinner animation during initializing state
    const tickTimer = setInterval(() => {
        if (chatLog.showStarting) tui.requestRender();
    }, 100);

    const PAGE_SIZE = 10;

    const onDebugEvent = (event: StreamEvent): void => {
        debugOverlay.addEvent(event);
        if (debugVisible) tui.requestRender();
    };
    options.emitter.on('event', onDebugEvent);

    const toggleDebug = (): void => {
        debugVisible = !debugVisible;
        if (debugVisible) {
            debugHandle = tui.showOverlay(debugOverlay, {
                anchor: 'top-right',
                width: 52,
                margin: { top: 2, right: 1, bottom: 0, left: 0 },
            });
        } else if (debugHandle) {
            debugHandle.hide();
            debugHandle = null;
        }
        tui.requestRender();
    };

    tui.addInputListener((data) => {
        if (isKeyRepeat(data) || isKeyRelease(data)) return undefined;

        if (matchesKey(data, 'ctrl+c')) {
            scheduleExit(130, 0);
            return { consume: true };
        }
        if (matchesKey(data, 'ctrl+g')) {
            toggleDebug();
            return { consume: true };
        }
        if (matchesKey(data, 'ctrl+o')) {
            chatLog.showThinking = !chatLog.showThinking;
            chatLog.invalidate();
            tui.requestRender();
            return { consume: true };
        }
        if (matchesKey(data, Key.pageUp)) {
            chatLog.scrollUp(PAGE_SIZE);
            tui.requestRender();
            return { consume: true };
        }
        if (matchesKey(data, Key.pageDown)) {
            chatLog.scrollDown(PAGE_SIZE);
            tui.requestRender();
            return { consume: true };
        }
        return undefined;
    });

    tui.addChild(header);
    tui.addChild(chatLog);
    tui.addChild(footer);

    tui.start();

    return {
        waitUntilExit: async () => {
            const code = await exitPromise;
            clearInterval(tickTimer);
            stateManager.destroy();
            options.emitter.off('event', onDebugEvent);
            await terminal.drainInput();
            if (code !== 0) process.exitCode = code;
        },
    };
}
