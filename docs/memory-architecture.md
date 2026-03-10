# GeminiClaw メモリアーキテクチャ

GeminiClawにおける記憶の書き込み・読み込み・圧縮の全操作を、タイミングと実施主体ごとに整理する。

---

## 全体フロー

```
runAgentTurn() — run-turn.ts:133
│
├─ [1] buildAgentContext()     ← 実行前: 記憶の読み込み + GEMINI.md 生成
│
├─ [2] runGemini()             ← 実行中: エージェントが自発的に記憶操作
│
└─ [3] postProcessRun()        ← 実行後: システムによる自動保存
```

---

## [1] 実行前 — buildAgentContext()

`run-turn.ts:48–65` → `context-builder.ts:48–183`

エージェントに渡す GEMINI.md を組み立てる。ここで過去の記憶がコンテキストに注入される。

### 1-a. 静的ファイル読み込み（Gemini CLI委譲）

```
context-builder.ts:63–68
```

| ファイル | 内容 | 注入方法 |
|---|---|---|
| `MEMORY.md` | 長期記憶（< 5KB） | `@MEMORY.md`（Gemini CLIが展開） |
| `SOUL.md` | エージェントの性格・指針 | 同上 |
| `AGENTS.md` | マルチエージェント設定 | 同上 |
| `USER.md` | ユーザー固有の設定 | 同上 |

GEMINI.md に `@MEMORY.md` というリテラルを書くだけ。実際のファイル読み込みはGemini CLIが行う。

### 1-b. 日次ログ自動注入（今日 + 昨日）

```
context-builder.ts:70–76, 211–228
```

- `memory/YYYY-MM-DD.md`（今日分 + 昨日分）を読み込み
- GEMINI.md に `## Recent Activity` セクションとしてインライン注入
- タイムゾーンは設定値で解決（`sv-SE` ロケールで `YYYY-MM-DD` 形式取得）

### 1-c. セッション履歴注入（JSONL → Markdown）

```
context-builder.ts:79–86 → session.ts:328–362 (formatAsContext)
```

- `sessions/<sessionId>.jsonl` から直近エントリを読み込み
- `User: <prompt>` / `Agent: <response>` / `Tools used: ...` の対話形式に変換
- GEMINI.md に `## Recent Session History` セクションとして注入

### 1-d. セッション履歴のコンパクション（条件付き）

```
run-turn.ts:52–56 → session.ts:263–320 (loadRecentWithCompaction)
```

- 直近20エントリを読み込み
- 推定トークン数が `maxTokens * 0.8`（デフォルト: 4000 * 0.8 = 3200）を超えた場合:
  - 直近エントリで予算内に収まる分を残す
  - 残りを `GeminiCompactor` に渡す
- `GeminiCompactor`（`session.ts:64–110`）は Gemini CLI を呼び出して要約を生成
  - 要約は `[Session summary covering N earlier entries]` 形式の合成エントリになる
- **コンパクションは読み込み時のみ発生。JSONL自体は書き換えない（追記のみ）**

### 1-e. Gemini CLIセッション継続判定

```
run-turn.ts:76–77 → session.ts:124–133 (evaluateSessionFreshness)
```

- 最後のエントリの `geminiSessionId` と経過時間をチェック
- 60分（設定可能）以内なら `--resume <id>` フラグをGemini CLIに渡す
- Gemini CLI本体が持つネイティブの会話コンテキスト（KVキャッシュ含む）を継承

---

## [2] 実行中 — エージェントの自発的記憶操作

Gemini CLIが起動中、エージェント自身がツールを使って記憶を操作する。
**すべてエージェントの判断で実行され、GeminiClawシステムは関与しない。**

### 2-a. MEMORY.md 編集（ファイルツール）

- エージェントがGemini CLIのネイティブファイルツールで直接編集
- GEMINI.md の `## Memory Management` セクションで以下を指示:
  > After taking significant actions or learning important information:
  > 1. Edit `MEMORY.md` — add new facts, remove outdated ones (keep < 5KB)
- **書き込みタイミング: エージェントが「重要」と判断したとき（不確実）**

### 2-b. 日次ログ追記（ファイルツール）

- エージェントが `memory/YYYY-MM-DD.md` にMarkdown形式で追記
- GEMINI.md の指示:
  > 2. Append to `memory/YYYY-MM-DD.md` for the audit trail
- **書き込みタイミング: エージェントが行動を取ったとき（不確実）**

### 2-c. remember / recall / forget（MCP ツール）

```
memory/mcp-server.ts → memory/db.ts
```

| ツール | 操作 | 保存先 |
|---|---|---|
| `remember(content, category?, tags?)` | SQLiteに記憶を保存 + 埋め込みベクトル生成 | `memory/memory.db` |
| `recall(query, limit?)` | FTS5（+ sqlite-vec RRF）でハイブリッド検索 | — (読み取りのみ) |
| `forget(id)` | ID指定で記憶を削除 | `memory/memory.db` |

