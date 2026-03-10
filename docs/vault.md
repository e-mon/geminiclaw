# Vault — Implementation Details

For basic usage (storing secrets, `$vault:` references, migration), see the [Vault section in README](../README.md#vault--secret-storage).

For security context (Agent-Blind pattern, env allowlist), see [docs/security.md](security.md#agent-blind-secrets).

---

## Backend Selection

When `backend: "auto"` (default):

```
KeyringBackend.isAvailable() → success → KeyringBackend (OS keychain)
                              → failure → EncryptedFileBackend (~/.geminiclaw/vault.enc)
```

| Backend | Storage | Requirements |
|---------|---------|--------------|
| `keyring` | OS keychain (macOS Keychain, GNOME Keyring, etc.) | `@napi-rs/keyring` required. Not supported on WSL2 |
| `encrypted-file` | `~/.geminiclaw/vault.enc` | No dependencies. Always available |
| `command` | Delegated to external tool | `list()` is empty so `$vault:` references are non-functional |

### External Command Backend

```jsonc
{
  "vault": {
    "backend": "command",
    "command": "pass show geminiclaw/{key}",
    "setCommand": "pass insert --force geminiclaw/{key}"
  }
}
```

Supports `pass`, `op` (1Password CLI), etc. However, `list()` returns an empty array so `$vault:` references do not work — only the `vault get <key>` CLI is available.

---

## Encryption (encrypted-file backend)

- **Algorithm**: AES-256-GCM (random IV per secret)
- **Key derivation**: `scrypt(password='geminiclaw-vault-key', salt=hostname+username)`
- **Password is hardcoded in source** — effective protection relies on file permissions (0o600)
- Machine-specific salt makes decryption impossible on another machine (intentional: forces explicit migration)
- Same security level as Gemini CLI's HybridTokenStorage

**Defense scope**: Prevents accidental plaintext exposure in backups, log collection, etc. Does not defend against a local privileged attacker.

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| init-once, sync-access pattern | `loadConfig()` is called synchronously in 25+ places; async conversion is impractical |
| Keyring preferred + encrypted-file fallback | Same pattern as Gemini CLI. Works on WSL2 |
| `$vault:` prefix scheme | Minimal schema changes. All references searchable via `grep` |
| Machine-specific encryption key | Passphrase input is incompatible with cron/Inngest automated execution |
| resolveSync() returns undefined when uninitialized | `loadConfig()` does not break. Env var fallback provides recovery |
| Key name validation (`[a-zA-Z0-9_.\-/]+`) | Prevents shell injection in external command backend |

**Files**: `src/vault/index.ts`, `src/vault/encrypted-file.ts`, `src/vault/keyring.ts`, `src/vault/external-command.ts`
