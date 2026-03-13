/**
 * tui/pi/workspace-viewer.ts — Workspace file browser overlay.
 *
 * Two modes:
 *   list   — show discovered workspace .md files + key files
 *   detail — show selected file content with scroll
 *
 * Navigation (handled by the app's input listener):
 *   ↑/↓    navigate list / scroll content
 *   Enter  open selected file
 *   Esc    back to list (from detail) or close (from list)
 *   Ctrl+W toggle open/close
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Component } from '@mariozechner/pi-tui';
import { wrapTextWithAnsi } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import { padToWidth } from './format.js';
import { accent, borderDim, mutedText, toolTitle } from './theme.js';

// Files always shown at the top of the list regardless of discovery order
const PRIORITY_FILES = ['MEMORY.md', 'SOUL.md', 'AGENTS.md', 'USER.md', 'GEMINI.md', 'HEARTBEAT.md', 'TODO.md'];

type ViewMode = 'list' | 'detail';

export class WorkspaceViewerComponent implements Component {
    private mode: ViewMode = 'list';
    private files: string[] = [];
    private selectedIdx = 0;
    private detailFile = '';
    private detailLines: string[] = [];
    private detailScroll = 0; // 0 = pinned to top (unlike chat — files read top-down)
    private _loaded = false;

    constructor(private workspacePath: string) {}

    /** Load/refresh workspace file list. Call when opening overlay. */
    async refresh(): Promise<void> {
        try {
            const entries = await readdir(this.workspacePath);
            const mdFiles = entries.filter((f) => f.endsWith('.md'));

            const priority = PRIORITY_FILES.filter((f) => mdFiles.includes(f));
            const rest = mdFiles.filter((f) => !PRIORITY_FILES.includes(f)).sort();
            this.files = [...priority, ...rest];
        } catch {
            this.files = [];
        }
        this.selectedIdx = Math.min(this.selectedIdx, Math.max(0, this.files.length - 1));
        this._loaded = true;
    }

    get isInDetail(): boolean {
        return this.mode === 'detail';
    }

    // ── Navigation API (called from app input listener) ──────────

    moveUp(): void {
        if (this.mode === 'list') {
            this.selectedIdx = Math.max(0, this.selectedIdx - 1);
        } else {
            this.detailScroll = Math.max(0, this.detailScroll - 1);
        }
    }

    moveDown(visibleLines: number): void {
        if (this.mode === 'list') {
            this.selectedIdx = Math.min(this.files.length - 1, this.selectedIdx + 1);
        } else {
            const max = Math.max(0, this.detailLines.length - visibleLines);
            this.detailScroll = Math.min(max, this.detailScroll + 1);
        }
    }

    pageUp(n: number): void {
        if (this.mode === 'detail') {
            this.detailScroll = Math.max(0, this.detailScroll - n);
        }
    }

    pageDown(n: number, visibleLines: number): void {
        if (this.mode === 'detail') {
            const max = Math.max(0, this.detailLines.length - visibleLines);
            this.detailScroll = Math.min(max, this.detailScroll + n);
        }
    }

    async openSelected(): Promise<void> {
        if (this.mode !== 'list' || this.files.length === 0) return;
        const filename = this.files[this.selectedIdx];
        await this._loadFile(filename);
    }

    backToList(): void {
        this.mode = 'list';
    }

    reset(): void {
        this.mode = 'list';
        this.selectedIdx = 0;
        this.detailScroll = 0;
    }

    invalidate(): void {}

    // ── Rendering ────────────────────────────────────────────────

    render(width: number): string[] {
        const w = Math.max(50, width);
        return this.mode === 'list' ? this._renderList(w) : this._renderDetail(w);
    }

    private _renderList(w: number): string[] {
        const rows: string[] = [];
        const hint = mutedText('[↑↓] Select  [Enter] Open  [Esc] Close');
        rows.push(padToWidth(`  ${toolTitle.bold('Workspace Files')}  ${hint}`, w));
        rows.push(padToWidth(borderDim('─'.repeat(w)), w));

        if (!this._loaded || this.files.length === 0) {
            rows.push(padToWidth(mutedText('  No files'), w));
        } else {
            for (let i = 0; i < this.files.length; i++) {
                const selected = i === this.selectedIdx;
                const prefix = selected ? chalk.cyan('▶ ') : '  ';
                const name = selected ? accent.bold(this.files[i]) : chalk.white(this.files[i]);
                rows.push(padToWidth(prefix + name, w));
            }
        }

        rows.push(padToWidth(borderDim('─'.repeat(w)), w));
        return rows;
    }

    private _renderDetail(w: number): string[] {
        const innerW = Math.max(1, w - 4);
        // Reflow lines to current width
        const reflowed: string[] = [];
        for (const line of this.detailLines) {
            const wrapped = wrapTextWithAnsi(line, innerW);
            for (const l of wrapped) reflowed.push(l);
        }

        const MAX_CONTENT = 22;
        const total = reflowed.length;
        const maxScroll = Math.max(0, total - MAX_CONTENT);
        const scroll = Math.min(this.detailScroll, maxScroll);

        const visible = reflowed.slice(scroll, scroll + MAX_CONTENT);
        while (visible.length < MAX_CONTENT) visible.push('');

        const hint = mutedText('[↑↓/PgUp/PgDn] Scroll  [Esc] Back to list');
        const rows: string[] = [];
        rows.push(padToWidth(`  ${accent.bold(this.detailFile)}  ${hint}`, w));
        rows.push(padToWidth(borderDim('─'.repeat(w)), w));

        for (const l of visible) {
            rows.push(padToWidth(`  ${chalk.white(l)}`, w));
        }

        const scrollHint =
            total > MAX_CONTENT
                ? mutedText(`  [${scroll + 1}–${Math.min(scroll + MAX_CONTENT, total)}/${total} lines]`)
                : mutedText(`  ${total} lines`);
        rows.push(padToWidth(borderDim('─'.repeat(w)), w));
        rows.push(padToWidth(scrollHint, w));
        return rows;
    }

    private async _loadFile(filename: string): Promise<void> {
        try {
            const raw = await readFile(join(this.workspacePath, filename), 'utf-8');
            this.detailLines = raw.split('\n');
        } catch {
            this.detailLines = ['(Failed to read file)'];
        }
        this.detailFile = filename;
        this.detailScroll = 0;
        this.mode = 'detail';
    }
}