- Embedderが設定されていれば `remember` 時に自動でベクトル化（Jina API or ローカルMLX）
- `recall` 時もクエリをベクトル化し、FTS5結果とRRFで統合
- **MEMORY.mdとは独立したストレージ。MEMORY.mdは汎用テキスト、こちらは構造化検索向き**

### 2-d. 実行中のシステム側書き込み（自動）

実行中にシステムが書き込むファイルもある（エージェントの操作ではない）。

| ファイル | タイミング | 内容 | コード |
|---|---|---|---|
| `memory/run-progress.json` | tool_use イベントごと | runId, lastToolUse, toolName | `runner.ts:372–386` |
| `memory/last-run-events.jsonl` | 全stream-jsonイベント | タイムスタンプ付き生ログ | `runner.ts:356–362` |

これらは `geminiclaw_status` MCPツールやデバッグ用途で参照される。

---

## [3] 実行後 — postProcessRun()

`run-turn.ts:107–124`

Gemini CLIプロセス終了後に**自動で**実行される。エージェントの判断に依存しない。

### 3-a. セッションJSONL追記

```
session.ts:177–182 (SessionStore.append)
```

- `sessions/<sessionId>.jsonl` に1行追記
- 保存内容: runId, timestamp, trigger, prompt, responseText, toolCalls, tokens, geminiSessionId
- **次回実行時の [1-c] セッション履歴注入の入力になる**

### 3-b. Markdown セッションログ

```
session.ts:371–412 (SessionStore.saveMarkdownLog)
```

- `sessions/<date>-<time>-<runId>.md` に人間可読なログを書き出し
- Prompt / Response / Tools Used / Tokens / Error の構造
- **HEARTBEAT_OK の場合はスキップ**（ノイズ防止）

### 3-c. トークン使用量記録

```
memory/usage.ts:33–48 (UsageTracker.saveRecord)
```

- `memory/memory.db` の `usage` テーブルに保存
- model, input/output/cached tokens, duration, cost estimate

### 3-d. ワークスペース git commit

```
workspace.ts:71–78 (Workspace.commitChanges)
```

- ワークスペース全体を `git add . && git commit`
- コミットメッセージ: `<trigger>:<runId短縮>`
- 変更がなければスキップ
- **エージェントが書いたMEMORY.md、日次ログ、MCPで保存したmemory.dbの変更も含まれる**

---

## 記憶の種類と特性まとめ

| 記憶の種類 | ストレージ | 書き込み主体 | 書き込みタイミング | 読み込みタイミング | 永続性 |
|---|---|---|---|---|---|
| **MEMORY.md** | ファイル | エージェント（自発） | 実行中（不確実） | 毎回実行前（@import） | git管理 |
| **日次ログ** (`memory/YYYY-MM-DD.md`) | ファイル | エージェント（自発） | 実行中（不確実） | 毎回実行前（今日+昨日） | git管理 |
| **構造化メモリ** (`memory.db` memories表) | SQLite | エージェント（MCPツール） | 実行中（不確実） | 実行中（recall時のみ） | git管理 |
| **セッションJSONL** (`sessions/*.jsonl`) | ファイル | システム（自動） | 毎回実行後 | 毎回実行前（履歴注入） | git管理 |
| **セッションMarkdown** (`sessions/*.md`) | ファイル | システム（自動） | 毎回実行後 | 参照されない（監査用） | git管理 |
| **使用量レコード** (`memory.db` usage表) | SQLite | システム（自動） | 毎回実行後 | status/health API | git管理 |
| **進捗シグナル** (`run-progress.json`) | ファイル | システム（自動） | 実行中（tool_useごと） | geminiclaw_status | 一時的 |
| **デバッグログ** (`last-run-events.jsonl`) | ファイル | システム（自動） | 実行中（全イベント） | デバッグ時 | 毎回上書き |
| **Gemini CLIセッション** | Gemini CLI内部 | Gemini CLI | Gemini CLI管理 | --resume時（60分TTL） | CLI管理 |

---

## エージェント依存 vs システム保証

```
信頼性高 ◄──────────────────────────────────────────► 信頼性低
（システム自動）                                      （エージェント任せ）

sessions/*.jsonl  ←  postProcessRun()で100%保存
sessions/*.md     ←  postProcessRun()で100%保存（heartbeat除外）
memory.db usage   ←  postProcessRun()で100%保存
git commit        ←  postProcessRun()で100%実行

──────────────────────── 境界 ────────────────────────

MEMORY.md         →  エージェントが書く指示はあるが保証なし
memory/日次ログ   →  エージェントが書く指示はあるが保証なし
memory.db memories →  エージェントがrememberツールを呼ぶかは不確実
```

**重要**: セッションJSONLは自動保存されるため、エージェントがMEMORY.mdに書き忘れても
会話履歴は失われない。次回実行時にJSONLから再構築される。
ただしJSONLはセッションスコープ（同一sessionId内）でのみ参照されるため、
セッションをまたいだ長期記憶はMEMORY.mdかrememberツールに依存する。
