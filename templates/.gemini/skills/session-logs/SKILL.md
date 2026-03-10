---
name: session-logs
description: Search and analyze past session logs. Use when the user says things like "in the previous conversation..." or "I did something before...", or when investigating cost and tool usage.
enabled: true
---

# session-logs

A skill for searching and analyzing GeminiClaw session history.
Operates using `jq` and `rg` (ripgrep) via `run_shell_command`.

## File Structure

Sessions are stored in JSONL format, with on-demand LLM-generated summaries:

### JSONL (structured data)
Location: `{workspace}/memory/sessions/<sessionId>.jsonl`

One entry per line, structure:
```json
{
  "runId": "uuid",
  "timestamp": "2026-02-23T12:34:56.789Z",
  "trigger": "manual" | "heartbeat",
  "responseText": "Agent response text",
  "toolCalls": [
    {"name": "tool_name", "args": {...}, "result": "...", "status": "success" | "error"}
  ],
  "heartbeatOk": false,
  "tokens": {"total": 12345, "input": 12000, "output": 345}
}
```

### Summaries (LLM-generated, Obsidian-optimized)
Location: `{workspace}/memory/summaries/YYYY-MM-DD-<slug>.md`

Auto-generated when a session goes idle, or manually via `geminiclaw session summary <sessionId>`.
Contains YAML frontmatter (date, tags, tokens), TL;DR, key decisions, and full conversation log.

## Common Queries

### List sessions (sorted by date)
```bash
ls -lt {workspace}/memory/sessions/*.jsonl | head -20
```

### Search sessions for a specific date
```bash
ls {workspace}/memory/sessions/*.jsonl | xargs grep -l "2026-02-23"
```

### Keyword search in response text
```bash
jq -r '.responseText' {workspace}/memory/sessions/*.jsonl | rg -i "keyword"
```

### Find sessions where a specific tool was called
```bash
jq -r 'select(.toolCalls[].name == "browser_navigate") | .timestamp + " " + .runId' {workspace}/memory/sessions/*.jsonl
```

### Total token usage across sessions
```bash
jq -s '[.[].tokens.total] | add' {workspace}/memory/sessions/*.jsonl
```

### Daily token usage
```bash
jq -r '"" + .timestamp[:10] + " " + (.tokens.total | tostring)' {workspace}/memory/sessions/*.jsonl \
  | awk '{a[$1]+=$2} END {for(d in a) print d, a[d]}' | sort -r
```

### Tool usage frequency ranking
```bash
jq -r '.toolCalls[].name' {workspace}/memory/sessions/*.jsonl | sort | uniq -c | sort -rn | head -20
```

### Sessions with the most errors
```bash
jq '{runId, timestamp, errors: [.toolCalls[] | select(.status == "error")] | length}' \
  {workspace}/memory/sessions/*.jsonl | jq -s 'sort_by(-.errors) | .[:10][]'
```

### Summary of the last N sessions
```bash
ls -t {workspace}/memory/sessions/*.jsonl | head -5 | xargs -I{} sh -c \
  'echo "=== {} ===" && jq "{timestamp, trigger, tokens, tools: [.toolCalls[].name]}" {}'
```

## Searching Summaries

```bash
# Search all summaries by keyword
rg -i "keyword" {workspace}/memory/summaries/

# List summaries for a specific date
ls {workspace}/memory/summaries/2026-02-23-*.md

# Search by tag in frontmatter
rg "topic/memory" {workspace}/memory/summaries/
```

## Finding the Workspace Path

`{workspace}` can be found via the `geminiclaw_status` tool or in the "Workspace" section of GEMINI.md.

## Tips

- The first line of a JSONL file may be `null` — filter with `select(. != null)` in `jq`
- Summaries are auto-generated on session idle; use `geminiclaw session summary <id>` for manual generation
- Summaries are Obsidian-compatible with YAML frontmatter and tags
