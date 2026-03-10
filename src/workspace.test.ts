/**
 * workspace.test.ts — Tests for workspace management.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace } from './workspace.js';

describe('Workspace', () => {
    let tmpDir: string;
    let workspacePath: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'geminiclaw-ws-test-'));
        workspacePath = join(tmpDir, 'workspace');
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('create', () => {
        it('initializes workspace with directories and templates', async () => {
            const ws = await Workspace.create(workspacePath);

            expect(existsSync(join(workspacePath, 'memory'))).toBe(true);
            expect(existsSync(join(workspacePath, 'memory', 'sessions'))).toBe(true);
            expect(existsSync(join(workspacePath, '.gemini', 'skills'))).toBe(true);
            expect(existsSync(join(workspacePath, 'runs'))).toBe(true);
            // Embedded templates should be written
            expect(existsSync(join(workspacePath, 'AGENTS.md'))).toBe(true);
            expect(ws.root).toBe(workspacePath);
        });

        it('does not overwrite existing files', async () => {
            mkdirSync(workspacePath, { recursive: true });
            writeFileSync(join(workspacePath, 'SOUL.md'), '# Custom Soul\n');

            await Workspace.create(workspacePath);
            const content = readFileSync(join(workspacePath, 'SOUL.md'), 'utf-8');
            expect(content).toBe('# Custom Soul\n');
        });
    });

    describe('path accessors', () => {
        it('returns correct paths', async () => {
            const ws = await Workspace.create(workspacePath);
            expect(ws.root).toBe(workspacePath);
            expect(ws.memoryDir).toBe(join(workspacePath, 'memory'));
            expect(ws.sessionsDir).toBe(join(workspacePath, 'memory', 'sessions'));
            expect(ws.skillsDir).toBe(join(workspacePath, '.gemini', 'skills'));
        });
    });
});
