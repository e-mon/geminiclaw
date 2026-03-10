---
name: agent-browser
description: Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task. Triggers include requests to "open a website", "fill out a form", "click a button", "take a screenshot", "scrape data from a page", "test this web app", "login to a site", "automate browser actions", or any task requiring programmatic web interaction.
allowed-tools: Bash(npx agent-browser:*), Bash(agent-browser:*), Read(.claude/skills/agent-browser/references/site-patterns.md), Edit(.claude/skills/agent-browser/references/site-patterns.md)
---

# Browser Automation with agent-browser

> **Native mode is enabled by default** via `AGENT_BROWSER_NATIVE=1` environment variable.
> All `agent-browser` commands use the Rust-native CDP backend — no Playwright/Node.js dependency required.

## Auth State — Automatic Session Restore

If `~/.geminiclaw/browser-auth-state.json` exists, **always load it before the first `open`** command:

```bash
agent-browser state load ~/.geminiclaw/browser-auth-state.json
agent-browser open <url>
```

This restores cookies and localStorage saved by `geminiclaw browser login`. Skip only if the task explicitly requires a fresh/anonymous session.

## Core Workflow

```bash
agent-browser open <url>
agent-browser wait 2000              # see: wait strategy below
agent-browser snapshot -i            # get refs like @e1, @e2
# interact using refs
agent-browser snapshot -i            # re-snapshot after any navigation
```

## Wait Strategy — Choose Carefully

| Situation | Use | Avoid |
|-----------|-----|-------|
| Simple pages (docs, forms) | `wait --load networkidle` | — |
| Busy sites (Amazon, SNS, news) | `wait 2000` or `wait 3000` | `wait --load networkidle` — **never settles, causes timeout** |
| After click/navigation | `wait 1500` or `wait @element` | — |
| Waiting for specific content | `wait "#selector"` | fixed-time waits |

## Data Extraction Strategy — Choose Carefully

| Goal | Use | Avoid |
|------|-----|-------|
| Find elements to click/read | `snapshot -i \| head -N` then `grep` | — |
| Read specific text quickly | `snapshot \| grep -E "pattern"` | `eval` for simple reads |
| Extract structured data from many elements | `eval --stdin <<'EOF' ... EOF` | `snapshot` (too verbose) |
| Site has built-in filters/sort | **Use the UI controls** (click filter) | URL parameter hacking |

## Essential Commands

```bash
# Navigation
agent-browser open <url>
agent-browser close

# Snapshot
agent-browser snapshot -i            # interactive elements with refs
agent-browser snapshot -i -C        # include onclick/cursor:pointer elements
agent-browser snapshot -i | grep -E "pattern"  # filter output directly

# Interaction
agent-browser click @e1
agent-browser click @e1 --new-tab
agent-browser fill @e2 "text"
agent-browser select @e1 "option"
agent-browser press Enter
agent-browser scroll down 500

# Info
agent-browser get url
agent-browser get title
agent-browser get text @e1

# Capture
agent-browser screenshot
agent-browser screenshot --annotate  # numbered labels → @eN refs, good for visual layout
```

## JavaScript Evaluation

Use only when `snapshot | grep` is insufficient (e.g., extracting structured data from many DOM nodes at once).

```bash
# Simple: single quotes are fine
agent-browser eval 'document.title'

# Complex (nested quotes, arrows, multiline): use --stdin to avoid shell corruption
agent-browser eval --stdin <<'EOF'
JSON.stringify(
  Array.from(document.querySelectorAll('.item')).map(el => ({
    title: el.querySelector('h2')?.textContent?.trim(),
    price: el.querySelector('.price')?.textContent?.trim()
  }))
)
EOF
```

## Chaining Commands

```bash
# Safe to chain when output of previous step isn't needed
agent-browser open https://example.com && agent-browser wait 2000 && agent-browser snapshot -i

# Run separately when you need to parse output first
agent-browser snapshot -i        # read refs
agent-browser click @e5          # use ref
agent-browser snapshot -i        # re-read after navigation
```

## Key Rules

- **Refs are invalidated after every navigation** — always re-snapshot
- **Prefer site's native UI filters** over URL parameter manipulation — faster and less fragile
- **`snapshot | grep`** is faster than `eval` for simple reads
- **`eval --stdin <<'EOF'`** is the safe form for any JS with nested quotes or arrow functions

## Ref Lifecycle

Refs (`@e1`, `@e2`, ...) are invalidated when:
- A link or button navigates to a new page
- A form is submitted
- Dynamic content loads (modals, dropdowns)

## Annotated Screenshots

```bash
agent-browser screenshot --annotate  # overlay numbered labels on interactive elements
agent-browser click @e3              # use @eN refs from the output legend
```
Use when: buttons lack text labels, canvas/chart elements exist, or spatial reasoning matters.

## Semantic Locators (fallback when refs fail)

```bash
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "value"
agent-browser find role button click --name "Submit"
agent-browser find placeholder "Search" type "query"
```

## Site-Specific Patterns

Before starting, check `references/site-patterns.md` for known patterns for the target site.

```bash
# Read site-patterns.md at task start if the target site might be documented
```

→ `references/site-patterns.md`

## Post-Task: Update Site Patterns

**After completing every task**, reflect and update `references/site-patterns.md` if any of the following apply:

| Trigger | Action |
|---------|--------|
| Found a reliable selector / URL param / navigation flow | Add to the site's section |
| Hit a pitfall (timeout, broken selector, wrong approach) | Add to Anti-patterns or correct existing entry |
| Existing pattern was wrong or suboptimal | Update in place with a note on why |
| Used a site not yet documented | Add a new section using the template below |

**Rules for updates:**
- Keep entries **generalizable** — no query-specific keywords, no one-off data
- If correcting an existing entry, rewrite it (don't append contradictions)
- One pattern per bullet; prefer concrete code over prose
- If uncertain whether a pattern is reliable, mark it with `[unverified]`

## Deep-Dive References

- `references/commands.md` — full command reference
- `references/snapshot-refs.md` — ref lifecycle and troubleshooting
- `references/authentication.md` — login flows, OAuth, state persistence
- `references/session-management.md` — parallel sessions, concurrent scraping
