import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';

// Load extract-blocks.js via vm to work around ESM/CJS issues
const SCRIPT_PATH = resolve(__dirname, '../../templates/.gemini/skills/translate-preview/references/extract-blocks.js');
const scriptCode = readFileSync(SCRIPT_PATH, 'utf8');

interface Block {
    id: number;
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
    const sandbox = {
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
    };
    vm.runInNewContext(scriptCode, sandbox);
    return (mod.exports as { extractBlocks: ExtractFn }).extractBlocks;
}

const extractBlocks = loadExtractor();

function extract(html: string): ExtractionResult {
    const dom = new JSDOM(html);
    return extractBlocks(dom.window.document as unknown as Document);
}

function extractWithDom(html: string): { result: ExtractionResult; dom: JSDOM } {
    const dom = new JSDOM(html);
    const result = extractBlocks(dom.window.document as unknown as Document);
    return { result, dom };
}

function texts(result: ExtractionResult): string[] {
    return result.blocks.map((b) => b.text);
}

function types(result: ExtractionResult): string[] {
    return result.blocks.map((b) => b.type);
}

// ============================================================
// 0. Browser auto-execute mode
// ============================================================
describe('browser auto-execute', () => {
    it('auto-executes extractBlocks when module is undefined', () => {
        const dom = new JSDOM(`<html><head><title>Auto Test</title></head><body>
      <article><h1>Auto Title</h1><p>Auto paragraph content here.</p></article>
    </body></html>`);

        // Simulate browser environment: no module defined
        const sandbox = {
            Set,
            RegExp,
            parseInt,
            JSON,
            getComputedStyle: undefined as unknown,
            location: undefined as unknown,
            window: dom.window,
            document: dom.window.document,
        };
        const result = vm.runInNewContext(scriptCode, sandbox);

        // The last expression is JSON.stringify(extractBlocks(document))
        expect(typeof result).toBe('string');
        const parsed = JSON.parse(result);
        expect(parsed.title).toBe('Auto Test');
        expect(parsed.blocks.length).toBeGreaterThanOrEqual(2);
        expect(parsed.blocks[0].text).toBe('Auto Title');
    });

    it('does NOT auto-execute when module is defined (Node.js)', () => {
        const dom = new JSDOM(`<html><body><article><p>Test</p></article></body></html>`);
        const exports: Record<string, unknown> = {};
        const mod = { exports };
        const sandbox = {
            module: mod,
            exports,
            Set,
            RegExp,
            parseInt,
            JSON,
            getComputedStyle: undefined as unknown,
            location: undefined as unknown,
            window: dom.window,
            document: dom.window.document,
        };
        // Should not throw, and extractBlocks should be exported
        vm.runInNewContext(scriptCode, sandbox);
        expect(typeof (mod.exports as Record<string, unknown>).extractBlocks).toBe('function');
    });
});

// ============================================================
// 1. Classic blog/article structure
// ============================================================
describe('classic article (semantic HTML)', () => {
    const html = `<html><head><title>Blog Post</title></head><body>
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
    <article>
      <h1>Understanding Ownership in Rust</h1>
      <p>Ownership is Rust's most unique feature.</p>
      <h2>What is Ownership?</h2>
      <p>Each value in Rust has a variable that's called its owner.</p>
      <blockquote>There can only be one owner at a time.</blockquote>
      <pre><code>let s = String::from("hello");</code></pre>
      <ul>
        <li>Each value has an owner</li>
        <li>Only one owner at a time</li>
        <li>Value is dropped when owner goes out of scope</li>
      </ul>
    </article>
    <footer><p>Copyright 2024</p></footer>
  </body></html>`;

    let result: ExtractionResult;
    beforeEach(() => {
        result = extract(html);
    });

    it('extracts title', () => {
        expect(result.title).toBe('Blog Post');
    });

    it('finds all content blocks', () => {
        expect(result.blockCount).toBeGreaterThanOrEqual(7);
    });

    it('skips nav and footer', () => {
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('Home');
        expect(allText).not.toContain('Copyright');
    });

    it('classifies headings with levels', () => {
        const headings = result.blocks.filter((b) => b.type === 'heading');
        expect(headings).toHaveLength(2);
        expect(headings[0].level).toBe(1);
        expect(headings[1].level).toBe(2);
    });

    it('classifies blockquote as quote', () => {
        const quotes = result.blocks.filter((b) => b.type === 'quote');
        expect(quotes).toHaveLength(1);
        expect(quotes[0].text).toContain('one owner');
    });

    it('classifies pre as code', () => {
        const code = result.blocks.filter((b) => b.type === 'code');
        expect(code).toHaveLength(1);
        expect(code[0].html).toContain('String::from');
    });

    it('extracts list items', () => {
        const items = result.blocks.filter((b) => b.type === 'list-item');
        expect(items).toHaveLength(3);
    });
});

