import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = resolve(
    __dirname,
    '../../templates/.gemini/skills/translate-preview/references/twitter-extract.js',
);
const scriptCode = readFileSync(SCRIPT_PATH, 'utf8');

interface Block {
    id: number;
    tag: string;
    type: string;
    text: string;
    html: string;
    level: number | null;
}

interface BlocksResult {
    title: string;
    url: string;
    domain: string;
    blockCount: number;
    blocks: Block[];
}

type ParseFn = (url: string) => { user: string; statusId: string } | null;
type ConvertFn = (data: object) => BlocksResult | null;

function loadModule(): { parseTweetUrl: ParseFn; convertFxtwitter: ConvertFn } {
    const exports: Record<string, unknown> = {};
    const mod = { exports };
    const sandbox = {
        module: mod,
        exports,
        String,
        Math,
        process: undefined as unknown,
    };
    vm.runInNewContext(scriptCode, sandbox);
    return mod.exports as { parseTweetUrl: ParseFn; convertFxtwitter: ConvertFn };
}

const { parseTweetUrl, convertFxtwitter } = loadModule();

function makeFxResponse(
    articleContent: {
        blocks: Array<{
            key?: string;
            text?: string;
            type?: string;
            inlineStyleRanges?: Array<{ offset: number; length: number; style: string }>;
            entityRanges?: Array<{ key: number; offset: number; length: number }>;
        }>;
        entityMap?: Array<{
            key: number;
            value: { data: Record<string, unknown> };
        }>;
    },
    opts?: { mediaEntities?: Array<Record<string, unknown>>; title?: string },
): object {
    return {
        tweet: {
            id: '1234567890',
            author: { screen_name: 'testuser' },
            article: {
                title: opts?.title || '',
                content: {
                    blocks: articleContent.blocks,
                    entityMap: articleContent.entityMap || [],
                },
                media_entities: opts?.mediaEntities || [],
            },
        },
    };
}

// ============================================================
// 0. URL parsing
// ============================================================
describe('parseTweetUrl', () => {
    it('parses x.com URLs', () => {
        const result = parseTweetUrl('https://x.com/elonmusk/status/1234567890');
        expect(result).toEqual({ user: 'elonmusk', statusId: '1234567890' });
    });

    it('parses twitter.com URLs', () => {
        const result = parseTweetUrl('https://twitter.com/rustlang/status/9876543210');
        expect(result).toEqual({ user: 'rustlang', statusId: '9876543210' });
    });

    it('handles query params', () => {
        const result = parseTweetUrl('https://x.com/user/status/123?s=46&t=abc');
        expect(result).toEqual({ user: 'user', statusId: '123' });
    });

    it('returns null for invalid URLs', () => {
        expect(parseTweetUrl('https://example.com/article')).toBeNull();
        expect(parseTweetUrl('https://x.com/user/likes')).toBeNull();
    });
});

// ============================================================
// 1. Basic paragraph extraction
// ============================================================
describe('basic paragraph extraction', () => {
    it('converts unstyled blocks to paragraphs', () => {
        const input = makeFxResponse({
            blocks: [
                { key: 'a', text: 'Hello world', type: 'unstyled' },
                { key: 'b', text: 'Second paragraph', type: 'unstyled' },
            ],
        });
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.blocks).toHaveLength(2);
        expect(result.blocks[0]).toMatchObject({ type: 'paragraph', tag: 'p', text: 'Hello world' });
        expect(result.blocks[1].text).toBe('Second paragraph');
    });

    it('skips empty unstyled blocks', () => {
        const input = makeFxResponse({
            blocks: [
                { key: 'a', text: 'Content', type: 'unstyled' },
                { key: 'b', text: '', type: 'unstyled' },
                { key: 'c', text: '   ', type: 'unstyled' },
                { key: 'd', text: 'More content', type: 'unstyled' },
            ],
        });
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.blocks).toHaveLength(2);
    });

    it('assigns sequential IDs', () => {
        const input = makeFxResponse({
            blocks: [
                { key: 'a', text: 'First', type: 'unstyled' },
                { key: 'b', text: 'Second', type: 'unstyled' },
                { key: 'c', text: 'Third', type: 'unstyled' },
            ],
        });
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.blocks.map((b) => b.id)).toEqual([0, 1, 2]);
    });
});

