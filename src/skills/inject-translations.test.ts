import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = resolve(
    __dirname,
    '../../templates/.gemini/skills/translate-preview/references/inject-translations.js',
);
const scriptCode = readFileSync(SCRIPT_PATH, 'utf8');

interface InjectData {
    blocks: Array<{
        id: number;
        type: string;
        translatedText: string;
    }>;
    targetLang?: string;
    sourceUrl?: string;
    title?: string;
}

type InjectFn = (doc: Document, data: InjectData) => void;

function loadInjector(): InjectFn {
    const exports: Record<string, unknown> = {};
    const mod = { exports };
    const sandbox = {
        module: mod,
        exports,
        Set,
        RegExp,
        parseInt,
        JSON,
        setTimeout,
        clearTimeout,
        console,
    };
    vm.runInNewContext(scriptCode, sandbox);
    return (mod.exports as { injectTranslations: InjectFn }).injectTranslations;
}

const injectTranslations = loadInjector();

function createMarkedDom(html: string): JSDOM {
    return new JSDOM(html);
}

// Load extract-blocks.js for window.__TP_DATA__ tests
const EXTRACT_SCRIPT_PATH = resolve(
    __dirname,
    '../../templates/.gemini/skills/translate-preview/references/extract-blocks.js',
);
const extractScriptCode = readFileSync(EXTRACT_SCRIPT_PATH, 'utf8');

// ============================================================
// Browser auto-execute with window.__TP_DATA__
// ============================================================
describe('browser auto-execute with window.__TP_DATA__', () => {
    it('auto-injects translations from window.__TP_DATA__', () => {
        const dom = createMarkedDom(`<html><head></head><body>
      <article>
        <h1 data-tp-id="0">Hello World</h1>
        <p data-tp-id="1">Test paragraph here.</p>
      </article>
    </body></html>`);

        const tpData = {
            blocks: [
                { id: 0, type: 'heading', translatedText: 'こんにちは世界' },
                { id: 1, type: 'paragraph', translatedText: 'テスト段落です。' },
            ],
            targetLang: 'ja',
            sourceUrl: 'https://example.com',
            title: 'Test',
        };

        // Simulate browser: no module, window.__TP_DATA__ set
        const sandbox = {
            Set,
            RegExp,
            parseInt,
            JSON,
            setTimeout,
            clearTimeout,
            console,
            window: Object.assign(dom.window, { __TP_DATA__: tpData }),
            document: dom.window.document,
        };
        vm.runInNewContext(scriptCode, sandbox);

        // Translations should be injected as adjacent siblings
        const translated = dom.window.document.querySelectorAll('.tp-translated');
        expect(translated.length).toBe(2);
        expect(translated[0].textContent).toBe('こんにちは世界');
        expect(translated[1].textContent).toBe('テスト段落です。');
    });

    it('re-runs extractBlocks when available to re-mark DOM', () => {
        // Start with unmarked DOM (no data-tp-id attributes)
        const dom = createMarkedDom(`<html><head></head><body>
      <article>
        <h1>Hello World</h1>
        <p>Test paragraph content here.</p>
      </article>
    </body></html>`);

        const tpData = {
            blocks: [
                { id: 0, type: 'heading', translatedText: 'こんにちは世界' },
                { id: 1, type: 'paragraph', translatedText: 'テスト段落です。' },
            ],
            targetLang: 'ja',
        };

        // First load extract-blocks.js to define extractBlocks globally
        const sandbox = {
            Set,
            RegExp,
            parseInt,
            JSON,
            setTimeout,
            clearTimeout,
            console,
            getComputedStyle: undefined as unknown,
            location: undefined as unknown,
            window: Object.assign(dom.window, { __TP_DATA__: tpData }),
            document: dom.window.document,
        };
        // Run extract-blocks first (defines extractBlocks globally, auto-executes)
        vm.runInNewContext(extractScriptCode, sandbox);
        // Now run inject-translations (should re-run extractBlocks + inject)
        vm.runInNewContext(scriptCode, sandbox);

        // DOM should be marked and translations injected as siblings
        const translated = dom.window.document.querySelectorAll('.tp-translated');
        expect(translated.length).toBe(2);
    });

    it('does NOT auto-execute when module is defined (Node.js)', () => {
        const dom = createMarkedDom(`<html><head></head><body><p data-tp-id="0">Test</p></body></html>`);
        const exports: Record<string, unknown> = {};
        const mod = { exports };
        const sandbox = {
            module: mod,
            exports,
            Set,
            RegExp,
            parseInt,
            JSON,
            setTimeout,
            clearTimeout,
            console,
            window: Object.assign(dom.window, {
                __TP_DATA__: {
                    blocks: [{ id: 0, type: 'paragraph', translatedText: 'テスト' }],
                },
            }),
            document: dom.window.document,
        };
        vm.runInNewContext(scriptCode, sandbox);

        // Should NOT auto-inject (module is defined)
        const translated = dom.window.document.querySelectorAll('.tp-translated');
        expect(translated.length).toBe(0);
        // But should export injectTranslations
        expect(typeof (mod.exports as Record<string, unknown>).injectTranslations).toBe('function');
    });

    it('does NOT auto-execute when window.__TP_DATA__ is absent', () => {
        const dom = createMarkedDom(`<html><head></head><body><p data-tp-id="0">Test</p></body></html>`);
        const sandbox = {
            Set,
            RegExp,
            parseInt,
            JSON,
            setTimeout,
            clearTimeout,
            console,
            window: dom.window,
            document: dom.window.document,
        };
        vm.runInNewContext(scriptCode, sandbox);

        // Should NOT inject (no __TP_DATA__)
        const translated = dom.window.document.querySelectorAll('.tp-translated');
        expect(translated.length).toBe(0);
    });

    it('exports _tp_capturePage in Node.js mode', () => {
        const exports: Record<string, unknown> = {};
        const mod = { exports };
        const sandbox = {
            module: mod,
            exports,
            Set,
            RegExp,
            parseInt,
            JSON,
            setTimeout,
            clearTimeout,
            console,
        };
        vm.runInNewContext(scriptCode, sandbox);
        expect(typeof (mod.exports as Record<string, unknown>)._tp_capturePage).toBe('function');
    });
});