// ============================================================
// 2. Div-heavy site (no semantic tags)
// ============================================================
describe('div-heavy site (no article/main)', () => {
    const html = `<html><body>
    <div class="nav-bar"><a href="/">Menu</a></div>
    <div class="wrapper">
      <div class="content">
        <div class="title-area"><h1>Product Guide</h1></div>
        <div class="section">
          <p>This guide covers all the basics you need to know about our product.</p>
          <div class="card">
            <p>Feature one: blazingly fast performance with zero overhead.</p>
          </div>
          <div class="card">
            <p>Feature two: seamless integration with existing tools and systems.</p>
          </div>
        </div>
      </div>
      <div class="sidebar" id="sidebar">
        <p>Related articles and promotional content here.</p>
      </div>
    </div>
    <div class="footer"><p>Terms of service</p></div>
  </body></html>`;

    let result: ExtractionResult;
    beforeEach(() => {
        result = extract(html);
    });

    it('extracts heading and paragraphs from nested divs', () => {
        expect(result.blockCount).toBeGreaterThanOrEqual(3);
        expect(texts(result)).toContain('Product Guide');
    });

    it('skips sidebar by id pattern', () => {
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('promotional');
    });

    it('skips footer by class pattern', () => {
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('Terms of service');
    });

    it('skips nav-bar by class pattern', () => {
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('Menu');
    });
});

// ============================================================
// 3. Table-heavy documentation
// ============================================================
describe('table-heavy page (API reference)', () => {
    const html = `<html><body>
    <main>
      <h1>API Reference</h1>
      <p>The following endpoints are available.</p>
      <table>
        <thead><tr><th>Method</th><th>Endpoint</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td>GET</td><td>/api/users</td><td>List all users in the system</td></tr>
          <tr><td>POST</td><td>/api/users</td><td>Create a new user account</td></tr>
          <tr><td>DELETE</td><td>/api/users/:id</td><td>Remove a user from the system</td></tr>
        </tbody>
      </table>
      <h2>Authentication</h2>
      <p>All requests require a Bearer token in the Authorization header.</p>
    </main>
  </body></html>`;

    let result: ExtractionResult;
    beforeEach(() => {
        result = extract(html);
    });

    it('extracts table cells', () => {
        const cells = result.blocks.filter((b) => b.type === 'table-cell');
        expect(cells.length).toBeGreaterThanOrEqual(6);
    });

    it('extracts headings alongside table', () => {
        const headings = result.blocks.filter((b) => b.type === 'heading');
        expect(headings).toHaveLength(2);
    });

    it('preserves reading order', () => {
        const typeSeq = types(result);
        const h1Idx = typeSeq.indexOf('heading');
        const firstCell = typeSeq.indexOf('table-cell');
        const h2Idx = typeSeq.lastIndexOf('heading');
        expect(h1Idx).toBeLessThan(firstCell);
        expect(firstCell).toBeLessThan(h2Idx);
    });
});

// ============================================================
// 4. Definition list / FAQ style
// ============================================================
describe('definition list / FAQ page', () => {
    const html = `<html><body>
    <article>
      <h1>Frequently Asked Questions</h1>
      <dl>
        <dt>What is GeminiClaw?</dt>
        <dd>GeminiClaw is an orchestration layer for Gemini CLI agents with scheduling and memory.</dd>
        <dt>How do I install it?</dt>
        <dd>Run npm install -g geminiclaw to install it globally on your system.</dd>
      </dl>
    </article>
  </body></html>`;

    let result: ExtractionResult;
    beforeEach(() => {
        result = extract(html);
    });

    it('extracts dt as def-term', () => {
        const terms = result.blocks.filter((b) => b.type === 'def-term');
        expect(terms).toHaveLength(2);
    });

    it('extracts dd as def-desc', () => {
        const descs = result.blocks.filter((b) => b.type === 'def-desc');
        expect(descs).toHaveLength(2);
    });
});

