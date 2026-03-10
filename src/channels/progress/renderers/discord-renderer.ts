/**
 * channels/progress/renderers/discord-renderer.ts — Discord-specific renderer.
 *
 * Extends BaseProgressRenderer with:
 * - Phase-based embed accent colors (for future raw API PATCH in Phase 2)
 * - Compact tool timeline formatting using arrow notation
 */

import type { ProgressPhase, ProgressView, ToolEntry } from '../types.js';
import { BaseProgressRenderer } from './base-renderer.js';

/** Discord embed color per phase (decimal RGB). */
const PHASE_COLORS: Record<ProgressPhase, number> = {
    thinking: 0xffa500, // orange
    tool_active: 0xffcc00, // yellow
    streaming: 0x3498db, // blue
    waiting_user: 0x9b59b6, // purple
    completed: 0x2ecc71, // green
    error: 0xe74c3c, // red
};

/**
 * Discord-optimized progress renderer.
 *
 * render() produces a plain markdown string (same as base).
 * `getEmbedColor()` provides the phase-appropriate color for
 * future raw Discord API PATCH (Phase 2).
 */
export class DiscordProgressRenderer extends BaseProgressRenderer {
    private lastPhase: ProgressPhase = 'thinking';

    override render(view: ProgressView): string {
        this.lastPhase = view.phase;
        return super.render(view);
    }

    /** Get the embed color for the current phase (for raw Discord API in Phase 2). */
    getEmbedColor(): number {
        return PHASE_COLORS[this.lastPhase] ?? PHASE_COLORS.thinking;
    }

    /** Compact tool entry for Discord (arrow notation for results). */
    protected override formatToolEntry(tool: ToolEntry): string {
        const icon = tool.status === 'success' ? '✅' : tool.status === 'error' ? '❌' : '🔧';
        let line = `${icon} \`${tool.name}\``;
        if (tool.status === 'running') {
            if (tool.description) {
                line += ` ${tool.description}`;
            }
        } else {
            if (tool.resultSummary) {
                line += ` → ${tool.resultSummary}`;
            }
        }
        return line;
    }
}
