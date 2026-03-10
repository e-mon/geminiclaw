# GeminiClaw

[![CI](https://github.com/geminiclaw/geminiclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/geminiclaw/geminiclaw/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

Autonomous agent orchestrator powered by [Gemini CLI](https://github.com/google-gemini/gemini-cli). GeminiClaw wraps Gemini CLI as the core agent engine, adding scheduling ([Inngest](https://www.inngest.com/)), persistent memory with hybrid search ([QMD](https://github.com/tobil/qmd)), MCP tools, and multi-channel messaging ([Vercel Chat SDK](https://github.com/nicepkg/chat) — Discord / Slack).

## Quick Start

```bash
git clone https://github.com/geminiclaw/geminiclaw.git
cd geminiclaw
bun install                  # Gemini CLI + QMD + patches auto-applied
bunx gemini                  # First launch opens browser for Google OAuth
task setup                   # build → bun link → interactive setup wizard
task start                   # Start all services (overmind)
```

<details>
<summary>Prerequisites</summary>

### Required

| Tool | Version | Install |
|------|---------|---------|
| **Node.js** | >= 20 | [nodejs.org](https://nodejs.org/) or `brew install node` |
| **Bun** | >= 1.3 | [bun.sh](https://bun.sh/) |
| **Docker** | latest | [Docker Desktop](https://www.docker.com/products/docker-desktop/) / [OrbStack](https://orbstack.dev/) (macOS) / [Docker Engine](https://docs.docker.com/engine/install/) (Linux) |
| **Inngest CLI** | latest | `bunx inngest-cli@latest` (auto-fetched) |

Gemini CLI is installed as a local dependency via `bun install` — no global install needed.

### Process Management (for `task start`)

| Tool | Install |
|------|---------|
| **overmind** | `brew install overmind` (macOS) / [releases](https://github.com/DarthSim/overmind/releases) (Linux) |
| **tmux** | `brew install tmux` (macOS) / `apt install tmux` (Linux) |
| **Task** | `brew install go-task` (macOS) / [taskfile.dev](https://taskfile.dev/) |

### One-liner setup

**macOS:**
```bash
brew install node go-task overmind tmux
curl -fsSL https://bun.sh/install | bash
```

**Ubuntu / Debian / WSL2:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs tmux
curl -fsSL https://bun.sh/install | bash

# Docker Engine
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io
sudo usermod -aG docker $USER  # Log out and back in

# go-task + overmind
sudo sh -c 'curl -fsSL https://taskfile.dev/install.sh | sh -s -- -d -b /usr/local/bin'
ARCH=$(dpkg --print-architecture)
curl -fsSL -o /tmp/overmind.gz "https://github.com/DarthSim/overmind/releases/latest/download/overmind-v2.5.1-linux-${ARCH}.gz"
gunzip /tmp/overmind.gz && chmod +x /tmp/overmind && sudo mv /tmp/overmind /usr/local/bin/
```

### Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| **macOS** | Fully supported | Docker sandbox ([OrbStack](https://orbstack.dev/) recommended) |
| **Linux** | Supported | Docker sandbox |
| **Windows** | Not supported | Use WSL2 with Linux instructions |

> **WSL2**: Clone under `~/` (not `/mnt/c/`). Vault auto-falls back to `encrypted-file` (Keychain unreliable on WSL2).

</details>

<details>
<summary>Optional Setup</summary>

### Browser Automation

Required by `agent-browser` and `deep-research` skills:

```bash
bun install -g agent-browser
geminiclaw browser login              # Save auth state (opens browser)
geminiclaw browser login https://...  # Open specific URL
```

Auth state is stored at `~/.geminiclaw/browser-auth-state.json` and auto-restored.

### Google Workspace (gog)

Required by the heartbeat skill for Gmail, Calendar, Drive:

```bash
brew install steipete/tap/gogcli                        # macOS
# go install github.com/steipete/gog@latest             # Linux

gog auth credentials ~/Downloads/client_secret_*.json   # OAuth credentials
gog auth add YOUR_EMAIL@gmail.com                       # Authenticate
geminiclaw setup                                        # Register with GeminiClaw
```

See [gog setup guide](https://github.com/steipete/gog#setup) for details.

### Preview Server

Shares agent-generated files (HTML reports, images) via URL. With [Tailscale](https://tailscale.com/), auto-exposes over tailnet via MagicDNS. Without Tailscale, falls back to `localhost`.

</details>

## Architecture

GeminiClaw wraps Gemini CLI with thin orchestration layers. See [docs/architecture.md](docs/architecture.md) for details.

| Concern | Delegated To |
|---|---|
| LLM reasoning & tool use | Gemini CLI (ACP) |
| Durable execution & scheduling | Inngest |
| Memory search & retrieval | QMD |
| Multi-channel messaging | Vercel Chat SDK |

- [Architecture](docs/architecture.md) — turn lifecycle, process pool, scheduling
- [Security](docs/security.md) — Docker sandbox, agent-blind secrets, tool effect gate
- [Memory](docs/memory.md) — write/read timing, reliability spectrum
- [Vault](docs/vault.md) — encrypted secret storage, backend selection

## CLI Commands

| Command | Description |
|---------|-------------|
| `geminiclaw setup` | Interactive setup wizard |
| `geminiclaw start` | Start Express server + Chat SDK |
| `geminiclaw run <prompt> [-s ID]` | Run a one-shot task |
| `geminiclaw status` | Show active run and sessions |
| `geminiclaw config show/get/set` | Configuration management |
| `geminiclaw sync-templates [--force]` | Sync templates to workspace |
| `geminiclaw session list [--date]` | List sessions |
| `geminiclaw browser login/status/reset` | Browser auth management |
| `geminiclaw vault set/get/list/delete/status/migrate` | Secret management |
| `geminiclaw cron list/add/remove` | Cron job management |
| `geminiclaw skill list/enable/disable/install/remove` | Skill management |
| `geminiclaw upgrade` | Pull latest, rebuild, sync templates |

<details>
<summary>Configuration</summary>

`~/.geminiclaw/config.json`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | `"auto"` | Gemini model name |
| `workspace` | string | `~/.geminiclaw/workspace` | Workspace path |
| `sandbox` | boolean \| string | `true` | `true` / `false` / `"docker"` / `"seatbelt"` |
| `timezone` | string | `""` | IANA timezone (e.g. `"Asia/Tokyo"`) |
| `language` | string | `"en"` | Agent response language |
| `heartbeatIntervalMin` | number | `30` | Heartbeat interval in minutes |
| `maxToolIterations` | number | `50` | Max tool calls per run |
| `sessionIdleMinutes` | number | `60` | Session expiry (0 = never resume) |
| `autonomyLevel` | string | `"autonomous"` | `autonomous` / `supervised` / `read_only` |
| `vault.backend` | string | `"auto"` | `auto` / `keyring` / `encrypted-file` / `command` |

Full schema: `geminiclaw config show`

Agents can self-modify behavioral settings via `{workspace}/config.json` (non-secret fields only).

</details>

## Development

```bash
task start              # All services in foreground
bun run build           # TypeScript compile
bun test                # vitest
bun run typecheck       # Type check
bun run lint            # Biome lint
```

<details>
<summary>Gemini CLI Patches</summary>

Patches are auto-applied via `bun patch` during `bun install`.

| Patch | Package | Description | Upstream |
|-------|---------|-------------|----------|
| usageMetadata | `@google/gemini-cli` | Token usage in ACP responses | — |
| ACP stdin bypass | `@google/gemini-cli` | Prevent sandbox from consuming ACP stdin | — |
| streamHistory skip | `@google/gemini-cli` | Remove history replay that contaminates responses | — |
| registerToolByName | `@google/gemini-cli-core` | Fix sub-agent MCP tool registration | [#18712](https://github.com/google-gemini/gemini-cli/issues/18712) |
| Discord reconnect | `@chat-adapter/discord` | Fix Gateway reconnection | — |
| QMD LLM compat | `@tobilu/qmd` | LLM integration fix | — |

```bash
# Updating patches
bun add @google/gemini-cli@<version>
bun patch @google/gemini-cli
# ... edit node_modules/@google/gemini-cli/ ...
bun patch --commit node_modules/@google/gemini-cli
```

</details>

<details>
<summary>Source Layout</summary>

```
src/
├── agent/             Turn lifecycle, ACP client/pool, session management
├── config/            Zod schema, config I/O, paths, Gemini CLI settings
├── memory/            SQLite usage tracking, QMD integration
├── mcp/               MCP servers (status, cron, ask-user, gog, admin)
├── channels/          Chat SDK adapters + reply delivery (Discord/Slack)
├── inngest/           Durable functions (agent-run, heartbeat, cron, daily-summary)
├── cli/commands/      CLI command implementations
├── vault/             Secret management (keyring/encrypted-file/command)
├── skills/            Skill management (install/scan/enable/disable)
├── dashboard/         Web analytics dashboard
└── upgrade/           Self-update and config merge

templates/             Workspace templates (source of truth)
├── AGENTS.md          Agent behavior rules
├── HEARTBEAT.md       Heartbeat checklist
├── .gemini/skills/    Skill definitions
└── ...
```

</details>

## License

[MIT](LICENSE)
