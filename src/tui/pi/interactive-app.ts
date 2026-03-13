/**
 * tui/pi/interactive-app.ts — Multi-turn interactive TUI (OpenClaw style).
 *
 * Layout (fills terminal rows):
 *   HeaderComponent      2 rows
 *   ChatLogComponent     dynamic (terminal - header - editor - hint)
 *   Editor               pi-tui multiline input (max ~8 rows)
 *   HintLine             1 row
 */

import type { EventEmitter } from 'node:events';
import {
    type Component,
    Editor,
    type EditorTheme,
    isKeyRelease,
    isKeyRepeat,
    Key,
    matchesKey,
    ProcessTerminal,
    TUI,
} from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { StreamEvent } from '../../agent/runner.js';
import { loadGeminiclawSettings } from '../../config/gemini-settings.js';
import { ChatLogComponent } from './chat-log.js';
import { DebugOverlayComponent } from './debug-overlay.js';
import { padToWidth } from './format.js';
import { HeaderComponent } from './header.js';
import { McpPanelComponent } from './mcp-panel.js';
import { InteractiveStateManager } from './state-manager.js';
import { mutedText } from './theme.js';
import { WorkspaceViewerComponent } from './workspace-viewer.js';

const HEADER_HEIGHT = 2;
// Reserve for Editor (up to 7 rows) + HintLine (1 row)
const BOTTOM_RESERVE = 9;

class HintLine implements Component {
    disabled = false;
    confirmClear = false;
    invalidate(): void {}
    render(width: number): string[] {
        let text: string;
        if (this.confirmClear) {
            text =
                chalk.yellow('  Clear chat history.') +
                chalk.white.bold(' [Enter]') +
                chalk.yellow(' Confirm  ') +
                chalk.white.bold('[Esc]') +
                chalk.yellow(' Cancel');
        } else if (this.disabled) {
            text = mutedText('  Agent running…');
        } else {
            text = mutedText(
                '  [Shift+Enter] Newline  [Ctrl+L] Clear  [Ctrl+G] Debug  [Ctrl+M] MCP  [Ctrl+W] Files  [Ctrl+C] Quit',
            );
        }
        return [padToWidth(text, width)];
    }
}

export interface InteractiveAppOptions {
    emitter: EventEmitter;
    defaultModel: string;
    sessionId: string;
    trigger: string;
    workspacePath: string;
    onUserMessage: (message: string) => void;
}

export interface InteractiveAppHandle {
    waitUntilExit: () => Promise<void>;
}