// ============================================================
// 2. Heading extraction
// ============================================================
describe('heading extraction', () => {
    it('converts header-one/two/three to heading blocks', () => {
        const input = makeFxResponse({
            blocks: [
                { key: 'a', text: 'Main Title', type: 'header-one' },
                { key: 'b', text: 'Subtitle', type: 'header-two' },
                { key: 'c', text: 'Sub-subtitle', type: 'header-three' },
            ],
        });
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.blocks).toHaveLength(3);
        expect(result.blocks[0]).toMatchObject({ type: 'heading', tag: 'h1', level: 1 });
        expect(result.blocks[1]).toMatchObject({ type: 'heading', tag: 'h2', level: 2 });
        expect(result.blocks[2]).toMatchObject({ type: 'heading', tag: 'h3', level: 3 });
    });
});

// ============================================================
// 3. Inline styles (Bold, Italic)
// ============================================================
describe('inline styles', () => {
    it('applies bold inline style', () => {
        const input = makeFxResponse({
            blocks: [
                {
                    key: 'a',
                    text: 'Hello bold world',
                    type: 'unstyled',
                    inlineStyleRanges: [{ offset: 6, length: 4, style: 'Bold' }],
                },
            ],
        });
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.blocks[0].html).toContain('<strong>bold</strong>');
        expect(result.blocks[0].text).toBe('Hello bold world');
    });

    it('applies italic inline style', () => {
        const input = makeFxResponse({
            blocks: [
                {
                    key: 'a',
                    text: 'Hello italic world',
                    type: 'unstyled',
                    inlineStyleRanges: [{ offset: 6, length: 6, style: 'Italic' }],
                },
            ],
        });
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.blocks[0].html).toContain('<em>italic</em>');
    });

    it('handles multiple styles', () => {
        const input = makeFxResponse({
            blocks: [
                {
                    key: 'a',
                    text: 'Bold and italic text',
                    type: 'unstyled',
                    inlineStyleRanges: [
                        { offset: 0, length: 4, style: 'Bold' },
                        { offset: 9, length: 6, style: 'Italic' },
                    ],
                },
            ],
        });
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.blocks[0].html).toContain('<strong>Bold</strong>');
        expect(result.blocks[0].html).toContain('<em>italic</em>');
    });
});

// ============================================================
// 4. Entity ranges (links)
// ============================================================
describe('entity ranges (links)', () => {
    it('converts entity ranges with url to anchor tags', () => {
        const input = makeFxResponse({
            blocks: [
                {
                    key: 'a',
                    text: 'Click here for more',
                    type: 'unstyled',
                    entityRanges: [{ key: 0, offset: 6, length: 4 }],
                },
            ],
            entityMap: [
                {
                    key: 0,
                    value: { data: { url: 'https://example.com' } },
                },
            ],
        });
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.blocks[0].html).toContain('<a href="https://example.com">here</a>');
    });
});

// ============================================================
// 5. Code blocks (atomic with markdown)
// ============================================================
describe('code blocks', () => {
    it('extracts code from atomic blocks with markdown entity', () => {
        const input = makeFxResponse({
            blocks: [
                { key: 'a', text: 'Before code', type: 'unstyled' },
                { key: 'b', text: ' ', type: 'atomic', entityRanges: [{ key: 0, offset: 0, length: 1 }] },
                { key: 'c', text: 'After code', type: 'unstyled' },
            ],
            entityMap: [
                {
                    key: 0,
                    value: { data: { markdown: '```python\nprint("hello")\n```' } },
                },
            ],
        });
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.blocks).toHaveLength(3);
        expect(result.blocks[1]).toMatchObject({ type: 'code', tag: 'pre' });
        expect(result.blocks[1].text).toContain('print("hello")');
    });
});

