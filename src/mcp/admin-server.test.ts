/**
 * mcp/admin-server.test.ts — Tests for admin MCP server logic.
 */

import { describe, expect, it } from 'vitest';
import { classifyEffect, parseMessageUrl } from './admin-server.js';

describe('classifyEffect', () => {
    const READ_COMMANDS: string[][] = [
        ['config', 'show'],
        ['config', 'get', 'model'],
        ['skill', 'list'],
        ['skill', 'enable', 'foo'],
        ['skill', 'disable', 'foo'],
        ['session', 'list'],
        ['status'],
        ['eval', 'list'],
        ['upgrade', '--check'],
        ['upgrade', '--dry-run'],
        ['config', 'set', '--help'],
    ];

    for (const args of READ_COMMANDS) {
        it(`classifies [${args.join(', ')}] as read`, () => {
            expect(classifyEffect(args)).toBe('read');
        });
    }

    it('classifies ["config", "set", "model", "pro"] as write', () => {
        expect(classifyEffect(['config', 'set', 'model', 'pro'])).toBe('write');
    });

    it('classifies ["upgrade"] as elevated', () => {
        expect(classifyEffect(['upgrade'])).toBe('elevated');
    });

    it('classifies ["skill", "remove", "foo"] as destructive', () => {
        expect(classifyEffect(['skill', 'remove', 'foo'])).toBe('destructive');
    });

    // skill install is intercepted — classifyEffect is never called for it in practice.
    // It falls through to 'read' since it's not in CONFIRM_COMMANDS, but the actual
    // effect is governed by handleSkillInstall() which uses confirmIfNeeded() directly.
    it('classifies ["skill", "install", "ref"] as read (intercepted, not classified here)', () => {
        expect(classifyEffect(['skill', 'install', 'ref'])).toBe('read');
    });

    // vault is fully blocked at command level, but classifyEffect
    // still returns 'read' since it's not in CONFIRM_COMMANDS
    it('classifies ["vault", "set", "key"] as read (blocked before reaching this)', () => {
        expect(classifyEffect(['vault', 'set', 'key'])).toBe('read');
    });

    it('classifies unknown command as read', () => {
        expect(classifyEffect(['help'])).toBe('read');
    });
});

describe('parseMessageUrl', () => {
    // ── Discord ──────────────────────────────────────────────────

    it('parses standard Discord message URL', () => {
        const result = parseMessageUrl('https://discord.com/channels/111/222/333');
        expect(result).toEqual({ platform: 'discord', guildId: '111', channelId: '222', messageId: '333' });
    });

    it('parses Discord PTB URL', () => {
        const result = parseMessageUrl('https://ptb.discord.com/channels/111/222/333');
        expect(result).toEqual({ platform: 'discord', guildId: '111', channelId: '222', messageId: '333' });
    });

    it('parses Discord canary URL', () => {
        const result = parseMessageUrl('https://canary.discord.com/channels/111/222/333');
        expect(result).toEqual({ platform: 'discord', guildId: '111', channelId: '222', messageId: '333' });
    });

    it('parses discordapp.com URL', () => {
        const result = parseMessageUrl('https://discordapp.com/channels/111/222/333');
        expect(result).toEqual({ platform: 'discord', guildId: '111', channelId: '222', messageId: '333' });
    });

    it('parses Discord URL with trailing slash', () => {
        const result = parseMessageUrl('https://discord.com/channels/111/222/333/');
        expect(result).toEqual({ platform: 'discord', guildId: '111', channelId: '222', messageId: '333' });
    });

    it('parses Discord URL with query params', () => {
        const result = parseMessageUrl('https://discord.com/channels/111/222/333?foo=bar');
        expect(result).toEqual({ platform: 'discord', guildId: '111', channelId: '222', messageId: '333' });
    });

    // ── Slack ────────────────────────────────────────────────────

    it('parses standard Slack message URL', () => {
        const result = parseMessageUrl('https://myworkspace.slack.com/archives/C12345678/p1234567890123456');
        expect(result).toEqual({
            platform: 'slack',
            workspace: 'myworkspace',
            channelId: 'C12345678',
            messageTs: '1234567890.123456',
        });
    });

    it('parses Slack URL with trailing slash', () => {
        const result = parseMessageUrl('https://myworkspace.slack.com/archives/C12345678/p1234567890123456/');
        expect(result).toEqual({
            platform: 'slack',
            workspace: 'myworkspace',
            channelId: 'C12345678',
            messageTs: '1234567890.123456',
        });
    });

    it('parses Slack URL with query params (thread_ts)', () => {
        const result = parseMessageUrl(
            'https://myworkspace.slack.com/archives/C12345678/p1234567890123456?thread_ts=1234567890.000000',
        );
        expect(result).toEqual({
            platform: 'slack',
            workspace: 'myworkspace',
            channelId: 'C12345678',
            messageTs: '1234567890.123456',
        });
    });

    // ── Invalid URLs ────────────────────────────────────────────

    it('returns undefined for unrecognized URL', () => {
        expect(parseMessageUrl('https://example.com/foo')).toBeUndefined();
    });

    it('returns undefined for Discord channel URL without message ID', () => {
        expect(parseMessageUrl('https://discord.com/channels/111/222')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
        expect(parseMessageUrl('')).toBeUndefined();
    });

    it('handles whitespace around URL', () => {
        const result = parseMessageUrl('  https://discord.com/channels/111/222/333  ');
        expect(result).toEqual({ platform: 'discord', guildId: '111', channelId: '222', messageId: '333' });
    });
});
