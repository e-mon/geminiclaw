/**
 * agent/session/title.ts — Session title generation + Discord thread rename.
 *
 * Generates a short title from the first turn of a session using Gemini CLI.
 * Also provides helpers to rename Discord threads via REST API.
 */

import { createLogger } from '../../logger.js';
import { spawnGeminiAcp } from '../acp/runner.js';

const log = createLogger('session-title');

const TITLE_MODEL = 'gemini-2.5-flash-lite';
const MAX_TITLE_LENGTH = 30;
const FALLBACK_TITLE_LENGTH = 30;

/**
 * Generate a short session title from the first turn's prompt and response.
 *
 * Uses Gemini CLI to produce a concise title (≤20 chars). Falls back to
 * truncating the prompt when the CLI call fails.
 *
 * Args:
 *     prompt: The user's first message.
 *     responseText: The agent's first response.
 *     workspacePath: Workspace root for Gemini CLI cwd.
 *
 * Returns:
 *     A short title string (never throws).
 */
export async function generateSessionTitle(
    prompt: string,
    responseText: string,
    workspacePath: string,
): Promise<string> {
    try {
        const titlePrompt = [
            `Generate a concise title (max ${MAX_TITLE_LENGTH} characters) for this conversation.`,
            'Rules:',
            '- Be SPECIFIC. Name the concrete subject — file names, feature names, API names, error types, tools, topics, etc.',
            '  Good: "Fix S3 upload timeout" Bad: "Bug fix"',
            '  Good: "Add retry to OAuth flow" Bad: "Feature work"',
            '- For casual/non-technical conversations, capture the actual topic discussed.',
            '  Good: "Weekend travel plans" Bad: "Chat"',
            '  Good: "Recommend sci-fi books" Bad: "Discussion"',
            '- For questions or research, state what was asked or investigated.',
            '  Good: "How Redis pub/sub works" Bad: "Question"',
            '- Match the conversation language (Japanese prompt → Japanese title).',
            '- Reply with ONLY the title text. No quotes, no punctuation, no explanation.',
            '',
            `User: ${prompt.substring(0, 800)}`,
            `Agent: ${responseText.substring(0, 500)}`,
        ].join('\n');

        const result = await spawnGeminiAcp({
            cwd: workspacePath,
            trigger: 'manual',
            prompt: titlePrompt,
            model: TITLE_MODEL,
        });

        const text = result.responseText.trim();
        if (!text) {
            return buildFallbackTitle(prompt);
        }

        return text.length > MAX_TITLE_LENGTH ? text.substring(0, MAX_TITLE_LENGTH) : text;
    } catch (err) {
        log.warn('title generation failed', { error: String(err) });
        return buildFallbackTitle(prompt);
    }
}

/**
 * Fallback title: first N characters of the prompt with channel prefix stripped.
 */
export function buildFallbackTitle(prompt: string): string {
    // Strip channel prefix like "[discord] Username: " from the prompt
    const stripped = prompt.replace(/^\[[^\]]+\]\s*[^:]+:\s*/, '');
    const text = stripped || prompt;
    if (text.length <= FALLBACK_TITLE_LENGTH) return text;
    return `${text.substring(0, FALLBACK_TITLE_LENGTH - 1)}…`;
}

// ── Discord thread rename ────────────────────────────────────────

/**
 * Rename a Discord thread via REST API.
 *
 * Fire-and-forget — logs warnings but never throws.
 *
 * Args:
 *     botToken: Discord bot token.
 *     threadId: Discord thread/channel ID.
 *     name: New thread name.
 */
export async function renameDiscordThread(botToken: string, threadId: string, name: string): Promise<void> {
    try {
        const response = await fetch(`https://discord.com/api/v10/channels/${threadId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bot ${botToken}`,
            },
            body: JSON.stringify({ name }),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            log.warn('discord thread rename failed', {
                status: response.status,
                threadId,
                body: body.substring(0, 200),
            });
        } else {
            log.info('discord thread renamed', { threadId, name });
        }
    } catch (err) {
        log.warn('discord thread rename error', { error: String(err), threadId });
    }
}

// ── serializedThread parser ──────────────────────────────────────

export interface ParsedThread {
    adapter: string;
    /** Discord thread/channel ID (the actual Discord snowflake). */
    discordThreadId?: string;
}

/**
 * Parse a serializedThread JSON to extract adapter name and Discord thread ID.
 *
 * The serialized thread contains an `id` field with format:
 *   "discord:guildId:channelId:threadId" (guild thread)
 *   "discord:guildId:channelId" (guild channel — no separate thread)
 *
 * For Discord threads, the Discord snowflake is the last segment (threadId if
 * present, otherwise channelId — since the bot creates threads, the thread's
 * snowflake is where we want to rename).
 *
 * Args:
 *     serializedThread: JSON string from AgentRunEventData.serializedThread.
 *
 * Returns:
 *     Parsed adapter name and optional Discord thread ID.
 */
export function parseSerializedThread(serializedThread: string): ParsedThread {
    try {
        const parsed = JSON.parse(serializedThread) as { id?: string; adapter?: string };
        const id = parsed.id ?? '';
        const parts = id.split(':');
        const adapter = parts[0] ?? '';

        if (adapter === 'discord' && parts.length >= 4 && parts[3]) {
            // Only rename actual threads (parts[3]), never text channels (parts[2])
            return { adapter, discordThreadId: parts[3] };
        }

        return { adapter };
    } catch {
        return { adapter: '' };
    }
}
