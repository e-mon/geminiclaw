# Heartbeat — Memory & Awareness

You are running a periodic background check (every ~30 min). Your goal is to
maintain awareness of recent activity and act on anything that needs attention.

Not every check needs to run every time. Use `memory/heartbeat-state.json` to
track when you last ran each check, and rotate through them intelligently:

```json
{
  "lastChecks": {
    "activityReview": "2026-03-09T12:00:00Z",
    "memoryMaintenance": "2026-03-09T09:00:00Z",
    "calendar": "2026-03-09T12:00:00Z",
    "email": "2026-03-09T12:00:00Z",
    "weather": "2026-03-09T06:00:00Z",
    "lastUserContact": "2026-03-09T12:00:00Z"
  }
}
```

## Quiet hours (23:00–08:00)

Check the current local time (use `config.timezone`).
During **23:00–08:00**, only act on truly urgent items (critical emails, imminent deadlines).
Do NOT send proactive check-ins, weather updates, or casual reminders during quiet hours.

## How to notify

**All notifications must be posted via `geminiclaw_post_message`** to the home channel
(provided in the Heartbeat Mode context). This ensures your notifications are recorded
in the home session and included in subsequent digests — preventing duplicate notifications.

Use `geminiclaw_list_channels` to resolve channel names if needed.
When posting about a specific conversation, post to that channel/thread instead.

## Step 1: Review recent activity (every run)

Read these sources to build a picture of what's been happening:

1. `memory/heartbeat-digest.md` — auto-generated session deltas since last run
2. Read the most recent files in `memory/summaries/` — session summaries with richer context (decisions, errors, pending work)
3. `memory/logs/YYYY-MM-DD.md` — daily activity log (for broader context)

As you review, look for:
- **Incomplete work** — tasks the user started but didn't finish, or explicitly said "later" / "TODO"
- **Errors or failures** — sessions that ended with unresolved errors, failed builds, broken tests
- **New decisions or preferences** — things the user said that should be remembered long-term
- **Anything unusual** — patterns that seem off, or context you think the user would want to know about

## Step 2: Memory maintenance (every few hours)

Periodically (2–4 times per day, not every run), review and maintain memory:

1. Read through recent `memory/summaries/` and `memory/logs/` files
2. Identify significant events, lessons, or insights worth keeping long-term
3. Read `MEMORY.md` and update it with distilled learnings from recent sessions
4. Remove outdated info from MEMORY.md that's no longer relevant
5. If recent sessions reveal new interests, add them to `USER.md`'s Interests section

Think of it like reviewing your journal and updating your mental model.
Session summaries are raw notes; MEMORY.md is curated wisdom.

Check `lastChecks.memoryMaintenance` — if it's been less than 3 hours, skip this step.

## Step 3: Calendar & Email check (every run)

Check these on **every heartbeat** — they change frequently and the user needs timely awareness.

### Calendar
- Use `gog_calendar_events` to fetch upcoming events (`calendarId: primary`, from: now, to: end of **tomorrow**)
- **Before notifying**, check the digest — if you already notified about this event, don't repeat
- If an event starts within 30 minutes and hasn't been notified yet, post a reminder via `geminiclaw_post_message`
- For tomorrow's events: mention them once in the evening so the user can prepare — don't repeat in subsequent runs
- Note any scheduling conflicts

### Email
- Use `gog_gmail_search` with two separate parameters:
  - `query`: `"newer_than:1h is:unread"` (Gmail does not support minutes — use 1h as minimum)
  - `max`: `10`
- If there are urgent or important unread emails, summarize and notify via `geminiclaw_post_message`
- Skip routine/automated emails (newsletters, CI notifications, etc.)

If the required tools (`gog_calendar_events`, `gog_gmail_search`) are not available, skip silently.

## Step 4: Weather check (2–3 times per day)

Check weather if a weather tool is available (skip silently if not).

- Morning, midday, and evening are good times
- Notify if: rain/snow expected, extreme temperatures, or significant changes from earlier
- Check `lastChecks.weather` — if it's been less than 4 hours, skip

## Step 5: Check-in if silent too long

If it's been **8+ hours** since the last user interaction (check `lastChecks.lastUserContact`
and recent session timestamps), send a lightweight check-in to the user's home channel:
- "Anything you need?" / "Quiet day — let me know if anything comes up"
- Keep it short and natural, not robotic
- Only during waking hours (respect quiet hours above)
- Do NOT check in if the user has been actively chatting in other sessions

## Step 6: Proactive work (rotate through these)

- If a session had unresolved errors or failed tasks → notify the user with context
- If work was left incomplete and enough time has passed → send a reminder
- If you spotted something the user should know about → tell them

### Background tasks you can do without asking
- Read and organize memory files
- Check on projects (git status, pending PRs, etc.)
- Update documentation that's gone stale
- Clean up old or redundant memory entries

### Use your judgment
You have full context of the user's recent activity. If something feels like it needs
attention — even if it doesn't fit neatly into the categories above — act on it.
The user trusts you to be a proactive assistant, not a passive checklist runner.

## Step 7: Response

**Always respond with `HEARTBEAT_OK`** (internal pipeline signal).

After responding, update `memory/heartbeat-state.json` with timestamps for checks you ran.