// ============================================================
// 5. Hidden elements and aria-hidden
// ============================================================
describe('hidden elements', () => {
    const html = `<html><body>
    <main>
      <h1>Visible Page Title</h1>
      <p>This paragraph is visible and should be extracted.</p>
      <div style="display:none"><p>This is hidden via inline style.</p></div>
      <div hidden><p>This is hidden via hidden attribute.</p></div>
      <div aria-hidden="true"><p>This is hidden via aria-hidden attribute.</p></div>
      <p>Another visible paragraph at the bottom of the page.</p>
    </main>
  </body></html>`;

    let result: ExtractionResult;
    beforeEach(() => {
        result = extract(html);
    });

    it('skips display:none elements', () => {
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('hidden via inline');
    });

    it('skips hidden attribute elements', () => {
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('hidden via hidden attribute');
    });

    it('skips aria-hidden elements', () => {
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('hidden via aria-hidden');
    });

    it('keeps visible elements', () => {
        expect(texts(result)).toContain('This paragraph is visible and should be extracted.');
        expect(texts(result)).toContain('Another visible paragraph at the bottom of the page.');
    });
});

// ============================================================
// 6. Content root detection priority
// ============================================================
describe('content root detection', () => {
    it('prefers <article> over body', () => {
        const html = `<html><body>
      <p>Body-level noise that should be ignored if article exists.</p>
      <article>
        <p>Article content that matters for the translation output.</p>
      </article>
    </body></html>`;
        const result = extract(html);
        expect(texts(result)).toContain('Article content that matters for the translation output.');
        expect(texts(result).join(' ')).not.toContain('noise');
    });

    it('prefers [role="main"]', () => {
        const html = `<html><body>
      <div class="sidebar"><p>Sidebar noise text that is not relevant.</p></div>
      <div role="main">
        <p>Main content that should be extracted for translation.</p>
      </div>
    </body></html>`;
        const result = extract(html);
        expect(texts(result)).toContain('Main content that should be extracted for translation.');
    });

    it('prefers .post-content class', () => {
        const html = `<html><body>
      <div class="site-header"><p>Header promotional text and navigation links.</p></div>
      <div class="post-content">
        <p>The actual blog post content written by the author.</p>
      </div>
    </body></html>`;
        const result = extract(html);
        expect(texts(result)).toContain('The actual blog post content written by the author.');
    });

    it('falls back to body when no content root found', () => {
        const html = `<html><body>
      <div class="random-wrapper">
        <h1>Page Without Semantic Markup</h1>
        <p>Content lives in random divs without any semantic structure.</p>
      </div>
    </body></html>`;
        const result = extract(html);
        expect(result.blockCount).toBeGreaterThanOrEqual(2);
    });
});

// ============================================================
// 7. Inline markup preservation
// ============================================================
describe('inline markup preservation', () => {
    const html = `<html><body><article>
    <p>This has <strong>bold</strong> and <a href="https://example.com">a link</a> inside.</p>
    <p>Code snippet: <code>console.log("hello")</code> in a paragraph.</p>
  </article></body></html>`;

    let result: ExtractionResult;
    beforeEach(() => {
        result = extract(html);
    });

    it('preserves <strong> in html field', () => {
        const p = result.blocks.find((b) => b.html.includes('<strong>'));
        expect(p).toBeDefined();
        expect(p?.html).toContain('<strong>bold</strong>');
    });

    it('preserves <a> tags in html field', () => {
        const p = result.blocks.find((b) => b.html.includes('<a'));
        expect(p).toBeDefined();
        expect(p?.html).toContain('href="https://example.com"');
    });

    it('preserves inline <code> in html field', () => {
        const p = result.blocks.find((b) => b.html.includes('<code>'));
        expect(p).toBeDefined();
    });
});

// ============================================================
// 8. Naked text in divs (no <p> tags)
// ============================================================
describe('naked text in divs', () => {
    const html = `<html><body><main>
    <div class="hero">
      This is a hero section with text directly inside a div without any paragraph tag around it.
    </div>
    <div class="description">
      Another div with substantial text content that should not be missed by the extractor.
    </div>
    <div class="tiny">Hi</div>
  </main></body></html>`;

    let result: ExtractionResult;
    beforeEach(() => {
        result = extract(html);
    });

    it('captures direct text in divs (>= 20 chars)', () => {
        expect(result.blockCount).toBeGreaterThanOrEqual(2);
        expect(texts(result).join(' ')).toContain('hero section');
        expect(texts(result).join(' ')).toContain('Another div');
    });

    it('skips short direct text (< 20 chars)', () => {
        const hiBlock = result.blocks.find((b) => b.text === 'Hi');
        expect(hiBlock).toBeUndefined();
    });
});

