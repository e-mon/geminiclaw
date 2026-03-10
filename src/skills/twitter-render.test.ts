import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = resolve(__dirname, '../../templates/.gemini/skills/translate-preview/references/twitter-render.js');
const scriptCode = readFileSync(SCRIPT_PATH, 'utf8');

interface Block {
    id: number;
    tag: string;
    type: string;
    text: string;
    html: string;
    level: number | null;
}

interface TranslatedBlock {
    id: number;
    type: string;
    translatedText?: string;
    text?: string;
}

type RenderFn = (
    blocks: Block[],
    translatedBlocks: TranslatedBlock[],
    options?: { sourceUrl?: string; title?: string; targetLang?: string },
) => string;

function loadRenderer(): RenderFn {
    const exports: Record<string, unknown> = {};
    const mod = { exports };
    const sandbox = {
        module: mod,
        exports,
        JSON,
        String,
        require: undefined as unknown,
        process: undefined as unknown,
    };
    vm.runInNewContext(scriptCode, sandbox);
    return (mod.exports as { renderTwitterHtml: RenderFn }).renderTwitterHtml;
}

const renderTwitterHtml = loadRenderer();

function render(
    blocks: Block[],
    translated: TranslatedBlock[],
    opts?: { sourceUrl?: string; title?: string; targetLang?: string },
): JSDOM {
    const html = renderTwitterHtml(blocks, translated, opts);
    return new JSDOM(html);
}

const sampleBlocks: Block[] = [
    { id: 0, tag: 'h1', type: 'heading', text: 'Main Title', html: 'Main Title', level: 1 },
    { id: 1, tag: 'p', type: 'paragraph', text: 'Hello world paragraph.', html: 'Hello world paragraph.', level: null },
    {
        id: 2,
        tag: 'pre',
        type: 'code',
        text: '```python\nprint("hi")\n```',
        html: '```python\nprint(&quot;hi&quot;)\n```',
        level: null,
    },
    {
        id: 3,
        tag: 'img',
        type: 'image',
        text: 'A photo',
        html: '<img src="https://pbs.twimg.com/test.jpg" alt="A photo">',
        level: null,
    },
];

const sampleTranslated: TranslatedBlock[] = [
    { id: 0, type: 'heading', translatedText: 'メインタイトル' },
    { id: 1, type: 'paragraph', translatedText: 'こんにちは世界の段落。' },
    { id: 2, type: 'code', translatedText: '```python\nprint("hi")\n```' },
    { id: 3, type: 'image', translatedText: '写真' },
];

// ============================================================
// 1. Basic HTML structure
// ============================================================
describe('basic HTML structure', () => {
    it('returns valid HTML with doctype', () => {
        const html = renderTwitterHtml(sampleBlocks, sampleTranslated, { title: 'Test' });
        expect(html).toMatch(/^<!DOCTYPE html>/);
        expect(html).toContain('<html');
        expect(html).toContain('</html>');
    });

    it('sets title in <head>', () => {
        const dom = render(sampleBlocks, sampleTranslated, { title: 'My Article' });
        expect(dom.window.document.title).toBe('My Article');
    });

    it('sets lang attribute', () => {
        const dom = render(sampleBlocks, sampleTranslated, { targetLang: 'ja' });
        const lang = dom.window.document.documentElement.getAttribute('lang');
        expect(lang).toBe('ja');
    });

    it('includes viewport meta tag', () => {
        const dom = render(sampleBlocks, sampleTranslated);
        const meta = dom.window.document.querySelector('meta[name="viewport"]');
        expect(meta).toBeTruthy();
    });
});

// ============================================================
// 2. Bilingual blocks (tp-block, tp-original, tp-translated)
// ============================================================
describe('bilingual blocks', () => {
    it('creates tp-block wrappers for non-code/non-image blocks', () => {
        const dom = render(sampleBlocks, sampleTranslated);
        const tpBlocks = dom.window.document.querySelectorAll('.tp-block');
        // heading + paragraph = 2 (code renders as <pre>, image as <figure>)
        expect(tpBlocks.length).toBe(2);
    });

    it('creates tp-translated and tp-original elements', () => {
        const dom = render(sampleBlocks, sampleTranslated);
        const translated = dom.window.document.querySelectorAll('.tp-translated');
        const originals = dom.window.document.querySelectorAll('.tp-original');
        expect(translated.length).toBe(2);
        expect(originals.length).toBe(2);
    });

    it('sets translated text in tp-translated', () => {
        const dom = render(sampleBlocks, sampleTranslated);
        const translated = dom.window.document.querySelectorAll('.tp-translated');
        expect(translated[0].textContent).toBe('メインタイトル');
        expect(translated[1].textContent).toBe('こんにちは世界の段落。');
    });

    it('preserves original text/html in tp-original', () => {
        const dom = render(sampleBlocks, sampleTranslated);
        const originals = dom.window.document.querySelectorAll('.tp-original');
        expect(originals[0].textContent).toBe('Main Title');
        expect(originals[1].textContent).toBe('Hello world paragraph.');
    });

    it('sets data-state="translated" by default', () => {
        const dom = render(sampleBlocks, sampleTranslated);
        const tpBlocks = dom.window.document.querySelectorAll('.tp-block');
        tpBlocks.forEach((block) => {
            expect(block.getAttribute('data-state')).toBe('translated');
        });
    });
});

