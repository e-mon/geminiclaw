/**
 * channels/chat-progress.ts — Chat SDK progress reporter.
 *
 * Shows a live "processing..." indicator in the thread that updates
 * as tool_use, think, and skill_activation events arrive, then either
 * finalizes into the reply (preview direct finalization) or deletes
 * itself when the run finishes.
 *
 * Delegates to:
 *   - ProgressViewBuilder  — state accumulation from StreamEvents
 *   - BaseProgressRenderer — Card JSX rendering (PF-specific subclasses override)
 *   - PlatformBehavior     — emoji reactions, typing, raw API calls
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SentMessage, Thread } from 'chat';
import { Actions, Button, Card, CardText } from 'chat';
import { writePending } from '../agent/ask-user-state.js';
import type { StreamEvent } from '../agent/runner.js';
import { createLogger } from '../logger.js';
import { createPlatformBehavior, type PlatformBehavior } from './progress/platform-behavior.js';
import { BaseProgressRenderer } from './progress/renderers/base-renderer.js';
import { DiscordProgressRenderer } from './progress/renderers/discord-renderer.js';
import { SlackProgressRenderer } from './progress/renderers/slack-renderer.js';
import { ProgressViewBuilder } from './progress/view-builder.js';
import type { ProgressReporter } from './progress-reporter.js';

const log = createLogger('chat-progress');

/** Minimum interval (ms) between progress message edits to avoid Discord rate limits. */
const EDIT_THROTTLE_MS = 3000;
/** Typing indicator keepalive interval (ms). Discord typing lasts ~10s, we refresh at 8s. */
const TYPING_KEEPALIVE_MS = 8000;

/**
 * Create the appropriate renderer for the given adapter name.
 */
function createRenderer(adapterName: string): BaseProgressRenderer {
    switch (adapterName) {
        case 'discord':
            return new DiscordProgressRenderer();
        case 'slack':
            return new SlackProgressRenderer();
        default:
            return new BaseProgressRenderer();
    }
}

/**
 * Chat SDK implementation of ProgressReporter.
 *
 * Uses thread.post() to create a progress message, then sent.edit()
 * and sent.delete() to update and remove it. All operations are
 * non-fatal — network errors degrade gracefully without aborting the run.
 */
export class ChatProgressReporter implements ProgressReporter {
    private readonly thread: Thread;
    private readonly workspacePath: string | undefined;
    private readonly sessionId: string | undefined;
    private readonly viewBuilder: ProgressViewBuilder;
    private readonly renderer: BaseProgressRenderer;
    private readonly platform: PlatformBehavior;
    private sent: SentMessage | undefined;
    private lastEditMs = 0;
    /** Earliest timestamp (ms) at which the next edit is allowed. Set on 429 backoff. */
    private editNotBefore = 0;
    private pendingEdit = false;
    private inflightEdit: Promise<void> | undefined;
    private editTimer: ReturnType<typeof setTimeout> | undefined;
    private typingTimer: ReturnType<typeof setInterval> | undefined;
    /** Set to true when finish() edits the progress message into the final reply. */
    private finalized = false;
    /** Set to true while waiting for user answer; cleared on next non-ask event. */
    private awaitingAskAnswer = false;
    /**
     * Full stream text accumulated from message deltas.
     * Used to flush pre-ask text as a separate message so the chat timeline
     * reads in chronological order (pre-ask text → Q&A card → post-ask text).
     */
    private fullStreamText = '';
    /** Text that was flushed before an ask_user card, stripped from finalText in finish(). */
    private preAskFlushedText: string | undefined;

    constructor(thread: Thread, workspacePath?: string, sessionId?: string) {
        this.thread = thread;
        this.workspacePath = workspacePath;
        this.sessionId = sessionId;
        this.viewBuilder = new ProgressViewBuilder();

        // Detect adapter name for PF-specific rendering and behavior
        const adapterName = thread.adapter?.name ?? '';
        this.renderer = createRenderer(adapterName);
        this.platform = createPlatformBehavior(adapterName);
    }

    async start(): Promise<void> {
        // Clean up orphaned progress message from a previous Inngest attempt.
        // When a step is retried, the old reporter's in-memory state is lost
        // but the Discord message persists. We persist the message ID to a file
        // so the next attempt can delete it.
        await this.cleanupStaleProgress();

        try {
            const content = this.renderer.render(this.viewBuilder.snapshot());
            this.sent = await this.thread.post(content);
            log.info('progress message posted', { messageId: this.sent.id, threadId: this.thread.id });
            this.persistProgressId(this.sent.id);
        } catch (err) {
            log.warn('failed to post progress message', { error: String(err) });
        }

        this.startTypingKeepalive();

        if (this.sent) {
            await this.platform.setEmoji('thinking', this.sent);
        }
    }

