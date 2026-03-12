/**
 * channels/list-channels.ts — Fetch available channels from Discord / Slack APIs.
 *
 * Shared by the setup wizard (CLI) and admin MCP server (agent).
 * Returns a unified format so consumers don't need to know API details.
 */

export interface ChannelEntry {
    id: string;
    name: string;
    /** Discord guild name or Slack workspace; undefined for flat lists. */
    group?: string;
}

interface DiscordGuild {
    id: string;
    name: string;
}

interface DiscordChannel {
    id: string;
    name: string;
    type: number;
}

interface SlackChannel {
    id: string;
    name: string;
    is_archived: boolean;
}

/**
 * Fetch text channels from all Discord guilds the bot belongs to.
 */
export async function fetchDiscordChannels(token: string): Promise<ChannelEntry[]> {
    const results: ChannelEntry[] = [];
    try {
        const res = await fetch('https://discord.com/api/v10/users/@me/guilds', {
            headers: { Authorization: `Bot ${token}` },
        });
        if (!res.ok) return results;
        const guilds = (await res.json()) as DiscordGuild[];

        for (const guild of guilds) {
            const chRes = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/channels`, {
                headers: { Authorization: `Bot ${token}` },
            });
            if (!chRes.ok) continue;
            const chans = (await chRes.json()) as DiscordChannel[];
            // type 0 = text channel
            for (const ch of chans.filter((c) => c.type === 0)) {
                results.push({ id: ch.id, name: ch.name, group: guild.name });
            }
        }
    } catch {
        /* network error */
    }
    return results;
}

interface TelegramChat {
    id: number;
    type: string;
    title?: string;
    first_name?: string;
    last_name?: string;
    username?: string;
}

interface TelegramUpdate {
    update_id: number;
    message?: { chat: TelegramChat };
}

/**
 * Fetch chats the Telegram bot has already received messages from.
 * Uses getUpdates to discover chats — the Bot API has no "list chats" endpoint.
 */
export async function fetchTelegramChats(botToken: string): Promise<ChannelEntry[]> {
    try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?limit=100`);
        if (!res.ok) return [];
        const body = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
        if (!body.ok || !body.result) return [];

        const seen = new Map<number, TelegramChat>();
        for (const update of body.result) {
            const chat = update.message?.chat;
            if (chat && !seen.has(chat.id)) {
                seen.set(chat.id, chat);
            }
        }

        return [...seen.values()].map((chat) => ({
            id: String(chat.id),
            name: chat.title ?? chat.first_name ?? chat.username ?? String(chat.id),
            group: chat.type === 'private' ? 'DM' : chat.type,
        }));
    } catch {
        return [];
    }
}

/**
 * Poll for a new Telegram message. Waits until a message arrives or timeout.
 * Returns the first discovered chat, or null on timeout.
 */
export async function pollForTelegramChat(botToken: string, timeoutMs: number): Promise<ChannelEntry | null> {
    const deadline = Date.now() + timeoutMs;
    let offset = 0;

    // Get the current offset to skip old messages
    try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?limit=1`);
        if (res.ok) {
            const body = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
            if (body.ok && body.result && body.result.length > 0) {
                offset = (body.result[body.result.length - 1] as TelegramUpdate).update_id + 1;
            }
        }
    } catch {
        /* ignore */
    }

    while (Date.now() < deadline) {
        try {
            const remaining = Math.min(30, Math.ceil((deadline - Date.now()) / 1000));
            if (remaining <= 0) break;
            const res = await fetch(
                `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=${remaining}&limit=1`,
            );
            if (!res.ok) break;
            const body = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
            if (body.ok && body.result && body.result.length > 0) {
                const chat = body.result[0]?.message?.chat;
                if (chat) {
                    return {
                        id: String(chat.id),
                        name: chat.title ?? chat.first_name ?? chat.username ?? String(chat.id),
                        group: chat.type === 'private' ? 'DM' : chat.type,
                    };
                }
            }
        } catch {
            break;
        }
    }
    return null;
}

/**
 * Fetch public channels from a Slack workspace.
 */
export async function fetchSlackChannels(token: string): Promise<ChannelEntry[]> {
    try {
        const res = await fetch(
            'https://slack.com/api/conversations.list?types=public_channel&exclude_archived=true&limit=200',
            { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) return [];
        const body = (await res.json()) as { ok: boolean; channels?: SlackChannel[] };
        if (!body.ok || !body.channels) return [];
        return body.channels.filter((c) => !c.is_archived).map((c) => ({ id: c.id, name: c.name }));
    } catch {
        return [];
    }
}
