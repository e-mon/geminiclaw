/**
 * mcp/admin-server.test.ts — Tests for admin MCP server logic.
 */

import { describe, expect, it } from 'vitest';
import { classifyEffect } from './admin-server.js';

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
