# Vault Architecture — GeminiClaw シークレット管理

> **ステータス**: Vault コア実装済み。Agent-Blind 強化（env ホワイトリスト・browser-profile）は未実装。

## 1. 課題

| 問題 | 影響 | 状態 |
|------|------|------|
| config.json に平文トークン | ファイルアクセスで読める | ✅ `$vault:` 参照で解決済み |
| `.env` にも平文トークン | `process.env` に読み込まれる | ⚠️ vault migrate は手動 |
| `runner.ts` が `...process.env` で全 env を渡す | `printenv` で丸見え | ❌ 未対応 |
| agent-browser の認証 | cookie/token の直接渡しが必要 | ❌ 未対応 |
| `vault.init()` が実行パスで呼ばれない | `$vault:` が解決されない | ❌ 未対応 |

### シークレットのデータフロー

```
config.json ($vault:xxx)
  │
  ├──[起動時]─→ vault.init() → backend.list() → backend.get() → cache (Map)
  │
  ├──[loadConfig() 呼び出し時]─→ vault.resolveSync($vault:xxx) → 平文値
  │                                ↓ 失敗時
  │                              env フォールバック (DISCORD_TOKEN 等)
  │
  ├──[spawnGemini() 時]─→ env ホワイトリスト適用 → 子プロセスに渡る env を制限
  │
  └──[MCP server 起動時]─→ resolveMcpEnv() → settings.json に平文で書き出し
                            (Gemini CLI の制約で回避不可、低リスクキーに限定)
```

**Agent-Blind の目標**: vault → ホスト側で解決 → Gemini CLI にはホワイトリスト env のみ。

---

## 2. 先行実装調査

- **Gemini CLI HybridTokenStorage**: macOS → Keychain, Linux → Secret Service, WSL2 → encrypted-file フォールバック。GeminiClaw はこの 2 段フォールバックを踏襲。
- **openclaw-secure**: `.env` + `dotenv`（暗号化なし）
- **ZeroClaw**: 外部コマンド (`pass`, `1password-cli`) 委譲パターン

---

## 3. 実装済み: VaultBackend と Vault Singleton

### VaultBackend インターフェース (`src/vault/types.ts:5-13`)

```typescript
export interface VaultBackend {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    list(): Promise<string[]>;
    isAvailable(): Promise<boolean>;
    readonly name: string;
}
```

### 3 つのバックエンド

| バックエンド | 保存先 | 制約 |
|---|---|---|
| `KeyringBackend` | OS キーチェーン (`@napi-rs/keyring`) | WSL2 非対応 |
| `EncryptedFileBackend` | `~/.geminiclaw/vault.enc` | 鍵ハードコード（後述） |
| `ExternalCommandBackend` | 外部ツール任せ | **非推奨**: `list()` が `[]` で `$vault:` 不可 + シェルインジェクションリスク |

**EncryptedFileBackend のセキュリティモデル**: 鍵導出は `scrypt(password='geminiclaw-vault-key', salt=hostname+username)` で、password がソースコードにハードコード。実質的な防御はファイルパーミッション（0o600）に依存する。暗号化の役割は偶発的暴露（バックアップ、ログ収集等）の防止。Gemini CLI の HybridTokenStorage と同等。

**ExternalCommandBackend は非推奨**: `list()` が `[]` → init() でキャッシュが空 → `$vault:` 参照が機能しない。加えて `execSync` にキーを直接埋め込むシェルインジェクションリスクがある。Phase 1 で `parseVaultRef()` にキー名バリデーションを追加して緩和し、公式サポートは将来の需要次第で判断する。`vault.get()` (async) は正常動作するため `vault get <key>` CLI は使用可能。

### バックエンド自動選択 (`vault/index.ts:76-82`, `backend: 'auto'`)

```
KeyringBackend.isAvailable() → 成功 → KeyringBackend
                              → 失敗 → EncryptedFileBackend
```

### Vault Singleton — "init once, sync access" (`vault/index.ts:85-191`)

`resolveSync()` (`vault/index.ts:131-136`) の挙動:
- 非 vault 値 → そのまま返す
- `$vault:` 参照 → cache から解決。見つからなければ **undefined**（throw しない）
- vault 未初期化時も同じ（cache が空 → undefined → env フォールバックで救済）
- `get()`/`set()`/`delete()`/`list()` は未初期化時に **throw**