export async function startInteractiveApp(options: InteractiveAppOptions): Promise<InteractiveAppHandle> {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal);

    const getChatHeight = () => Math.max(4, tui.terminal.rows - HEADER_HEIGHT - BOTTOM_RESERVE);

    const header = new HeaderComponent();
    const chatLog = new ChatLogComponent();
    const hint = new HintLine();
    const debugOverlay = new DebugOverlayComponent();
    const wsViewer = new WorkspaceViewerComponent(options.workspacePath);
    const mcpPanel = new McpPanelComponent();

    // Pre-load MCP server definitions from settings
    mcpPanel.loadServers(loadGeminiclawSettings().mcpServers);

    chatLog.getHeight = getChatHeight;

    header.trigger = options.trigger;

    const editorTheme: EditorTheme = {
        borderColor: chalk.hex('#3C414B'),
        selectList: {
            selectedPrefix: (t: string) => chalk.cyan('▶ ') + t,
            selectedText: chalk.cyan,
            description: chalk.gray,
            scrollInfo: chalk.gray,
            noMatch: chalk.gray,
        },
    };
    const editor = new Editor(tui, editorTheme, { paddingX: 1 });

    let exitResolve!: () => void;
    const exitPromise = new Promise<void>((r) => {
        exitResolve = r;
    });
    let debugHandle: ReturnType<typeof tui.showOverlay> | null = null;
    let debugVisible = false;
    let wsHandle: ReturnType<typeof tui.showOverlay> | null = null;
    let wsVisible = false;
    let mcpHandle: ReturnType<typeof tui.showOverlay> | null = null;
    let mcpVisible = false;

    const stateManager = new InteractiveStateManager(options.emitter, options.defaultModel, () => {
        const state = stateManager.getState();
        const effectiveSessionId = state.sessionId || options.sessionId;

        header.model = state.model;
        header.sessionId = effectiveSessionId;
        header.elapsedMs = state.turnElapsedMs;
        header.isRunning = state.status === 'running';

        chatLog.setChunks(state.conversationChunks);

        editor.disableSubmit = state.status === 'running';
        hint.disabled = state.status === 'running';

        tui.requestRender();
    });

    // Pipe all Gemini CLI events to the debug overlay so it shows a live feed.
    // Reset on each new turn so the overlay reflects the current turn's activity.
    const onDebugEvent = (event: StreamEvent): void => {
        debugOverlay.addEvent(event);
        if (debugVisible) tui.requestRender();
    };
    // Track MCP tool calls from stream events
    const onMcpEvent = (event: StreamEvent): void => {
        if (event.type === 'tool_use') {
            mcpPanel.onToolUse(event.tool_name, event.tool_id);
            if (mcpVisible) tui.requestRender();
        } else if (event.type === 'tool_result') {
            mcpPanel.onToolResult(event.tool_id, event.status);
            if (mcpVisible) tui.requestRender();
        }
    };
    const onTurnStart = (): void => {
        debugOverlay.reset();
    };
    options.emitter.on('event', onDebugEvent);
    options.emitter.on('event', onMcpEvent);
    options.emitter.on('turn-start', onTurnStart);

    const PAGE_SIZE = 10;

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
        // Keep cursor in the editor regardless of overlay state
        tui.setFocus(editor);
        tui.requestRender();
    };

    const toggleWorkspace = async (): Promise<void> => {
        wsVisible = !wsVisible;
        if (wsVisible) {
            wsViewer.reset();
            await wsViewer.refresh();
            wsHandle = tui.showOverlay(wsViewer, {
                anchor: 'top-right',
                width: 60,
                margin: { top: 2, right: 1, left: 0, bottom: 0 },
            });
        } else if (wsHandle) {
            wsHandle.hide();
            wsHandle = null;
        }
        tui.setFocus(editor);
        tui.requestRender();
    };

    const toggleMcp = (): void => {
        mcpVisible = !mcpVisible;
        if (mcpVisible) {
            // Refresh server list in case settings changed
            mcpPanel.loadServers(loadGeminiclawSettings().mcpServers);
            mcpHandle = tui.showOverlay(mcpPanel, {
                anchor: 'top-right',
                width: 56,
                margin: { top: 2, right: 1, bottom: 0, left: 0 },
            });
        } else if (mcpHandle) {
            mcpHandle.hide();
            mcpHandle = null;
        }
        tui.setFocus(editor);
        tui.requestRender();
    };

    tui.addInputListener((data) => {
        // Only act on key press events. Kitty protocol sends separate repeat/release events;
        // without this guard a single keypress fires twice (press + release) and toggles back off.
        if (isKeyRepeat(data) || isKeyRelease(data)) return undefined;

        if (matchesKey(data, 'ctrl+c')) {
            tui.stop();
            exitResolve();
            return { consume: true };
        }
        if (matchesKey(data, 'ctrl+g')) {
            toggleDebug();
            return { consume: true };
        }
        if (matchesKey(data, 'ctrl+m')) {
            toggleMcp();
            return { consume: true };
        }
        if (matchesKey(data, 'ctrl+w')) {
            void toggleWorkspace();
            return { consume: true };
        }
        if (wsVisible) {
            if (matchesKey(data, Key.up)) {
                wsViewer.moveUp();
                tui.requestRender();
                return { consume: true };
            }
            if (matchesKey(data, Key.down)) {
                wsViewer.moveDown(22);
                tui.requestRender();
                return { consume: true };
            }
            if (matchesKey(data, Key.pageUp)) {
                wsViewer.pageUp(PAGE_SIZE);
                tui.requestRender();
                return { consume: true };
            }
            if (matchesKey(data, Key.pageDown)) {
                wsViewer.pageDown(PAGE_SIZE, 22);
                tui.requestRender();
                return { consume: true };
            }
            if (matchesKey(data, Key.enter)) {
                void wsViewer.openSelected().then(() => tui.requestRender());
                return { consume: true };
            }
            if (matchesKey(data, Key.escape)) {
                if (wsViewer.isInDetail) {
                    wsViewer.backToList();
                } else {
                    void toggleWorkspace();
                }
                tui.requestRender();
                return { consume: true };
            }
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
        if (hint.confirmClear) {
            // Waiting for clear confirmation: Enter=confirm, anything else=cancel
            if (matchesKey(data, Key.enter)) {
                hint.confirmClear = false;
                stateManager.clearConversation();
                chatLog.scrollToBottom();
            } else {
                hint.confirmClear = false;
                tui.requestRender();
            }
            return { consume: true };
        }
        if (matchesKey(data, 'ctrl+l')) {
            hint.confirmClear = true;
            tui.requestRender();
            return { consume: true };
        }
        return undefined;
    });

    editor.onSubmit = (text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        editor.addToHistory(trimmed);
        options.onUserMessage(trimmed);
    };

    tui.addChild(header);
    tui.addChild(chatLog);
    tui.addChild(editor);
    tui.addChild(hint);

    tui.setFocus(editor);
    tui.start();

    return {
        waitUntilExit: async () => {
            await exitPromise;
            stateManager.destroy();
            options.emitter.off('event', onDebugEvent);
            options.emitter.off('event', onMcpEvent);
            options.emitter.off('turn-start', onTurnStart);
            await terminal.drainInput();
        },
    };
}
