/**
 * channels/progress/parts.ts — Pure function to decompose ProgressView into semantic parts.
 *
 * buildParts() decides *which* parts to show based on the current view state.
 * Renderers decide *how* to display each part.
 */

import type { ProgressPart, ProgressView } from './types.js';

/**
 * Build an ordered list of semantic parts from a progress view snapshot.
 *
 * Args:
 *     view: Current progress state snapshot.
 *
 * Returns:
 *     Ordered list of parts to render.
 */
export function buildParts(view: ProgressView): ProgressPart[] {
    const parts: ProgressPart[] = [];

    // Header is always present
    parts.push({
        type: 'header',
        phase: view.phase,
        skill: view.skill,
    });

    // Tool timeline: show when any tools have been used
    if (view.tools.length > 0) {
        parts.push({
            type: 'tool_timeline',
            tools: view.tools,
        });
    }

    // Thinking block: only when we have thinking text and not in completed/error phase
    if (view.thinkingText && view.phase !== 'completed' && view.phase !== 'error') {
        parts.push({
            type: 'thinking',
            text: view.thinkingText,
        });
    }

    // Stream preview: only when actively streaming
    if (view.streamText && view.phase === 'streaming') {
        parts.push({
            type: 'stream_preview',
            text: view.streamText,
        });
    }

    // Stats footer is always present
    parts.push({
        type: 'stats_footer',
        elapsedSec: view.elapsedSec,
        toolCount: view.tools.length,
    });

    return parts;
}
