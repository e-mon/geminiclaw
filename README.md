# GeminiClaw

[![CI](https://github.com/geminiclaw/geminiclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/geminiclaw/geminiclaw/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

Autonomous agent orchestrator powered by [Gemini CLI](https://github.com/google-gemini/gemini-cli). GeminiClaw wraps Gemini CLI as the core agent engine, adding scheduling ([Inngest](https://www.inngest.com/)), persistent memory with hybrid search ([QMD](https://github.com/tobil/qmd)), MCP tools, and multi-channel messaging ([Vercel Chat SDK](https://github.com/nicepkg/chat) — Discord / Slack).

## Features

- **ACP process pool** — Warm Gemini CLI processes with session affinity and FIFO wait queue
- **Lane Queue execution** — Inngest durable functions serialize runs per session, parallelize across sessions
- **Persistent memory** — File-based memory with hybrid search via QMD (BM25 + Vector + LLM Reranking)
- **Docker sandbox** — Gemini CLI's built-in Docker sandbox with custom image and bind-mount isolation
- **Cron scheduling** — Recurring tasks with file-based context sharing
- **MCP tool ecosystem** — Built-in MCP servers for Google Workspace, search, cron, and user interaction
- **Multi-channel messaging** — Discord and Slack adapters via Vercel Chat SDK
- **Template system** — Managed agent instructions, skills, and heartbeat checks
- **Skill management** — Install, scan (3-layer security check), enable/disable community skills
- **Analytics dashboard** — Web UI with pool visualization, run viewer, and usage analytics

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| **macOS** | Fully supported | Docker sandbox ([OrbStack](https://orbstack.dev/) recommended), Keychain, homebrew |
| **Linux** | Supported | Docker sandbox, gog requires manual install |
| **Windows** | Not supported | Use WSL2 with Linux instructions |

---

## Prerequisites

### Required

| Tool | Version | Install | Purpose |
|------|---------|---------|---------|
| **Node.js** | >= 20 | [nodejs.org](https://nodejs.org/) or `brew install node` | TypeScript build & runtime |
| **Bun** | >= 1.3 | [bun.sh](https://bun.sh/) | Package manager & script runner |
| **Docker** | latest | [Docker Desktop](https://www.docker.com/products/docker-desktop/) / [OrbStack](https://orbstack.dev/) (macOS) / [Docker Engine](https://docs.docker.com/engine/install/) (Linux) | Sandbox isolation (required for `sandbox: true`) |
| **Inngest CLI** | latest | `bunx inngest-cli@latest` (auto-fetched) | Durable function runtime |

> **Note**: Gemini CLI is automatically installed as a local dependency when you run `bun install`. No global installation is needed. On first launch (`bunx gemini`), a browser window opens for Google OAuth authentication. Credentials are stored in `~/.gemini/` and shared between local and global installations.

### Process Management (for `task start`)

| Tool | Install | Purpose |
|------|---------|---------|
| **overmind** | `brew install overmind` (macOS) / see Linux setup below | Procfile-based process manager |
| **tmux** | `brew install tmux` (macOS) / `apt install tmux` (Linux) | Required by overmind |
| **Task** | `brew install go-task` (macOS) / see Linux setup below | Task runner ([docs](https://taskfile.dev/)) |

### Optional — Host Tools

These run on the **host machine** (outside the sandbox). Install manually.

| Tool | Install | Purpose |
|------|---------|---------|
| **gog** | `brew install steipete/tap/gogcli` (macOS) / `go install github.com/steipete/gog@latest` (Linux) | Google Workspace CLI — runs as MCP server on host (heartbeat skill) |
| **Tailscale** | [tailscale.com/download](https://tailscale.com/download) | Preview server sharing over tailnet (see [Preview Server](#preview-server)) |

> Agent skill dependencies (chromium, gh, poppler, tesseract, etc.) are pre-installed in the Docker sandbox image via `sandbox.Dockerfile`. No manual setup needed.

### One-liner setup (macOS)

```bash
brew install node go-task overmind tmux
curl -fsSL https://bun.sh/install | bash
```

### One-liner setup (Ubuntu / Debian / WSL2)

```bash
# Node.js + Bun + tmux
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs tmux
curl -fsSL https://bun.sh/install | bash

# Docker Engine
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io
sudo usermod -aG docker $USER  # Log out and back in to apply

# go-task
sudo sh -c 'curl -fsSL https://taskfile.dev/install.sh | sh -s -- -d -b /usr/local/bin'

# overmind
ARCH=$(dpkg --print-architecture)  # amd64 or arm64
curl -fsSL -o /tmp/overmind.gz "https://github.com/DarthSim/overmind/releases/latest/download/overmind-v2.5.1-linux-${ARCH}.gz"
gunzip /tmp/overmind.gz && chmod +x /tmp/overmind && sudo mv /tmp/overmind /usr/local/bin/
```

> **WSL2 Notes**:
> - **Docker**: Either install Docker Engine inside WSL2 (above) or enable [Docker Desktop WSL2 backend](https://docs.docker.com/desktop/wsl/). Both work.
> - **Filesystem**: Clone the repo under `~/` (Linux filesystem), not `/mnt/c/` (Windows mount). The Windows mount has significant I/O overhead.
> - **Vault**: OS Keychain (`@napi-rs/keyring`) is unreliable on WSL2. GeminiClaw auto-falls back to `encrypted-file` backend — no action needed.
> - **Notifications**: `notify-send` requires `libnotify-bin` (`sudo apt-get install -y libnotify-bin`). Notification delivery depends on your WSL2 setup and may not work in all configurations — failures are silently ignored.

## Quick Start

```bash
git clone https://github.com/geminiclaw/geminiclaw.git
cd geminiclaw
bun install                  # Gemini CLI + QMD + patches auto-applied
bunx gemini                  # First launch opens browser for Google OAuth
task setup                   # build → bun link → interactive setup wizard

# Start all services (Inngest + geminiclaw)
task start                   # = overmind start (see Procfile)
```

### Procfile Environment Variables

Overmind auto-loads `.env`. These variables customize the Procfile services:

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVE_PORT` | `3000` | Express server port (also used by Inngest) |

### Browser Automation (optional)

Required by `agent-browser` and `deep-research` skills:

```bash
bun install -g agent-browser
```

#### Authenticated Browsing

To let the agent operate the browser while logged into a site, save the authentication state in advance:

```bash
# A browser window opens — navigate to the site you want to log into, sign in, then press Enter to save
geminiclaw browser login

# To open a specific URL directly
geminiclaw browser login https://amazon.co.jp
```

Saved cookies are stored at `~/.geminiclaw/browser-auth-state.json` and are automatically restored when the agent uses `agent-browser`.

```bash
geminiclaw browser status    # Check saved auth state
geminiclaw browser reset     # Delete saved auth state
```

> **Note**: Google login is blocked by automation detection ([agent-browser#271](https://github.com/vercel-labs/agent-browser/issues/271)). Non-Google sites (Amazon, GitHub, etc.) work without issues.

### Google Workspace via gog (optional)

Required by the heartbeat skill for Gmail, Calendar, Drive access:

```bash
# 1. Install gog CLI
#    macOS:
brew install steipete/tap/gogcli
#    Linux / WSL2 (requires Go 1.21+):
#    go install github.com/steipete/gog@latest

# 2. Set up Google Cloud OAuth credentials
#    Download client_secret JSON from Google Cloud Console, then:
gog auth credentials ~/Downloads/client_secret_*.json

# 3. Authenticate your Google account
gog auth add YOUR_EMAIL@gmail.com    # Opens browser for OAuth consent

# 4. Verify
gog auth list                        # Should show your account

# 5. Register with GeminiClaw (interactive wizard handles this)
geminiclaw setup
```

The gog MCP server runs on the host (not inside the sandbox) and uses Keychain-stored OAuth tokens. See [gog setup guide](https://github.com/steipete/gog#setup) for detailed Google Cloud Console instructions.

### Preview Server

The preview server lets the agent share generated HTML reports, images, and other files via URL. It runs on a separate port (main port + 1 by default) for origin isolation — agent-generated content cannot access the main server's APIs.

When [Tailscale](https://tailscale.com/) is installed and connected, GeminiClaw automatically runs `tailscale serve` to expose the preview directory over the tailnet with HTTPS via MagicDNS. This lets you access preview URLs from any device on your tailnet without port forwarding or manual DNS setup. If Tailscale is not available, previews fall back to `localhost`.

```
# With Tailscale:    https://your-machine.tail1234.ts.net/preview/report.html
# Without Tailscale: http://localhost:3001/preview/report.html
```

Configuration in `~/.geminiclaw/config.json`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `preview.enabled` | boolean | `true` | Enable the preview server |
| `preview.port` | number | main port + 1 | Preview server port |
| `preview.cleanupHours` | number | `72` | Auto-delete preview files older than N hours (0 = disabled) |

---

## Architecture

GeminiClaw wraps **Gemini CLI as the core agent engine** with thin orchestration layers. See [docs/architecture.md](docs/architecture.md) for full details.

| Concern | Delegated To |
|---|---|
| LLM reasoning & tool use | **Gemini CLI** (ACP) |
| Durable execution & scheduling | **Inngest** |
| Memory search & retrieval | **QMD** |
| Multi-channel messaging | **Vercel Chat SDK** |

Related documentation:
- [Architecture](docs/architecture.md) — turn lifecycle, process pool, scheduling, memory model
- [Security](docs/security.md) — Docker sandbox, agent-blind secrets, tool effect gate, skills scanner
- [Memory](docs/memory.md) — write/read timing, reliability spectrum
- [Vault](docs/vault.md) — backend selection, encryption details

### Vault — Secret Storage

API tokens and credentials used by GeminiClaw (Discord bot token, Slack signing secret, etc.) should be stored in the vault rather than plaintext in config.json. The vault encrypts secrets and keeps them invisible to the agent process.

```bash
# Store a new secret
geminiclaw vault set discord-token

# Migrate an existing plaintext config value to the vault
geminiclaw vault migrate channels.discord.token discord-token
# Then update config.json: "token": "xoxb-..." → "token": "$vault:discord-token"

# Check vault status
geminiclaw vault status
```

Config values prefixed with `$vault:` are automatically resolved from encrypted storage at startup:

```jsonc
{
  "channels": {
    "discord": { "token": "$vault:discord-token" },
    "slack": {
      "token": "$vault:slack-token",
      "signingSecret": "$vault:slack-signing-secret"
    }
  }
}
```

For backend selection, encryption details, and external command integration, see [docs/vault.md](docs/vault.md).

---

## Configuration

`~/.geminiclaw/config.json`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | `"auto"` | Gemini model name |
| `workspace` | string | `~/.geminiclaw/workspace` | Workspace path |
| `sandbox` | boolean \| string | `true` | `true` (auto-detect) / `false` / `"seatbelt"` / `"docker"` |
| `timezone` | string | `""` | IANA timezone (e.g. `"Asia/Tokyo"`) |
| `language` | string | `"en"` | Agent response language (IETF tag, e.g. `"ja"`) |
| `heartbeatIntervalMin` | number | `30` | Heartbeat interval in minutes |
| `maxToolIterations` | number | `50` | Max tool calls per run |
| `sessionIdleMinutes` | number | `60` | Session expiry (0 = never resume) |
| `autonomyLevel` | string | `"autonomous"` | `autonomous` / `supervised` / `read_only` |
| `gogAccount` | string | — | Google account for gog CLI (e.g. `"user@gmail.com"`) |
| `vault.backend` | string | `"auto"` | `auto` / `keyring` / `encrypted-file` / `command` |

For the full schema including heartbeat notifications, preview server, cost tracking, and session summary options, run `geminiclaw config show`.

### Workspace Config

Agents can self-modify behavioral settings by writing to `{workspace}/config.json`. Only non-secret fields are allowed (model, autonomyLevel, maxToolIterations, etc.).

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `geminiclaw setup` | Interactive setup wizard |
| `geminiclaw init` | Initialize workspace and MCP configs |
| `geminiclaw start` | Start Express server + Chat SDK (use `task start` to include all services) |
| `geminiclaw run <prompt> [-s ID]` | Run a one-shot task (`-s` to continue a session) |
| `geminiclaw status` | Show active run, recent sessions, and workspace info |
| `geminiclaw dashboard [--inngest]` | Open web dashboard (`--inngest` for Inngest dev server) |
| `geminiclaw config show/get/set` | Configuration management (`--reveal` to unmask secrets) |
| `geminiclaw sync-templates [--force]` | Sync template files to workspace (`--force` for 3-way merge of protected files) |
| `geminiclaw session list [--date]` | List sessions |
| `geminiclaw browser login/status/reset` | Browser auth state management |
| `geminiclaw vault set/get/list/delete/status` | Secret management |
| `geminiclaw vault migrate <config-key> <vault-key>` | Move plaintext config token to vault |
| `geminiclaw cron list/add/remove` | Cron job management |
| `geminiclaw skill list/enable/disable` | Manage workspace skills |
| `geminiclaw skill install/search/remove` | Install or remove community skills |
| `geminiclaw upgrade [--dev]` | Pull latest from main (or develop with `--dev`), rebuild, and sync templates |

---

## Development

```bash
task start          # Start all services in foreground (Ctrl-C to stop)
task start -- -d    # Start as daemon
task install        # Build + bun link

bun run build       # TypeScript compile
bun test            # vitest
bun run typecheck   # Type check only
bun run lint        # Biome lint
bun run format      # Biome format

# overmind operations (when running via task start)
overmind connect serve       # Attach to serve process
overmind restart inngest     # Restart individual service
overmind stop                # Stop all services
```

### Gemini CLI Patches

Gemini CLI (`@google/gemini-cli`) is bundled as a local dependency, and the following patches are automatically applied via `bun patch` during `bun install`.

| Patch | Target Package | Description | Upstream Issue/PR |
|-------|---------------|-------------|-------------------|
| usageMetadata | `@google/gemini-cli` | Returns token usage upon ACP `session/prompt` completion | — |
| ACP stdin bypass | `@google/gemini-cli` | Prevents sandbox mode from consuming ACP's JSON-RPC stdin stream | — |
| loadSession streamHistory | `@google/gemini-cli` | Removes `streamHistory()` replay that contaminates next-turn responses | — |
| registerToolByName | `@google/gemini-cli-core` | Fixes sub-agent MCP tool registration prefix check bug | [#18712](https://github.com/google-gemini/gemini-cli/issues/18712) |
| Discord reconnect | `@chat-adapter/discord` | Fixes Gateway reconnection handling | — |
| QMD LLM compat | `@tobilu/qmd` | Compatibility fix for QMD's LLM integration | — |

Patch files are stored in the `patches/` directory and automatically applied during `bun install`. When updating dependency versions, check whether the fixes have been merged upstream and remove the patches if no longer needed.

```bash
# Dependency version update procedure
bun add @google/gemini-cli@<version>        # Update dependency
bun patch @google/gemini-cli                # Prepare for editing
# ... make changes in node_modules/@google/gemini-cli/ ...
bun patch --commit node_modules/@google/gemini-cli  # Regenerate patch
```

### Source Layout

```
src/
├── agent/             Turn lifecycle, ACP client/pool, session management
├── config/            Zod schema, config I/O, paths, Gemini CLI settings
├── memory/            SQLite usage tracking
├── mcp/               MCP servers (status, cron, ask-user, gog, admin)
├── channels/          Chat SDK adapters + reply delivery (Discord/Slack)
├── inngest/           Durable functions (agent-run, heartbeat, cron, daily-summary)
├── cli/commands/      CLI command implementations
├── vault/             Secret management (keyring/encrypted-file/command)
├── skills/            Skill management (install/scan/enable/disable)
├── dashboard/         Web analytics dashboard
├── eval/              Evaluation framework
└── upgrade/           Self-update and config merge

templates/             Workspace templates (source of truth)
├── AGENTS.md          Agent behavior rules
├── HEARTBEAT.md       Heartbeat checklist
├── .gemini/skills/    Skill definitions
└── ...
```

## License

[MIT](LICENSE)
