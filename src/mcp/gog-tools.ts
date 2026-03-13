/**
 * mcp/gog-tools.ts — Tool definitions for the gog MCP server.
 *
 * Each entry maps an MCP tool name to its gog CLI subcommand,
 * input schema, tool effect classification, and argument builder.
 */

import type { ToolEffect } from './tool-effect.js';

export interface GogToolDef {
    name: string;
    description: string;
    inputSchema: object;
    effect: ToolEffect;
    /** gog subcommand segments, e.g. ['gmail', 'search'] */
    command: string[];
    /** Convert MCP params → gog CLI args (excluding --json --no-input --account) */
    buildArgs: (params: Record<string, unknown>) => string[];
}

// ── Helpers ──────────────────────────────────────────────────────

function str(v: unknown): string {
    return String(v ?? '');
}

function optFlag(params: Record<string, unknown>, key: string, flag: string): string[] {
    const v = params[key];
    if (v === undefined || v === null || v === '') return [];
    return [flag, str(v)];
}

// ── Tool definitions ─────────────────────────────────────────────

export const GOG_TOOLS: GogToolDef[] = [
    // ── Gmail ────────────────────────────────────────────────────
    {
        name: 'gog_gmail_search',
        description:
            'Search Gmail threads. Returns one row per conversation thread. ' +
            'Use gog_gmail_messages_search for per-message results.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Gmail search query (e.g. "newer_than:2h is:unread")' },
                max: { type: 'number', description: 'Max results (default 10)' },
            },
            required: ['query'],
        },
        effect: 'read',
        command: ['gmail', 'search'],
        buildArgs: (p) => [str(p.query), ...optFlag(p, 'max', '--max')],
    },
    {
        name: 'gog_gmail_messages_search',
        description: 'Search Gmail messages individually (ignores threading). ' + 'Returns one row per email.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Gmail search query' },
                max: { type: 'number', description: 'Max results (default 20)' },
            },
            required: ['query'],
        },
        effect: 'read',
        command: ['gmail', 'messages', 'search'],
        buildArgs: (p) => [str(p.query), ...optFlag(p, 'max', '--max')],
    },
    {
        name: 'gog_gmail_send',
        description: 'Send an email via Gmail. Requires user confirmation before execution.',
        inputSchema: {
            type: 'object',
            properties: {
                to: { type: 'string', description: 'Recipient email address' },
                subject: { type: 'string', description: 'Email subject' },
                body: { type: 'string', description: 'Plain text body' },
                bodyHtml: { type: 'string', description: 'HTML body (alternative to body)' },
                replyToMessageId: { type: 'string', description: 'Message ID to reply to' },
                cc: { type: 'string', description: 'CC recipients (comma-separated)' },
                bcc: { type: 'string', description: 'BCC recipients (comma-separated)' },
            },
            required: ['to', 'subject'],
        },
        effect: 'elevated',
        command: ['gmail', 'send'],
        buildArgs: (p) => [
            '--to',
            str(p.to),
            '--subject',
            str(p.subject),
            ...(p.bodyHtml ? ['--body-html', str(p.bodyHtml)] : p.body ? ['--body', str(p.body)] : []),
            ...optFlag(p, 'replyToMessageId', '--reply-to-message-id'),
            ...optFlag(p, 'cc', '--cc'),
            ...optFlag(p, 'bcc', '--bcc'),
        ],
    },
    {
        name: 'gog_gmail_drafts_create',
        description: 'Create a Gmail draft.',
        inputSchema: {
            type: 'object',
            properties: {
                to: { type: 'string', description: 'Recipient email address' },
                subject: { type: 'string', description: 'Email subject' },
                body: { type: 'string', description: 'Plain text body' },
                bodyHtml: { type: 'string', description: 'HTML body (alternative to body)' },
            },
            required: ['to', 'subject'],
        },
        effect: 'write',
        command: ['gmail', 'drafts', 'create'],
        buildArgs: (p) => [
            '--to',
            str(p.to),
            '--subject',
            str(p.subject),
            ...(p.bodyHtml ? ['--body-html', str(p.bodyHtml)] : p.body ? ['--body', str(p.body)] : []),
        ],
    },
    {
        name: 'gog_gmail_drafts_send',
        description: 'Send an existing Gmail draft. Requires user confirmation.',
        inputSchema: {
            type: 'object',
            properties: {
                draftId: { type: 'string', description: 'Draft ID to send' },
            },
            required: ['draftId'],
        },
        effect: 'elevated',
        command: ['gmail', 'drafts', 'send'],
        buildArgs: (p) => [str(p.draftId)],
    },

    {
        name: 'gog_gmail_thread_modify',
        description:
            'Modify labels on a Gmail thread. ' +
            'Common uses: archive (remove INBOX), trash (add TRASH), mark read (remove UNREAD), mark unread (add UNREAD). ' +
            'Requires user confirmation.',
        inputSchema: {
            type: 'object',
            properties: {
                threadId: { type: 'string', description: 'Thread ID to modify' },
                add: { type: 'string', description: 'Labels to add (comma-separated, e.g. "TRASH,STARRED")' },
                remove: {
                    type: 'string',
                    description: 'Labels to remove (comma-separated, e.g. "INBOX,UNREAD")',
                },
            },
            required: ['threadId'],
        },
        effect: 'elevated',
        command: ['gmail', 'thread', 'modify'],
        buildArgs: (p) => [str(p.threadId), ...optFlag(p, 'add', '--add'), ...optFlag(p, 'remove', '--remove')],
    },

    // ── Calendar ─────────────────────────────────────────────────
    {
        name: 'gog_calendar_events',
        description: 'List calendar events for a date range.',
        inputSchema: {
            type: 'object',
            properties: {
                calendarId: { type: 'string', description: 'Calendar ID (default: "primary")' },
                from: { type: 'string', description: 'Start date/time (ISO 8601)' },
                to: { type: 'string', description: 'End date/time (ISO 8601)' },
            },
            required: [],
        },
        effect: 'read',
        command: ['calendar', 'events'],
        buildArgs: (p) => [
            str(p.calendarId || 'primary'),
            ...optFlag(p, 'from', '--from'),
            ...optFlag(p, 'to', '--to'),
        ],
    },
    {
        name: 'gog_calendar_create',
        description: 'Create a calendar event. Supports recurring events via rrule.',
        inputSchema: {
            type: 'object',
            properties: {
                calendarId: { type: 'string', description: 'Calendar ID (default: "primary")' },
                summary: { type: 'string', description: 'Event title' },
                from: { type: 'string', description: 'Start date/time (ISO 8601)' },
                to: { type: 'string', description: 'End date/time (ISO 8601)' },
                allDay: { type: 'boolean', description: 'All-day event (use date-only in from/to)' },
                rrule: {
                    type: 'string',
                    description:
                        'Recurrence rule (e.g. "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR", ' +
                        '"RRULE:FREQ=MONTHLY;BYMONTHDAY=11"). Multiple rules comma-separated.',
                },
                attendees: { type: 'string', description: 'Comma-separated attendee emails' },
                reminder: {
                    type: 'string',
                    description:
                        'Custom reminders as method:duration (e.g. "popup:30m", "email:1d"). Comma-separated, max 5.',
                },
                eventColor: { type: 'string', description: 'Event color ID (1-11)' },
                location: { type: 'string', description: 'Event location' },
                description: { type: 'string', description: 'Event description' },
                visibility: { type: 'string', description: 'Event visibility: default, public, private, confidential' },
                transparency: { type: 'string', description: 'Show as busy (opaque) or free (transparent)' },
            },
            required: ['summary', 'from', 'to'],
        },
        effect: 'write',
        command: ['calendar', 'create'],
        buildArgs: (p) => [
            str(p.calendarId || 'primary'),
            '--summary',
            str(p.summary),
            '--from',
            str(p.from),
            '--to',
            str(p.to),
            ...(p.allDay ? ['--all-day'] : []),
            ...optFlag(p, 'rrule', '--rrule'),
            ...optFlag(p, 'attendees', '--attendees'),
            ...optFlag(p, 'reminder', '--reminder'),
            ...optFlag(p, 'eventColor', '--event-color'),
            ...optFlag(p, 'location', '--location'),
            ...optFlag(p, 'description', '--description'),
            ...optFlag(p, 'visibility', '--visibility'),
            ...optFlag(p, 'transparency', '--transparency'),
        ],
    },
    {
        name: 'gog_calendar_update',
        description:
            'Update an existing calendar event. For recurring events, use scope to control which instances to update.',
        inputSchema: {
            type: 'object',
            properties: {
                calendarId: { type: 'string', description: 'Calendar ID (default: "primary")' },
                eventId: { type: 'string', description: 'Event ID to update' },
                summary: { type: 'string', description: 'New event title' },
                from: { type: 'string', description: 'New start date/time (ISO 8601)' },
                to: { type: 'string', description: 'New end date/time (ISO 8601)' },
                allDay: { type: 'boolean', description: 'All-day event (use date-only in from/to)' },
                rrule: {
                    type: 'string',
                    description: 'Recurrence rule (e.g. "RRULE:FREQ=WEEKLY;BYDAY=MO"). Set empty to clear recurrence.',
                },
                attendees: {
                    type: 'string',
                    description: 'Comma-separated attendee emails (replaces all; set empty to clear)',
                },
                addAttendee: {
                    type: 'string',
                    description: 'Comma-separated attendee emails to add (preserves existing)',
                },
                reminder: {
                    type: 'string',
                    description: 'Custom reminders as method:duration (e.g. "popup:30m"). Set empty to clear.',
                },
                eventColor: { type: 'string', description: 'Event color ID (1-11)' },
                location: { type: 'string', description: 'Event location' },
                description: { type: 'string', description: 'Event description' },
                visibility: { type: 'string', description: 'Event visibility: default, public, private, confidential' },
                transparency: { type: 'string', description: 'Show as busy (opaque) or free (transparent)' },
                scope: { type: 'string', description: 'For recurring events: single, future, or all (default: all)' },
                originalStart: {
                    type: 'string',
                    description: 'Original start time of instance (required for scope=single or scope=future)',
                },
            },
            required: ['eventId'],
        },
        effect: 'write',
        command: ['calendar', 'update'],
        buildArgs: (p) => [
            str(p.calendarId || 'primary'),
            str(p.eventId),
            ...optFlag(p, 'summary', '--summary'),
            ...optFlag(p, 'from', '--from'),
            ...optFlag(p, 'to', '--to'),
            ...(p.allDay ? ['--all-day'] : []),
            ...optFlag(p, 'rrule', '--rrule'),
            ...optFlag(p, 'attendees', '--attendees'),
            ...optFlag(p, 'addAttendee', '--add-attendee'),
            ...optFlag(p, 'reminder', '--reminder'),
            ...optFlag(p, 'eventColor', '--event-color'),
            ...optFlag(p, 'location', '--location'),
            ...optFlag(p, 'description', '--description'),
            ...optFlag(p, 'visibility', '--visibility'),
            ...optFlag(p, 'transparency', '--transparency'),
            ...optFlag(p, 'scope', '--scope'),
            ...optFlag(p, 'originalStart', '--original-start'),
        ],
    },

    // ── Drive ────────────────────────────────────────────────────
    {
        name: 'gog_drive_search',
        description: 'Search Google Drive files.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Drive search query' },
                max: { type: 'number', description: 'Max results (default 10)' },
            },
            required: ['query'],
        },
        effect: 'read',
        command: ['drive', 'search'],
        buildArgs: (p) => [str(p.query), ...optFlag(p, 'max', '--max')],
    },

    // ── Contacts ─────────────────────────────────────────────────
    {
        name: 'gog_contacts_list',
        description: 'List Google Contacts.',
        inputSchema: {
            type: 'object',
            properties: {
                max: { type: 'number', description: 'Max results (default 20)' },
            },
            required: [],
        },
        effect: 'read',
        command: ['contacts', 'list'],
        buildArgs: (p) => [...optFlag(p, 'max', '--max')],
    },

    // ── Sheets ───────────────────────────────────────────────────
    {
        name: 'gog_sheets_get',
        description: 'Read data from a Google Sheets range.',
        inputSchema: {
            type: 'object',
            properties: {
                sheetId: { type: 'string', description: 'Spreadsheet ID' },
                range: { type: 'string', description: 'Cell range (e.g. "Sheet1!A1:D10")' },
            },
            required: ['sheetId', 'range'],
        },
        effect: 'read',
        command: ['sheets', 'get'],
        buildArgs: (p) => [str(p.sheetId), str(p.range)],
    },
    {
        name: 'gog_sheets_update',
        description: 'Update data in a Google Sheets range.',
        inputSchema: {
            type: 'object',
            properties: {
                sheetId: { type: 'string', description: 'Spreadsheet ID' },
                range: { type: 'string', description: 'Cell range (e.g. "Sheet1!A1:B2")' },
                valuesJson: { type: 'string', description: 'JSON array of rows (e.g. \'[["A","B"],["1","2"]]\')' },
                input: {
                    type: 'string',
                    description: 'Value input option (RAW or USER_ENTERED, default USER_ENTERED)',
                },
            },
            required: ['sheetId', 'range', 'valuesJson'],
        },
        effect: 'write',
        command: ['sheets', 'update'],
        buildArgs: (p) => [
            str(p.sheetId),
            str(p.range),
            '--values-json',
            str(p.valuesJson),
            ...optFlag(p, 'input', '--input'),
        ],
    },

    // ── Docs ─────────────────────────────────────────────────────
    {
        name: 'gog_docs_cat',
        description: 'Output the text content of a Google Doc.',
        inputSchema: {
            type: 'object',
            properties: {
                docId: { type: 'string', description: 'Google Doc ID' },
            },
            required: ['docId'],
        },
        effect: 'read',
        command: ['docs', 'cat'],
        buildArgs: (p) => [str(p.docId)],
    },
];

/** Lookup table by tool name for fast access. */
export const GOG_TOOLS_MAP = new Map(GOG_TOOLS.map((t) => [t.name, t]));
