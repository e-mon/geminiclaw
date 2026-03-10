/**
 * Real-site extraction tests.
 *
 * These tests run the extractor against HTML fetched from actual websites
 * (saved as fixtures in /tmp/). They verify that the extractor produces
 * reasonable results on real-world markup.
 *
 * Fixtures are fetched at test time via curl. Tests are skipped if fetch fails.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

// Load extractor
const SCRIPT_PATH = resolve(__dirname, '../../templates/.gemini/skills/translate-preview/references/extract-blocks.js');
const scriptCode = readFileSync(SCRIPT_PATH, 'utf8');

interface Block {
    tag: string;
    type: string;
    text: string;
    html: string;
    level: number | null;
}

interface ExtractionResult {
    title: string;
    lang: string;
    blockCount: number;
    blocks: Block[];
}

type ExtractFn = (doc: Document) => ExtractionResult;

function loadExtractor(): ExtractFn {
    const exports: Record<string, unknown> = {};
    const mod = { exports };
    vm.runInNewContext(scriptCode, {
        module: mod,
        exports,
        Set,
        RegExp,
        parseInt,
        JSON,
        getComputedStyle: undefined as unknown,
        location: undefined as unknown,
        window: undefined as unknown,
        document: undefined as unknown,
    });
    return (mod.exports as { extractBlocks: ExtractFn }).extractBlocks;
}

const extractBlocks = loadExtractor();

function extract(html: string): ExtractionResult {
    const dom = new JSDOM(html);
    return extractBlocks(dom.window.document as unknown as Document);
}

// Fixture management
const FIXTURES: Record<string, { url: string; path: string }> = {
    anthropic: {
        url: 'https://www.anthropic.com/research/claude-character',
        path: '/tmp/eb-test-anthropic.html',
    },
    rustBook: {
        url: 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html',
        path: '/tmp/eb-test-rust-book.html',
    },
    mdn: {
        url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise',
        path: '/tmp/eb-test-mdn.html',
    },
    wikipedia: {
        url: 'https://en.wikipedia.org/wiki/Large_language_model',
        path: '/tmp/eb-test-wikipedia.html',
    },
    hackerNews: {
        url: 'https://news.ycombinator.com/',
        path: '/tmp/eb-test-hn.html',
    },
    xPost: {
        url: 'https://x.com/djfarrelly/status/2028556984396452250',
        path: '/tmp/eb-test-x-post.html',
    },
    github: {
        url: 'https://github.com/anthropics/anthropic-cookbook',
        path: '/tmp/eb-test-github.html',
    },
};

function fetchFixture(key: string): string | null {
    const fixture = FIXTURES[key];
    if (!existsSync(fixture.path)) {
        try {
            execSync(`curl -sL -o ${fixture.path} '${fixture.url}'`, { timeout: 15000 });
        } catch {
            return null;
        }
    }
    if (!existsSync(fixture.path)) return null;
    return readFileSync(fixture.path, 'utf8');
}

function typeCounts(result: ExtractionResult): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const b of result.blocks) {
        counts[b.type] = (counts[b.type] || 0) + 1;
    }
    return counts;
}

function allText(result: ExtractionResult): string {
    return result.blocks.map((b) => b.text).join(' ');
}

// ============================================================
// Anthropic Research Blog
// ============================================================
describe('real: Anthropic blog (claude-character)', () => {
    let html: string | null;
    let result: ExtractionResult;

    beforeAll(() => {
        html = fetchFixture('anthropic');
        if (html) result = extract(html);
    });

    it('fetches successfully', () => {
        expect(html).not.toBeNull();
    });

    it('extracts a reasonable number of blocks', () => {
        if (!html) return;
        // Anthropic blog post should have substantial content
        expect(result.blockCount).toBeGreaterThan(15);
    });

    it('has title containing "Claude" or "Character"', () => {
        if (!html) return;
        expect(result.title.toLowerCase()).toMatch(/claude|character/);
    });

    it('extracts headings', () => {
        if (!html) return;
        const headings = result.blocks.filter((b) => b.type === 'heading');
        expect(headings.length).toBeGreaterThan(3);
    });

    it('extracts substantial paragraph text', () => {
        if (!html) return;
        const paragraphs = result.blocks.filter((b) => b.type === 'paragraph');
        expect(paragraphs.length).toBeGreaterThan(10);
        // At least some paragraphs should have meaningful length
        const longParagraphs = paragraphs.filter((p) => p.text.length > 50);
        expect(longParagraphs.length).toBeGreaterThan(5);
    });

    it('content mentions AI/model topics', () => {
        if (!html) return;
        const text = allText(result).toLowerCase();
        expect(text).toMatch(/model|ai|claude|character|training/);
    });

    it('does not contain obvious nav/footer noise', () => {
        if (!html) return;
        const text = allText(result).toLowerCase();
        // Anthropic nav items
        expect(text).not.toMatch(/^\s*(research|company|news|careers)\s*$/m);
    });
});

// ============================================================
// Rust Book — What is Ownership?
// ============================================================
describe('real: Rust Book (ownership chapter)', () => {
    let html: string | null;
    let result: ExtractionResult;

    beforeAll(() => {
        html = fetchFixture('rustBook');
        if (html) result = extract(html);
    });

    it('fetches successfully', () => {
        expect(html).not.toBeNull();
    });

    it('extracts 50+ blocks (long chapter)', () => {
        if (!html) return;
        expect(result.blockCount).toBeGreaterThan(50);
    });

    it('title contains "Ownership"', () => {
        if (!html) return;
        expect(result.title).toContain('Ownership');
    });

    it('has code blocks (Rust examples)', () => {
        if (!html) return;
        const counts = typeCounts(result);
        expect(counts.code).toBeGreaterThan(5);
    });

    it('code blocks contain Rust syntax', () => {
        if (!html) return;
        const codeBlocks = result.blocks.filter((b) => b.type === 'code');
        const allCode = codeBlocks.map((b) => b.text).join(' ');
        expect(allCode).toMatch(/fn |let |String|println!/);
    });

    it('has heading hierarchy (h1 + h2s + h3s)', () => {
        if (!html) return;
        const headings = result.blocks.filter((b) => b.type === 'heading');
        const levels = new Set(headings.map((h) => h.level));
        expect(levels.size).toBeGreaterThanOrEqual(2);
    });

    it('extracts list items', () => {
        if (!html) return;
        const counts = typeCounts(result);
        expect(counts['list-item']).toBeGreaterThan(3);
    });

    it('mentions ownership/borrow/stack/heap concepts', () => {
        if (!html) return;
        const text = allText(result).toLowerCase();
        expect(text).toContain('ownership');
        expect(text).toMatch(/stack|heap|borrow|scope/);
    });
});

// ============================================================
// MDN — Promise reference
// ============================================================
describe('real: MDN (Promise reference)', () => {
    let html: string | null;
    let result: ExtractionResult;

    beforeAll(() => {
        html = fetchFixture('mdn');
        if (html) result = extract(html);
    });

    it('fetches successfully', () => {
        expect(html).not.toBeNull();
    });

    it('extracts substantial content', () => {
        if (!html) return;
        expect(result.blockCount).toBeGreaterThan(30);
    });

    it('title contains "Promise"', () => {
        if (!html) return;
        expect(result.title).toContain('Promise');
    });

    it('has code examples', () => {
        if (!html) return;
        const codeBlocks = result.blocks.filter((b) => b.type === 'code');
        expect(codeBlocks.length).toBeGreaterThan(3);
    });

    it('code blocks contain JS syntax', () => {
        if (!html) return;
        const codeBlocks = result.blocks.filter((b) => b.type === 'code');
        const allCode = codeBlocks.map((b) => b.text).join(' ');
        expect(allCode).toMatch(/Promise|then|catch|async|await|resolve|reject/);
    });

    it('has definition terms (method descriptions)', () => {
        if (!html) return;
        const counts = typeCounts(result);
        // MDN uses dl/dt/dd for method lists
        expect((counts['def-term'] || 0) + (counts['def-desc'] || 0)).toBeGreaterThan(5);
    });

    it('has multiple heading levels', () => {
        if (!html) return;
        const headings = result.blocks.filter((b) => b.type === 'heading');
        expect(headings.length).toBeGreaterThan(5);
    });
});

// ============================================================
// Wikipedia — Large Language Model
// ============================================================
describe('real: Wikipedia (LLM article)', () => {
    let html: string | null;
    let result: ExtractionResult;

    beforeAll(() => {
        html = fetchFixture('wikipedia');
        if (html) result = extract(html);
    });

    it('fetches successfully', () => {
        expect(html).not.toBeNull();
    });

    it('extracts very large number of blocks (long article)', () => {
        if (!html) return;
        expect(result.blockCount).toBeGreaterThan(100);
    });

    it('title contains "language model"', () => {
        if (!html) return;
        expect(result.title.toLowerCase()).toContain('language model');
    });

    it('has headings for article sections', () => {
        if (!html) return;
        const headings = result.blocks.filter((b) => b.type === 'heading');
        expect(headings.length).toBeGreaterThan(10);
        // Should mention key topics
        const headingTexts = headings.map((h) => h.text.toLowerCase()).join(' ');
        expect(headingTexts).toMatch(/training|architecture|history|application|dataset/i);
    });

    it('has many list items (references, examples)', () => {
        if (!html) return;
        const counts = typeCounts(result);
        expect(counts['list-item']).toBeGreaterThan(50);
    });

    it('has table cells (comparison tables)', () => {
        if (!html) return;
        const counts = typeCounts(result);
        expect(counts['table-cell'] || 0).toBeGreaterThan(0);
    });

    it('content discusses LLM topics', () => {
        if (!html) return;
        const text = allText(result).toLowerCase();
        expect(text).toMatch(/transformer|gpt|training|parameter/);
    });
});

// ============================================================
// Hacker News — table-based layout
// ============================================================
describe('real: Hacker News (table layout)', () => {
    let html: string | null;
    let result: ExtractionResult;

    beforeAll(() => {
        html = fetchFixture('hackerNews');
        if (html) result = extract(html);
    });

    it('fetches successfully', () => {
        expect(html).not.toBeNull();
    });

    it('extracts some content (even from table layout)', () => {
        if (!html) return;
        // HN is a table-based layout, extractor may struggle
        // but should at least get something
        expect(result.blockCount).toBeGreaterThan(0);
    });

    it('title is "Hacker News"', () => {
        if (!html) return;
        expect(result.title).toBe('Hacker News');
    });
});

// ============================================================
// X/Twitter post — SPA, requires JS rendering
// ============================================================
describe('real: X/Twitter post (SPA — static HTML only)', () => {
    let html: string | null;
    let result: ExtractionResult;

    beforeAll(() => {
        html = fetchFixture('xPost');
        if (html) result = extract(html);
    });

    it('fetches successfully', () => {
        expect(html).not.toBeNull();
    });

    it('gets zero meaningful blocks from static HTML (SPA limitation)', () => {
        if (!html) return;
        // X/Twitter is a React SPA — static HTML has no tweet content
        // The extractor correctly finds nothing useful, confirming that
        // agent-browser execute_js is required for this type of site
        const meaningful = result.blocks.filter((b) => !b.text.includes('went wrong') && !b.text.includes('privacy'));
        expect(meaningful.length).toBe(0);
    });

    it('documents that agent-browser is required for SPAs', () => {
        if (!html) return;
        // This test exists to document the expected behavior:
        // static HTML extraction cannot handle JS-rendered SPAs.
        // SKILL.md instructs the agent to use agent-browser for such cases.
        expect(result.blockCount).toBeLessThanOrEqual(5);
    });
});

// ============================================================
// GitHub repo page
// ============================================================
describe('real: GitHub repo (anthropic-cookbook)', () => {
    let html: string | null;
    let result: ExtractionResult;

    beforeAll(() => {
        html = fetchFixture('github');
        if (html) result = extract(html);
    });

    it('fetches successfully', () => {
        expect(html).not.toBeNull();
    });

    it('extracts content from README area', () => {
        if (!html) return;
        expect(result.blockCount).toBeGreaterThan(10);
    });

    it('title contains repo name', () => {
        if (!html) return;
        expect(result.title.toLowerCase()).toMatch(/anthropic|cookbook/);
    });

    it('has headings from README', () => {
        if (!html) return;
        const headings = result.blocks.filter((b) => b.type === 'heading');
        expect(headings.length).toBeGreaterThan(0);
    });

    it('content mentions anthropic/claude', () => {
        if (!html) return;
        const text = allText(result).toLowerCase();
        expect(text).toMatch(/anthropic|claude|api|cookbook/);
    });
});
