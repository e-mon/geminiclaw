---
name: gog
description: Google Workspace MCP tools for Gmail, Calendar, Drive, Contacts, Sheets, and Docs.
enabled: true
---

# gog — Google Workspace MCP Tools

Interact with Gmail, Calendar, Drive, Contacts, Sheets, and Docs via MCP tools.
Tools are automatically available when gog CLI is installed on the host machine.

## Setup (once, host machine)

1. Install gog CLI: `brew install steipete/tap/gogcli`
2. Register OAuth credentials: `gog auth credentials /path/to/client_secret.json`
3. Authorize account: `gog auth add you@gmail.com --services gmail,calendar,drive,contacts,docs,sheets`
4. Set account in config: `~/.geminiclaw/config.json` → `"gogAccount": "you@gmail.com"`
5. Re-initialize: `geminiclaw init`

## Available MCP Tools

### Gmail
| Tool | Description | Side Effect |
|---|---|---|
| `gog_gmail_search` | Search threads (query, max) | read |
| `gog_gmail_messages_search` | Search individual messages (query, max) | read |
| `gog_gmail_send` | Send email (to, subject, body/bodyHtml, cc, bcc, replyToMessageId) | **send** (requires confirmation) |
| `gog_gmail_drafts_create` | Create draft (to, subject, body/bodyHtml) | write |
| `gog_gmail_drafts_send` | Send existing draft (draftId) | **send** (requires confirmation) |
| `gog_gmail_thread_modify` | Modify labels on a thread (threadId, add, remove). Archive=remove INBOX, trash=add TRASH, mark read=remove UNREAD | **send** (requires confirmation) |

### Calendar
| Tool | Description | Side Effect |
|---|---|---|
| `gog_calendar_events` | List events (calendarId, from, to) | read |
| `gog_calendar_create` | Create event (calendarId, summary, from, to, eventColor, location, description) | write |
| `gog_calendar_update` | Update event (calendarId, eventId, summary, from, to, eventColor) | write |

### Drive & Contacts
| Tool | Description | Side Effect |
|---|---|---|
| `gog_drive_search` | Search files (query, max) | read |
| `gog_contacts_list` | List contacts (max) | read |

### Sheets & Docs
| Tool | Description | Side Effect |
|---|---|---|
| `gog_sheets_get` | Read range (sheetId, range) | read |
| `gog_sheets_update` | Update range (sheetId, range, valuesJson, input) | write |
| `gog_docs_cat` | Read doc text (docId) | read |

## Side Effect Classification

- **read**: No confirmation needed. Read-only operations.
- **write**: No confirmation needed. Creates/modifies data but is non-destructive.
- **send**: Requires user confirmation before execution. Sends messages externally.

## Calendar Colors

Use `eventColor` parameter with IDs 1-11:
- 1: #a4bdfc, 2: #7ae7bf, 3: #dbadff, 4: #ff887c, 5: #fbd75b
- 6: #ffb878, 7: #46d6db, 8: #e1e1e1, 9: #5484ed, 10: #51b749, 11: #dc2127

## Email Formatting

- Prefer plain text (`body` parameter).
- Use `bodyHtml` only when rich formatting is needed.
- HTML tags: `<p>`, `<br>`, `<strong>`, `<em>`, `<a>`, `<ul>`/`<li>`.

## Notes

- All tools automatically use `--json --no-input` flags.
- Account is set via `GOG_ACCOUNT` environment variable (from `gogAccount` config).
- If gog CLI is not installed, tools are simply not exposed (no error).
- Audit log: All tool calls are recorded in `memory/audit.jsonl`.
