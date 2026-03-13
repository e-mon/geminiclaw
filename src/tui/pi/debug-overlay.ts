/**
 * tui/pi/debug-overlay.ts — Live Gemini CLI event feed (Ctrl+D).
 *
 * Subscribes to the EventEmitter and maintains a ring buffer of
 * StreamEvents, rendered as a scrollable activity log:
 *
 *   +00:00  ⬡ init  gemini-2.5-pro
 *   +00:01  ⚙ tool_use  read_file  {"path":"foo.ts"}
 *   +00:02    ↩ done  1234 chars
 *   +00:03  ▸ msg  "The file contains..."
 *   +00:05  ● result  42.1s  3820 tok
 */

import type { Component } from '@mariozechner/pi-tui';
import { wrapTextWithAnsi } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { StreamEvent } from '../../agent/runner.js';
import { formatElapsed, padToWidth } from './format.js';
import { accent, borderDim, mutedText, toolTitle } from './theme.js';

const MAX_ENTRIES = 300;
const ARGS_PREVIEW_CHARS = 60;
const DELTA_PREVIEW_CHARS = 80;

interface LogEntry {
    offsetMs: number; // ms since first event
    line: string; // pre-rendered ANSI line (single line, no wrap)
}

function argsPreview(params: unknown): string {
    try {
        const s = JSON.stringify(params);
        if (s.length <= ARGS_PREVIEW_CHARS) return s;
        return `${s.slice(0, ARGS_PREVIEW_CHARS)}…`;
    } catch {
        return '';
    }
}

function formatEntry(event: StreamEvent, offsetMs: number): LogEntry {
    const ts = chalk.dim(`+${formatElapsed(offsetMs)}`);

    let line: string;
    switch (event.type) {
        case 'init':
            line = `${ts}  ${chalk.green('⬡')} ${mutedText('init')}  ${accent(event.model)}  ${chalk.magenta(event.session_id.slice(0, 8))}`;
            break;

        case 'message': {
            const rawDelta = typeof event.delta === 'string' ? event.delta : null;
            const raw = rawDelta ?? (typeof event.content === 'string' ? event.content : null);
            if (!raw) {
                line = `${ts}  ${chalk.gray('▸')} ${mutedText('msg')}  ${chalk.dim('[no text]')}`;
            } else {
                // Strip newlines for single-line preview
                const preview = raw.replace(/\n/g, '↵').slice(0, DELTA_PREVIEW_CHARS);
                const suffix = raw.length > DELTA_PREVIEW_CHARS ? '…' : '';
                line = `${ts}  ${chalk.gray('▸')} ${mutedText('msg')}  ${chalk.white(preview + suffix)}`;
            }
            break;
        }

        case 'tool_use': {
            const args = argsPreview(event.parameters);
            line = `${ts}  ${chalk.yellow('⚙')} ${toolTitle(event.tool_name)}  ${chalk.dim(args)}`;
            break;
        }

        case 'tool_result': {
            if (event.status === 'success') {
                const chars = (event.output ?? '').length;
                line = `${ts}    ${chalk.green('↩')} ${mutedText('done')}  ${chalk.dim(`${chars} chars`)}`;
            } else {
                const err = (event.error ?? '').slice(0, DELTA_PREVIEW_CHARS);
                line = `${ts}    ${chalk.red('✗')} ${mutedText('error')}  ${chalk.red(err)}`;
            }
            break;
        }

        case 'error':
            line = `${ts}  ${chalk.red('✗')} ${chalk.red('error')}  ${chalk.red(event.message.slice(0, DELTA_PREVIEW_CHARS))}`;
            break;

        case 'result': {
            const s = event.stats;
            line = `${ts}  ${chalk.cyan('●')} ${chalk.cyan('done')}  ${mutedText(`${(s.duration_ms / 1000).toFixed(1)}s`)}  ${mutedText(`${s.total_tokens} tok`)}  ${mutedText(`${s.tool_calls} tools`)}`;
            break;
        }

        default:
            line = `${ts}  ${chalk.dim((event as StreamEvent).type)}`;
    }

    return { offsetMs, line };
}

export class DebugOverlayComponent implements Component {
    private entries: LogEntry[] = [];
    private startMs = 0;
    private scrollOffset = 0; // 0 = pinned to bottom

    /** Wire this to emitter.on('event', ...) in the app layer. */
    addEvent(event: StreamEvent): void {
        if (this.startMs === 0) this.startMs = Date.now();
        const entry = formatEntry(event, Date.now() - this.startMs);
        this.entries.push(entry);
        if (this.entries.length > MAX_ENTRIES) {
            this.entries.shift();
        }
        // Auto-scroll to bottom when at bottom
        if (this.scrollOffset === 0) {
            // already pinned — nothing to do, render will pick it up
        }
    }

    reset(): void {
        this.entries = [];
        this.startMs = 0;
        this.scrollOffset = 0;
    }

    scrollUp(n: number): void {
        this.scrollOffset += n;
    }
    scrollDown(n: number): void {
        this.scrollOffset = Math.max(0, this.scrollOffset - n);
    }

    invalidate(): void {}

    render(width: number): string[] {
        const w = Math.max(50, width);
        const rows: string[] = [];

        // Title bar
        const title = `  ${toolTitle.bold('Gemini CLI Live')}  ${mutedText('[Ctrl+D] Close  [↑/↓] Scroll')}`;
        rows.push(padToWidth(title, w));
        rows.push(padToWidth(borderDim('─'.repeat(w)), w));

        if (this.entries.length === 0) {
            rows.push(padToWidth(mutedText('  Waiting for Gemini CLI events…'), w));
            rows.push(padToWidth(borderDim('─'.repeat(w)), w));
            return rows;
        }

        // Compute how many content lines we can show
        // (overlay height is determined by pi-tui based on rendered rows count — we target ~20 content lines)
        const maxContentLines = 18;
        const total = this.entries.length;
        const maxOffset = Math.max(0, total - maxContentLines);
        const offset = Math.min(this.scrollOffset, maxOffset);

        const endIdx = total - offset;
        const startIdx = Math.max(0, endIdx - maxContentLines);
        const visible = this.entries.slice(startIdx, endIdx);

        for (const entry of visible) {
            // Wrap long lines to width
            const wrapped = wrapTextWithAnsi(entry.line, Math.max(1, w - 2));
            for (const l of wrapped) {
                rows.push(padToWidth(`  ${l}`, w));
            }
        }

        // Scroll indicator
        const atBottom = offset === 0;
        const scrollHint = atBottom
            ? mutedText(`  Latest ${total} events`)
            : chalk.yellow.dim(`  [${startIdx + 1}–${endIdx}/${total}] ↓ To latest`);
        rows.push(padToWidth(borderDim('─'.repeat(w)), w));
        rows.push(padToWidth(scrollHint, w));

        return rows;
    }
}
