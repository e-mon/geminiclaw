/**
 * channels/progress/index.ts — Barrel export for progress display module.
 */

export { buildParts } from './parts.js';
export type { PlatformBehavior } from './platform-behavior.js';
export { createPlatformBehavior } from './platform-behavior.js';
export { BaseProgressRenderer } from './renderers/base-renderer.js';
export { DiscordProgressRenderer } from './renderers/discord-renderer.js';
export { SlackProgressRenderer } from './renderers/slack-renderer.js';
export type {
    ProgressHeader,
    ProgressPart,
    ProgressPhase,
    ProgressView,
    StatsFooter,
    StreamPreview,
    ThinkingBlock,
    ToolEntry,
    ToolTimeline,
} from './types.js';
export { ProgressViewBuilder } from './view-builder.js';
