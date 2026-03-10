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