// ============================================================
// 9. Deduplication
// ============================================================
describe('deduplication', () => {
    const html = `<html><body><main>
    <p>This exact paragraph appears multiple times on the page for some reason.</p>
    <div class="sidebar-excerpt">
      <p>This exact paragraph appears multiple times on the page for some reason.</p>
    </div>
    <p>Unique paragraph that should definitely be extracted by the script.</p>
  </main></body></html>`;

    it('deduplicates identical paragraphs', () => {
        const result = extract(html);
        const matches = result.blocks.filter((b: Block) => b.text.includes('appears multiple times'));
        expect(matches).toHaveLength(1);
    });
});

// ============================================================
// 10. Script/style/noscript exclusion
// ============================================================
describe('script and style exclusion', () => {
    const html = `<html><body><main>
    <h1>Real Content Title</h1>
    <script>var x = "should not appear in extraction results";</script>
    <style>.hidden { display: none; }</style>
    <noscript>Please enable JavaScript to view this page properly.</noscript>
    <p>Visible paragraph that should be extracted normally.</p>
  </main></body></html>`;

    it('excludes script/style/noscript content', () => {
        const result = extract(html);
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('should not appear');
        expect(allText).not.toContain('.hidden');
        expect(allText).not.toContain('enable JavaScript');
        expect(allText).toContain('Real Content Title');
        expect(allText).toContain('Visible paragraph');
    });
});

// ============================================================
// 11. figcaption and summary
// ============================================================
describe('figcaption and details/summary', () => {
    const html = `<html><body><article>
    <figure>
      <figcaption>Figure 1: Performance comparison across different configurations.</figcaption>
    </figure>
    <details>
      <summary>Click to expand detailed technical specifications</summary>
      <p>The system uses a hybrid approach combining both static and dynamic analysis.</p>
    </details>
  </article></body></html>`;

    let result: ExtractionResult;
    beforeEach(() => {
        result = extract(html);
    });

    it('extracts figcaption as caption', () => {
        const caps = result.blocks.filter((b) => b.type === 'caption');
        expect(caps).toHaveLength(1);
        expect(caps[0].text).toContain('Performance comparison');
    });

    it('extracts summary', () => {
        const sums = result.blocks.filter((b) => b.type === 'summary');
        expect(sums).toHaveLength(1);
        expect(sums[0].text).toContain('Click to expand');
    });
});

// ============================================================
// 12. Japanese content
// ============================================================
describe('Japanese content', () => {
    const html = `<html lang="ja"><head><title>技術ブログ</title></head><body>
    <article>
      <h1>Rustの所有権を理解する</h1>
      <p>所有権はRustの最も独自な機能であり、ガベージコレクタなしでメモリ安全性を保証します。</p>
      <h2>所有権とは何か</h2>
      <p>Rustの各値にはオーナーと呼ばれる変数があります。</p>
      <ul>
        <li>各値にはオーナーが存在する</li>
        <li>同時に存在できるオーナーは1つだけ</li>
      </ul>
    </article>
  </body></html>`;

    let result: ExtractionResult;
    beforeEach(() => {
        result = extract(html);
    });

    it('extracts Japanese text correctly', () => {
        expect(result.title).toBe('技術ブログ');
        expect(result.lang).toBe('ja');
        expect(texts(result)).toContain('Rustの所有権を理解する');
    });

    it('handles Japanese list items', () => {
        const items = result.blocks.filter((b) => b.type === 'list-item');
        expect(items).toHaveLength(2);
        expect(items[0].text).toContain('オーナー');
    });
});

