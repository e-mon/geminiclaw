import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Bun's JSDOM eval doesn't expose top-level `var` declarations to the global scope,
// so tests that eval bundled JS and call extractBlocks/inject fail. Skip on Bun.
const isBun = typeof globalThis.Bun !== 'undefined';

const __test_dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(
    __test_dirname,
    '../../templates/.gemini/skills/translate-preview/references/build-injection.js',
);

let tmpDir: string;

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'build-injection-'));
});

afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

function buildInjection(blocks: object, translated: object): string {
    const blocksPath = join(tmpDir, 'blocks.json');
    const translatedPath = join(tmpDir, 'translated.json');
    writeFileSync(blocksPath, JSON.stringify(blocks));
    writeFileSync(translatedPath, JSON.stringify(translated));

    return execFileSync('node', [SCRIPT_PATH, blocksPath, translatedPath], {
        encoding: 'utf8',
        timeout: 10000,
    });
}

function evalInjection(pageHtml: string, injectionJs: string): JSDOM {
    const dom = new JSDOM(pageHtml, { runScripts: 'outside-only' });
    dom.window.eval(injectionJs);
    return dom;
}

// ============================================================
// 1. Output structure
// ============================================================
describe('output structure', () => {
    it('outputs window.__TP_DATA__ assignment followed by inject-translations.js', () => {
        const output = buildInjection(
            { title: 'Test', url: 'https://example.com', blocks: [{ id: 0, type: 'paragraph', text: 'Hello' }] },
            { blocks: [{ id: 0, type: 'paragraph', translatedText: 'こんにちは' }] },
        );
        expect(output).toMatch(/^window\.__TP_DATA__\s*=/);
        expect(output).toContain('extractBlocks');
        expect(output).toContain('injectTranslations');
        expect(output).toContain('_tp_capturePage');
    });

    it('includes merged block data in __TP_DATA__', () => {
        const output = buildInjection(
            { title: 'T', url: 'https://x.com', blocks: [{ id: 0, type: 'heading', text: 'Original' }] },
            { blocks: [{ id: 0, type: 'heading', translatedText: '翻訳済み' }], targetLang: 'ja' },
        );
        const jsonMatch = output.match(/window\.__TP_DATA__\s*=\s*(\{.*?\});/s);
        expect(jsonMatch).toBeTruthy();
        const data = JSON.parse(jsonMatch?.[1]);
        expect(data.blocks[0].translatedText).toBe('翻訳済み');
        expect(data.sourceUrl).toBe('https://x.com');
        expect(data.title).toBe('T');
        expect(data.targetLang).toBe('ja');
    });
});

// ============================================================
// 2. Injection into marked DOM
// ============================================================
describe.skipIf(isBun)('injection into marked DOM', () => {
    it('injects translations when evaled on a marked page', () => {
        const injectionJs = buildInjection(
            {
                title: 'Test Page',
                url: 'https://example.com',
                blocks: [
                    { id: 0, type: 'heading', text: 'Hello World' },
                    { id: 1, type: 'paragraph', text: 'Test paragraph.' },
                ],
            },
            {
                blocks: [
                    { id: 0, type: 'heading', translatedText: 'こんにちは世界' },
                    { id: 1, type: 'paragraph', translatedText: 'テスト段落。' },
                ],
            },
        );

        const dom = evalInjection(
            `<html><head></head><body>
                <h1 data-tp-id="0">Hello World</h1>
                <p data-tp-id="1">Test paragraph.</p>
            </body></html>`,
            injectionJs,
        );

        const doc = dom.window.document;

        const translated = doc.querySelectorAll('.tp-translated');
        expect(translated.length).toBe(2);
        expect(translated[0].textContent).toBe('こんにちは世界');
        expect(translated[1].textContent).toBe('テスト段落。');

        const header = doc.querySelector('.tp-header');
        expect(header).toBeTruthy();

        const originals = doc.querySelectorAll('.tp-original');
        expect(originals.length).toBe(2);
    });

    it('skips code blocks', () => {
        const injectionJs = buildInjection(
            {
                title: 'Code',
                url: '',
                blocks: [
                    { id: 0, type: 'paragraph', text: 'Text' },
                    { id: 1, type: 'code', text: 'const x = 1;' },
                ],
            },
            {
                blocks: [
                    { id: 0, type: 'paragraph', translatedText: 'テキスト' },
                    { id: 1, type: 'code', translatedText: 'const x = 1;' },
                ],
            },
        );

        const dom = evalInjection(
            `<html><head></head><body>
                <p data-tp-id="0">Text</p>
                <pre data-tp-id="1"><code>const x = 1;</code></pre>
            </body></html>`,
            injectionJs,
        );

        const translated = dom.window.document.querySelectorAll('.tp-translated');
        expect(translated.length).toBe(1);
        expect(translated[0].textContent).toBe('テキスト');
    });
});

// ============================================================
// 3. Auto-marking unmarked DOM via extractBlocks
// ============================================================
describe.skipIf(isBun)('auto-marking unmarked DOM', () => {
    it('marks and injects translations on a page without data-tp-id attributes', () => {
        const injectionJs = buildInjection(
            {
                title: 'Test',
                url: 'https://example.com',
                blocks: [
                    { id: 0, type: 'heading', text: 'Hello World' },
                    { id: 1, type: 'paragraph', text: 'Some paragraph text.' },
                ],
            },
            {
                blocks: [
                    { id: 0, type: 'heading', translatedText: 'こんにちは世界' },
                    { id: 1, type: 'paragraph', translatedText: '段落テキスト。' },
                ],
            },
        );

        // DOM has NO data-tp-id attributes — extractBlocks should mark them
        const dom = evalInjection(
            `<html><head></head><body>
                <h1>Hello World</h1>
                <p>Some paragraph text.</p>
            </body></html>`,
            injectionJs,
        );

        const doc = dom.window.document;
        // extractBlocks should have added data-tp-id attributes
        const marked = doc.querySelectorAll('[data-tp-id]');
        expect(marked.length).toBeGreaterThan(0);
        // Translations should be injected
        const translated = doc.querySelectorAll('.tp-translated');
        expect(translated.length).toBeGreaterThan(0);
    });
});

// ============================================================
// 4. Fallback when translation is missing
// ============================================================
describe('missing translations', () => {
    it('falls back to original text when translatedText is missing', () => {
        const output = buildInjection(
            { blocks: [{ id: 0, type: 'paragraph', text: 'Original text' }] },
            { blocks: [] },
        );
        const jsonMatch = output.match(/window\.__TP_DATA__\s*=\s*(\{.*?\});/s);
        const data = JSON.parse(jsonMatch?.[1]);
        expect(data.blocks[0].translatedText).toBe('Original text');
    });
});
