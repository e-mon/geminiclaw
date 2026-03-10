# Memory Architecture

For the high-level overview (three-tier model, QMD, session lifecycle), see [Architecture — Memory & Search](architecture.md#memory--search).

This document details **who writes what, when** — the timing and ownership of every memory operation.

---

## Write/Read Timeline

### Pre-run — Context Assembly

| What | Source | How |
|---|---|---|
| MEMORY.md, SOUL.md, AGENTS.md, USER.md | Workspace files | `@`-imported by Gemini CLI (static, written once at init) |
| Session-specific directives | `buildSessionContext()` | Injected as prompt prefix via ACP `-p` parameter |

GEMINI.md is static and never rewritten per-turn. Dynamic context (trigger type, channel formatting) is passed as a prompt prefix to avoid file-write contention between concurrent sessions.

### During Run — Agent-Initiated

The agent uses Gemini CLI's native file tools at its own discretion. GeminiClaw does not control these writes.

| What | Writer | Reliability |
|---|---|---|
| MEMORY.md edits | Agent (voluntary) | Best-effort — agent is instructed but not guaranteed to write |
| Daily logs (`memory/logs/YYYY-MM-DD.md`) | Agent (voluntary) | Best-effort |
| QMD search (`qmd_search`, `qmd_vector_search`, `qmd_deep_search`) | Agent via MCP | On-demand reads from QMD index |

System-side writes during execution (not agent-initiated):

| What | Trigger | Purpose |
|---|---|---|
| `run-progress-{sessionId}.json` | Each `tool_use` event | Progress tracking for `geminiclaw_status` |
| `last-run-events-{sessionId}.jsonl` | All stream events | Debug log (overwritten each run) |

### Post-run — System Automatic

Runs after Gemini CLI process completes. Three handlers:

| Handler | What | Reliability |
|---|---|---|
| **save-session** | Append RunResult to `memory/sessions/<sessionId>.jsonl` | Fail-closed (must succeed) |
| **track-usage** | Record tokens/cost to `memory/memory.db` | Fail-closed |
| **memory-flush + reindex** | Flush important signals from session history to MEMORY.md via LLM, then trigger QMD reindex | Fail-open (errors logged, never blocks) |

### Session Idle — Pool Lifecycle

Triggered by ACP process pool events (idle timeout or eviction), not by the run pipeline.

| What | Writer | Details |
|---|---|---|
| Session summary (`memory/summaries/{date}-{slug}.md`) | System (automatic) | LLM-generated Obsidian-format summary. Supports incremental updates (only new entries sent to LLM). Indexed by QMD for cross-session search. |

`syncSessionSummaries()` runs at server startup, on session eviction, and by daily cron to generate or update session summaries.

---

## Memory Types

| Type | Storage | Writer | Persistence |
|---|---|---|---|
| **MEMORY.md** | File | Agent (voluntary) + system flush | Permanent |
| **Daily logs** | File | Agent (voluntary) | Permanent |
| **Session JSONL** | File | System (post-run) | Permanent, append-only |
| **Session summaries** | File | System (on idle) | Permanent, QMD-indexed |
| **Usage records** | SQLite | System (post-run) | Permanent |
| **Progress signal** | File | System (during run) | Ephemeral |
| **Debug log** | File | System (during run) | Overwritten each run |
| **ACP session** | Gemini CLI memory | Gemini CLI | Process lifetime |

---

## Reliability Spectrum

```
System automatic (guaranteed)          Agent-initiated (best-effort)
◄──────────────────────────────────────────────────────────────────►

sessions/*.jsonl   memory.db   MEMORY.md (flush)   summaries/   │   MEMORY.md (agent)   daily logs
   fail-closed      fail-closed    fail-open        on-idle      │     voluntary           voluntary
```

Session JSONL is always saved, so conversation history is never lost even if the agent forgets to write to MEMORY.md. Memory flush is the safety net that automatically persists important signals before they can be lost across sessions. Session summaries bridge the cross-session gap by making past context discoverable via QMD search.
