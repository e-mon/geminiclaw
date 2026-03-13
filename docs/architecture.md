# Architecture

## Design Philosophy

GeminiClaw treats **Gemini CLI as the core agent engine** and wraps it with thin orchestration layers built from existing, proven tools:

| Concern | Delegated To | Why |
|---|---|---|
| LLM reasoning & tool use | **Gemini CLI** (ACP) | Full-featured agent runtime with sandbox, MCP, multi-turn sessions |
| Durable execution & scheduling | **Inngest** | Retry, step persistence, concurrency control without custom queue |
| Memory search & retrieval | **QMD** | Hybrid search (BM25 + Vector + LLM reranking) without custom embedder |
| Multi-channel messaging | **Vercel Chat SDK** | Discord/Slack/Telegram adapters without managing gateway connections |

GeminiClaw itself is the glue: session lifecycle, process pool management, context injection, and security gates. This thin-wrapper approach keeps the codebase extensible without reimplementing capabilities that already exist upstream.

```
                         ┌─────────────────────┐
                         │   Trigger Sources    │
                         │  Discord · Slack ·   │
                         │  Telegram            │
                         │  CLI · Cron · HTTP   │
                         └─────────┬───────────┘
                                   │ webhook / event
                         ┌─────────▼───────────┐
                         │      Inngest         │
                         │  event bus +         │
                         │  durable execution   │
                         └─────────┬───────────┘
                                   │ inngest.send()
┌──────────────────────────────────▼──────────────────────────────────┐
│                          GeminiClaw                                  │
│  session lifecycle · process pool · context injection · security    │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │                    Gemini CLI (ACP)                         │     │
│  │        reasoning · tool use · sandbox · MCP host           │     │
│  └────────────────────────────────────────────────────────────┘     │
│          │                    │                    │                 │
│  ┌───────▼─────┐    ┌────────▼────────┐    ┌──────▼──────┐         │
│  │    QMD      │    │   Chat SDK      │    │    MCP      │         │
│  │   hybrid    │    │ Discord/Slack/  │    │  Servers    │         │
│  │   search    │    │   Telegram      │    │  gog · cron │         │
│  │   over      │    │                 │    │  ask-user   │         │
│  │   memory    │    │                 │    │  status     │         │
│  └─────────────┘    └─────────────────┘    │  admin      │         │
│      search              delivery          └─────────────┘         │
│                                                 tools              │
└────────────────────────────────────────────────────────────────────┘
```

---

## Turn Lifecycle

Each agent run flows through 4 phases:

| Phase | Purpose |
|---|---|
| **Pre-execution** | Check if the ACP session can be resumed; build agent context (GEMINI.md + session-specific directives) |
| **Execution** | Acquire a pooled Gemini CLI process, send prompt via ACP, stream events |
| **Post-run** | Persist session JSONL, record usage, flush important context to MEMORY.md |
| **Deliver** | Generate session title, send reply to channel, notify on heartbeat alerts |

Post-run and deliver execute in parallel — reply delivery is not blocked by memory flush.

### Context Injection

GEMINI.md is written once at workspace initialization (static content: @-imports, memory guidelines, autonomy level). Per-turn context (trigger type, channel formatting, session history) is injected as a prompt prefix via ACP's `-p` parameter, avoiding file-write contention between concurrent sessions.

### Error Recovery

Three recovery paths, each retried at most once (`_isRetry` flag prevents loops):

| Trigger | Recovery |
|---|---|
| ACP session died (pool eviction, process crash) | Generate session summary, retry as fresh session |
| Context overflow (Gemini CLI history full) | Flush to MEMORY.md, start new session |
| Retryable tool error (e.g. PDF parse failure) | Inject error message into prompt, retry |

---

## ACP Process Pool

Gemini CLI processes are **stateful** — each holds conversation history in memory. Killing a process loses that state, so the pool optimizes for session reuse.

### Pool Sizing

| Parameter | Default | Rationale |
|---|---|---|
| `maxSize` | 6 | Inngest concurrency (4) + reserved slots (2) |
| `reservedSlots` | 2 | Background tasks (heartbeat, summary) never block user requests |
| `waitTimeoutMs` | 60s | FIFO queue when all slots are in use |

### Session Affinity

The pool scores idle processes using a **Filter → Score → Bind** pipeline:

| Score | Condition | Cost of Eviction |
|---|---|---|
| 100 | Same session ID (in-process reuse) | Zero — no reload needed |
| 50 | No session held (free slot) | Zero — nothing to lose |
| 1 | Different session held | High — requires `loadSession` replay |