// ============================================================
// 6. Image blocks (atomic with mediaItems)
// ============================================================
describe('image blocks', () => {
    it('extracts images from atomic blocks with mediaItems', () => {
        const input = makeFxResponse(
            {
                blocks: [{ key: 'a', text: ' ', type: 'atomic', entityRanges: [{ key: 0, offset: 0, length: 1 }] }],
                entityMap: [
                    {
                        key: 0,
                        value: { data: { mediaItems: [{ media_id: '111' }], caption: 'A photo' } },
                    },
                ],
            },
            {
                mediaEntities: [
                    {
                        media_id: '111',
                        media_info: { original_img_url: 'https://pbs.twimg.com/media/test.jpg' },
                    },
                ],
            },
        );
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.blocks).toHaveLength(1);
        expect(result.blocks[0]).toMatchObject({ type: 'image', tag: 'img', text: 'A photo' });
        expect(result.blocks[0].html).toContain('pbs.twimg.com/media/test.jpg');
    });

    it('falls back to positional matching when mediaItems lack media_id', () => {
        const input = makeFxResponse(
            {
                blocks: [
                    { key: 'a', text: ' ', type: 'atomic', entityRanges: [{ key: 0, offset: 0, length: 1 }] },
                    { key: 'b', text: ' ', type: 'atomic', entityRanges: [{ key: 1, offset: 0, length: 1 }] },
                ],
                entityMap: [
                    { key: 0, value: { data: { mediaItems: [{ media_id: null }], caption: 'First' } } },
                    { key: 1, value: { data: { mediaItems: [{ media_id: null }], caption: 'Second' } } },
                ],
            },
            {
                mediaEntities: [
                    { media_id: '111', media_info: { original_img_url: 'https://pbs.twimg.com/media/first.jpg' } },
                    { media_id: '222', media_info: { original_img_url: 'https://pbs.twimg.com/media/second.jpg' } },
                ],
            },
        );
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.blocks).toHaveLength(2);
        expect(result.blocks[0].html).toContain('first.jpg');
        expect(result.blocks[0].text).toBe('First');
        expect(result.blocks[1].html).toContain('second.jpg');
        expect(result.blocks[1].text).toBe('Second');
    });

    it('handles mix of valid and null media_id', () => {
        const input = makeFxResponse(
            {
                blocks: [
                    { key: 'a', text: ' ', type: 'atomic', entityRanges: [{ key: 0, offset: 0, length: 1 }] },
                    { key: 'b', text: ' ', type: 'atomic', entityRanges: [{ key: 1, offset: 0, length: 1 }] },
                ],
                entityMap: [
                    { key: 0, value: { data: { mediaItems: [{ media_id: '111' }] } } },
                    { key: 1, value: { data: { mediaItems: [{ media_id: null }] } } },
                ],
            },
            {
                mediaEntities: [
                    { media_id: '111', media_info: { original_img_url: 'https://pbs.twimg.com/media/first.jpg' } },
                    { media_id: '222', media_info: { original_img_url: 'https://pbs.twimg.com/media/second.jpg' } },
                ],
            },
        );
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.blocks).toHaveLength(2);
        expect(result.blocks[0].html).toContain('first.jpg');
        expect(result.blocks[1].html).toContain('second.jpg');
    });
});