    onEvent(event: StreamEvent): void {
        this.processEvent(event).catch((err) => {
            log.warn('processEvent failed', { event: event.type, error: String(err) });
        });
    }

    async finish(finalText?: string): Promise<void> {
        if (this.editTimer) clearTimeout(this.editTimer);
        // Wait for any in-flight throttled edit to complete before sending the
        // final edit, otherwise the throttled PATCH may arrive after ours and
        // overwrite the finalized content back to "Responding...".
        if (this.inflightEdit) {
            await this.inflightEdit.catch(() => {});
        }
        // Respect 429 backoff before sending the final edit/delete.
        // Only wait for the backoff deadline, not the normal throttle interval —
        // finish shouldn't be delayed just because a regular edit happened recently.
        const backoffRemaining = this.editNotBefore - Date.now();
        if (backoffRemaining > 0) {
            await new Promise((r) => setTimeout(r, Math.min(backoffRemaining, 10_000)));
        }
        this.stopTypingKeepalive();

        // Strip pre-ask text that was already flushed as a separate message.
        // Without this, the final reply would duplicate text the user already saw.
        let effectiveFinalText = finalText;
        if (effectiveFinalText && this.preAskFlushedText) {
            const idx = effectiveFinalText.indexOf(this.preAskFlushedText);
            if (idx !== -1) {
                effectiveFinalText = effectiveFinalText.slice(idx + this.preAskFlushedText.length).trimStart();
            }
        }

        // Final emoji
        if (this.sent) {
            const finalPhase = this.viewBuilder.hadError ? 'error' : 'completed';
            await this.platform.setEmoji(finalPhase, this.sent);
        }

        if (!this.sent) return;

        // Always delete the progress message so the caller posts the reply as a new message.
        // Discord does not send push notifications for message edits, so editing the progress
        // message into the final reply would leave users unnotified for long-running tasks.
        // See: https://github.com/e-mon/geminiclaw/issues/6
        try {
            await this.thread.adapter.deleteMessage(this.thread.id, this.sent.id);
            log.info('progress message deleted', { messageId: this.sent.id });
        } catch (err) {
            log.warn('failed to delete progress message', { error: String(err) });
        }

        this.clearProgressId();
    }

    /** Whether finish() successfully edited the progress message into the final reply. */
    get wasFinalized(): boolean {
        return this.finalized;
    }

    // ── Private ──────────────────────────────────────────────────

    private async processEvent(event: StreamEvent): Promise<void> {
        // Accumulate full stream text for pre-ask flushing
        if (event.type === 'message' && event.role === 'assistant' && event.delta) {
            this.fullStreamText += event.delta;
        }

        // Handle ask_user separately — it has side effects beyond state tracking
        if (event.type === 'ask_user') {
            this.viewBuilder.processEvent(event);
            await this.flushPreAskText();
            await this.handleAskUser(event);
            await this.doEdit();
            this.awaitingAskAnswer = true;
            return;
        }

        // After ask_user is answered, the model resumes and sends new events.
        // Delete the old progress message (above the Q&A log) and re-post below it
        // so the timeline reads top-to-bottom: Q&A log → resumed progress → final reply.
        if (this.awaitingAskAnswer) {
            this.awaitingAskAnswer = false;
            this.fullStreamText = '';
            await this.repostProgressBelow();
        }

        // Delegate state accumulation to the view builder
        const changed = this.viewBuilder.processEvent(event);
        if (!changed) return;

        // High-frequency streaming events use throttled edits
        if (event.type === 'message') {
            this.scheduleEdit();
            return;
        }

        // Phase-based emoji transitions for tool events
        if (event.type === 'tool_use' && this.sent) {
            this.platform.setEmoji('tool_active', this.sent).catch(() => {});
        }

        await this.doEdit();
    }

    /**
     * Flush accumulated stream text as a separate message before the Q&A card.
     *
     * Without this, pre-ask text is hidden inside the progress indicator and
     * only reappears in the final reply — making it look like everything was
     * generated after the user answered.
     */
    private async flushPreAskText(): Promise<void> {
        const text = this.fullStreamText.trim();
        if (!text) return;

        try {
            await this.thread.post(text);
            this.preAskFlushedText = text;
            log.info('pre-ask stream text flushed', { chars: text.length });
        } catch (err) {
            log.warn('failed to flush pre-ask text', { error: String(err) });
        }

        this.fullStreamText = '';
    }