// ============================================================
// 13. News site layout
// ============================================================
describe('news site layout', () => {
    const html = `<html><body>
    <header role="banner">
      <div class="logo">NewsDaily</div>
      <nav><a href="/politics">Politics</a><a href="/tech">Tech</a></nav>
    </header>
    <div class="ad-banner"><p>Buy our premium subscription today!</p></div>
    <main>
      <article>
        <h1>Breaking: New Technology Transforms Industry</h1>
        <p class="byline"><span>By John Doe</span> | <time>March 3, 2026</time></p>
        <p>A revolutionary new technology has been announced that could transform the entire industry landscape.</p>
        <p>Experts say this development has been years in the making and represents a significant breakthrough.</p>
        <blockquote>"This changes everything we thought we knew about the field," said Dr. Smith.</blockquote>
        <h2>Industry Impact</h2>
        <p>The impact is expected to be felt across multiple sectors and geographic regions worldwide.</p>
        <figure>
          <figcaption>Chart showing projected growth over the next five years.</figcaption>
        </figure>
      </article>
      <aside class="sidebar">
        <h3>Trending Articles</h3>
        <p>Other trending stories and related content.</p>
      </aside>
    </main>
    <footer role="contentinfo">
      <p>Copyright 2026 NewsDaily. All rights reserved.</p>
    </footer>
  </body></html>`;

    let result: ExtractionResult;
    beforeEach(() => {
        result = extract(html);
    });

    it('skips banner header', () => {
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('NewsDaily');
        expect(allText).not.toContain('Politics');
    });

    it('skips ad banner', () => {
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('premium subscription');
    });

    it('skips footer with contentinfo role', () => {
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('All rights reserved');
    });

    it('skips sidebar (aside)', () => {
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('Trending Articles');
    });

    it('extracts article content in order', () => {
        const t = texts(result);
        expect(t[0]).toContain('New Technology');
        const quoteIdx = result.blocks.findIndex((b) => b.type === 'quote');
        const h2Idx = result.blocks.findIndex((b) => b.type === 'heading' && b.level === 2);
        expect(quoteIdx).toBeLessThan(h2Idx);
    });

    it('extracts figcaption', () => {
        const caps = result.blocks.filter((b) => b.type === 'caption');
        expect(caps).toHaveLength(1);
    });
});

// ============================================================
// 14. Mixed content without semantic root
// ============================================================
describe('no semantic root, mixed content', () => {
    const html = `<html><body>
    <div id="page">
      <div class="breadcrumb"><a href="/">Home</a> > <a href="/docs">Docs</a></div>
      <h1>Installation Guide for New Users</h1>
      <p>Follow these steps to install the software on your machine.</p>
      <ol>
        <li>Download the installer from the official website</li>
        <li>Run the installer with administrator privileges</li>
        <li>Follow the on-screen instructions to complete setup</li>
      </ol>
      <h2>Troubleshooting Common Installation Issues</h2>
      <p>If you encounter issues during installation, try these solutions.</p>
      <table>
        <tr><th>Error Code</th><th>Solution</th></tr>
        <tr><td>ERR_001</td><td>Restart the installer and try again</td></tr>
        <tr><td>ERR_002</td><td>Check your network connection and firewall</td></tr>
      </table>
      <div class="cookie-notice"><p>We use cookies to improve experience.</p></div>
    </div>
  </body></html>`;

    let result: ExtractionResult;
    beforeEach(() => {
        result = extract(html);
    });

    it('skips breadcrumb', () => {
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('Home');
    });

    it('skips cookie notice', () => {
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('cookies');
    });

    it('extracts ordered list items', () => {
        const items = result.blocks.filter((b) => b.type === 'list-item');
        expect(items).toHaveLength(3);
    });

    it('extracts table headers and cells', () => {
        const cells = result.blocks.filter((b) => b.type === 'table-cell');
        expect(cells.length).toBeGreaterThanOrEqual(4);
    });
});

// ============================================================
// 15. Twitter/X-like post layout (div-heavy, no semantic tags)
// ============================================================
describe('Twitter/X-like post layout', () => {
    const html = `<html><body>
    <div id="react-root">
      <div role="banner"><span>Home</span></div>
      <div role="navigation"><a href="/explore">Explore</a><a href="/notifications">Notifications</a></div>
      <main role="main">
        <article role="article">
          <div class="tweet-header">
            <span>@rustlang</span>
            <span>Mar 3</span>
          </div>
          <div data-testid="tweetText">
            <p>We're excited to announce Rust 2026 edition! This brings major improvements to async, const generics, and the borrow checker. Read more at our blog.</p>
          </div>
          <div class="quoted-tweet">
            <p>The Rust Foundation just published the annual survey results showing massive growth in adoption.</p>
          </div>
        </article>
        <article role="article">
          <div data-testid="tweetText">
            <p>Replying to @rustlang: This is amazing news! Can't wait to try the new async features in production.</p>
          </div>
        </article>
      </main>
      <div role="complementary">
        <h2>What's happening</h2>
        <p>Trending topics and recommendations for you.</p>
      </div>
    </div>
  </body></html>`;

    let result: ExtractionResult;
    beforeEach(() => {
        result = extract(html);
    });

    it('skips banner and navigation', () => {
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('Explore');
        expect(allText).not.toContain('Notifications');
    });

    it('skips complementary sidebar (trending)', () => {
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('Trending topics');
    });

    it('extracts tweet text from first article', () => {
        const allText = texts(result).join(' ');
        expect(allText).toContain('Rust 2026 edition');
        // Second article may not be reached since querySelector returns first <article>
        // This is acceptable — content root scoping prioritizes precision over recall
    });

    it('extracts quoted tweet', () => {
        const allText = texts(result).join(' ');
        expect(allText).toContain('annual survey');
    });
});