// ============================================================
// Basic injection
// ============================================================
describe('basic translation injection', () => {
    function setup() {
        const dom = createMarkedDom(`<html><head></head><body>
      <h1 data-tp-id="0">Hello World</h1>
      <p data-tp-id="1">This is a test paragraph.</p>
      <pre data-tp-id="2"><code>const x = 1;</code></pre>
    </body></html>`);
        const data: InjectData = {
            blocks: [
                { id: 0, type: 'heading', translatedText: 'こんにちは世界' },
                { id: 1, type: 'paragraph', translatedText: 'これはテスト段落です。' },
                { id: 2, type: 'code', translatedText: 'const x = 1;' },
            ],
            targetLang: 'ja',
            sourceUrl: 'https://example.com/test',
            title: 'Test Page',
        };
        injectTranslations(dom.window.document as unknown as Document, data);
        return dom;
    }

    it('creates tp-translated and tp-original as adjacent siblings', () => {
        const dom = setup();
        const translated = dom.window.document.querySelectorAll('.tp-translated');
        const originals = dom.window.document.querySelectorAll('.tp-original');
        // code blocks are skipped, so only 2
        expect(translated.length).toBe(2);
        expect(originals.length).toBe(2);
        // Each translated element should be immediately before its original
        for (let i = 0; i < translated.length; i++) {
            expect(translated[i].nextElementSibling).toBe(originals[i]);
        }
    });

    it('wraps block pairs in .tp-block containers with data-state', () => {
        const dom = setup();
        const blocks = dom.window.document.querySelectorAll('.tp-block');
        expect(blocks.length).toBe(2); // h1 + p (code is skipped)
        blocks.forEach((block) => {
            expect(block.getAttribute('data-state')).toBe('translated');
            expect(block.querySelector('.tp-translated')).toBeTruthy();
            expect(block.querySelector('.tp-original')).toBeTruthy();
        });
    });

    it('sets translated text content', () => {
        const dom = setup();
        const translated = dom.window.document.querySelectorAll('.tp-translated');
        expect(translated[0].textContent).toBe('こんにちは世界');
        expect(translated[1].textContent).toBe('これはテスト段落です。');
    });

    it('preserves original text in tp-original', () => {
        const dom = setup();
        const originals = dom.window.document.querySelectorAll('.tp-original');
        expect(originals[0].textContent).toBe('Hello World');
        expect(originals[1].textContent).toBe('This is a test paragraph.');
    });

    it('pairs translated and original inside same .tp-block wrapper', () => {
        const dom = setup();
        const blocks = dom.window.document.querySelectorAll('.tp-block');
        blocks.forEach((block) => {
            const translated = block.querySelector('.tp-translated');
            const original = block.querySelector('.tp-original');
            expect(translated).toBeTruthy();
            expect(original).toBeTruthy();
            expect(original?.classList.contains('tp-original')).toBe(true);
        });
    });

    it('skips code blocks', () => {
        const dom = setup();
        const pre = dom.window.document.querySelector('pre');
        expect(pre).toBeTruthy();
        // code block should NOT have tp-original class
        expect(pre?.classList.contains('tp-original')).toBe(false);
        // code content should be unchanged
        expect(pre?.textContent).toContain('const x = 1;');
    });
});