    /** Handle ask_user: post question card and write pending state. */
    private async handleAskUser(event: StreamEvent): Promise<void> {
        if (event.type !== 'ask_user') return;

        const askId = event.askId;
        let cardMessageId: string | undefined;

        // Post the question as a separate message (not the progress indicator)
        // so it persists after finish() deletes the progress message.
        try {
            if (this.thread.adapter?.name === 'discord') {
                // Post via Discord REST API directly to avoid the double-display
                // bug where the Chat SDK sets both `content` (fallback text) and
                // `embeds`, causing Discord to render the question twice.
                cardMessageId = await this.postAskCardDiscord(askId, event.question, event.options);
            } else {
                let sent: SentMessage | undefined;
                if (event.options && event.options.length > 0) {
                    const buttons = event.options.map((opt, i) =>
                        Button({
                            id: `ask-user:${askId}:${i}`,
                            label: opt,
                            style: i === 0 ? 'primary' : 'default',
                            value: String(i),
                        }),
                    );
                    sent = await this.thread.post(
                        Card({
                            children: [CardText(`**Agent asks:**\n${event.question}`), Actions(buttons)],
                        }),
                    );
                } else {
                    sent = await this.thread.post(`**Agent asks:**\n${event.question}`);
                }
                cardMessageId = sent?.id;
            }
        } catch (err) {
            log.warn('failed to post ask_user question', { error: String(err) });
        }

        // Write pending state so chat-handlers can route the user's reply.
        // Include cardMessageId so the handler can edit it into a Q&A log.
        if (this.workspacePath && this.sessionId) {
            writePending(this.workspacePath, {
                askId,
                sessionId: this.sessionId,
                question: event.question,
                options: event.options,
                timestamp: event.timestamp,
                runId: event.runId,
                cardMessageId,
            });
        }
    }