// ============================================================
// 16. Code-heavy tech article (lots of <pre> blocks)
// ============================================================
describe('code-heavy tech article', () => {
    const html = `<html><body>
    <article class="post-content">
      <h1>Building a REST API with Rust</h1>
      <p>In this tutorial, we'll build a complete REST API using Actix-web framework.</p>
      <h2>Project Setup</h2>
      <p>First, create a new Rust project and add the required dependencies to Cargo.toml.</p>
      <pre><code>[dependencies]
actix-web = "4"
serde = { version = "1", features = ["derive"] }
tokio = { version = "1", features = ["full"] }</code></pre>
      <p>Now let's create the main application file with the server configuration.</p>
      <pre><code>use actix_web::{web, App, HttpServer};

#[actix_web::main]
async fn main() -> std::io::Result&lt;()&gt; {
    HttpServer::new(|| App::new().route("/", web::get().to(index)))
        .bind("127.0.0.1:8080")?
        .run()
        .await
}</code></pre>
      <h2>Adding Routes</h2>
      <p>Define route handlers for CRUD operations on our user resource.</p>
      <pre><code>async fn get_users() -> impl Responder {
    HttpResponse::Ok().json(vec!["user1", "user2"])
}</code></pre>
      <h3>Error Handling</h3>
      <p>Proper error handling is crucial for production APIs and user experience.</p>
      <blockquote>Always return meaningful error messages with appropriate HTTP status codes to help API consumers debug issues.</blockquote>
    </article>
  </body></html>`;

    let result: ExtractionResult;
    beforeEach(() => {
        result = extract(html);
    });

    it('extracts both prose and code blocks', () => {
        const codeBlocks = result.blocks.filter((b) => b.type === 'code');
        const paragraphs = result.blocks.filter((b) => b.type === 'paragraph');
        expect(codeBlocks.length).toBe(3);
        expect(paragraphs.length).toBeGreaterThanOrEqual(4);
    });

    it('preserves code content in html field', () => {
        const codeBlocks = result.blocks.filter((b) => b.type === 'code');
        expect(codeBlocks[0].html).toContain('actix-web');
        expect(codeBlocks[1].html).toContain('HttpServer');
    });

    it('correctly classifies heading hierarchy', () => {
        const headings = result.blocks.filter((b) => b.type === 'heading');
        const levels = headings.map((h) => h.level);
        expect(levels).toEqual([1, 2, 2, 3]);
    });

    it('maintains document order: prose → code → prose', () => {
        const order = types(result);
        const firstCode = order.indexOf('code');
        const prevParagraph = order.lastIndexOf('paragraph', firstCode);
        const nextParagraph = order.indexOf('paragraph', firstCode);
        expect(prevParagraph).toBeLessThan(firstCode);
        expect(firstCode).toBeLessThan(nextParagraph);
    });
});

