# Security Architecture

GeminiClaw employs a multi-layered defense strategy to create a safe operating environment for autonomous agents. Each layer addresses an independent threat model so that a breach of any single layer does not compromise the entire system.

```
┌─────────────────────────────────────────────────────┐
│                   GeminiClaw Host                     │
│                                                       │
│  Agent-Blind Secrets      Tool Effect Gate             │
│  ┌────────────────┐       ┌──────────────────┐       │
│  │ $vault: resolve │       │ elevated/destru- │       │
│  │ env allowlist   │       │ ctive → IPC →    │       │
│  └────────────────┘       │ user approval    │       │
│         │                  └──────────────────┘       │
│  ┌──────┴────────────────────────┴──────────────┐    │
│  │              Sandbox (Docker)                   │    │
│  │  ┌──────────────────────────────────────────┐ │    │
│  │  │           Gemini CLI (ACP)                │ │    │
│  │  │  - workspace-only read/write             │ │    │
│  │  │  - selective bind mounts only             │ │    │
│  │  │  - secret env vars invisible             │ │    │
│  │  └──────────────────────────────────────────┘ │    │
│  └──────────────────────────────────────────────────┘ │
│                                                       │
│  Skills Scanner (install)         Audit Log (runtime) │
│  ┌────────────────┐            ┌──────────────────┐  │
│  │ 3-layer scan    │            │ JSONL recording  │  │
│  │ static > LLM   │            │ tool, params, ms │  │
│  └────────────────┘            └──────────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## Sandbox — Docker Process Isolation

GeminiClaw leverages **Gemini CLI's built-in Docker sandbox** to isolate the agent process inside a container with full namespace/cgroup separation. Gemini CLI supports running inside a Docker container via the `--sandbox` flag, and GeminiClaw controls this behavior through environment variables.

### Docker Runtime

A Docker-compatible runtime is required. On macOS, **[OrbStack](https://orbstack.dev/)** is recommended over Docker Desktop for its lightweight footprint and faster startup.

| Runtime | Platform | Notes |
|---|---|---|
| **OrbStack** | macOS | Lightweight and fast. Recommended Docker Desktop alternative |
| **Docker Desktop** | macOS / Linux | Official Docker runtime |
| **Docker Engine** | Linux | CLI-only, suitable for server environments |

`isDockerAvailable()` checks availability at startup via `docker info`. OrbStack's shim at `~/.orbstack/bin/docker` is also detected as a fallback.

### Configuration

| Config | Behavior |
|---|---|
| `true` (default) | Docker if available, disabled with warning otherwise |
| `'docker'` | Explicit Docker sandbox |
| `'seatbelt'` | Legacy macOS sandbox-exec (not recommended) |
| `false` | Disabled |

### How It Works

GeminiClaw sets environment variables (`GEMINI_SANDBOX`, `GEMINI_SANDBOX_IMAGE`, `SANDBOX_MOUNTS`, `SANDBOX_ENV`) that tell Gemini CLI to re-exec itself inside a Docker container. Only the workspace, `~/.geminiclaw`, and MCP server paths are bind-mounted — the agent cannot access arbitrary host directories.

The sandbox image (`geminiclaw-sandbox`) is built automatically from `{workspace}/.gemini/sandbox.Dockerfile` at startup, with hash-based change detection to avoid unnecessary rebuilds. Agent skill dependencies (chromium, gh, poppler, etc.) are pre-installed in the image.

### Legacy: Seatbelt (macOS only)

Available via `sandbox: 'seatbelt'` for explicit opt-in only. Uses macOS `sandbox-exec` with a custom profile. **Not recommended** — the `(allow default)` base provides blacklist-only protection with no process or network isolation.

**File**: `src/agent/turn/sandbox.ts`

---

## Agent-Blind Secrets

Secrets are resolved on the host side and **never passed to the agent process**. This pattern ensures the agent cannot exfiltrate credentials even if the sandbox is compromised.

```
Host (GeminiClaw)
  vault.init() → cache → loadConfig() resolves $vault: refs
  ↓ spawn (Docker sandbox + pickSafeEnv() allowlist)
Gemini CLI (inside sandbox)
  ✓ PATH, HOME, GEMINI_*, AGENT_BROWSER_*, NODE_*
  ✗ DISCORD_TOKEN, SLACK_BOT_TOKEN, and other secrets
```

### Environment Variable Allowlist

`pickSafeEnv()` filters `process.env` through an allowlist before passing it to the child process:

```
Allowed: PATH, HOME, USER, SHELL, LANG, LC_*, TERM*, TMPDIR,
         XDG_*, NODE_*, NPM_*, NVM_*,
         AGENT_BROWSER_*, GEMINI_*, GEMINICLAW_*,
         NO_COLOR, FORCE_COLOR, CLICOLOR

