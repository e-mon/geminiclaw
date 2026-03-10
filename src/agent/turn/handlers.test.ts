import { describe, expect, it } from 'vitest';
import { type Handler, runHandlers, runHandlersParallel } from './handlers.js';

interface TestCtx {
    value: number;
    flag?: boolean;
}

describe('runHandlers', () => {
    it('executes handlers in order', async () => {
        const order: string[] = [];
        const handlers: Handler<TestCtx>[] = [
            {
                id: 'a',
                errorSemantics: 'fail-closed',
                run: async () => {
                    order.push('a');
                },
            },
            {
                id: 'b',
                errorSemantics: 'fail-closed',
                run: async () => {
                    order.push('b');
                },
            },
        ];
        await runHandlers('test', handlers, { value: 1 });
        expect(order).toEqual(['a', 'b']);
    });

    it('fail-open swallows errors and continues', async () => {
        const order: string[] = [];
        const handlers: Handler<TestCtx>[] = [
            {
                id: 'fail',
                errorSemantics: 'fail-open',
                run: async () => {
                    throw new Error('boom');
                },
            },
            {
                id: 'after',
                errorSemantics: 'fail-closed',
                run: async () => {
                    order.push('after');
                },
            },
        ];
        await runHandlers('test', handlers, { value: 1 });
        expect(order).toEqual(['after']);
    });

    it('fail-closed propagates errors', async () => {
        const handlers: Handler<TestCtx>[] = [
            {
                id: 'fail',
                errorSemantics: 'fail-closed',
                run: async () => {
                    throw new Error('critical');
                },
            },
            {
                id: 'never',
                errorSemantics: 'fail-closed',
                run: async () => {
                    /* unreachable */
                },
            },
        ];
        await expect(runHandlers('test', handlers, { value: 1 })).rejects.toThrow('critical');
    });

    it('skips handlers whose condition returns false', async () => {
        const order: string[] = [];
        const handlers: Handler<TestCtx>[] = [
            {
                id: 'skip-me',
                errorSemantics: 'fail-closed',
                condition: (ctx) => ctx.flag === true,
                run: async () => {
                    order.push('skip-me');
                },
            },
            {
                id: 'run-me',
                errorSemantics: 'fail-closed',
                run: async () => {
                    order.push('run-me');
                },
            },
        ];
        await runHandlers('test', handlers, { value: 1, flag: false });
        expect(order).toEqual(['run-me']);
    });

    it('runs handlers whose condition returns true', async () => {
        const order: string[] = [];
        const handlers: Handler<TestCtx>[] = [
            {
                id: 'conditional',
                errorSemantics: 'fail-closed',
                condition: (ctx) => ctx.value > 0,
                run: async () => {
                    order.push('conditional');
                },
            },
        ];
        await runHandlers('test', handlers, { value: 5 });
        expect(order).toEqual(['conditional']);
    });
});

describe('runHandlersParallel', () => {
    it('runs all eligible handlers concurrently', async () => {
        const results: string[] = [];
        const handlers: Handler<TestCtx>[] = [
            {
                id: 'slow',
                errorSemantics: 'fail-open',
                run: async () => {
                    await new Promise((r) => setTimeout(r, 30));
                    results.push('slow');
                },
            },
            {
                id: 'fast',
                errorSemantics: 'fail-open',
                run: async () => {
                    results.push('fast');
                },
            },
        ];
        await runHandlersParallel('test', handlers, { value: 1 });
        // Both ran — fast finishes before slow due to concurrency
        expect(results).toContain('slow');
        expect(results).toContain('fast');
        expect(results[0]).toBe('fast');
    });

    it('fail-open errors do not affect other handlers', async () => {
        const results: string[] = [];
        const handlers: Handler<TestCtx>[] = [
            {
                id: 'boom',
                errorSemantics: 'fail-open',
                run: async () => {
                    throw new Error('boom');
                },
            },
            {
                id: 'ok',
                errorSemantics: 'fail-open',
                run: async () => {
                    results.push('ok');
                },
            },
        ];
        await runHandlersParallel('test', handlers, { value: 1 });
        expect(results).toEqual(['ok']);
    });

    it('skips handlers whose condition returns false', async () => {
        const results: string[] = [];
        const handlers: Handler<TestCtx>[] = [
            {
                id: 'skip',
                errorSemantics: 'fail-open',
                condition: () => false,
                run: async () => {
                    results.push('skip');
                },
            },
            {
                id: 'run',
                errorSemantics: 'fail-open',
                run: async () => {
                    results.push('run');
                },
            },
        ];
        await runHandlersParallel('test', handlers, { value: 1 });
        expect(results).toEqual(['run']);
    });
});
