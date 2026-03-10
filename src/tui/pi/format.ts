/**
 * tui/pi/format.ts — Inline markdown formatter and text utilities.
 *
 * Converts agent output lines to ANSI-coloured strings suitable for
 * terminal display. Handles headers, bullets, bold, italic, inline code.
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@mariozechner/pi-tui';
import chalk from 'chalk';

export { visibleWidth, truncateToWidth, wrapTextWithAnsi };

/** Pad text to exactly `width` visible columns (truncate if needed). */
export function padToWidth(text: string, width: number): string {
    const vw = visibleWidth(text);
    if (vw >= width) return truncateToWidth(text, width);
    return text + ' '.repeat(width - vw);
}

/** Spinner frames for running-state indicator. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export function spinnerFrame(): string {
    return SPINNER[Math.floor(Date.now() / 100) % SPINNER.length];
}

/** Format elapsed milliseconds as MM:SS. */
export function formatElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)
        .toString()
        .padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

/** Apply simple inline markdown formatting to a single line. */
export function formatMarkdownLine(line: string): string {
    if (line === '') return '';

    // Code fences — show as-is in dim
    if (line.startsWith('```')) return chalk.gray(line);

    // Headers: # Title
    if (/^#{1,6}\s/.test(line)) return chalk.bold.yellow(line);

    // Horizontal rules
    if (/^[-*_]{3,}\s*$/.test(line)) return chalk.gray('─'.repeat(40));

    // Bullet list  * / - / +
    line = line.replace(/^(\s*)[*\-+](\s+)/, (_, ws, sp) => ws + chalk.cyan('•') + sp);

    // Numbered list  1. / 2.
    line = line.replace(/^(\s*)(\d+\.)(\s+)/, (_, ws, num, sp) => ws + chalk.cyan(num) + sp);

    // Bold **text**
    line = line.replace(/\*\*([^*]+)\*\*/g, (_, t) => chalk.bold(t));

    // Italic *text* (not preceded/followed by *)
    line = line.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, t) => chalk.italic(t));

    // Inline code `code`
    line = line.replace(/`([^`]+)`/g, (_, t) => chalk.cyan(t));

    return line;
}

/**
 * Convert a text chunk content to display lines.
 * Applies inline markdown and word-wraps to fit `width`.
 * `indent` is the prefix added before each rendered line (e.g. "  ").
 */
export function textChunkToLines(content: string, width: number, indent = '  '): string[] {
    if (content === '') return [''];
    const formatted = formatMarkdownLine(content);
    const innerWidth = Math.max(1, width - visibleWidth(indent));
    const wrapped = wrapTextWithAnsi(formatted, innerWidth);
    return wrapped.map((l) => indent + l);
}

/** Wrap plain (non-markdown) text to lines with an indent prefix. */
export function wrapLines(content: string, width: number, indent = '  '): string[] {
    if (content === '') return [''];
    const innerWidth = Math.max(1, width - visibleWidth(indent));
    return wrapTextWithAnsi(content, innerWidth).map((l) => indent + l);
}