// ============================================================
// UI overlay
// ============================================================
describe('UI overlay', () => {
    function setup() {
        const dom = createMarkedDom(`<html><head></head><body>
      <p data-tp-id="0">Hello</p>
    </body></html>`);
        const data: InjectData = {
            blocks: [{ id: 0, type: 'paragraph', translatedText: 'こんにちは' }],
            sourceUrl: 'https://example.com',
        };
        injectTranslations(dom.window.document as unknown as Document, data);
        return dom;
    }

    it('injects header at top of body', () => {
        const dom = setup();
        const header = dom.window.document.querySelector('.tp-header');
        expect(header).toBeTruthy();
        expect(dom.window.document.body.firstElementChild?.classList.contains('tp-header')).toBe(true);
    });

    it('has three mode buttons', () => {
        const dom = setup();
        const buttons = dom.window.document.querySelectorAll('[data-tp-mode]');
        expect(buttons.length).toBe(3);
        const modes = Array.from(buttons).map((b) => b.getAttribute('data-tp-mode'));
        expect(modes).toEqual(['translated', 'both', 'original']);
    });

    it('displays source URL', () => {
        const dom = setup();
        const url = dom.window.document.querySelector('.tp-header-url');
        expect(url).toBeTruthy();
        expect(url?.getAttribute('href')).toBe('https://example.com');
    });

    it('adds padding-top to body', () => {
        const dom = setup();
        const padding = dom.window.document.body.style.paddingTop;
        expect(parseInt(padding, 10)).toBeGreaterThanOrEqual(56);
    });
});

// ============================================================
// Styles and scripts
// ============================================================
describe('injected styles and scripts', () => {
    function setup() {
        const dom = createMarkedDom(`<html><head></head><body>
      <p data-tp-id="0">Test</p>
    </body></html>`);
        const data: InjectData = {
            blocks: [{ id: 0, type: 'paragraph', translatedText: 'テスト' }],
        };
        injectTranslations(dom.window.document as unknown as Document, data);
        return dom;
    }

    it('injects style tag with data-state-based visibility rules', () => {
        const dom = setup();
        const styles = dom.window.document.querySelectorAll('style[data-tp]');
        expect(styles.length).toBe(1);
        const css = styles[0].textContent || '';
        expect(css).toContain('.tp-block[data-state="translated"]');
        expect(css).toContain('.tp-block[data-state="original"]');
        expect(css).toContain('.tp-block[data-state="both"]');
        expect(css).toContain('display: contents');
    });

    it('injects script tag with data-tp attribute', () => {
        const dom = setup();
        const scripts = dom.window.document.querySelectorAll('script[data-tp]');
        expect(scripts.length).toBe(1);
        expect(scripts[0].textContent).toContain('data-tp-mode');
        expect(scripts[0].textContent).toContain('tpToggle');
    });
});

