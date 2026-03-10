/**
 * tui/pi/header.ts — Top bar component (2 rows).
 *
 * Single-row content: ⬡ GeminiClaw · model · trigger · session · [spinner elapsed]
 * Border line below content.
 */

import type { Component } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import { formatElapsed, padToWidth, spinnerFrame } from './format.js';
import { accent, borderDim, mutedText } from './theme.js';

export class HeaderComponent implements Component {
    model = '';
    sessionId = '';
    trigger = '';
    elapsedMs = 0;
    isRunning = false;

    invalidate(): void {}

    render(width: number): string[] {
        const shortModel = this.model ? this.model.replace(/^gemini-/, '').replace(/-latest$/, '') : '...';
        const shortId = this.sessionId ? this.sessionId.slice(0, 8) : '--------';

        const parts: string[] = [
            `${chalk.green('⬡')} ${chalk.white.bold('GeminiClaw')}`,
            borderDim('·'),
            accent(shortModel),
            borderDim('·'),
            mutedText(this.trigger || 'manual'),
            borderDim('·'),
            chalk.magenta(shortId),
        ];

        if (this.isRunning) {
            parts.push(borderDim('·'), chalk.cyan(`${spinnerFrame()} ${formatElapsed(this.elapsedMs)}`));
        }

        const line = `  ${parts.join(' ')}`;
        const border = borderDim('─'.repeat(width));

        return [padToWidth(line, width), padToWidth(border, width)];
    }
}
