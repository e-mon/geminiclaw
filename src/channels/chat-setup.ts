/**
 * channels/chat-setup.ts — Chat SDK factory and singleton management.
 *
 * Creates a Chat instance with Discord/Slack adapters based on config.
 * The instance is registered as a singleton so serialized threads
 * can be deserialized anywhere (e.g. in Inngest steps).
 */

import { createMemoryState } from '@chat-adapter/state-memory';
import { type Adapter, Chat } from 'chat';
import type { Config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('chat-setup');

let chatInstance: Chat | undefined;

/**
 * Create and configure the Chat SDK instance.
 *
 * Registers Discord and Slack adapters based on the provided config.
 * Calls `registerSingleton()` so `ThreadImpl.fromJSON()` works globally.
 *
 * Args:
 *     config: GeminiClaw config with channel credentials.
 *
 * Returns:
 *     Initialized Chat instance.
 */
export async function createChat(config: Config): Promise<Chat> {
    if (chatInstance) return chatInstance;

    const adapters: Record<string, Adapter> = {};

    // Discord adapter: requires bot token, public key, and application ID.
    // applicationId is auto-fetched from Discord API if not set.
    // publicKey is required by the Chat SDK for webhook verification —
    // obtain it from Discord Developer Portal > Application > General Information.
    if (config.channels.discord.enabled && config.channels.discord.token) {
        let publicKey = process.env.DISCORD_PUBLIC_KEY;
        let applicationId = process.env.DISCORD_APPLICATION_ID;

        // Auto-fetch applicationId from Discord API using bot token
        if (!applicationId) {
            try {
                const res = await fetch('https://discord.com/api/v10/applications/@me', {
                    headers: { Authorization: `Bot ${config.channels.discord.token}` },
                });
                if (res.ok) {
                    const app = (await res.json()) as { id: string; verify_key: string };
                    applicationId = app.id;
                    // Also grab publicKey from the API if not set
                    if (!publicKey && app.verify_key) {
                        publicKey = app.verify_key;
                    }
                    log.info('fetched Discord application info from API', { applicationId });
                } else {
                    log.warn('failed to fetch Discord application info', { status: res.status });
                }
            } catch (err) {
                log.warn('failed to fetch Discord application info', { error: String(err) });
            }
        }

        if (!publicKey || !applicationId) {
            log.error(
                'Discord adapter not created — DISCORD_PUBLIC_KEY and DISCORD_APPLICATION_ID are required. ' +
                    'Get them from https://discord.com/developers/applications',
            );
        } else {
            const { createDiscordAdapter } = await import('@chat-adapter/discord');
            adapters.discord = createDiscordAdapter({
                botToken: config.channels.discord.token,
                publicKey,
                applicationId,
            });
            log.info('discord adapter registered');
        }
    }

    // Slack adapter: requires bot token and signing secret
    if (config.channels.slack.enabled && config.channels.slack.token && config.channels.slack.signingSecret) {
        const { createSlackAdapter } = await import('@chat-adapter/slack');
        adapters.slack = createSlackAdapter({
            botToken: config.channels.slack.token,
            signingSecret: config.channels.slack.signingSecret,
        });
        log.info('slack adapter registered');
    }

    const chat = new Chat({
        userName: 'geminiclaw',
        adapters,
        state: createMemoryState(),
        logger: 'warn',
    });

    // Required for ThreadImpl.fromJSON() deserialization in Inngest steps
    chat.registerSingleton();

    chatInstance = chat;
    return chat;
}

/**
 * Get the existing Chat instance.
 *
 * Returns:
 *     The Chat singleton, or undefined if not yet created.
 */
export function getChat(): Chat | undefined {
    return chatInstance;
}