// ============================================================
// 3. Code blocks
// ============================================================
describe('code blocks', () => {
    it('renders code blocks as <pre><code>', () => {
        const dom = render(sampleBlocks, sampleTranslated);
        const pres = dom.window.document.querySelectorAll('pre');
        expect(pres.length).toBe(1);
        expect(pres[0].querySelector('code')).toBeTruthy();
    });

    it('does not wrap code blocks in tp-block', () => {
        const dom = render(sampleBlocks, sampleTranslated);
        const pre = dom.window.document.querySelector('pre');
        expect(pre?.parentElement?.classList.contains('tp-block')).toBe(false);
    });

    it('preserves code content', () => {
        const dom = render(sampleBlocks, sampleTranslated);
        const code = dom.window.document.querySelector('pre code');
        expect(code?.textContent).toContain('print');
    });
});

// ============================================================
// 4. Image blocks
// ============================================================
describe('image blocks', () => {
    it('renders images in <figure> tags', () => {
        const dom = render(sampleBlocks, sampleTranslated);
        const figures = dom.window.document.querySelectorAll('figure');
        expect(figures.length).toBe(1);
    });

    it('includes img src from html field', () => {
        const dom = render(sampleBlocks, sampleTranslated);
        const img = dom.window.document.querySelector('figure img');
        expect(img).toBeTruthy();
        expect(img?.getAttribute('src')).toContain('pbs.twimg.com');
    });
});

// ============================================================
// 5. Header UI
// ============================================================
describe('header UI', () => {
    it('includes tp-header', () => {
        const dom = render(sampleBlocks, sampleTranslated, { sourceUrl: 'https://x.com/test/status/123' });
        const header = dom.window.document.querySelector('.tp-header');
        expect(header).toBeTruthy();
    });

    it('has three mode buttons', () => {
        const dom = render(sampleBlocks, sampleTranslated);
        const buttons = dom.window.document.querySelectorAll('[data-tp-mode]');
        expect(buttons.length).toBe(3);
        const modes = Array.from(buttons).map((b) => b.getAttribute('data-tp-mode'));
        expect(modes).toEqual(['translated', 'both', 'original']);
    });

    it('displays source URL', () => {
        const dom = render(sampleBlocks, sampleTranslated, { sourceUrl: 'https://x.com/test/status/123' });
        const url = dom.window.document.querySelector('.tp-header-url');
        expect(url).toBeTruthy();
        expect(url?.getAttribute('href')).toBe('https://x.com/test/status/123');
    });

    it('omits URL link when sourceUrl not provided', () => {
        const dom = render(sampleBlocks, sampleTranslated);
        const url = dom.window.document.querySelector('.tp-header-url');
        expect(url).toBeNull();
    });
});

// ============================================================
// 6. Styles and scripts
// ============================================================
describe('styles and scripts', () => {
    it('includes style tag with tp-block CSS', () => {
        const dom = render(sampleBlocks, sampleTranslated);
        const styles = dom.window.document.querySelectorAll('style');
        expect(styles.length).toBeGreaterThanOrEqual(1);
        const css = Array.from(styles)
            .map((s) => s.textContent)
            .join('');
        expect(css).toContain('.tp-block');
        expect(css).toContain('.tp-original');
        expect(css).toContain('.tp-translated');
    });

    it('includes dark mode styles', () => {
        const dom = render(sampleBlocks, sampleTranslated);
        const styles = dom.window.document.querySelectorAll('style');
        const css = Array.from(styles)
            .map((s) => s.textContent)
            .join('');
        expect(css).toContain('prefers-color-scheme: dark');
    });

    it('includes interaction script with data-tp attribute', () => {
        const dom = render(sampleBlocks, sampleTranslated);
        const scripts = dom.window.document.querySelectorAll('script[data-tp]');
        expect(scripts.length).toBe(1);
        expect(scripts[0].textContent).toContain('data-tp-mode');
        expect(scripts[0].textContent).toContain('contextmenu');
    });
});

