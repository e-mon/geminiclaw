/**
 * config/paths.ts — Well-known filesystem paths for GeminiClaw.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './schema.js';

export const GEMINICLAW_HOME = join(homedir(), '.geminiclaw');
export const CONFIG_PATH = join(GEMINICLAW_HOME, 'config.json');
/** GeminiClaw-specific Gemini CLI settings file. Never written to ~/.gemini/settings.json. */
export const GEMINICLAW_SETTINGS_PATH = join(GEMINICLAW_HOME, 'settings.json');

export const BROWSER_PROFILE_DIR = join(GEMINICLAW_HOME, 'browser-profile');
export const BROWSER_STATE_PATH = join(GEMINICLAW_HOME, 'browser-auth-state.json');

/**
 * Resolve the `dist/mcp/` directory at runtime.
 *
 * This file lives at `dist/config/paths.js`, so `../mcp` resolves to
 * `dist/mcp/` regardless of where the package is installed.
 */
export function getMcpDir(): string {
    return join(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), '..', 'mcp');
}

export function getWorkspacePath(config?: Config): string {
    if (config?.workspace) return config.workspace;
    return join(GEMINICLAW_HOME, 'workspace');
}

/**
 * Resolve the `gemini` binary path.
 *
 * Prefers the locally bundled binary (`node_modules/.bin/gemini`) so that
 * patch-package patches are guaranteed to be applied. Falls back to the
 * global `gemini` command when running from a global install where no
 * local `node_modules` tree exists.
 */
export function getGeminiBin(): string {
    // Walk up from this file (dist/config/paths.js) to the package root,
    // then check node_modules/.bin/gemini.
    const pkgRoot = join(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), '..', '..');
    const localBin = join(pkgRoot, 'node_modules', '.bin', 'gemini');
    if (existsSync(localBin)) return localBin;
    // Fallback: assume globally installed `gemini` is on PATH.
    return 'gemini';
}
