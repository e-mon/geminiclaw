---
name: self-manage
description: Self-management via geminiclaw_admin MCP tool. Config, skills, upgrade, sessions.
enabled: true
---

# Self-Management

`geminiclaw_admin` MCP tool to run geminiclaw CLI commands on the host.

## Tool Usage

```
geminiclaw_admin({ args: ["<command>", "<subcommand>", ...] })
```

## Available Commands

### Config (read)

```
geminiclaw_admin({ args: ["config", "show"] })
geminiclaw_admin({ args: ["config", "get", "model"] })
geminiclaw_admin({ args: ["config", "get", "heartbeat.model"] })
```

### Config (write — requires user confirmation)

```
geminiclaw_admin({ args: ["config", "set", "model", "pro"] })
geminiclaw_admin({ args: ["config", "set", "heartbeat.notifications", "desktop"] })
```

Model values: `auto`, `pro`, `flash`, `flash-lite`, `auto-gemini-2.5`, `gemini-2.5-pro`, `gemini-2.5-flash`

### Skill Management

```
geminiclaw_admin({ args: ["skill", "list"] })
geminiclaw_admin({ args: ["skill", "enable", "<name>"] })
geminiclaw_admin({ args: ["skill", "disable", "<name>"] })
```

Skill install/remove require user confirmation:

```
geminiclaw_admin({ args: ["skill", "install", "<ref>"] })
geminiclaw_admin({ args: ["skill", "remove", "<name>"] })
```

### Upgrade

Check for updates (safe, no side effect):

```
geminiclaw_admin({ args: ["upgrade", "--check"] })
```

Apply upgrade (requires user confirmation):

```
geminiclaw_admin({ args: ["upgrade"] })
```

### Session Management (read-only)

```
geminiclaw_admin({ args: ["session", "list"] })
geminiclaw_admin({ args: ["session", "show", "<id>"] })
```

### Status (read-only)

```
geminiclaw_admin({ args: ["status"] })
```

### Eval (read-only for report, write for run)

```
geminiclaw_admin({ args: ["eval", "list"] })
geminiclaw_admin({ args: ["eval", "report"] })
```

## Blocked Commands

The following are blocked to prevent recursion, secret leakage, or destructive behavior:

- `run` — would spawn a nested agent
- `start` — would start a second server
- `init` — workspace re-initialization
- `dashboard` — opens browser dashboard (no use from agent)
- `vault` — secrets must be managed by the user directly (see AGENTS.md)

## Side Effect Classification

| Command | Side Effect | Confirmation |
|---|---|---|
| `config show/get` | read | No |
| `config set` | write | Yes |
| `skill list/enable/disable` | read | No |
| `skill install` | write | Yes (intercepted with scan) |
| `skill remove` | delete | Yes |
| `upgrade --check` | read | No |
| `upgrade` (apply) | send | Yes |
| `session list/show` | read | No |
| `status` | read | No |
| `eval list/report` | read | No |

## When to Use

- User asks to change model, config, or settings
- User asks about installed skills or wants to install/remove one
- User requests a system upgrade check
- User asks about session history
- Heartbeat detects outdated templates or available upgrades