// ============================================================
// Nested structures
// ============================================================
describe('nested structures', () => {
    it('li elements are wrapped in .tp-block inside ul', () => {
        const dom = createMarkedDom(`<html><head></head><body>
      <ul>
        <li data-tp-id="0">Item one</li>
        <li data-tp-id="1">Item two</li>
      </ul>
    </body></html>`);
        const data: InjectData = {
            blocks: [
                { id: 0, type: 'list-item', translatedText: 'アイテム1' },
                { id: 1, type: 'list-item', translatedText: 'アイテム2' },
            ],
        };
        injectTranslations(dom.window.document as unknown as Document, data);

        // .tp-block wrappers with display:contents preserve list layout
        const wrappers = dom.window.document.querySelectorAll('.tp-block');
        expect(wrappers.length).toBe(2);

        // Each wrapper contains translated + original li
        wrappers.forEach((w) => {
            expect(w.querySelector('.tp-translated')?.tagName).toBe('LI');
            expect(w.querySelector('.tp-original')?.tagName).toBe('LI');
        });
    });

    it('flex parent children wrapped in .tp-block with display:contents', () => {
        const dom = createMarkedDom(`<html><head></head><body>
      <div style="display:flex">
        <p data-tp-id="0">Flex child 1</p>
        <p data-tp-id="1">Flex child 2</p>
      </div>
    </body></html>`);
        const data: InjectData = {
            blocks: [
                { id: 0, type: 'paragraph', translatedText: 'フレックス子1' },
                { id: 1, type: 'paragraph', translatedText: 'フレックス子2' },
            ],
        };
        injectTranslations(dom.window.document as unknown as Document, data);

        // .tp-block wrappers inserted (display:contents avoids layout disruption)
        const wrappers = dom.window.document.querySelectorAll('.tp-block');
        expect(wrappers.length).toBe(2);

        // Each wrapper contains translated + original <p> tags
        wrappers.forEach((w) => {
            expect(w.querySelector('.tp-translated')?.tagName).toBe('P');
            expect(w.querySelector('.tp-original')?.tagName).toBe('P');
        });
    });

    it('inline spans: no wrapper, text swap in place', () => {
        const dom = createMarkedDom(`<html><head></head><body>
      <div style="display:flex">
        <span data-tp-id="0">Hello world inline</span>
        <a href="/link">Link</a>
        <span data-tp-id="1">Another inline text</span>
      </div>
    </body></html>`);
        const data: InjectData = {
            blocks: [
                { id: 0, type: 'paragraph', translatedText: 'インラインこんにちは' },
                { id: 1, type: 'paragraph', translatedText: 'もう一つのインライン' },
            ],
        };
        injectTranslations(dom.window.document as unknown as Document, data);

        // No wrappers for inline elements
        const wrappers = dom.window.document.querySelectorAll('.tp-block');
        expect(wrappers.length).toBe(0);

        // Text is swapped in place
        const inlines = dom.window.document.querySelectorAll('.tp-inline');
        expect(inlines.length).toBe(2);
        expect(inlines[0].textContent).toBe('インラインこんにちは');
        expect(inlines[1].textContent).toBe('もう一つのインライン');

        // Original text stored as data attribute
        expect(inlines[0].getAttribute('data-tp-original')).toBe('Hello world inline');
        expect(inlines[1].getAttribute('data-tp-original')).toBe('Another inline text');

        // Parent layout is not disrupted — link is still a sibling
        const flex = dom.window.document.querySelector('div[style]');
        expect(flex?.children.length).toBe(3);
    });

    it('handles missing data-tp-id gracefully', () => {
        const dom = createMarkedDom(`<html><head></head><body>
      <p data-tp-id="0">Exists</p>
    </body></html>`);
        const data: InjectData = {
            blocks: [
                { id: 0, type: 'paragraph', translatedText: '存在' },
                { id: 99, type: 'paragraph', translatedText: '存在しない' },
            ],
        };
        // Should not throw
        injectTranslations(dom.window.document as unknown as Document, data);
        const translated = dom.window.document.querySelectorAll('.tp-translated');
        expect(translated.length).toBe(1);
    });
});