// ============================================================
// 17. Anthropic-style tech blog (clean HTML, image placeholders)
// ============================================================
describe('Anthropic-style tech blog', () => {
    const html = `<html lang="en"><head><title>Introducing Claude 4 | Anthropic</title></head><body>
    <header role="banner">
      <nav>
        <a href="/">Anthropic</a>
        <a href="/research">Research</a>
        <a href="/news">News</a>
      </nav>
    </header>
    <main>
      <article>
        <div class="post-header">
          <h1>Introducing Claude 4: A New Frontier in AI Safety</h1>
          <p class="post-meta">Published March 1, 2026 by the Anthropic Research Team</p>
        </div>
        <div class="post-body">
          <p>Today we're announcing Claude 4, our most capable and safe model yet. Building on the foundation of Constitutional AI, Claude 4 represents a significant step forward.</p>
          <figure>
            <img src="/images/claude4-benchmark.png" alt="Claude 4 benchmark results">
            <figcaption>Figure 1: Claude 4 performance compared to previous models across key benchmarks.</figcaption>
          </figure>
          <h2>Key Improvements</h2>
          <p>Claude 4 introduces several major improvements over its predecessor in reasoning capability.</p>
          <ul>
            <li>Enhanced reasoning capabilities with formal verification support</li>
            <li>Improved multilingual understanding across 50+ languages</li>
            <li>Better calibration and reduced hallucination rates</li>
            <li>Stronger safety properties through Constitutional AI v3</li>
          </ul>
          <h2>Safety First Approach</h2>
          <p>Safety remains our top priority. We've conducted extensive red-teaming and evaluation before this release.</p>
          <blockquote>Our mission is to build AI systems that are safe, beneficial, and understandable. Claude 4 embodies these principles at every level of its architecture and training process.</blockquote>
          <h3>Evaluation Methodology</h3>
          <p>We evaluated Claude 4 across 150+ benchmarks spanning reasoning, coding, safety, and multilingual tasks.</p>
          <table>
            <thead><tr><th>Benchmark</th><th>Claude 3</th><th>Claude 4</th><th>Improvement</th></tr></thead>
            <tbody>
              <tr><td>MMLU Pro</td><td>85.2%</td><td>92.1%</td><td>+6.9%</td></tr>
              <tr><td>HumanEval</td><td>78.5%</td><td>91.3%</td><td>+12.8%</td></tr>
              <tr><td>Safety Score</td><td>94.1%</td><td>98.7%</td><td>+4.6%</td></tr>
            </tbody>
          </table>
          <h2>Getting Started</h2>
          <p>Claude 4 is available today through the API and Claude.ai for all users.</p>
          <pre><code>from anthropic import Anthropic
client = Anthropic()
response = client.messages.create(
    model="claude-4-20260301",
    messages=[{"role": "user", "content": "Hello, Claude 4!"}]
)</code></pre>
        </div>
      </article>
    </main>
    <footer role="contentinfo">
      <p>© 2026 Anthropic. All rights reserved.</p>
      <nav><a href="/careers">Careers</a><a href="/contact">Contact</a></nav>
    </footer>
  </body></html>`;

    let result: ExtractionResult;
    beforeEach(() => {
        result = extract(html);
    });

    it('skips header nav and footer', () => {
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('Careers');
        expect(allText).not.toContain('© 2026');
    });

    it('extracts all content types', () => {
        const typeSet = new Set(types(result));
        expect(typeSet).toContain('heading');
        expect(typeSet).toContain('paragraph');
        expect(typeSet).toContain('list-item');
        expect(typeSet).toContain('quote');
        expect(typeSet).toContain('table-cell');
        expect(typeSet).toContain('code');
        expect(typeSet).toContain('caption');
    });

    it('extracts figcaption but not img', () => {
        const caps = result.blocks.filter((b) => b.type === 'caption');
        expect(caps).toHaveLength(1);
        expect(caps[0].text).toContain('benchmark');
        // img should not produce a block
        const allTags = result.blocks.map((b) => b.tag);
        expect(allTags).not.toContain('img');
    });

    it('extracts benchmark table data', () => {
        const cells = result.blocks.filter((b) => b.type === 'table-cell');
        const cellTexts = cells.map((c) => c.text);
        expect(cellTexts).toContain('MMLU Pro');
        expect(cellTexts).toContain('+12.8%');
    });

    it('gets code block with API example', () => {
        const code = result.blocks.filter((b) => b.type === 'code');
        expect(code).toHaveLength(1);
        expect(code[0].html).toContain('anthropic');
    });

    it('extracts all 4 list items', () => {
        const items = result.blocks.filter((b) => b.type === 'list-item');
        expect(items).toHaveLength(4);
        expect(items[0].text).toContain('reasoning');
    });

    it('has substantial block count', () => {
        // h1 + meta paragraph + body paragraphs + figcaption + h2s + h3 + list items + quote + table cells + code
        expect(result.blockCount).toBeGreaterThanOrEqual(20);
    });
});

