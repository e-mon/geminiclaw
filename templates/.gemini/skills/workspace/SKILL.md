---
name: workspace
description: Create session working directories. Provision directories under runs/ when file output is needed.
enabled: true
---

# Workspace — Session Working Directory

When file creation or saving is needed, output to a session-specific directory under `runs/` instead of cluttering the workspace root.

## Trigger Patterns

Use this skill **autonomously** when the following apply:
- File creation or saving is needed (HTML, CSV, reports, images, etc.)
- User requests "write to a file", "create a report", etc.

**Exceptions — edit directly in the workspace root:**
- `MEMORY.md`, `memory/*.md` — Long-term memory / daily logs
- `cron/jobs.json` — Scheduled jobs
- `.gemini/skills/*/SKILL.md` — Skill definitions

## Procedure

1. Identify the session ID (refer to `Session ID` in Runtime Directives)
2. Create the `runs/{sessionId}/` directory (use the existing one if it already exists)
3. All subsequent file output goes inside this directory
4. When sending files to the user, specify the `MEDIA:` path as a relative path from the workspace root

## Path Examples

```
runs/discord-general-123456/report.csv
runs/discord-general-123456/chart.png
runs/manual/analysis.html
```

## MEDIA: Path

```
MEDIA:runs/discord-general-123456/report.csv
```

## Notes

- Do not change the cwd from the workspace root
- Use the session ID as-is for the directory name (no date needed)
- When creating multiple files in the same session, place them all in the same directory
