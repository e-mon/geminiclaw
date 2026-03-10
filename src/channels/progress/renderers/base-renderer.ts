/**
 * channels/progress/renderers/base-renderer.ts — Markdown progress renderer.
 *
 * Produces a plain markdown string from a ProgressView. This is the
 * baseline format that works identically across all Chat SDK adapters
 * (Discord, Slack, etc.) without embed/Card quirks.
 *
 * Subclasses can override protected format methods to customize
 * individual parts for their platform.
 *
 * A future `renderCard()` method can produce Card JSX for richer
 * rendering once adapter edit-Card behavior is validated (Phase 2).
 */

import { buildParts } from '../parts.js';
import type {
    ProgressHeader,
    ProgressPart,
    ProgressView,
    StatsFooter,
    StreamPreview,
    ThinkingBlock,
    ToolEntry,
    ToolTimeline,
} from '../types.js';

const PHASE_LABELS: Record<string, string> = {
    thinking: '🤔 **Thinking…**',
    tool_active: '🔧 **Using tool…**',
    streaming: '💬 **Responding…**',
    waiting_user: '⏳ **Waiting for your reply…**',
    completed: '✅ **Done**',
    error: '❌ **Error**',
};

const TOOL_STATUS_ICON: Record<string, string> = {
    running: '🔧',
    success: '✅',
    error: '❌',
};

/** Maximum number of tools to show in the timeline (most recent). */
const MAX_TIMELINE_TOOLS = 5;
/** Max lines of stream text to show. */
const MAX_STREAM_LINES = 6;

/**
 * Base progress renderer producing plain markdown strings.
 *
 * Override protected methods to customize formatting for specific platforms.
 */
export class BaseProgressRenderer {
    /** Render a ProgressView into a markdown string for posting/editing. */
    render(view: ProgressView): string {
        const parts = buildParts(view);
        const sections = parts.map((part) => this.renderPart(part)).filter(Boolean);
        return sections.join('\n\n');
    }

    /** Dispatch a single part to its format method. */
    protected renderPart(part: ProgressPart): string {
        switch (part.type) {
            case 'header':
                return this.formatHeader(part);
            case 'tool_timeline':
                return this.formatToolTimeline(part);
            case 'thinking':
                return this.formatThinking(part);
            case 'stream_preview':
                return this.formatStreamPreview(part);
            case 'stats_footer':
                return this.formatStatsFooter(part);
        }
    }

    protected formatHeader(header: ProgressHeader): string {
        let text = PHASE_LABELS[header.phase] ?? '🔄 **Processing…**';
        if (header.skill) {
            text += `\n\n**Skill:** \`${header.skill}\``;
        }
        return text;
    }

    protected formatToolTimeline(timeline: ToolTimeline): string {
        const { tools } = timeline;
        const recent = tools.slice(-MAX_TIMELINE_TOOLS);
        const hidden = tools.length - recent.length;

        const lines: string[] = [];
        if (hidden > 0) {
            lines.push(`_…${hidden} earlier tool${hidden > 1 ? 's' : ''}_`);
        }
        for (const tool of recent) {
            lines.push(this.formatToolEntry(tool));
        }

        return lines.join('\n');
    }

    protected formatToolEntry(tool: ToolEntry): string {
        const icon = TOOL_STATUS_ICON[tool.status] ?? '🔧';
        let line = `${icon} \`${tool.name}\``;
        if (tool.description) {
            line += ` — ${tool.description}`;
        }
        if (tool.resultSummary && tool.status !== 'running') {
            line += `\n> ✓ ${tool.resultSummary}`;
        }
        return line;
    }

    protected formatThinking(thinking: ThinkingBlock): string {
        return `💭 **Thinking:**\n> ${thinking.text.replace(/\n/g, '\n> ')}`;
    }

    protected formatStreamPreview(preview: StreamPreview): string {
        const lines = preview.text.split('\n').slice(-MAX_STREAM_LINES);
        return `> ${lines.join('\n> ')}`;
    }

    protected formatStatsFooter(footer: StatsFooter): string {
        return `*${footer.elapsedSec}s elapsed · Tools: ${footer.toolCount}*`;
    }
}
