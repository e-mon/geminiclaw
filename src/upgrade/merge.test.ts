/**
 * upgrade/merge.test.ts — Tests for LLM template merge utility.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock spawnGeminiAcp before importing merge module
vi.mock('../agent/acp/runner.js', () => ({
    spawnGeminiAcp: vi.fn(),
}));

import { spawnGeminiAcp } from '../agent/acp/runner.js';
import { type MergeOptions, mergeTemplateFile } from './merge.js';

const mockedSpawn = vi.mocked(spawnGeminiAcp);

function makeMergeOpts(overrides: Partial<MergeOptions> = {}): MergeOptions {
    return {
        templateContent: '# Template\nNew section added.\n',
        workspaceContent: '# Template\nUser customization here.\n',
        filename: 'AGENTS.md',
        model: 'gemini-2.0-flash',
        cwd: '/tmp/test-workspace',
        ...overrides,
    };
}

describe('mergeTemplateFile', () => {
    beforeEach(() => {
        mockedSpawn.mockReset();
    });

    it('returns merged content from LLM response', async () => {
        mockedSpawn
            .mockResolvedValueOnce({
                responseText: '# Template\nNew section added.\nUser customization here.',
            } as never)
            .mockResolvedValueOnce({
                responseText: 'テンプレートの新セクションを追加し、ユーザーカスタマイズを保持しました。',
            } as never);

        const result = await mergeTemplateFile(makeMergeOpts());

        expect(result.merged).toBe('# Template\nNew section added.\nUser customization here.');
        expect(result.summary).toContain('テンプレート');
        expect(mockedSpawn).toHaveBeenCalledTimes(2);
    });

    it('passes correct cwd to spawnGeminiAcp', async () => {
        mockedSpawn.mockResolvedValue({ responseText: 'merged content' } as never);

        await mergeTemplateFile(makeMergeOpts({ model: 'gemini-2.5-pro', cwd: '/my/workspace' }));

        const opts = mockedSpawn.mock.calls[0]?.[0];
        expect(opts?.cwd).toBe('/my/workspace');
    });

    it('throws when LLM returns empty response', async () => {
        mockedSpawn.mockResolvedValue({ responseText: '' } as never);

        await expect(mergeTemplateFile(makeMergeOpts())).rejects.toThrow('empty merge result');
    });

    it('uses default summary when summary LLM call fails', async () => {
        mockedSpawn
            .mockResolvedValueOnce({ responseText: 'merged result' } as never)
            .mockRejectedValueOnce(new Error('summary failed'));

        const result = await mergeTemplateFile(makeMergeOpts());

        expect(result.merged).toBe('merged result');
        expect(result.summary).toBe('マージ完了');
    });

    it('includes filename in the merge prompt', async () => {
        mockedSpawn.mockResolvedValue({ responseText: 'merged' } as never);

        await mergeTemplateFile(makeMergeOpts({ filename: 'HEARTBEAT.md' }));

        const opts = mockedSpawn.mock.calls[0]?.[0];
        expect(opts?.prompt).toContain('HEARTBEAT.md');
    });
});
