/**
 * tui/pi/chat-log.ts — Full-width chat log component (OpenClaw style).
 *
 * Layout: no split panel. Each message/tool is a full-width card.
 *
 *   user_message  → bgHex(userBg) card with "You" label
 *   text          → plain assistant text with markdown
 *   think         → collapsed or expanded thinking block
 *   tool_call     → bgHex card (pending/success/error) with tool name + result size
 *
 * Scrolling: offset=0 = pinned to bottom. PgUp/PgDn via scrollUp()/scrollDown().
 */

import type { Component } from '@mariozechner/pi-tui';
import { wrapTextWithAnsi } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { OutputChunk } from '../types.js';
import { formatMarkdownLine, padToWidth } from './format.js';
import {
    borderDim,
    mutedText,
    toolErrorBg,
    toolPendingBg,
    toolSuccessBg,
    toolTitle,
    userMsgBg,
    userText,
} from './theme.js';

/** Max lines of tool output preview before truncation. */
const _TOOL_PREVIEW_LINES = 12;

/** Convert a chunk to display lines for layout computation. */
function chunkToLines(chunk: OutputChunk, width: number, showThinking: boolean): string[] {
    const innerW = Math.max(1, width - 4); // 2-char padding each side inside box

    switch (chunk.kind) {
        case 'user_message': {
            // Box adds 2 lines (padding top/bottom=1) + content lines
            const label = userText.bold('You');
            const wrapped = wrapTextWithAnsi(chunk.content, innerW);
            return [
                userMsgBg(padToWidth(`  ${label}`, width)),
                ...wrapped.map((l) => userMsgBg(padToWidth(`  ${userText(l)}`, width))),
                userMsgBg(padToWidth('', width)),
            ];
        }

        case 'think': {
            if (!showThinking) {
                return [mutedText(`  [thinking ${chunk.content.length} chars]`)];
            }
            const bar = borderDim(`╭ thinking ${'─'.repeat(Math.max(0, width - 13))}`);
            const wrapped = wrapTextWithAnsi(chunk.content, Math.max(1, width - 4));
            return [
                bar,
                ...wrapped.map((l) => chalk.gray.dim(`  ${l}`)),
                borderDim(`╰${'─'.repeat(Math.max(0, width - 2))}`),
            ];
        }

        case 'tool_call': {
            const isDone = chunk.resultChars !== undefined;
            const isError = chunk.toolStatus === 'error';
            const bg = isError ? toolErrorBg : isDone ? toolSuccessBg : toolPendingBg;

            const icon = isError ? chalk.red('✗') : isDone ? chalk.green('✓') : chalk.yellow('…');
            const name = toolTitle.bold(chunk.content);
            const result = isDone ? mutedText(` → ${chunk.resultChars ?? 0} chars`) : mutedText(' running…');

            const lines: string[] = [];
            lines.push(bg(padToWidth(`  ${icon} ${name}${result}`, width)));

            // Show tool parameters if present
            if (chunk.toolParams && chunk.toolParams !== '{}' && chunk.toolParams !== 'null') {
                // Wrap long params to fit card width
                const paramW = Math.max(1, width - 6);
                const paramLines = wrapTextWithAnsi(chalk.dim(chunk.toolParams), paramW);
                for (const pl of paramLines) {
                    lines.push(bg(padToWidth(`    ${pl}`, width)));
                }
            }

            return lines;
        }

        case 'text': {
            // Each text chunk is one logical line split at \n by applyEvent
            const formatted = formatMarkdownLine(chunk.content);
            const wrapped = wrapTextWithAnsi(formatted, Math.max(1, width - 2));
            return wrapped.map((l) => `  ${l}`);
        }

        default:
            return [];
    }
}

export class ChatLogComponent implements Component {
    /** Callback returning available height in rows. */
    getHeight: () => number = () => 20;
    showThinking = false;

    private _chunks: OutputChunk[] = [];
    private _scrollOffset = 0; // 0 = pinned to bottom
    private _manualScroll = false;

    // Line cache — invalidated on chunk list identity change or width change
    private _cachedLines: string[] = [];
    private _cachedChunkCount = -1;
    private _cachedWidth = 0;

    setChunks(chunks: OutputChunk[]): void {
        if (chunks !== this._chunks) {
            this._chunks = chunks;
            if (!this._manualScroll) this._scrollOffset = 0;
        }
    }

    scrollUp(lines: number): void {
        this._manualScroll = true;
        this._scrollOffset += lines;
        this.invalidate();
    }

    scrollDown(lines: number): void {
        this._scrollOffset = Math.max(0, this._scrollOffset - lines);
        if (this._scrollOffset === 0) this._manualScroll = false;
        this.invalidate();
    }

    scrollToBottom(): void {
        this._scrollOffset = 0;
        this._manualScroll = false;
        this.invalidate();
    }

    invalidate(): void {
        this._cachedChunkCount = -1;
    }

    render(width: number): string[] {
        // Reserve 1 row for the scroll hint
        const displayHeight = Math.max(1, this.getHeight() - 1);

        if (this._cachedChunkCount !== this._chunks.length || this._cachedWidth !== width) {
            this._cachedLines = this._buildLines(width);
            this._cachedChunkCount = this._chunks.length;
            this._cachedWidth = width;
        }

        const all = this._cachedLines;
        const total = all.length;
        const maxOffset = Math.max(0, total - displayHeight);
        const offset = Math.min(this._scrollOffset, maxOffset);
        const isAtBottom = offset === 0;

        const endIdx = total - offset;
        const startIdx = Math.max(0, endIdx - displayHeight);
        const visible = all.slice(startIdx, endIdx).map((l) => padToWidth(l, width));

        // Pad empty rows
        while (visible.length < displayHeight) visible.push('');

        // Hint row: scroll position indicator
        const hintParts: string[] = [];
        const hasThink = this._chunks.some((c) => c.kind === 'think');
        if (hasThink) {
            hintParts.push(mutedText(`[Ctrl+O] Thinking ${this.showThinking ? 'ON' : 'OFF'}`));
        }
        if (!isAtBottom) {
            hintParts.push(chalk.yellow.dim(`↑ [${startIdx + 1}–${endIdx}/${total}] PgDn to latest`));
        } else if (total > displayHeight) {
            hintParts.push(mutedText('PgUp / Opt+↑ to scroll'));
        }

        const hint = padToWidth(`  ${hintParts.join('  ')}`, width);
        return [hint, ...visible];
    }

    private _buildLines(width: number): string[] {
        const lines: string[] = [];
        let prevKind: OutputChunk['kind'] | null = null;

        for (const chunk of this._chunks) {
            const cl = chunkToLines(chunk, width, this.showThinking);
            if (cl.length === 0) {
                prevKind = chunk.kind;
                continue;
            }

            // Blank separator between non-consecutive text chunks and other blocks
            if (lines.length > 0) {
                const bothText = chunk.kind === 'text' && prevKind === 'text';
                if (!bothText) lines.push('');
            }
            for (const l of cl) lines.push(l);
            prevKind = chunk.kind;
        }
        return lines;
    }
}
