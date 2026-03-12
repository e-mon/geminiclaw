---
name: topic-patrol
description: Proactively explore the web for topics matching the user's interests and share findings conversationally. Designed for cron execution with Flash model.
enabled: true
---

# Topic Patrol

Explore the web based on the user's interests and share discoveries like a curious friend — not a news bot.

```
1. Read     → USER.md (Interests + Work Context + sources) + prior state
2. Explore  → Route to the right source tool per topic
3. Filter   → "Would I tell a friend about this?"
4. Share    → Conversational message to home channel (or stay silent)
5. Record   → Update state + findings log
```

## Trigger Patterns

- **Cron job** — scheduled every 4-8 hours with a lightweight model (e.g. `gemini-2.5-flash`)
- **Manual** — user says "patrol", "track this topic", "what's new in {X}", or "anything interesting lately?"

When triggered manually, reply directly in the conversation instead of posting to home channel.

## Execution Flow

### Step 1: Understand the User

1. Read `USER.md`:
   - **Interests** section — primary exploration source. Each topic may have a `sources:` line (see Source Routing below).
   - **Work Context** section — anchor findings to what the user is currently working on
   - If Interests is empty, fall back to Work Context topics. If both are empty, skip and stay silent.
2. Read `patrol/state.json` (default: `{ "lastRun": null, "rotationIndex": 0 }` if missing)
3. Read `patrol/findings.md` (default: empty if missing) — for dedup
4. Check for entries marked `deferred` from a previous quiet-hours run. If still relevant, share them first before exploring new topics.

### Step 2: Explore

Run **2-3 queries**, rotating through Interests across runs via `rotationIndex`. Wrap around to 0 when it exceeds the number of Interest topics.

#### Source Routing

Each Interest topic in USER.md may have an optional `sources:` line. Route queries to the appropriate tool based on source type:

| Source prefix | Tool | Example query |
|---|---|---|
| _(no sources specified)_ | `web_search` + `web_fetch` | `{interest} latest news 2026` |
| `HN` | `web_search` with `site:news.ycombinator.com` | `site:news.ycombinator.com {interest}` |
| `Reddit/{subreddit}` | `web_search` with `site:reddit.com/r/{subreddit}` | `site:reddit.com/r/LocalLLaMA {interest}` |
| `github:{owner}/{repo}` | `github` skill tools (releases, issues) | Check latest releases / recent issues |
| `@{handle}` | Twitter/X MCP tools if available, else `web_search` | `from:{handle} {interest}` or `web_search` fallback |
| `rss:{url}` | RSS MCP tools if available, else skip | Fetch and filter feed entries |
| URL (e.g. `https://blog.nodejs.org`) | `web_fetch` directly | Read the page and look for new content |

**Fallback rule**: if the specified source tool is not available, fall back to `web_search` with a `site:` filter or topic keywords. Never error on a missing tool — degrade gracefully.

#### Query Categories

| Category | What to search | Example |
|---|---|---|
| **Interest-driven** | A topic from the Interests section, using its sources | `site:news.ycombinator.com AI agents` |
| **Work-adjacent** | Something near the user's current work | `{technology} best practices tips` |
| **Serendipity** (occasional) | Cross-topic or tangential discovery | `{work_context_tool} alternative approaches` |

For promising results, **read the actual page** with `web_fetch` to get substance beyond snippets. Do not curate based on search snippets alone.

> Not every run needs a Serendipity query. Rotate it in roughly 1 in 3 runs.

### Step 3: Filter — "Would I tell a friend?"

For each finding, consider:

- **Novel?** — not already in `patrol/findings.md`
- **Interesting?** — not a generic press release or product announcement
- **Relevant?** — connects to the user's work or stated interests
- **Worth sharing?** — would make someone say "oh cool, I didn't know that"

Use your judgment. If nothing clears the bar, share nothing — silence is better than noise.

### Step 4: Share (only when worth it)

Check the current time via `geminiclaw_status`. Respect **quiet hours (23:00–08:00)** — defer delivery until morning.

Post to home channel via `geminiclaw_post_message`. Limit to **1-2 topics per message**.

**Tone**: natural, conversational. Explain WHY it's interesting, not just WHAT it is. Connect it to the user's current work. End with a question or action prompt.

Good:
```
Hey — spotted something relevant to your {work_context} work.
{1-2 sentence summary of the finding and why it matters}.

Source: {URL}

Want me to dig into this further?
```

Bad (do NOT do this):
```
📰 Topic Patrol Report
1. {topic}: {summary}
2. {topic}: {summary}
3. {topic}: {summary}
```

### Step 5: Update State

1. Append to **`patrol/findings.md`** (whether shared or not):
   ```markdown
   ## YYYY-MM-DD
   - {topic}: {one-line summary} — shared / skipped ({reason}) / deferred (quiet hours)
   ```
   Prune entries older than 14 days to keep the file small. Use `geminiclaw_status` for the current date.

2. Update **`patrol/state.json`**:
   ```json
   { "lastRun": "2026-03-10T14:00:00+09:00", "rotationIndex": 2 }
   ```

If nothing was found, still update `lastRun` and increment `rotationIndex`.

## Cron Setup

```
Schedule: { "type": "every", "intervalMin": 360 }
Timezone: [user's timezone from config]
Prompt: "Run the topic-patrol skill."
Model: flash
```

## Graceful Degradation

| Condition | Behavior |
|---|---|
| USER.md has no Interests or Work Context | Stay silent — nothing to explore |
| `web_search` not available | Stay silent — cannot explore |
| Source tool not available (RSS, Twitter, etc.) | Fall back to `web_search` with `site:` filter |
| `patrol/state.json` missing | Start fresh with defaults |
| `patrol/findings.md` missing | Treat as empty (no dedup history) |
| Quiet hours (23:00–08:00) | Skip delivery, record findings for next run |

## Prohibited Patterns

- Formatted news-briefing style (numbered lists, emoji headers, "report" framing)
- Cramming 3+ topics into a single message
- Sharing something just because it's new — it must be genuinely interesting
- Reporting "nothing found" — silence is the correct response
- Sending duplicates without checking `patrol/findings.md`