Blocked: DISCORD_TOKEN, SLACK_BOT_TOKEN, all other secrets
```

### Vault (`$vault:` References)

Config values prefixed with `$vault:` are resolved from encrypted storage at startup. The agent only sees the resolved values indirectly through MCP tools — never the raw secrets. See [docs/vault.md](vault.md) for backend details and CLI usage.

### Filesystem Path Validation

The ACP client enforces workspace boundaries in `fs/readTextFile` and `fs/writeTextFile` handlers. Symlink-based escapes are prevented by `realpathSync()`. **The agent cannot read or write files outside the workspace.**

**File**: `src/agent/acp/client.ts`

---

## Tool Effect Gate

MCP tools that produce external or destructive effects require explicit user approval before execution. Each tool declares a `ToolEffect` level, and `ListTools` responses include MCP-standard `ToolAnnotations` (`readOnlyHint`, `destructiveHint`, `openWorldHint`) derived from the effect.

### Tool Effect Classification

| Level | Behavior | MCP Annotations | Examples |
|---|---|---|---|
| `read` | Immediate execution | `readOnlyHint: true` | Gmail search, Calendar lookup |
| `write` | Immediate execution | `destructiveHint: false` | Config update, draft create |
| `elevated` | **Awaits user approval** | `openWorldHint: true` | Send email, post to Slack |
| `destructive` | **Awaits user approval** | `destructiveHint: true` | Remove skill, delete file |

When `autonomyLevel === 'supervised'`, `write` is promoted to `elevated`.

### File-Based IPC (ask_user)

Gemini CLI's ACP does not support native `ask_user` prompts, and the MCP specification's elicitation feature is not yet available in Gemini CLI. GeminiClaw implements user interaction through **file-based IPC** as a substitute:

```
1. MCP tool → writes ask-user-pending-{askId}.json
2. Runner  → detects file → sends button message to chat (Discord/Slack/Telegram)
3. User    → clicks button
4. Chat handler → writes ask-user-answer-{askId}.json
5. MCP tool → detects file (500ms polling) → continue or abort
```

This approach is necessary because:
- MCP servers run inside the sandbox where stdin/stdout are occupied by ACP JSON-RPC
- Gemini CLI does not expose a native `ask_user` capability through ACP
- MCP elicitation (structured questions from server to user) is not implemented in Gemini CLI

**Safeguards**:
- **askId**: UUID v4 makes file names unpredictable
- **30-minute TTL**: Unanswered pending files are auto-deleted
- **runId scoping**: `GEMINICLAW_RUN_ID` env var prevents cross-session contamination when multiple runs execute concurrently

### Admin Server

The `geminiclaw_admin` MCP tool allows the agent to execute GeminiClaw CLI commands on the host. Dangerous commands (`run`, `start`, `vault`, `--reveal`) are blocked. Destructive commands (`skill remove`, `upgrade`) are gated by tool effect classification.

### MCP Tool Hard Caps

Result counts are capped to prevent bulk data extraction:

| Tool | Limit |
|---|---|
| `gog_gmail_search` | 50 |
| `gog_calendar_events` | 100 |
| `gog_contacts_list` | 50 |
| `gog_drive_search` | 50 |

**Files**: `src/mcp/tool-effect.ts`, `src/agent/ask-user-state.ts`

---

## Skills Security Scanner

Skills undergo 3-layer verification at install time to prevent execution of malicious code.

### Layer 1: Static Pattern Scan (Deterministic)

**DANGER** (installation blocked):
- RCE chains: `curl|bash`, `wget|bash`, `base64|bash`
- Destructive operations: `rm -rf /` (`/tmp` excluded)
- Backdoors: `/dev/tcp/`, `nc -[el]`, `bore.pub`
- Malware: xmrig, cryptonight, atomic stealer
- macOS quarantine bypass: `xattr -[rd].*quarantine`

**WARNING** (user confirmation required):
- External requests: `curl`, `wget`
- Credential access: `~/.ssh`, `~/.aws`, `~/.gnupg`
- Secret files: `.env`, `.pem`, `.key`
- Dynamic dependencies: `npm install`, `pip install`
- Privilege escalation: `sudo`, `su -c`
- Plaintext HTTP: `http://` (excluding localhost)

**PROMPT INJECTION** (SKILL.md only):
- Instruction override: `ignore previous instructions`
- System spoofing: `[SYSTEM]`, `[ADMIN]`
- Context exfiltration: `send your memory/context/instructions`
- Covert operations: `silently`, `secretly`, `without telling user`
- Config tampering: `modify HEARTBEAT/MEMORY/settings.json`

**Unicode obfuscation detection**: zero-width characters (ZWSP, ZWNJ, ZWJ) and Cyrillic/Latin homoglyph mixing.

### Layer 2: LLM Advisory (Supplementary)

Analyzes skill content via Gemini ACP (base64-encoded to prevent adversarial injection). **LLM judgment does not change the risk level** — LLMs are vulnerable to adversarial skills ([arXiv:2505.13348](https://arxiv.org/abs/2505.13348)), so static patterns have final authority. Used only as a human review aid.

### Layer 3: Runtime Sandbox

Post-install execution runs inside the Docker sandbox. Last line of defense against unknown attack patterns that bypass scanning.

### Risk Level Determination

```
Matches danger pattern → danger (installation blocked)
Warning patterns only   → warning (install after user confirmation)
No matches              → safe (automatic installation)
```

**File**: `src/skills/scanner.ts`

---

## Audit Log

All MCP tool invocations are recorded in JSONL format at `{workspace}/memory/audit.jsonl`. Parameter values are truncated to 200 characters. Write failures do not block tool execution (fire-and-forget).

**File**: `src/mcp/audit.ts`

---

## Threat Model

| Threat | Defense Layer |
|---|---|
| Agent reading sensitive files | Docker container isolation + ACP path validation |
| Agent stealing secrets | Agent-Blind pattern + env allowlist |
| Agent writing outside workspace | Docker isolation + ACP path validation |
| Symlink-based sandbox escape | `realpathSync()` link resolution |
| Unintended external operations | Tool Effect Gate (elevated/destructive require approval) |
| User interaction without elicitation | File-based IPC ask_user |
| ask_user cross-session contamination | runId (UUID v4) process tree scoping |
| Malicious skill installation | 3-layer skill scan (static > LLM > sandbox) |
| Skill scan bypass (Unicode obfuscation) | Static pattern homoglyph/zero-width detection |
| Privilege escalation via Admin CLI | Command blocklist + tool effect classification |
| Bulk data extraction via MCP | Result count hard caps |
| Post-mortem incident tracking | Audit JSONL log |