// ============================================================
// 18. Image-heavy portfolio / gallery page
// ============================================================
describe('image-heavy page with minimal text', () => {
    const html = `<html><body>
    <main>
      <h1>Photography Portfolio</h1>
      <p>A collection of my best landscape photography from travels around the world.</p>
      <div class="gallery">
        <figure><img src="1.jpg"><figcaption>Sunset over Mount Fuji, Japan, captured during golden hour.</figcaption></figure>
        <figure><img src="2.jpg"><figcaption>Northern lights in Tromsø, Norway, a breathtaking winter display.</figcaption></figure>
        <figure><img src="3.jpg"><figcaption>Grand Canyon at dawn with mist filling the valley below.</figcaption></figure>
      </div>
      <h2>About the Photographer</h2>
      <p>I've been capturing landscapes for over 15 years across six continents.</p>
    </main>
  </body></html>`;

    let result: ExtractionResult;
    beforeEach(() => {
        result = extract(html);
    });

    it('extracts figcaptions from gallery', () => {
        const caps = result.blocks.filter((b) => b.type === 'caption');
        expect(caps).toHaveLength(3);
        expect(caps[0].text).toContain('Mount Fuji');
    });

    it('extracts surrounding prose', () => {
        const paragraphs = result.blocks.filter((b) => b.type === 'paragraph');
        expect(paragraphs.length).toBeGreaterThanOrEqual(2);
    });

    it('does not create blocks for img elements', () => {
        const allTags = result.blocks.map((b) => b.tag);
        expect(allTags).not.toContain('img');
    });
});

// ============================================================
// 19. <aside> inside article (not sidebar)
// ============================================================
describe('aside inside article (callout box)', () => {
    const html = `<html><body>
    <article>
      <h1>Getting Started with Docker</h1>
      <p>Docker allows you to package applications with all their dependencies into containers.</p>
      <aside>
        <p>Note: Make sure Docker Desktop is installed before proceeding with this tutorial.</p>
      </aside>
      <p>Let's start by creating a simple Dockerfile for a Node.js application.</p>
    </article>
    <aside class="sidebar">
      <p>Popular articles and recommended reading from our blog.</p>
    </aside>
  </body></html>`;

    let result: ExtractionResult;
    beforeEach(() => {
        result = extract(html);
    });

    it('skips sidebar aside (class-based)', () => {
        const allText = texts(result).join(' ');
        expect(allText).not.toContain('Popular articles');
    });

    it('extracts content from article body', () => {
        const allText = texts(result).join(' ');
        expect(allText).toContain('Docker allows');
        expect(allText).toContain('Dockerfile');
    });
});

// ============================================================
// 20. data-tp-id markers and block id field
// ============================================================
describe('data-tp-id markers', () => {
    const html = `<html><body>
    <article>
      <h1>Marker Test Title</h1>
      <p>First paragraph for marker testing in the document.</p>
      <p>Second paragraph for marker testing in the document.</p>
      <pre><code>const x = 42;</code></pre>
    </article>
  </body></html>`;

    it('assigns sequential id field to blocks', () => {
        const result = extract(html);
        const ids = result.blocks.map((b) => b.id);
        expect(ids).toEqual([0, 1, 2, 3]);
    });

    it('sets data-tp-id attribute on DOM nodes', () => {
        const { dom } = extractWithDom(html);
        const doc = dom.window.document;
        const marked = doc.querySelectorAll('[data-tp-id]');
        expect(marked.length).toBe(4);
        expect(marked[0].getAttribute('data-tp-id')).toBe('0');
        expect(marked[1].getAttribute('data-tp-id')).toBe('1');
        expect(marked[2].getAttribute('data-tp-id')).toBe('2');
        expect(marked[3].getAttribute('data-tp-id')).toBe('3');
    });

    it('marker id matches block id', () => {
        const { result, dom } = extractWithDom(html);
        const doc = dom.window.document;
        for (const block of result.blocks) {
            const node = doc.querySelector(`[data-tp-id="${block.id}"]`);
            expect(node).toBeTruthy();
        }
    });

    it('sets data-tp-id on naked text divs', () => {
        const nakedHtml = `<html><body><main>
      <div class="hero">
        This is a hero section with text directly inside a div without any paragraph wrapping.
      </div>
    </main></body></html>`;
        const { result, dom } = extractWithDom(nakedHtml);
        expect(result.blocks.length).toBe(1);
        expect(result.blocks[0].id).toBe(0);
        const node = dom.window.document.querySelector('[data-tp-id="0"]');
        expect(node).toBeTruthy();
        expect(node?.className).toContain('hero');
    });
});
