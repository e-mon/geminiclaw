/**
 * tailscale.ts — Tailscale detection and `tailscale serve` management.
 *
 * Used by the preview server to expose workspace preview files over the tailnet
 * with automatic HTTPS via MagicDNS.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createLogger } from './logger.js';

const log = createLogger('tailscale');

const EXEC_TIMEOUT_MS = 5_000;

/** macOS Tailscale.app bundles the CLI here (not in PATH by default). */
const MACOS_TAILSCALE_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/**
 * Resolve the tailscale CLI binary path.
 *
 * 1. `tailscale` in PATH (Linux, Homebrew, or user-symlinked)
 * 2. macOS Tailscale.app bundled CLI
 */
function resolveTailscaleBin(): string | null {
    // Check PATH first
    try {
        execFileSync('tailscale', ['version'], {
            timeout: EXEC_TIMEOUT_MS,
            encoding: 'utf-8',
            stdio: 'ignore',
        });
        return 'tailscale';
    } catch {
        // Not in PATH
    }

    // macOS Tailscale.app fallback
    if (existsSync(MACOS_TAILSCALE_CLI)) {
        return MACOS_TAILSCALE_CLI;
    }

    return null;
}

/** Cached binary path — resolved once per process. */
let cachedBin: string | null | undefined;

function getTailscaleBin(): string | null {
    if (cachedBin === undefined) {
        cachedBin = resolveTailscaleBin();
        if (cachedBin && cachedBin !== 'tailscale') {
            log.info('using Tailscale CLI from app bundle', { path: cachedBin });
        }
    }
    return cachedBin;
}

export interface TailscaleInfo {
    ipv4: string;
    hostname: string | undefined;
    connected: boolean;
}

/**
 * Detect Tailscale connectivity and return network info.
 *
 * Returns null when Tailscale is not installed or not running.
 */
export function detectTailscale(): TailscaleInfo | null {
    const bin = getTailscaleBin();
    if (!bin) return null;

    let ipv4: string;
    try {
        ipv4 = execFileSync(bin, ['ip', '-4'], {
            timeout: EXEC_TIMEOUT_MS,
            encoding: 'utf-8',
        }).trim();
    } catch {
        return null;
    }

    if (!ipv4) return null;

    let hostname: string | undefined;
    try {
        const raw = execFileSync(bin, ['status', '--json'], {
            timeout: EXEC_TIMEOUT_MS,
            encoding: 'utf-8',
        });
        const status = JSON.parse(raw) as { Self?: { DNSName?: string } };
        // DNSName typically ends with a trailing dot — strip it
        const dns = status.Self?.DNSName?.replace(/\.$/, '');
        if (dns) hostname = dns;
    } catch {
        // MagicDNS hostname unavailable — ipv4 fallback still works
    }

    return { ipv4, hostname, connected: true };
}

export interface TailscaleServeResult {
    /** URL accessible from the tailnet (HTTPS via serve, or HTTP via IP fallback). */
    url: string;
    /** Whether `tailscale serve` was successfully started (needs cleanup on shutdown). */
    serving: boolean;
}

/**
 * Start `tailscale serve` for a specific path on the given local port.
 *
 * Returns the URL and whether `tailscale serve` is active. When `tailscale serve`
 * fails (e.g. not enabled on the tailnet), falls back to a direct HTTP URL via
 * the Tailscale IP — this works as long as Express binds to 0.0.0.0.
 *
 * Returns null when Tailscale is not installed or not connected.
 */
export function startTailscaleServe(port: number, path: string): TailscaleServeResult | null {
    const info = detectTailscale();
    if (!info) {
        log.warn('Tailscale not detected — preview will be localhost-only. See docs/tailscale.md for setup');
        return null;
    }

    const bin = getTailscaleBin() as string;
    try {
        execFileSync(bin, ['serve', '--bg', '--set-path', path, String(port)], {
            timeout: EXEC_TIMEOUT_MS,
            encoding: 'utf-8',
        });
        const url = info.hostname ? `https://${info.hostname}${path}` : `http://${info.ipv4}:${port}${path}`;
        return { url, serving: true };
    } catch (err) {
        log.warn(
            'tailscale serve failed — falling back to IP direct access. Enable HTTPS in tailnet for serve: docs/tailscale.md',
            { error: String(err) },
        );

        // tailscale serve not available — direct access via Tailscale IP
        return { url: `http://${info.ipv4}:${port}${path}`, serving: false };
    }
}

/**
 * Stop `tailscale serve` for a specific path. Best-effort — errors are logged
 * but never thrown.
 */
export function stopTailscaleServe(path: string): void {
    const bin = getTailscaleBin();
    if (!bin) return;

    try {
        execFileSync(bin, ['serve', 'off', '--set-path', path], {
            timeout: EXEC_TIMEOUT_MS,
            encoding: 'utf-8',
        });
        log.info('tailscale serve stopped', { path });
    } catch (err) {
        log.warn('tailscale serve off failed (non-fatal)', { path, error: String(err) });
    }
}