// ============================================================
// 7. Content wrapper
// ============================================================
describe('content wrapper', () => {
    it('wraps content in .tp-content main element', () => {
        const dom = render(sampleBlocks, sampleTranslated);
        const main = dom.window.document.querySelector('main.tp-content');
        expect(main).toBeTruthy();
        // All tp-blocks should be inside main
        const tpBlocks = main?.querySelectorAll('.tp-block');
        expect(tpBlocks?.length).toBe(2);
    });
});

// ============================================================
// 8. Edge cases
// ============================================================
describe('edge cases', () => {
    it('handles empty blocks array', () => {
        const html = renderTwitterHtml([], [], { title: 'Empty' });
        expect(html).toContain('<!DOCTYPE html>');
        expect(html).toContain('Empty');
    });

    it('handles blocks without matching translations', () => {
        const blocks: Block[] = [
            { id: 0, tag: 'p', type: 'paragraph', text: 'No translation', html: 'No translation', level: null },
        ];
        const dom = render(blocks, []);
        // Falls back to original text as translated
        const translated = dom.window.document.querySelector('.tp-translated');
        expect(translated?.textContent).toBe('No translation');
    });

    it('escapes HTML in title', () => {
        const html = renderTwitterHtml([], [], { title: '<script>alert("xss")</script>' });
        expect(html).not.toContain('<script>alert');
        expect(html).toContain('&lt;script&gt;');
    });

    it('handles blockquote blocks', () => {
        const blocks: Block[] = [
            { id: 0, tag: 'blockquote', type: 'quote', text: 'A wise saying', html: 'A wise saying', level: null },
        ];
        const translated: TranslatedBlock[] = [{ id: 0, type: 'quote', translatedText: '名言' }];
        const dom = render(blocks, translated);
        const tpBlock = dom.window.document.querySelector('.tp-block');
        expect(tpBlock).toBeTruthy();
        const tp = dom.window.document.querySelector('.tp-translated');
        expect(tp?.textContent).toBe('名言');
    });

    it('handles list-item blocks with p wrapper', () => {
        const blocks: Block[] = [
            { id: 0, tag: 'li', type: 'list-item', text: 'Item one', html: 'Item one', level: null },
        ];
        const translated: TranslatedBlock[] = [{ id: 0, type: 'list-item', translatedText: 'アイテム1' }];
        const dom = render(blocks, translated);
        // li tag is converted to p inside tp-block
        const tp = dom.window.document.querySelector('.tp-translated');
        expect(tp?.tagName.toLowerCase()).toBe('p');
        expect(tp?.textContent).toBe('アイテム1');
    });
});

// ============================================================
// 8. Translation from text field (no translatedText)
// ============================================================
describe('translation stored in text field', () => {
    it('uses text field when translatedText is absent', () => {
        const blocks: Block[] = [
            { id: 0, tag: 'p', type: 'paragraph', text: 'Hello world', html: 'Hello world', level: null },
            { id: 1, tag: 'p', type: 'paragraph', text: 'Second line', html: 'Second line', level: null },
        ];
        const translated: TranslatedBlock[] = [
            { id: 0, type: 'paragraph', text: 'こんにちは世界' },
            { id: 1, type: 'paragraph', text: '二行目' },
        ];
        const dom = render(blocks, translated);
        const tps = dom.window.document.querySelectorAll('.tp-translated');
        expect(tps[0].textContent).toBe('こんにちは世界');
        expect(tps[1].textContent).toBe('二行目');
        const originals = dom.window.document.querySelectorAll('.tp-original');
        expect(originals[0].textContent).toBe('Hello world');
    });

    it('prefers translatedText over text when both exist', () => {
        const blocks: Block[] = [{ id: 0, tag: 'p', type: 'paragraph', text: 'Hello', html: 'Hello', level: null }];
        const translated: TranslatedBlock[] = [
            { id: 0, type: 'paragraph', translatedText: 'こんにちは', text: '別のテキスト' },
        ];
        const dom = render(blocks, translated);
        const tp = dom.window.document.querySelector('.tp-translated');
        expect(tp?.textContent).toBe('こんにちは');
    });

    it('accepts plain string array as translatedBlocks', () => {
        const blocks: Block[] = [
            { id: 0, tag: 'p', type: 'paragraph', text: 'Hello', html: 'Hello', level: null },
            { id: 1, tag: 'p', type: 'paragraph', text: 'World', html: 'World', level: null },
        ];
        // Agent may write translations as a plain string array
        const translated = ['こんにちは', '世界'] as unknown as TranslatedBlock[];
        const dom = render(blocks, translated);
        const tps = dom.window.document.querySelectorAll('.tp-translated');
        expect(tps[0]?.textContent).toBe('こんにちは');
        expect(tps[1]?.textContent).toBe('世界');
    });
});
