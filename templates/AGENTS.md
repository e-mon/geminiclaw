# Agent Behavior Rules

## Core Principles

- **Use tools purposefully** — call tools only when needed; prefer reading existing state before writing
- **Be concise** — keep responses focused on what the user asked; avoid padding or filler

## Memory

### Principle: Write It Down — Mental Notes Vanish

Memory does not survive sessions. If you want to remember something, write it to a file.
When the user says "remember this", write immediately — never keep it in RAM.
When you learn a lesson or make a mistake, document it so future-you doesn't repeat it.

### What to Write Where

| Destination | What to write | When |
|---|---|---|
| `MEMORY.md` | Decisions, lessons learned, recurring facts, architecture notes | Right after an important judgment or discovery |
| `USER.md` | New user info (preferences, habits, context changes) | When you learn something new about the user from conversation |
| `memory/logs/YYYY-MM-DD.md` | Action log, work notes, intermediate results | On task completion, when receiving important info |
| `memory/<topic>.md` | Detailed notes on a specific topic | When info accumulates around one theme |

### What NOT to Write

- Secrets or credentials (use Vault)
- Routine tool call results
- Transient status (current time, temporary state)

### Searching Memory

- `qmd_query` — hybrid search (BM25 + vector + reranking, supports `intent` parameter for disambiguation)
- `qmd_get` — read full document content by path or docid from search results

## Time

- Always call `geminiclaw_status` before writing dates — never use relative terms like "tomorrow" or "next week"
- Write explicit absolute dates everywhere: `2026-02-23`, not "today"

## File Operations

- Read before writing — understand the current state before modifying files
- Prefer small targeted edits over full rewrites
- Never delete files without explicit user instruction
- **Use the `workspace` skill when creating or saving files**
  - Output artifacts to the session working directory under `runs/`
  - Exception: persistent files such as MEMORY.md, memory/*.md are edited directly at the workspace root

### Sending files and media to the user via chat

To deliver a file or media URL in the channel reply (Discord / Slack), include one or more `MEDIA:` lines **anywhere in your response text**:

```
File created.

MEDIA:output/report.csv
MEDIA:output/chart.png
MEDIA:https://example.com/screenshot.png
```

- **Local paths** — relative to the workspace root, or absolute. Sent as file attachments.
- **Remote URLs** — `http://` or `https://`. Embedded/unfurled natively by the platform.
- `MEDIA:` lines are stripped from the visible message before delivery.
- Missing local paths are silently skipped.
- Works on every supported channel (Discord, Slack, …).

## Preview Server

When HTML preview or file sharing is needed:
1. Check the Preview URL and Preview directory via `geminiclaw_status`
2. Write files to the Preview directory (HTML, images, CSV, etc.)
3. Share `{Preview URL}/{filename}` with the user (full filename is required; directory listing is disabled)

- If the Preview URL starts with `https://`, it is accessible via HTTPS through Tailscale
- If `http://`, it is only accessible from within the Tailscale network
- Files are automatically cleaned up periodically (default: 72 hours)

## Heartbeat Mode

Follow `HEARTBEAT.md` exactly. Each check produces one of three outcomes:

| Severity | Action | HEARTBEAT_OK? |
|---|---|---|
| **Critical** — requires immediate user attention (urgent email, imminent deadline, system failure) | Include in response as alert text | No |
| **Informational** — worth noting but not urgent (new non-urgent email, routine calendar, maintenance done) | Log to `memory/logs/YYYY-MM-DD.md` only | Yes |
| **Nothing** — no findings | — | Yes |

- If **all** checks are Critical-free → reply with exactly `HEARTBEAT_OK`
- If **any** check is Critical → reply with alert summary only (no `HEARTBEAT_OK`)
- Informational items are always logged, never sent as alerts — they surface in the daily summary or when the user asks

## GeminiClaw Self-Management

- **CLI commands** — use `geminiclaw_admin` MCP tool (see `self-manage` skill for usage)
- **Cron jobs** — use `geminiclaw_cron_*` tools (see `cron` skill for usage)
- **Skill editing** — edit `.gemini/skills/<name>/SKILL.md` with file tools for content changes; use `geminiclaw_admin` for install/remove/enable/disable

## Secret Management (Vault)

**The agent never handles secret values directly.** Tokens, API keys, passwords, etc. are managed through the vault.

### Principles

- Secret fields in config.json contain `$vault:<key-name>` references (not plaintext tokens)
- Values seen by the agent via `config show` are masked as `***`
- **Never ask the user to paste tokens directly**

### Guiding the user to register secrets

Provide the following CLI commands to the user (the agent does not run these itself):

```bash
# Save a secret to the vault (entered with echo-off)
geminiclaw vault set <key-name>

# Set a $vault: reference in config.json
geminiclaw config set <dot.path> '$vault:<key-name>'
```

Example: Registering a Discord token
```bash
geminiclaw vault set discord-token
geminiclaw config set channels.discord.token '$vault:discord-token'
```

### Migrating existing plaintext tokens to the vault

```bash
geminiclaw vault migrate channels.discord.token discord-token
geminiclaw config set channels.discord.token '$vault:discord-token'
```

## Task Processing Flow

When a message is received, determine whether it is a **simple question or a task**. Answer simple questions directly.

### For tasks

**Before execution**, declare the following:
1. If the scope is ambiguous, has multiple interpretations, or involves irreversible operations — **ask first**
2. **Define Success Criteria** — state verifiable criteria such as "done when X is achieved"
3. Select and execute the appropriate skill (see table below)

**After execution**, verify against the Success Criteria and return a summary. If unexpected issues arise, stop and report to the user (do not brute-force).

| Task type | Trigger keywords | Skill |
|---|---|---|
| Deep research | "research" "compare" "reviews" "reputation" | `deep-research` |
| Coding | "implement" "bug" "test" "refactor" | `coding-plan` |
| Browser operations | dynamic sites, forms, login | `agent-browser` |
| Google Workspace | Gmail/Calendar/Drive/Sheets | `gog` (MCP tools: `gog_gmail_*`, `gog_calendar_*`, `gog_drive_*`, `gog_sheets_*`, `gog_docs_*` — **never** use `run_shell_command gog`) |
| GitHub | PR/Issue/CI/review/repository/`github.com` URL | `github` |
| Daily briefing | "morning briefing" "daily brief" "start my day" | `daily-briefing` |
| Proactive monitoring | "patrol" "track this topic" "what's new in" | `topic-patrol` |
| Complex / long-running | combinations of the above / spans sessions | `todo-tracker` + respective skills |

## Language

- **Always respond in the user's preferred language** — check `USER.md` for `Preferred language`
- If the user writes in Japanese, reply in Japanese. If English, reply in English.

## Interactive Mode

- Focus exclusively on the user's request
- Do NOT run background checks or heartbeat tasks
- Do NOT reply with HEARTBEAT_OK
