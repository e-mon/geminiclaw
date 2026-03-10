/**
 * tui/pi/footer.ts — Bottom bar for single-run mode (2 rows).
 *
 * Shows: border + token/duration line.
 */

import type { Component } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import { COST_PER_MILLION_TOKENS } from '../../memory/usage.js';
import { padToWidth } from './format.js';
import { borderDim, mutedText } from './theme.js';

export class FooterComponent implements Component {
    tokens = { input: 0, output: 0, thinking: 0, total: 0, cached: 0 };
    durationMs = 0;
    model = '';

    invalidate(): void {}

    render(width: number): string[] {
        const parts: string[] = [];

        if (this.tokens.total > 0) {
            parts.push(mutedText(`in:${this.tokens.input} out:${this.tokens.output} total:${this.tokens.total}`));
            if (this.tokens.thinking > 0) {
                parts.push(chalk.dim(`think:${this.tokens.thinking}`));
            }
            if (this.tokens.cached > 0) {
                parts.push(chalk.dim(`cached:${this.tokens.cached}`));
            }
        }

        if (this.durationMs > 0) {
            parts.push(mutedText(`${(this.durationMs / 1000).toFixed(1)}s`));
        }

        if (this.model && this.tokens.total > 0) {
            const cpm = COST_PER_MILLION_TOKENS[this.model];
            if (cpm !== undefined) {
                const { input, output, thinking, cached } = this.tokens;
                const freshInput = input - cached;
                const cost = ((freshInput + output + thinking) / 1_000_000) * cpm + (cached / 1_000_000) * cpm * 0.1;
                parts.push(chalk.dim(`~$${cost.toFixed(4)}`));
            }
        }

        const content = parts.length > 0 ? `  ${parts.join('  ·  ')}` : '';

        return [padToWidth(borderDim('─'.repeat(width)), width), padToWidth(content, width)];
    }
}
