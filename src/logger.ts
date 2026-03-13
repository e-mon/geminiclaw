/**
 * logger.ts — Lightweight structured logger for daemon mode.
 *
 * Format mirrors the Inngest dev server:
 *   [HH:MM:SS.mmm] LVL [component] message key="value" key=number
 *
 * Writes to stderr so stdout stays clean for piped output.
 */

type Level = 'INF' | 'WRN' | 'ERR';
type Fields = Record<string, string | number | boolean | undefined | null>;

/**
 * When true, all log output is suppressed.
 * Used by the TUI to prevent stderr writes from corrupting the alternate screen.
 */
let suppressed = false;

export function suppressLogs(value: boolean): void {
    suppressed = value;
}

/** Timezone-aware time string. Respects TIMEZONE env (IANA format). */
function currentTime(): string {
    const tz = process.env.TIMEZONE || undefined;
    const n = new Date();
    try {
        // Intl produces "HH:MM:SS" — append milliseconds manually
        const base = n.toLocaleTimeString('en-GB', { hour12: false, timeZone: tz });
        const ms = String(n.getMilliseconds()).padStart(3, '0');
        return `${base}.${ms}`;
    } catch {
        // Invalid timezone — fall back to UTC
        return n.toISOString().substring(11, 23);
    }
}

function serializeFields(fields: Fields): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === null) continue;
        parts.push(typeof v === 'string' ? `${k}="${v}"` : `${k}=${v}`);
    }
    return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function write(level: Level, component: string, msg: string, fields?: Fields): void {
    if (suppressed) return;
    const fieldStr = fields ? serializeFields(fields) : '';
    process.stderr.write(`[${currentTime()}] ${level} [${component}] ${msg}${fieldStr}\n`);
}

export interface Logger {
    info: (msg: string, fields?: Fields) => void;
    warn: (msg: string, fields?: Fields) => void;
    error: (msg: string, fields?: Fields) => void;
}

/**
 * Create a logger bound to a specific component name.
 * The component name appears in brackets, e.g. [discord], [agent-run].
 */
export function createLogger(component: string): Logger {
    return {
        info: (msg, fields) => write('INF', component, msg, fields),
        warn: (msg, fields) => write('WRN', component, msg, fields),
        error: (msg, fields) => write('ERR', component, msg, fields),
    };
}
