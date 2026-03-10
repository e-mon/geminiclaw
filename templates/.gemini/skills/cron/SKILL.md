---
name: cron
description: Job scheduling. Manage recurring tasks using MCP tools.
enabled: true
---

# Cron Job Scheduler

Manage scheduled jobs using MCP tools (`geminiclaw_cron_add` / `geminiclaw_cron_list` / `geminiclaw_cron_remove`).
**Do not directly edit `cron/jobs.json` with file tools. Always operate through MCP tools.**

## Trigger Patterns

Use this skill **autonomously** when the following apply:
- User requests a recurring task such as "every morning at 9" or "every 30 minutes"
- User requests a one-time scheduled task such as "tomorrow at 2pm"
- User requests viewing, modifying, or deleting existing jobs

## MCP Tools

### `geminiclaw_cron_add` — Register a Job

Parameters:
- `id` (required): Unique job ID (prefer `job-` + short description)
- `name` (required): Human-readable name
- `schedule` (required): Schedule object (see below)
- `prompt` (required): Self-contained prompt (see below)
- `timezone`: IANA timezone (e.g., `Asia/Tokyo`)
- `reply`: Reply destination `{ channel: "discord"|"slack", channelId: "..." }`

`nextRunAt` and `createdAt` are set automatically by the tool.

### `geminiclaw_cron_list` — List Jobs

No parameters. Returns details of all jobs.

### `geminiclaw_cron_remove` — Delete a Job

Parameters:
- `id` (required): ID of the job to delete

## Schedule Types

### `at` — One-time

```json
{ "type": "at", "datetime": "2026-03-01T09:00:00+09:00" }
```
Sets `enabled: false` after execution.

### `every` — Fixed Interval (minutes)

```json
{ "type": "every", "intervalMin": 60 }
```
Runs every 60 minutes.

### `cron` — Cron Expression

```json
{ "type": "cron", "expression": "0 9 * * *" }
```
Standard 5-field cron expression. Use in combination with `timezone`.

## Job Registration Procedure

1. Check the current time with `geminiclaw_status`
2. Check existing jobs with `geminiclaw_cron_list`
3. **Write a self-contained prompt** (see below)
4. **Record background information in MEMORY.md** (see below)
5. **Present the registration details to the user via `geminiclaw_ask_user` and get confirmation**:
   ```
   I'd like to register the following job. Does this look correct?

   - Name: {name}
   - Schedule: {human-readable description of schedule}
   - Prompt: {beginning or full text of prompt}
   - Timezone: {timezone}
   - Reply to: {description of reply or "default"}

   Reply "OK" to proceed, or let me know if anything needs to be changed.
   ```
   If modifications are requested, update the relevant parts and re-present.
6. After approval, register with `geminiclaw_cron_add`

### Write Self-Contained Prompts

The agent executing a cron job **has no knowledge of the original conversation**.
Include all information needed for execution in the prompt.

Bad example (context is lost):
```
"Check on that Cloudflare thing we discussed earlier"
```

Good example (self-contained):
```
"Check the stock price of Cloudflare (NET).
Background: The goal is to verify the support line near $150.
Check: current price, volume (vs recent average), whether the $150 support holds.
Report results to the Discord channel (ID: 123456789012345678)."
```

### Record Background Information in MEMORY.md

Write background, decision criteria, and context that don't fit in the prompt to MEMORY.md.
The original conversation is preserved in the daily log but expires after 2 days, so always record important information here.

Examples of what to record:
- Why this job was created (rationale for decisions, conditions to monitor)
- Thresholds and decision criteria (e.g., "flag if volume exceeds 1.5x the average")
- Relationships with other jobs if applicable

Example entry:
```markdown
## Cron Jobs

### Cloudflare (NET) Monitoring — Registered: 2026-02-24
Purpose: Entry decision near the $150 support line.
Criteria: Support holds + volume increasing → consider buying. No volume → pass.
Registered jobs: cloudflare-check-open / cloudflare-analysis / cloudflare-final-decision
```

## Reply Field

Sends results to a Discord/Slack channel after job completion.
**Set this to the channel ID of the conversation where the user made the request.**
If not set, falls back to the default channel from system settings.

## Notes

- Do not directly edit `cron/jobs.json`. Always use `geminiclaw_cron_*` tools.
- `schedule` must always be set as an object (strings are not accepted).
- Dates should be in ISO 8601 format, preferably with a timezone offset.
- The poller runs at 1-minute intervals, so second-level precision is not guaranteed.
