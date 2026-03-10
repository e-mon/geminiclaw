/**
 * preview.ts — Preview directory management and cleanup.
 *
 * The preview directory holds files that the agent wants to serve over HTTP
 * (HTML reports, images, etc.). Files are served by Express static middleware
 * and optionally exposed to the tailnet via `tailscale serve`.
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('preview');

/**
 * Get (and lazily create) the preview directory under the workspace.
 */
export function getPreviewDir(workspacePath: string): string {
    const dir = join(workspacePath, 'preview');
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    return dir;
}

/**
 * Delete preview files older than `maxAgeHours`.
 *
 * Returns the number of files deleted.
 */
export function cleanupOldPreviews(previewDir: string, maxAgeHours: number): number {
    if (!existsSync(previewDir)) return 0;

    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const now = Date.now();
    let deleted = 0;

    for (const entry of readdirSync(previewDir)) {
        const filePath = join(previewDir, entry);
        try {
            const stat = statSync(filePath);
            if (!stat.isFile()) continue;
            if (now - stat.mtimeMs > maxAgeMs) {
                unlinkSync(filePath);
                deleted++;
            }
        } catch {
            // Skip files that can't be stat'd or deleted
        }
    }

    if (deleted > 0) {
        log.info('cleaned up old preview files', { deleted });
    }
    return deleted;
}

export interface PreviewInfo {
    baseUrl: string;
    previewDir: string;
}

/**
 * Write preview-info.json so MCP status and agents can discover the preview URL.
 */
export function writePreviewInfo(workspacePath: string, baseUrl: string, previewDir: string): void {
    const info: PreviewInfo = { baseUrl, previewDir };
    const infoPath = join(workspacePath, 'memory', 'preview-info.json');
    writeFileSync(infoPath, JSON.stringify(info, null, 2), 'utf-8');
    log.info('preview info written', { path: infoPath, baseUrl });
}
