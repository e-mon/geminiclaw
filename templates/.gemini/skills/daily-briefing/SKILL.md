---
name: daily-briefing
description: Generate a prioritized daily briefing with calendar, email, tasks, and yesterday's activity. Designed for cron execution. Trigger with "morning briefing", "daily brief", "start my day".
enabled: true
---

# Daily Briefing

Generate a concise, prioritized daily briefing. Works standalone with core GeminiClaw tools and gracefully skips unavailable data sources.

## Execution Flow

```
1. Gather   → Pull data from available sources (parallel)
2. Analyze  → Prioritize and detect conflicts/urgencies
3. Format   → Produce scannable briefing
4. Deliver  → Output as reply text
```

## Phase 1: Gather Data

Call `geminiclaw_status` first to confirm the current date and time.
Execute available data sources **in parallel**. Skip any source whose tool is not available — do not error.

### 1.1 Calendar (Today)

Tool: `gog_calendar_events`
- `calendarId`: `primary`
- `from` / `to`: today (full day, local timezone)

Extract: event summary, time, location, attendees, meet link.

### 1.2 Email (Unread, Last 24h)

Tool: `gog_gmail_search`
- `query`: `newer_than:1d is:unread`
- `max`: `15`

Extract: sender, subject, snippet, date.
Classify: **Needs Response** (from a person, expects reply) vs **FYI** (notifications, newsletters).

### 1.3 Tasks & TODOs

Read: `MEMORY.md` — look for TODO, task, or reminder sections.
Read: `cron/jobs.json` — list active cron jobs for awareness.

### 1.4 Yesterday's Activity & Summaries

Read these files for yesterday's date (YYYY-MM-DD = yesterday):

1. **Daily summary**: `memory/summaries/YYYY-MM-DD-daily.md`
   - Contains: session list, heartbeat stats, cron job stats, LLM-generated highlights
   - This is the most comprehensive source — use it as the primary recap
2. **Session summaries**: `memory/summaries/YYYY-MM-DD-*.md` (excluding `-daily.md` and `-heartbeat-activity.md`)
   - Contains per-session TL;DR, decisions made, tools used
   - Highlight any decisions or open items that carry over to today
3. **Daily log** (fallback): `memory/logs/YYYY-MM-DD.md`
   - Agent-written activity notes — use if summaries are not available

Extract: key accomplishments, decisions made, open items carried over.

### 1.5 Weather (Optional)

If web search is available, search for weather in the user's location (check `USER.md` for location).
Extract: conditions, high/low, precipitation chance.
Skip silently if location unknown or search unavailable.

## Phase 2: Analyze & Prioritize

Review gathered data and identify:

- **Conflicts**: overlapping calendar events
- **Urgencies**: overdue tasks, emails from important senders, meetings starting soon
- **Carryover**: unfinished items from yesterday
- **#1 Priority**: the single most important thing to focus on today

## Phase 3: Format Briefing

Produce a concise briefing. Target: **under 2 minutes to read**.

```markdown
# Daily Briefing — [YYYY-MM-DD] [Day of Week]

[Weather one-liner if available]

## #1 Priority
**[Most important action for today]**
[Why it matters — one sentence]

## Schedule ([N] events)
| Time | Event | Notes |
|------|-------|-------|
| 09:00 | Team sync | [attendees or prep note] |
| 14:00 | 1:1 with [name] | [context] |

[Conflicts or gaps worth noting]

## Email ([N] unread)

**Needs Response:**
- [Sender] — [Subject] ([time ago])

**FYI:**
- [Sender] — [Subject]

## Tasks
- [ ] [Carried over from yesterday]
- [ ] [From MEMORY.md]

## Yesterday ([N] sessions)
**Highlights:** [from daily summary or log]
- [Key accomplishment / decision 1]
- [Key accomplishment / decision 2]

**Carried Over:**
- [ ] [Unfinished item from yesterday's sessions]

## Active Cron Jobs
- [job-name]: [next run time] — [description]
```

### Formatting Rules

- Keep each section to 3-5 items max. If more, show top items and note "(+N more)".
- Use relative time for emails ("2h ago", "yesterday").
- Omit empty sections entirely — do not show "No items" placeholders.
- For chat delivery: use **bold** for key terms, `inline code` for times/names, bullet lists for enumeration.

## Phase 4: Deliver

Output the briefing as the reply text. The cron system or channel layer handles delivery to the configured destination (Discord, Slack, etc.).

## Cron Setup

To run daily, register with the `cron` skill:

```
Schedule: { "type": "cron", "expression": "0 8 * * *" }
Timezone: [user's timezone from config]
Prompt: "Run the daily-briefing skill. Output the briefing."
Reply: { "channel": "discord", "channelId": "[target channel]" }
```

Adjust the hour (8 = 8:00 AM) to the user's preference.

## Graceful Degradation

| Source | Tool Missing | Behavior |
|--------|-------------|----------|
| Calendar | `gog_calendar_events` not available | Skip "Schedule" section |
| Email | `gog_gmail_search` not available | Skip "Email" section |
| Weather | Web search not available or no location | Skip weather line |
| Yesterday | No summaries or log file for yesterday | Skip "Yesterday" section |
| Tasks | No TODO section in MEMORY.md | Skip "Tasks" section |

The briefing is useful even with only 1-2 sources available.