// ============================================================
// 7. List items
// ============================================================
describe('list items', () => {
    it('converts ordered-list-item', () => {
        const input = makeFxResponse({
            blocks: [
                { key: 'a', text: 'First item', type: 'ordered-list-item' },
                { key: 'b', text: 'Second item', type: 'ordered-list-item' },
            ],
        });
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.blocks).toHaveLength(2);
        expect(result.blocks[0]).toMatchObject({ type: 'list-item', tag: 'li' });
    });

    it('converts unordered-list-item', () => {
        const input = makeFxResponse({
            blocks: [{ key: 'a', text: 'Bullet one', type: 'unordered-list-item' }],
        });
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.blocks[0].type).toBe('list-item');
    });
});

// ============================================================
// 8. Blockquote
// ============================================================
describe('blockquote', () => {
    it('converts blockquote type to quote blocks', () => {
        const input = makeFxResponse({
            blocks: [{ key: 'a', text: 'A wise quote', type: 'blockquote' }],
        });
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.blocks[0]).toMatchObject({ type: 'quote', tag: 'blockquote' });
    });
});

// ============================================================
// 9. Output metadata
// ============================================================
describe('output metadata', () => {
    it('includes title from article', () => {
        const input = makeFxResponse(
            {
                blocks: [{ key: 'a', text: 'Content', type: 'unstyled' }],
            },
            { title: 'My Article Title' },
        );
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.title).toBe('My Article Title');
    });

    it('falls back to first heading when no article title', () => {
        const input = makeFxResponse({
            blocks: [
                { key: 'a', text: 'Heading Title', type: 'header-one' },
                { key: 'b', text: 'Content', type: 'unstyled' },
            ],
        });
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.title).toBe('Heading Title');
    });

    it('sets domain to x.com', () => {
        const input = makeFxResponse({
            blocks: [{ key: 'a', text: 'Content', type: 'unstyled' }],
        });
        expect(convertFxtwitter(input)?.domain).toBe('x.com');
    });

    it('constructs canonical URL', () => {
        const input = makeFxResponse({
            blocks: [{ key: 'a', text: 'Content', type: 'unstyled' }],
        });
        expect(convertFxtwitter(input)?.url).toBe('https://x.com/testuser/status/1234567890');
    });

    it('sets blockCount correctly', () => {
        const input = makeFxResponse({
            blocks: [
                { key: 'a', text: 'One', type: 'unstyled' },
                { key: 'b', text: 'Two', type: 'unstyled' },
                { key: 'c', text: '', type: 'unstyled' },
            ],
        });
        expect(convertFxtwitter(input)?.blockCount).toBe(2);
    });
});

// ============================================================
// 10. Non-article tweet
// ============================================================
describe('non-article tweet', () => {
    it('returns null when tweet has no article', () => {
        const input = { tweet: { id: '123', author: { screen_name: 'testuser' }, text: 'Regular tweet' } };
        expect(convertFxtwitter(input)).toBeNull();
    });
});

// ============================================================
// 11. HTML escaping
// ============================================================
describe('HTML escaping', () => {
    it('escapes special characters in html, preserves text', () => {
        const input = makeFxResponse({
            blocks: [{ key: 'a', text: 'Use <div> & "quotes"', type: 'unstyled' }],
        });
        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.blocks[0].html).toContain('&lt;div&gt;');
        expect(result.blocks[0].html).toContain('&amp;');
        expect(result.blocks[0].text).toBe('Use <div> & "quotes"');
    });
});

