/**
 * cli/env-loader.ts — Minimal .env file loader (no external deps).
 *
 * Load .env file from cwd into process.env.
 * Existing env vars are never overwritten so system env takes precedence.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadEnvFile(envPath: string = join(process.cwd(), '.env')): void {
    if (!existsSync(envPath)) return;
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed
            .slice(eqIdx + 1)
            .trim()
            .replace(/^["']|["']$/g, '');
        if (key && !(key in process.env)) {
            process.env[key] = val;
        }
    }
}