---

## 4. 実装済み: `$vault:` 参照と loadConfig() 統合

config.json で `"$vault:discord-token"` → `parseVaultRef()` (`types.ts:79-82`) でキー抽出 → `vault.resolveSync()` で解決。

**loadConfig() のマージ順序** (`config/io.ts:29-87`): Zod デフォルト → config.json → workspace config → vault 解決 (`io.ts:66-68`) → env フォールバック (`io.ts:71-84`)。

対象フィールド: `channels.discord.token`, `channels.slack.token`, `channels.slack.signingSecret`。
`embedding.jinaApiKey` は **未対応**（Phase 1 で追加）。

---

## 5. 実装済み: CLI コマンド

`vault set/get/list/delete/status/migrate`。migrate は 1 フィールドずつ手動（config.json の自動書き換えなし）。

---

## 6. 未実装: vault.init() 統合

`vault.init()` は `cli/commands/vault.ts:44-47` 内でのみ呼ばれ、`start`/`run`/Inngest では呼ばれない。

**対策**: CLI preAction フック (`cli/index.ts`) + `serve.ts` 起動時に `vault.init()` 追加。`loadEnvFile()` は不要（vault は env に一切依存しない）。

**実行タイミング**:
```
[プロセス起動] → vault.init() → [loadConfig() × N回] → resolveSync() はキャッシュ参照のみ
```
`vault.init()` は loadConfig() の **前** に 1 回だけ呼ぶ。以降の loadConfig() 呼び出し（25+箇所）は全て同期的にキャッシュから解決。

---

## 7. 未実装: Agent-Blind パターン

### 7a. spawnGemini env ホワイトリスト

`runner.ts:455-458` の `{ ...process.env }` をホワイトリスト方式に変更。`spawnGemini()` 1 箇所の修正で全 5 呼び出し元に適用。

```typescript
const SPAWN_ENV_ALLOWLIST = [
    'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR',
    'GEMINI_API_KEY', 'AGENT_BROWSER_PROFILE',
] as const;
```

`options.env` は内部 API からのみ使用する前提（JSDoc に明記）。

### 7b. MCP server env 注入

`settings.json` の `$vault:` 参照を `resolveMcpEnv()` で解決。vault にキーがない `$vault:` 参照は **env から省略**（生文字列リーク防止）。

**settings.json 漏洩リスク**: 解決済みの値が `{workspace}/.gemini/settings.json` に平文で書き出される。Gemini CLI の設計上回避困難。低リスクキー（embedding API key）に限定する運用で対処。

### 7c. Sandbox 分離の全体像

```
ホスト (GeminiClaw プロセス)
  vault.init() → キャッシュ → loadConfig() / MCP env 解決
  ↓ spawn (Seatbelt + env ホワイトリスト)
Gemini CLI (sandbox 内)
  ✓ PATH, HOME, GEMINI_API_KEY, AGENT_BROWSER_PROFILE
  ✗ DISCORD_API_KEY, SLACK_BOT_TOKEN, JINA_API_KEY
  △ .gemini/settings.json は読める (低リスクキーのみ)
```

`GEMINI_API_KEY` は Gemini CLI 自体が必要なため渡すしかない（Agent-Blind の限界として受容）。

---

## 8. 未実装: agent-browser 認証 — Profile 方式

`agent-browser --profile <path>` / `AGENT_BROWSER_PROFILE` env で認証済み Chromium プロファイルを事前作成。`agent-browser --help` (v0.15.0) で確認済み。

```
エージェントが知ること: プロファイルのパス
エージェントが知らないこと: パスワード、cookie 値、OAuth トークン
```

**profile を選択した理由**: Chromium 暗号化 DB による Agent-Blind 特性（`state save/load` は JSON 平文で cookie が見える）。MCP 化は不要、既存の CLI + Bash スキル方式を維持。

**Seatbelt 書き込み権限**: `~/.geminiclaw/browser-profiles/` は許可リスト外。agent-browser デーモンはホスト上で動作するため Seatbelt の影響を受けない可能性が高いが、実機テストが必要。

---

## 9. Migration パス

**安全な順序**:

