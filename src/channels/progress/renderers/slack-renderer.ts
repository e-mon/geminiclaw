/**
 * channels/progress/renderers/slack-renderer.ts — Slack-specific renderer.
 *
 * Extends BaseProgressRenderer with:
 * - Compact thinking display (no bold header)
 * - Compact tool timeline using arrow notation
 */

import type { ThinkingBlock, ToolEntry } from '../types.js';
import { BaseProgressRenderer } from './base-renderer.js';

/**
 * Slack-optimized progress renderer.
 *
 * Produces more compact markdown since Slack's message rendering
 * has less vertical space than Discord embeds.
 */
export class SlackProgressRenderer extends BaseProgressRenderer {
    /** Compact thinking text without bold header. */
    protected override formatThinking(thinking: ThinkingBlock): string {
        return `💭 _${thinking.text}_`;
    }

    /** Compact single-line tool entries for Slack's narrower layout. */
    protected override formatToolEntry(tool: ToolEntry): string {
        const icon = tool.status === 'success' ? '✅' : tool.status === 'error' ? '❌' : '⏳';
        const result = tool.resultSummary && tool.status !== 'running' ? ` → ${tool.resultSummary}` : '';
        return `${icon} \`${tool.name}\`${result}`;
    }
}