Highest-scoring process wins. Within the same score, recency (`lastUsedAt`) breaks ties. The pool key is `${cwd}::${model}` to prevent cross-model reuse.

**File**: `src/agent/acp/process-pool.ts`

---

## Scheduling & Event Bus — Inngest

Inngest serves as both the **durable execution engine** and the **event bus** that unifies all trigger sources. Every external input — webhooks, CLI commands, cron schedules — is normalized into an Inngest event (`geminiclaw/run`), making the agent execution path uniform regardless of origin.

```
Discord webhook  ─┐
Slack webhook    ─┤
Telegram polling ─┤
CLI command      ─┼─→ inngest.send('geminiclaw/run') ─→ agentRun() ─→ turn lifecycle
Heartbeat cron   ─┤
Custom cron      ─┘
```

This architecture means adding a new trigger source (e.g. a GitHub webhook, an HTTP API, or a scheduled task) only requires emitting an Inngest event — no changes to the agent execution pipeline.

### Lane Queue

Agent runs use session-scoped serialization:

```
Session A: ─── run1 ──→ run2 ──→ run3 ──→   (serial)
Session B: ─── run1 ──→ run2 ──→             (serial)
Session C: ─── run1 ──→                      (serial)
           ←── max 4 concurrent sessions ──→  (parallel)
```

Same session ID → queued serial (prevents workspace conflicts). Different session IDs → parallel up to 4. Each run is a durable function with step-level persistence and automatic retries.

### Inngest Functions

| Function | Trigger | Purpose |
|---|---|---|
| `agentRun` | `geminiclaw/run` event | Unified agent executor (turn lifecycle) |
| `heartbeatCron` | Inngest cron schedule | Emits `geminiclaw/run` at configured interval |
| `cronJobRunner` | `geminiclaw/cron-run` event | Self-rescheduling user-defined cron jobs |
| `dailySummaryCron` | Inngest cron schedule | Daily session summary generation |

**Files**: `src/inngest/agent-run.ts`, `src/inngest/heartbeat.ts`, `src/inngest/cron-scheduler.ts`

---

## Memory & Search

GeminiClaw manages memory **writes**; QMD handles memory **reads**. There is no custom search code.

### Three-Tier Model

```
Tier 1: System Context (injected every run via @-import)
├── MEMORY.md        Long-term memory (agent edits via file tools)
├── SOUL.md          Agent personality and principles
├── USER.md          User-specific settings
└── AGENTS.md        Behavior rules and skill routing

Tier 2: Working Memory (on-demand reference)
├── memory/sessions/*.jsonl    Session history (append-only)
├── memory/summaries/*.md      Session summaries (LLM-generated, Obsidian format)
├── memory/logs/YYYY-MM-DD.md  Daily activity logs
└── HEARTBEAT.md               Heartbeat checklist

Tier 3: Indexed Memory (QMD hybrid search via MCP)
└── QMD indexes all .md files in the vault directory
    ├── qmd_search              BM25 keyword search
    ├── qmd_vector_search       Semantic vector search
    ├── qmd_deep_search         Hybrid + LLM reranking
    └── qmd_get                 Retrieve full document
```

### Session Lifecycle

Sessions are stored as append-only JSONL (`memory/sessions/<sessionId>.jsonl`). When a session goes idle (≥5 min), an LLM-generated summary is written to `memory/summaries/`. Summaries support incremental updates — if new entries arrive after the initial summary, only the delta is sent to the LLM. Summaries are indexed by QMD, making past session context searchable.

### Memory Flush

Important signals from session history are periodically flushed to MEMORY.md (via LLM summarization) so they survive across sessions. Flush is fail-open — errors are logged but never block the pipeline.

### Usage Tracking

Token usage is recorded in SQLite (`memory/memory.db`) for cost estimation and analytics.

---

## MCP Servers

Registered in `~/.geminiclaw/settings.json`, auto-configured by `geminiclaw init`.

| Server | Purpose |
|---|---|
| **qmd** | Hybrid search over memory files (BM25 + Vector + LLM Reranking) |
| **geminiclaw-status** | Current time, run progress, preview URL |
| **geminiclaw-cron** | Cron job CRUD |
| **geminiclaw-ask-user** | Forward questions to user via channel |
| **gog** | Google Workspace (Gmail, Calendar, Drive, Contacts, Sheets, Docs) via gog CLI |

Browser automation (`agent-browser`) runs as a Gemini skill, not an MCP server.
