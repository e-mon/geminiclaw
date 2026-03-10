/**
 * agent/session/summary-template.ts — Default Markdown template for session summaries.
 *
 * Uses Handlebars-style placeholders ({{var}}) for variable substitution.
 * Custom templates can override this via config.sessionSummary.template.
 */

export const DEFAULT_SUMMARY_TEMPLATE = `\
---
date: "{{date}}"
session: "{{sessionId}}"
trigger: "{{trigger}}"
turns: {{turns}}
tokens: {{tokens}}
duration_min: {{durationMin}}
tags:
{{tags}}
---

# {{title}}

## TL;DR
{{tldr}}

## Topics
{{topics}}

## Key Decisions
{{decisions}}

## Conversation Log
{{conversationLog}}
`;

export interface SummaryTemplateVars {
    date: string;
    sessionId: string;
    trigger: string;
    turns: number;
    tokens: number;
    durationMin: number;
    tags: string[];
    title: string;
    tldr: string;
    topics: Array<{ topic: string; summary: string }>;
    decisions: string[];
    conversationLog: string;
}

/** Escape a string for safe YAML value embedding (quote-wrapped). */
function yamlEscape(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Render a summary template with the given variables.
 *
 * Supports simple {{var}} substitution and array formatting for
 * tags (YAML list) and decisions (Markdown list).
 * Uses replaceAll to support multiple occurrences in custom templates.
 */
export function renderSummaryTemplate(template: string, vars: SummaryTemplateVars): string {
    let result = template;

    // Format tags as YAML list items
    const tagsYaml = vars.tags.map((t) => `  - ${t}`).join('\n');
    result = result.replaceAll('{{tags}}', tagsYaml);

    // Format topics as bold-label bullet list
    const topicsMd = vars.topics.map((t) => `- **${t.topic}**: ${t.summary}`).join('\n');
    result = result.replaceAll('{{topics}}', topicsMd);

    // Format decisions as Markdown list items
    const decisionsMd = vars.decisions.map((d) => `- ${d}`).join('\n');
    result = result.replaceAll('{{decisions}}', decisionsMd);

    // Scalar substitutions — YAML frontmatter values are escaped
    result = result.replaceAll('{{date}}', yamlEscape(vars.date));
    result = result.replaceAll('{{sessionId}}', yamlEscape(vars.sessionId));
    result = result.replaceAll('{{trigger}}', yamlEscape(vars.trigger));
    result = result.replaceAll('{{turns}}', String(vars.turns));
    result = result.replaceAll('{{tokens}}', String(vars.tokens));
    result = result.replaceAll('{{durationMin}}', String(vars.durationMin));
    result = result.replaceAll('{{title}}', vars.title);
    result = result.replaceAll('{{tldr}}', vars.tldr);
    result = result.replaceAll('{{conversationLog}}', vars.conversationLog);

    return result;
}
