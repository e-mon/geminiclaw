/**
 * channels/progress/platform-behavior.ts — Platform-specific side effects.
 *
 * Abstracts emoji reactions, typing indicators, and raw API edits
 * so that ChatProgressReporter doesn't need platform conditionals.
 */

import type { SentMessage, Thread } from 'chat';
import { createLogger } from '../../logger.js';
import type { ProgressPhase } from './types.js';

const log = createLogger('platform-behavior');

type EmojiPhase = 'thinking' | 'tool' | 'done' | 'error';

const PHASE_EMOJI: Record<EmojiPhase, string> = {
    thinking: '🤔',
    tool: '🔧',
    done: '✅',
    error: '❌',
};

/** Maps ProgressPhase to EmojiPhase for reactions. */
function toEmojiPhase(phase: ProgressPhase): EmojiPhase {
    switch (phase) {
        case 'thinking':
        case 'streaming':
            return 'thinking';
        case 'tool_active':
            return 'tool';
        case 'completed':
            return 'done';
        case 'error':
            return 'error';
        case 'waiting_user':
            return 'thinking';
    }
}

/**
 * Platform-specific behaviors that are not representable via Card JSX.
 */
export interface PlatformBehavior {
    /** Set an emoji reaction reflecting the current phase. */
    setEmoji(phase: ProgressPhase, sent: SentMessage): Promise<void>;

    /** Send a typing indicator. */
    sendTyping(thread: Thread): void;

    /** Optional raw API edit (e.g. Discord embed color). Returns true if handled. */
    editRaw?(thread: Thread, sent: SentMessage, content: unknown): Promise<boolean>;
}

/**
 * Base behavior: typing indicator only, no emoji or raw edits.
 */
export class BasePlatformBehavior implements PlatformBehavior {
    async setEmoji(_phase: ProgressPhase, _sent: SentMessage): Promise<void> {
        // No-op for platforms without reaction support
    }

    sendTyping(thread: Thread): void {
        try {
            thread.startTyping();
        } catch {
            // Non-fatal
        }
    }
}

/**
 * Behavior for platforms that support emoji reactions via Chat SDK
 * (Discord, Slack, and any future adapter implementing addReaction/removeReaction).
 */
export class ReactionPlatformBehavior extends BasePlatformBehavior {
    private currentEmoji: EmojiPhase | undefined;

    override async setEmoji(phase: ProgressPhase, sent: SentMessage): Promise<void> {
        const emojiPhase = toEmojiPhase(phase);
        if (emojiPhase === this.currentEmoji) return;

        try {
            if (this.currentEmoji) {
                await sent.removeReaction(PHASE_EMOJI[this.currentEmoji]);
            }
            await sent.addReaction(PHASE_EMOJI[emojiPhase]);
            this.currentEmoji = emojiPhase;
        } catch (err) {
            log.warn('failed to set emoji reaction', { phase, error: String(err) });
        }
    }
}

/**
 * Create the appropriate PlatformBehavior for the given adapter name.
 */
export function createPlatformBehavior(adapterName: string): PlatformBehavior {
    switch (adapterName) {
        case 'discord':
        case 'slack':
            return new ReactionPlatformBehavior();
        default:
            return new BasePlatformBehavior();
    }
}
