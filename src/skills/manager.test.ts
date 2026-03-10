import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disableSkill, enableSkill, listSkills } from './manager.js';

let workspace: string;

beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'skill-mgr-'));
});

afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
});

function createSkill(dir: '.gemini' | '.agents', name: string, content?: string, disabled = false): void {
    content ??= `---\nname: ${name}\ndescription: A test skill\n---\nDo something.`;
    const skillDir = join(workspace, dir, 'skills', name);
    mkdirSync(skillDir, { recursive: true });
    const filename = disabled ? 'SKILL.md.disabled' : 'SKILL.md';
    writeFileSync(join(skillDir, filename), content, 'utf-8');
}

describe('enableSkill', () => {
    it('renames SKILL.md.disabled → SKILL.md', async () => {
        createSkill('.gemini', 'my-skill', undefined, true);
        const dir = join(workspace, '.gemini', 'skills', 'my-skill');

        expect(existsSync(join(dir, 'SKILL.md.disabled'))).toBe(true);
        expect(existsSync(join(dir, 'SKILL.md'))).toBe(false);

        await enableSkill('my-skill', workspace);

        expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);
        expect(existsSync(join(dir, 'SKILL.md.disabled'))).toBe(false);
    });

    it('is a no-op if already enabled', async () => {
        createSkill('.gemini', 'my-skill');
        await enableSkill('my-skill', workspace);
        expect(existsSync(join(workspace, '.gemini', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
    });

    it('throws if skill does not exist', async () => {
        await expect(enableSkill('nonexistent', workspace)).rejects.toThrow('Skill not found');
    });

    it('works with external skills (.agents/skills/)', async () => {
        createSkill('.agents', 'ext-skill', undefined, true);
        await enableSkill('ext-skill', workspace);
        expect(existsSync(join(workspace, '.agents', 'skills', 'ext-skill', 'SKILL.md'))).toBe(true);
    });
});

describe('disableSkill', () => {
    it('renames SKILL.md → SKILL.md.disabled', async () => {
        createSkill('.gemini', 'my-skill');
        const dir = join(workspace, '.gemini', 'skills', 'my-skill');

        await disableSkill('my-skill', workspace);

        expect(existsSync(join(dir, 'SKILL.md.disabled'))).toBe(true);
        expect(existsSync(join(dir, 'SKILL.md'))).toBe(false);
    });

    it('is a no-op if already disabled', async () => {
        createSkill('.gemini', 'my-skill', undefined, true);
        await disableSkill('my-skill', workspace);
        expect(existsSync(join(workspace, '.gemini', 'skills', 'my-skill', 'SKILL.md.disabled'))).toBe(true);
    });

    it('throws if skill does not exist', async () => {
        await expect(disableSkill('nonexistent', workspace)).rejects.toThrow('Skill not found');
    });
});

describe('listSkills', () => {
    it('lists bundled and external skills', async () => {
        createSkill('.gemini', 'bundled-a');
        createSkill('.agents', 'external-b');

        const skills = await listSkills(workspace);
        const names = skills.map((s) => s.name);

        expect(names).toContain('bundled-a');
        expect(names).toContain('external-b');
    });

    it('shows disabled skills with enabled=false', async () => {
        createSkill('.gemini', 'disabled-skill', undefined, true);

        const skills = await listSkills(workspace);
        const s = skills.find((x) => x.name === 'disabled-skill');

        expect(s).toBeDefined();
        expect(s?.enabled).toBe(false);
    });

    it('deduplicates: bundled wins over external with same name', async () => {
        createSkill('.gemini', 'dup', '---\nname: dup\ndescription: bundled\n---\n');
        createSkill('.agents', 'dup', '---\nname: dup\ndescription: external\n---\n');

        const skills = await listSkills(workspace);
        const dups = skills.filter((s) => s.name === 'dup');

        expect(dups).toHaveLength(1);
        expect(dups[0].source).toBe('bundled');
    });

    it('returns empty array when no skills exist', async () => {
        const skills = await listSkills(workspace);
        expect(skills).toEqual([]);
    });
});

describe('enable → disable round-trip', () => {
    it('preserves file content through enable/disable cycle', async () => {
        const content = '---\nname: roundtrip\ndescription: Test roundtrip\n---\n# My Skill\nDo the thing.';
        createSkill('.gemini', 'roundtrip', content);

        await disableSkill('roundtrip', workspace);
        await enableSkill('roundtrip', workspace);

        const result = readFileSync(join(workspace, '.gemini', 'skills', 'roundtrip', 'SKILL.md'), 'utf-8');
        expect(result).toBe(content);
    });
});

describe('validateSkillName', () => {
    it('rejects path traversal attempts', async () => {
        await expect(enableSkill('../etc', workspace)).rejects.toThrow('Invalid skill name');
    });

    it('rejects empty names', async () => {
        await expect(enableSkill('', workspace)).rejects.toThrow('Invalid skill name');
    });

    it('rejects names with slashes', async () => {
        await expect(disableSkill('foo/bar', workspace)).rejects.toThrow('Invalid skill name');
    });
});
