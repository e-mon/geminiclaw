/**
 * memory/sqlite.ts — SQLite database adapter.
 *
 * Uses bun:sqlite at runtime (Bun's native binding, no native addon needed).
 * Falls back to better-sqlite3 in vitest (where bun:sqlite is unavailable).
 *
 * Both libraries share the same API surface for the operations we use
 * (exec, prepare, get, all, run, close).
 */

import { createRequire } from 'node:module';

let DatabaseClass: new (path: string) => DatabaseInstance;

interface DatabaseInstance {
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
}

interface Statement {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
}

const _require = createRequire(import.meta.url);

try {
    // bun:sqlite is available at runtime under Bun
    const mod = _require('bun:sqlite');
    DatabaseClass = mod.Database;
} catch {
    // Fallback for vitest / Node.js — use better-sqlite3
    const mod = _require('better-sqlite3');
    DatabaseClass = mod.default ?? mod;
}

export { DatabaseClass as Database };
export type { DatabaseInstance, Statement };
