/**
 * notifier.ts — Cross-platform desktop notifications.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function escapeForShell(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Send a desktop notification via macOS osascript or Linux notify-send.
 * Failures are silently ignored (non-fatal).
 */
export async function sendDesktopNotification(title: string, body: string): Promise<void> {
    try {
        if (process.platform === 'darwin') {
            await execFileAsync('osascript', [
                '-e',
                `display notification "${escapeForShell(body)}" with title "${escapeForShell(title)}"`,
            ]);
        } else {
            // Linux / WSL — notify-send (part of libnotify)
            await execFileAsync('notify-send', [title, body]);
        }
    } catch {
        // Notification failures are non-fatal
    }
}