    /**
     * Post an ask_user card via Discord REST API (embed + components only, no content).
     *
     * The Chat SDK's Card rendering sets both `content` and `embeds` on Discord
     * messages, causing the question to appear twice. Posting directly avoids this.
     */
    private async postAskCardDiscord(askId: string, question: string, options?: string[]): Promise<string | undefined> {
        const parts = this.thread.id.split(':');
        // In threads, messages go to parts[3] (thread channel); otherwise parts[2]
        const channelId = parts[3] ?? parts[2] ?? '';
        const botToken = (this.thread.adapter as unknown as { botToken: string }).botToken;
        log.info('postAskCardDiscord', {
            askId,
            optionCount: options?.length ?? 0,
            options: options?.join(', '),
        });
        if (!channelId || !botToken) {
            // Fallback to plain text if we can't extract Discord details
            const sent = await this.thread.post(`**Agent asks:**\n${question}`);
            return sent?.id;
        }

        const payload: Record<string, unknown> = {
            embeds: [
                {
                    description: `**Agent asks:**\n${question}`,
                    color: 0x9b59b6, // purple
                },
            ],
        };

        if (options && options.length > 0) {
            const buttons = options.map((opt, i) => ({
                type: 2, // BUTTON
                style: i === 0 ? 1 : 2, // PRIMARY : SECONDARY
                label: opt,
                custom_id: `ask-user:${askId}:${i}`,
            }));
            payload.components = [{ type: 1, components: buttons }]; // ACTION_ROW
        }

        const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
            body: JSON.stringify(payload),
        });

        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            log.warn('Discord REST: failed to post ask card', {
                status: resp.status,
                body: body.substring(0, 300),
            });
            // Fallback to Chat SDK
            const sent = await this.thread.post(`**Agent asks:**\n${question}`);
            return sent?.id;
        }

        const data = (await resp.json()) as { id?: string; components?: unknown[] };
        log.info('Discord REST: ask card posted', {
            messageId: data.id,
            hasComponents: !!data.components?.length,
        });
        return data.id;
    }

    /**
     * Delete the current progress message and re-post it so it appears
     * below the Q&A log card, preserving chronological order.
     */
    private async repostProgressBelow(): Promise<void> {
        if (!this.sent) return;
        try {
            await this.thread.adapter.deleteMessage(this.thread.id, this.sent.id);
        } catch {
            // Non-fatal — old message may already be gone
        }
        try {
            const content = this.renderer.render(this.viewBuilder.snapshot());
            this.sent = await this.thread.post(content);
            this.persistProgressId(this.sent.id);
            log.info('progress message re-posted below Q&A log', { messageId: this.sent.id });
        } catch (err) {
            log.warn('failed to re-post progress message', { error: String(err) });
        }
    }

    // ── Progress message persistence (orphan cleanup) ─────────────

    private get progressIdPath(): string | undefined {
        if (!this.workspacePath || !this.sessionId) return undefined;
        const safe = this.sessionId.replace(/[:/\\]/g, '_');
        return join(this.workspacePath, 'memory', `progress-msg-${safe}.json`);
    }

    private persistProgressId(messageId: string): void {
        const path = this.progressIdPath;
        if (!path) return;
        try {
            writeFileSync(path, JSON.stringify({ messageId, threadId: this.thread.id }), 'utf-8');
        } catch {
            // Non-fatal
        }
    }

    private clearProgressId(): void {
        const path = this.progressIdPath;
        if (!path) return;
        try {
            unlinkSync(path);
        } catch {
            // File may not exist
        }
    }

    /** Delete orphaned progress message from a previous Inngest attempt. */
    private async cleanupStaleProgress(): Promise<void> {
        const path = this.progressIdPath;
        if (!path || !existsSync(path)) return;
        try {
            const data = JSON.parse(readFileSync(path, 'utf-8')) as { messageId?: string; threadId?: string };
            if (data.messageId && data.threadId) {
                await this.thread.adapter.deleteMessage(data.threadId, data.messageId);
                log.info('stale progress message cleaned up', { messageId: data.messageId });
            }
            unlinkSync(path);
        } catch (err) {
            log.warn('failed to clean up stale progress', { error: String(err) });
            try {
                unlinkSync(path);
            } catch {
                // ignore
            }
        }
    }

    /** Throttled edit for high-frequency events (message chunks). */
    private scheduleEdit(): void {
        if (this.pendingEdit) return;
        const now = Date.now();
        // Two constraints: normal throttle interval and 429 backoff.
        // Use whichever pushes the next edit further into the future.
        const nextAllowed = Math.max(this.lastEditMs + EDIT_THROTTLE_MS, this.editNotBefore);
        const delay = Math.max(0, nextAllowed - now);
        if (delay === 0) {
            this.pendingEdit = true;
            const p = this.doEdit().finally(() => {
                this.pendingEdit = false;
                this.inflightEdit = undefined;
            });
            this.inflightEdit = p;
        } else {
            this.pendingEdit = true;
            if (this.editTimer) clearTimeout(this.editTimer);
            this.editTimer = setTimeout(() => {
                const p = this.doEdit().finally(() => {
                    this.pendingEdit = false;
                    this.inflightEdit = undefined;
                });
                this.inflightEdit = p;
            }, delay);
        }
    }

    private async doEdit(): Promise<void> {
        if (!this.sent) return;
        try {
            const content = this.renderer.render(this.viewBuilder.snapshot());
            await this.thread.adapter.editMessage(this.thread.id, this.sent.id, content);
            this.lastEditMs = Date.now();
        } catch (err) {
            // On rate limit, set a backoff deadline separate from the throttle timer
            const retryAfter = parseRetryAfter(err);
            if (retryAfter > 0) {
                this.editNotBefore = Date.now() + retryAfter;
            }
        }
    }

    // ── Typing indicator ─────────────────────────────────────────

    private startTypingKeepalive(): void {
        this.platform.sendTyping(this.thread);
        this.typingTimer = setInterval(() => this.platform.sendTyping(this.thread), TYPING_KEEPALIVE_MS);
    }

    private stopTypingKeepalive(): void {
        if (this.typingTimer) {
            clearInterval(this.typingTimer);
            this.typingTimer = undefined;
        }
    }
}

/** Extract retry_after (ms) from a Discord 429 error, or return 0. */
function parseRetryAfter(err: unknown): number {
    const msg = String(err);
    const match = /"retry_after":\s*([\d.]+)/.exec(msg);
    if (match) return Math.ceil(Number(match[1]) * 1000);

    // Some SDK wrappers expose retryAfter as a property
    if (err && typeof err === 'object' && 'retryAfter' in err) {
        const val = (err as Record<string, unknown>).retryAfter;
        if (typeof val === 'number') return Math.ceil(val * 1000);
    }
    return 0;
}
