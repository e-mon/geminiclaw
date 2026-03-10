/**
 * tui/utils/think-filter.ts — Pure-function thinking-tag processor.
 *
 * Strips <think>...</think> and <thought>...</thought> blocks from the
 * visible stream, capturing their content separately for optional display.
 */

const OPEN_TAGS = ['<think>', '<thought>'] as const;
const CLOSE_TAGS: Record<string, string> = {
    '<think>': '</think>',
    '<thought>': '</thought>',
};

// Longest possible partial prefix of any open tag (for safe-flush detection)
const MAX_OPEN_PREFIX = Math.max(...OPEN_TAGS.map((t) => t.length)) - 1;

export interface ThinkFilterState {
    readonly inThinkBlock: boolean;
    /** Which closing tag to look for while inside a block. */
    readonly closeTag: string;
    /** Partial tag buffer held back from flush (only when !inThinkBlock). */
    readonly pending: string;
    /** Accumulated think content (only when inThinkBlock). */
    readonly thinkAcc: string;
}

export function createThinkFilterState(): ThinkFilterState {
    return { inThinkBlock: false, closeTag: '', pending: '', thinkAcc: '' };
}

/**
 * Process a streaming delta through the think-tag filter.
 *
 * Returns:
 *   flushed      — visible text ready to display
 *   thinkFlushed — completed think-block content (empty if none finished)
 *   nextState    — updated state for the next call
 */
export function processThinkDelta(
    state: ThinkFilterState,
    delta: string,
): { flushed: string; thinkFlushed: string; nextState: ThinkFilterState } {
    let buf = state.pending + delta;
    let inThink = state.inThinkBlock;
    let closeTag = state.closeTag;
    let thinkAcc = state.thinkAcc;
    let flushed = '';
    let thinkFlushed = '';

    while (buf.length > 0) {
        if (inThink) {
            const closeIdx = buf.indexOf(closeTag);
            if (closeIdx === -1) {
                thinkAcc += buf;
                buf = '';
                break;
            }
            thinkFlushed += thinkAcc + buf.slice(0, closeIdx);
            thinkAcc = '';
            inThink = false;
            buf = buf.slice(closeIdx + closeTag.length);
            closeTag = '';
        } else {
            // Find the earliest opening tag among all candidates
            let bestIdx = -1;
            let bestTag = '';
            for (const tag of OPEN_TAGS) {
                const idx = buf.indexOf(tag);
                if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
                    bestIdx = idx;
                    bestTag = tag;
                }
            }

            if (bestIdx === -1) {
                const safeEnd = computeSafeEnd(buf);
                flushed += buf.slice(0, safeEnd);
                buf = buf.slice(safeEnd);
                break;
            }
            flushed += buf.slice(0, bestIdx);
            inThink = true;
            closeTag = CLOSE_TAGS[bestTag];
            thinkAcc = '';
            buf = buf.slice(bestIdx + bestTag.length);
        }
    }

    return {
        flushed,
        thinkFlushed,
        nextState: { inThinkBlock: inThink, closeTag, pending: buf, thinkAcc },
    };
}

/**
 * Flush remaining buffer at stream end.
 * Incomplete think blocks are discarded.
 */
export function flushThinkBuffer(state: ThinkFilterState): { text: string; think: string } {
    if (state.inThinkBlock) {
        return { text: '', think: '' };
    }
    return { text: state.pending, think: '' };
}

/**
 * How many chars at the end of `buf` to hold back because they could be
 * the start of any open tag (avoids prematurely flushing a partial tag).
 */
function computeSafeEnd(buf: string): number {
    for (let len = Math.min(buf.length, MAX_OPEN_PREFIX); len >= 1; len--) {
        const tail = buf.slice(-len);
        if (OPEN_TAGS.some((tag) => tag.startsWith(tail))) {
            return buf.length - len;
        }
    }
    return buf.length;
}
