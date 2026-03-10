/**
 * embedded-templates.ts — Auto-generated (dev mode)
 * DO NOT EDIT. Re-generate with: bun scripts/embed-templates.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const __dirname = import.meta.dirname ?? '.';

// biome-ignore format: auto-generated
const TEMPLATE_PATHS: Record<string, string> = {
    ".gemini/sandbox.bashrc": resolve(__dirname, "../templates/.gemini/sandbox.bashrc"),
    ".gemini/sandbox.Dockerfile": resolve(__dirname, "../templates/.gemini/sandbox.Dockerfile"),
    ".gemini/skills/agent-browser/references/authentication.md": resolve(__dirname, "../templates/.gemini/skills/agent-browser/references/authentication.md"),
    ".gemini/skills/agent-browser/references/commands.md": resolve(__dirname, "../templates/.gemini/skills/agent-browser/references/commands.md"),
    ".gemini/skills/agent-browser/references/profiling.md": resolve(__dirname, "../templates/.gemini/skills/agent-browser/references/profiling.md"),
    ".gemini/skills/agent-browser/references/proxy-support.md": resolve(__dirname, "../templates/.gemini/skills/agent-browser/references/proxy-support.md"),
    ".gemini/skills/agent-browser/references/session-management.md": resolve(__dirname, "../templates/.gemini/skills/agent-browser/references/session-management.md"),
    ".gemini/skills/agent-browser/references/site-patterns.md": resolve(__dirname, "../templates/.gemini/skills/agent-browser/references/site-patterns.md"),
    ".gemini/skills/agent-browser/references/snapshot-refs.md": resolve(__dirname, "../templates/.gemini/skills/agent-browser/references/snapshot-refs.md"),
    ".gemini/skills/agent-browser/references/video-recording.md": resolve(__dirname, "../templates/.gemini/skills/agent-browser/references/video-recording.md"),
    ".gemini/skills/agent-browser/SKILL.md": resolve(__dirname, "../templates/.gemini/skills/agent-browser/SKILL.md"),
    ".gemini/skills/agent-browser/templates/authenticated-session.sh": resolve(__dirname, "../templates/.gemini/skills/agent-browser/templates/authenticated-session.sh"),
    ".gemini/skills/agent-browser/templates/capture-workflow.sh": resolve(__dirname, "../templates/.gemini/skills/agent-browser/templates/capture-workflow.sh"),
    ".gemini/skills/agent-browser/templates/form-automation.sh": resolve(__dirname, "../templates/.gemini/skills/agent-browser/templates/form-automation.sh"),
    ".gemini/skills/coding-plan/SKILL.md": resolve(__dirname, "../templates/.gemini/skills/coding-plan/SKILL.md"),
    ".gemini/skills/cron/SKILL.md": resolve(__dirname, "../templates/.gemini/skills/cron/SKILL.md"),
    ".gemini/skills/daily-briefing/cron.json": resolve(__dirname, "../templates/.gemini/skills/daily-briefing/cron.json"),
    ".gemini/skills/daily-briefing/SKILL.md": resolve(__dirname, "../templates/.gemini/skills/daily-briefing/SKILL.md"),
    ".gemini/skills/deep-research/SKILL.md": resolve(__dirname, "../templates/.gemini/skills/deep-research/SKILL.md"),
    ".gemini/skills/github/SKILL.md": resolve(__dirname, "../templates/.gemini/skills/github/SKILL.md"),
    ".gemini/skills/gog/SKILL.md": resolve(__dirname, "../templates/.gemini/skills/gog/SKILL.md"),
    ".gemini/skills/pdf/SKILL.md": resolve(__dirname, "../templates/.gemini/skills/pdf/SKILL.md"),
    ".gemini/skills/self-manage/SKILL.md": resolve(__dirname, "../templates/.gemini/skills/self-manage/SKILL.md"),
    ".gemini/skills/session-logs/SKILL.md": resolve(__dirname, "../templates/.gemini/skills/session-logs/SKILL.md"),
    ".gemini/skills/todo-tracker/SKILL.md": resolve(__dirname, "../templates/.gemini/skills/todo-tracker/SKILL.md"),
    ".gemini/skills/topic-patrol/cron.json": resolve(__dirname, "../templates/.gemini/skills/topic-patrol/cron.json"),
    ".gemini/skills/topic-patrol/SKILL.md": resolve(__dirname, "../templates/.gemini/skills/topic-patrol/SKILL.md"),
    ".gemini/skills/translate-preview/references/build-injection.js": resolve(__dirname, "../templates/.gemini/skills/translate-preview/references/build-injection.js"),
    ".gemini/skills/translate-preview/references/extract-blocks.js": resolve(__dirname, "../templates/.gemini/skills/translate-preview/references/extract-blocks.js"),
    ".gemini/skills/translate-preview/references/extract.js": resolve(__dirname, "../templates/.gemini/skills/translate-preview/references/extract.js"),
    ".gemini/skills/translate-preview/references/inject-translations.js": resolve(__dirname, "../templates/.gemini/skills/translate-preview/references/inject-translations.js"),
    ".gemini/skills/translate-preview/references/package.json": resolve(__dirname, "../templates/.gemini/skills/translate-preview/references/package.json"),
    ".gemini/skills/translate-preview/references/render.js": resolve(__dirname, "../templates/.gemini/skills/translate-preview/references/render.js"),
    ".gemini/skills/translate-preview/references/twitter-extract.js": resolve(__dirname, "../templates/.gemini/skills/translate-preview/references/twitter-extract.js"),
    ".gemini/skills/translate-preview/references/twitter-render.js": resolve(__dirname, "../templates/.gemini/skills/translate-preview/references/twitter-render.js"),
    ".gemini/skills/translate-preview/SKILL.md": resolve(__dirname, "../templates/.gemini/skills/translate-preview/SKILL.md"),
    ".gemini/skills/workspace/SKILL.md": resolve(__dirname, "../templates/.gemini/skills/workspace/SKILL.md"),
    "AGENTS.md": resolve(__dirname, "../templates/AGENTS.md"),
    "HEARTBEAT.md": resolve(__dirname, "../templates/HEARTBEAT.md"),
    "MEMORY.md": resolve(__dirname, "../templates/MEMORY.md"),
    "SOUL.md": resolve(__dirname, "../templates/SOUL.md"),
    "USER.md": resolve(__dirname, "../templates/USER.md")
};

let cached: Record<string, string> | undefined;

export function getEmbeddedTemplates(): Record<string, string> {
    if (cached) return cached;
    cached = {};
    for (const [relPath, filePath] of Object.entries(TEMPLATE_PATHS)) {
        cached[relPath] = readFileSync(filePath, 'utf-8');
    }
    return cached;
}
