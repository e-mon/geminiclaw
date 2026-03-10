/**
 * agent/context-builder.test.ts — Tests for static GEMINI.md + dynamic session context.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextBuilder, truncateWithContext } from './context-builder.js';

describe('ContextBuilder', () => {
    let tmpDir: string;
    let workspaceRoot: string;
    let builder: ContextBuilder;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'geminiclaw-ctx-test-'));
        workspaceRoot = join(tmpDir, 'workspace');
        mkdirSync(join(workspaceRoot, 'memory', 'sessions'), { recursive: true });

        builder = new ContextBuilder(workspaceRoot);
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── writeStaticGeminiMd ──────────────────────────────────────

    describe('writeStaticGeminiMd', () => {
        it('writes GEMINI.md with header and timezone', async () => {
            const content = await builder.writeStaticGeminiMd({ timezone: 'Asia/Tokyo' });

            expect(content).toContain('# GeminiClaw Agent Context');
            expect(content).toContain('Timezone: Asia/Tokyo');
            expect(content).toContain('geminiclaw_status');
        });

        it('writes GEMINI.md file to workspace root', async () => {
            await builder.writeStaticGeminiMd();
            const written = readFileSync(join(workspaceRoot, 'GEMINI.md'), 'utf-8');
            expect(written).toContain('# GeminiClaw Agent Context');
        });

        it('emits @-imports for existing workspace files', async () => {
            writeFileSync(join(workspaceRoot, 'SOUL.md'), '# Soul\nBe helpful.');
            writeFileSync(join(workspaceRoot, 'AGENTS.md'), '# Agents\nBe concise.');
            writeFileSync(join(workspaceRoot, 'USER.md'), '# User\nName: Test');
            writeFileSync(join(workspaceRoot, 'MEMORY.md'), '# Memory\nFacts here.');

            const content = await builder.writeStaticGeminiMd();
            expect(content).toContain('@SOUL.md');
            expect(content).toContain('@AGENTS.md');
            expect(content).toContain('@USER.md');
            expect(content).toContain('@MEMORY.md');
            // Content should NOT be inlined
            expect(content).not.toContain('Be helpful.');
            expect(content).not.toContain('Be concise.');
            expect(content).not.toContain('Name: Test');
            expect(content).not.toContain('Facts here.');
        });

        it('omits @-imports for missing files', async () => {
            const content = await builder.writeStaticGeminiMd();
            expect(content).not.toContain('@SOUL.md');
            expect(content).not.toContain('@AGENTS.md');
            expect(content).not.toContain('@USER.md');
            expect(content).not.toContain('@MEMORY.md');
        });

        it('includes memory guidelines with QMD search reference', async () => {
            const content = await builder.writeStaticGeminiMd();
            expect(content).toContain('## Memory Management');
            expect(content).toContain('qmd_search');
        });

        it('includes autonomy level restrictions when not autonomous', async () => {
            const readOnly = await builder.writeStaticGeminiMd({ autonomyLevel: 'read_only' });
            expect(readOnly).toContain('READ_ONLY');

            const supervised = await builder.writeStaticGeminiMd({ autonomyLevel: 'supervised' });
            expect(supervised).toContain('SUPERVISED');
        });

        it('does not include autonomy restrictions when autonomous', async () => {
            const content = await builder.writeStaticGeminiMd({ autonomyLevel: 'autonomous' });
            expect(content).not.toContain('READ_ONLY');
            expect(content).not.toContain('SUPERVISED');
        });

        it('does NOT contain session history or runtime directives', async () => {
            const content = await builder.writeStaticGeminiMd();
            expect(content).not.toContain('## Recent Session History');
            expect(content).not.toContain('## Runtime & Directives');
            expect(content).not.toContain('Trigger source:');
            expect(content).not.toContain('HEARTBEAT_OK');
        });

        it('does NOT contain daily logs', async () => {
            const todayStr = '2026-02-22';
            writeFileSync(join(workspaceRoot, 'memory', `${todayStr}.md`), '## 10:00 - Did something\nDetails.');

            const content = await builder.writeStaticGeminiMd();
            expect(content).not.toContain('## Recent Activity');
            expect(content).not.toContain('Did something');
        });
    });

    // ── sanitizeMemoryImports ─────────────────────────────────────

    describe('sanitizeMemoryImports', () => {
        it('strips @ from non-existent references', async () => {
            writeFileSync(join(workspaceRoot, 'MEMORY.md'), 'Follow @sonogame_wo on Twitter and @testuser too.');

            const removed = await builder.sanitizeMemoryImports();

            expect(removed).toEqual(['sonogame_wo', 'testuser']);
            const updated = readFileSync(join(workspaceRoot, 'MEMORY.md'), 'utf-8');
            expect(updated).toBe('Follow sonogame_wo on Twitter and testuser too.');
        });

        it('preserves valid @-imports with known extensions', async () => {
            writeFileSync(join(workspaceRoot, 'SOUL.md'), '# Soul');
            writeFileSync(
                join(workspaceRoot, 'MEMORY.md'),
                'See @SOUL.md for persona. Also @config.json is important.',
            );

            const removed = await builder.sanitizeMemoryImports();

            expect(removed).toEqual([]);
            const updated = readFileSync(join(workspaceRoot, 'MEMORY.md'), 'utf-8');
            expect(updated).toContain('@SOUL.md');
            expect(updated).toContain('@config.json');
        });

        it('preserves @ references to existing workspace files', async () => {
            writeFileSync(join(workspaceRoot, 'somefile'), 'data');
            writeFileSync(join(workspaceRoot, 'MEMORY.md'), 'Check @somefile for details.');

            const removed = await builder.sanitizeMemoryImports();

            expect(removed).toEqual([]);
            const updated = readFileSync(join(workspaceRoot, 'MEMORY.md'), 'utf-8');
            expect(updated).toContain('@somefile');
        });

        it('does not rewrite file when no changes needed', async () => {
            writeFileSync(join(workspaceRoot, 'MEMORY.md'), 'No at-signs here.');
            const mtimeBefore = statSync(join(workspaceRoot, 'MEMORY.md')).mtimeMs;

            const removed = await builder.sanitizeMemoryImports();

            expect(removed).toEqual([]);
            const mtimeAfter = statSync(join(workspaceRoot, 'MEMORY.md')).mtimeMs;
            expect(mtimeAfter).toBe(mtimeBefore);
        });

        it('returns empty array when MEMORY.md does not exist', async () => {
            const removed = await builder.sanitizeMemoryImports();
            expect(removed).toEqual([]);
        });
    });

    // ── geminiMdExists ───────────────────────────────────────────

    describe('geminiMdExists', () => {
        it('returns false when GEMINI.md does not exist', () => {
            expect(builder.geminiMdExists()).toBe(false);
        });

        it('returns true after writeStaticGeminiMd', async () => {
            await builder.writeStaticGeminiMd();
            expect(builder.geminiMdExists()).toBe(true);
        });
    });

    // ── buildSessionContext ──────────────────────────────────────

    describe('buildSessionContext', () => {
        it('includes runtime directives for heartbeat trigger', () => {
            const ctx = builder.buildSessionContext({ trigger: 'heartbeat' });
            expect(ctx).toContain('## Runtime & Directives');
            expect(ctx).toContain('Trigger source: heartbeat');
            expect(ctx).toContain('HEARTBEAT_OK');
        });

        it('includes runtime directives for manual trigger', () => {
            const ctx = builder.buildSessionContext({ trigger: 'manual' });
            expect(ctx).toContain('Trigger source: manual');
            expect(ctx).toContain('### Interactive Mode');
            // Should not contain the heartbeat reply instruction (but may mention HEARTBEAT_OK in negation)
            expect(ctx).not.toContain('### Heartbeat Mode');
        });

        it('includes cron mode directives', () => {
            const ctx = builder.buildSessionContext({ trigger: 'cron' });
            expect(ctx).toContain('### Cron Job Mode');
            expect(ctx).not.toContain('### Heartbeat Mode');
        });

        it('includes channel formatting for discord', () => {
            const ctx = builder.buildSessionContext({ trigger: 'discord' });
            expect(ctx).toContain('### Channel Context');
            expect(ctx).toContain('Platform Markdown');
        });

        it('does not include session history section (managed by Gemini CLI)', () => {
            const ctx = builder.buildSessionContext({ trigger: 'manual' });
            expect(ctx).not.toContain('Session History');
        });

        it('includes channel topic when provided for discord trigger', () => {
            const ctx = builder.buildSessionContext({
                trigger: 'discord',
                channelTopic: '日本語で応答してください',
            });
            expect(ctx).toContain('### Channel Behavior (from channel topic)');
            expect(ctx).toContain('> 日本語で応答してください');
            expect(ctx).toContain('mandatory behavioral instructions');
        });

        it('omits channel topic section when not provided', () => {
            const ctx = builder.buildSessionContext({ trigger: 'discord' });
            expect(ctx).not.toContain('### Channel Behavior (from channel topic)');
        });

        it('quotes each line of multiline channel topic', () => {
            const ctx = builder.buildSessionContext({
                trigger: 'discord',
                channelTopic: '日本語で応答\nコードレビューモード',
            });
            expect(ctx).toContain('> 日本語で応答');
            expect(ctx).toContain('> コードレビューモード');
        });

        it('omits channel topic for non-channel triggers', () => {
            const ctx = builder.buildSessionContext({
                trigger: 'manual',
                channelTopic: 'some topic',
            });
            expect(ctx).not.toContain('### Channel Behavior (from channel topic)');
        });

        it('does NOT contain daily logs', () => {
            const ctx = builder.buildSessionContext({ trigger: 'manual' });
            expect(ctx).not.toContain('## Recent Activity');
        });
    });
});

// ── truncateWithContext ──────────────────────────────────────────

describe('truncateWithContext', () => {
    it('returns content unchanged when under limit', () => {
        const content = 'short text';
        expect(truncateWithContext(content, 100)).toBe(content);
    });

    it('truncates with head/tail preservation', () => {
        const content = 'A'.repeat(1000);
        const result = truncateWithContext(content, 100);
        // 70% head = 70 chars, 20% tail = 20 chars
        expect(result).toContain('A'.repeat(70));
        expect(result).toContain('chars omitted');
        expect(result.length).toBeLessThan(1000);
    });

    it('preserves exact boundary content', () => {
        const content = `AAAA${'B'.repeat(96)}CCCC`;
        const result = truncateWithContext(content, 50);
        // Head should start with original head
        expect(result.startsWith('AAAA')).toBe(true);
        // Tail should end with original tail
        expect(result.endsWith('CCCC')).toBe(true);
    });
});