// ============================================================
// 12. Mixed content article
// ============================================================
describe('mixed content article', () => {
    it('handles realistic article with multiple block types', () => {
        const input = makeFxResponse(
            {
                blocks: [
                    { key: 'a', text: 'Understanding Ownership in Rust', type: 'header-one' },
                    { key: 'b', text: "Ownership is Rust's most unique feature.", type: 'unstyled' },
                    { key: 'c', text: 'What is Ownership?', type: 'header-two' },
                    {
                        key: 'd',
                        text: 'Each value in Rust has a variable called its owner.',
                        type: 'unstyled',
                        inlineStyleRanges: [{ offset: 14, length: 4, style: 'Bold' }],
                    },
                    { key: 'e', text: ' ', type: 'atomic', entityRanges: [{ key: 0, offset: 0, length: 1 }] },
                    { key: 'f', text: 'Each value has an owner', type: 'ordered-list-item' },
                    { key: 'g', text: 'Only one owner at a time', type: 'ordered-list-item' },
                    { key: 'h', text: 'There can only be one owner at a time.', type: 'blockquote' },
                ],
                entityMap: [{ key: 0, value: { data: { markdown: '```rust\nlet s = String::from("hello");\n```' } } }],
            },
            { title: 'Understanding Ownership in Rust' },
        );

        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        expect(result.title).toBe('Understanding Ownership in Rust');
        expect(result.blockCount).toBe(8);
        expect(result.blocks.map((b) => b.type)).toEqual([
            'heading',
            'paragraph',
            'heading',
            'paragraph',
            'code',
            'list-item',
            'list-item',
            'quote',
        ]);
        expect(result.blocks[3].html).toContain('<strong>Rust</strong>');
        expect(result.blocks[4].text).toContain('String::from');
    });
});

// ============================================================
// 9. Image ordering — camelCase mediaId lookup
// ============================================================
describe('image ordering with camelCase mediaId', () => {
    it('matches images by mediaId when media_entities order differs from block order', () => {
        // media_entities in a different order than article blocks
        const input = makeFxResponse(
            {
                blocks: [
                    { key: 'a', text: 'Intro', type: 'unstyled' },
                    { key: 'b', text: ' ', type: 'atomic', entityRanges: [{ key: 0, offset: 0, length: 1 }] },
                    { key: 'c', text: 'Middle', type: 'unstyled' },
                    { key: 'd', text: ' ', type: 'atomic', entityRanges: [{ key: 1, offset: 0, length: 1 }] },
                    { key: 'e', text: 'End', type: 'unstyled' },
                    { key: 'f', text: ' ', type: 'atomic', entityRanges: [{ key: 2, offset: 0, length: 1 }] },
                ],
                entityMap: [
                    { key: 0, value: { data: { mediaItems: [{ mediaId: '300', mediaCategory: 'DraftTweetImage' }] } } },
                    { key: 1, value: { data: { mediaItems: [{ mediaId: '100', mediaCategory: 'DraftTweetImage' }] } } },
                    { key: 2, value: { data: { mediaItems: [{ mediaId: '200', mediaCategory: 'DraftTweetImage' }] } } },
                ],
            },
            {
                mediaEntities: [
                    { media_id: '100', media_info: { original_img_url: 'https://img/first.png' } },
                    { media_id: '200', media_info: { original_img_url: 'https://img/second.png' } },
                    { media_id: '300', media_info: { original_img_url: 'https://img/third.png' } },
                ],
            },
        );

        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        const images = result.blocks.filter((b) => b.type === 'image');
        expect(images).toHaveLength(3);
        // Block order: mediaId 300, 100, 200 → should map to third, first, second
        expect(images[0].html).toContain('https://img/third.png');
        expect(images[1].html).toContain('https://img/first.png');
        expect(images[2].html).toContain('https://img/second.png');
    });

    it('falls back to positional matching when mediaId is absent', () => {
        const input = makeFxResponse(
            {
                blocks: [{ key: 'a', text: ' ', type: 'atomic', entityRanges: [{ key: 0, offset: 0, length: 1 }] }],
                entityMap: [{ key: 0, value: { data: { mediaItems: [{ mediaCategory: 'DraftTweetImage' }] } } }],
            },
            {
                mediaEntities: [{ media_id: '100', media_info: { original_img_url: 'https://img/fallback.png' } }],
            },
        );

        const result = convertFxtwitter(input) as NonNullable<ReturnType<typeof convertFxtwitter>>;
        const images = result.blocks.filter((b) => b.type === 'image');
        expect(images).toHaveLength(1);
        expect(images[0].html).toContain('https://img/fallback.png');
    });
});