```
1. Phase 1 コード変更を適用（vault.init() 統合 + env ホワイトリスト）
2. geminiclaw vault migrate でシークレットを vault に保存
3. config.json を $vault: 参照に書き換え
4. 動作確認
5. .env からシークレット行を削除（GEMINI_API_KEY は残す）
```

**ロールバック**: config.json を平文に戻す（`vault get <key>` で値確認可能）。vault.enc は `cp` でバックアップ可。

**後方互換**: `$vault:` のない値はそのまま使用。vault 未初期化でも env フォールバックで機能。

---

## 10. セキュリティ監査結果と実装フェーズ

### Phase 1: vault 統合 + env ホワイトリスト + 高リスク修正

| タスク | ファイル | 備考 |
|---|---|---|
| vault.init() を preAction フック + serve.ts に追加 | `cli/index.ts`, `serve.ts` | |
| `...process.env` → ホワイトリスト | `runner.ts` | |
| `embedding.jinaApiKey` を vault 解決対象に追加 | `config/io.ts` | |
| **S1: シェルインジェクション緩和** | `types.ts` | `parseVaultRef()` にキー名バリデーション (`/^[a-zA-Z0-9_-]+$/`)。ExternalCommandBackend の `execFile` 化は非推奨解除時に実施 |
| **S2: ファイルパーミッション** | `io.ts`, `setup.ts`, `config-show.ts`, `encrypted-file.ts` | config.json に `mode: 0o600`、ディレクトリに `0o700` |
| **S3: vault 解決済みトークンの書き戻し防止** | `setup.ts`, `io.ts` | `saveConfig()` を廃止し、config.json を read→patch→write する `patchConfigFile()` に置換。vault 解決済みの Config オブジェクトをディスクに書かない |
| **S4: `config get` マスキング** | `config-show.ts` | シークレットフィールド検出時にマスク、`--reveal` で解除 |

**テスト**: E2E (vault→loadConfig 解決)、env ホワイトリスト (禁止 env 非漏洩)、キー名バリデーション

### Phase 2: MCP env 注入 + browser-profile + 中低リスク修正

| タスク | ファイル | 備考 |
|---|---|---|
| `resolveMcpEnv()` 追加 | `gemini-settings.ts` | |
| `AGENT_BROWSER_PROFILE` を spawn env に注入 | `run-turn.ts` | |
| `browser-profile` CLI コマンド | `browser-profile.ts` (新規) | setup/list/delete/test |
| **S5: vault.enc atomic write** | `encrypted-file.ts` | 一時ファイル + rename |
| **S6: shutdown キャッシュクリア** | `vault/index.ts` | SIGINT/SIGTERM で `cache.clear()` |
| **S8: デバッグ JSONL 制御** | `runner.ts` | パーミッション 0o600 or フラグ化 |
| **S9: ask-user ログ除去** | `ask-user-server.ts` | 回答内容を redact |

### テストカバレッジ現状

| コンポーネント | カバレッジ | 備考 |
|---|---|---|
| `EncryptedFileBackend` | ~90% | `isAvailable()` 未テスト |
| `KeyringBackend` | 0% | optional 依存 |
| `ExternalCommandBackend` | 0% | 外部バイナリ依存 |
| `parseVaultRef()` / `resolveSync()` | 100% | 全分岐 |

Phase 2 で KeyringBackend (CI スキップ) と ExternalCommandBackend (mock) のテストを追加。

---

## 設計判断の根拠

| 判断 | 理由 |
|---|---|
| Keyring 優先 + encrypted-file フォールバック | Gemini CLI の実績あるパターン。WSL2 でも動作保証 |
| `$vault:` プレフィックス方式 | スキーマ変更最小。grep で参照箇所を特定可能 |
| resolveSync() が未初期化時 undefined を返す | loadConfig() が壊れない。env フォールバックで後方互換 |
| マシンバインド鍵 (encrypted-file) | パスフレーズ入力は自動実行（cron/Inngest）と相性が悪い |
| env ホワイトリスト | `...process.env` は Agent-Blind の最大の穴。最小権限で塞ぐ |
| browser-profile | Chromium 暗号化 DB で Agent-Blind。既存 CLI 方式を維持。保守コスト低 |
| settings.json 漏洩リスクの受容 | Gemini CLI の設計上回避困難。低リスクキーに限定 |
