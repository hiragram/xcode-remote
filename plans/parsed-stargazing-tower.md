# xcode-remote 実装プラン

## Context

iOS アプリを Claude Code で開発する際、`dangerously-skip-permissions` で自律的に作業させたいが、Mac 全体のアクセスを許すのは危険。コード編集は Docker (Linux) に閉じ込めつつ、ビルド/テスト処理だけ Mac ホストに投げる仕組みが必要。

**xcode-remote** は、Docker 内の Claude Code から Mac ホスト上の xcodebuild を安全にリモート実行するための MCP サーバー。

## アーキテクチャ

```
[Docker コンテナ]                        [Mac ホスト]

 Claude Code                    xcode-remote (Streamable HTTP MCP Server)
   ↕ HTTP                          ↕ spawn
   ↕ host.docker.internal:19418    xcodebuild
```

**単一プロセス**: Mac 上で動くデーモンが MCP サーバー (Streamable HTTP) として機能。
Docker 側の Claude Code は `.mcp.json` に URL を書くだけ。

- **言語**: TypeScript (Node.js)
- **MCP Transport**: Streamable HTTP (`/mcp` エンドポイント)
- **キューイング**: インメモリ FIFO、同時実行数制限（デフォルト 1）
- **MCPツール**: `run_xcodebuild` 1つのみ。引数はxcodebuildコマンドラインをそのまま渡す
- **結果**: xcodebuild の stdout/stderr + exit code をパースせずにそのまま返す

## プロジェクト構成

単一パッケージ。モノレポ不使用。

```
xcode-remote/
├── package.json
├── tsconfig.json
├── .gitignore
└── src/
    ├── index.ts              ← エントリポイント (HTTP サーバー起動)
    ├── server.ts             ← HTTP サーバー + MCP Streamable HTTP 統合
    ├── config.ts             ← 環境変数読み込み
    ├── tools/
    │   └── run-xcodebuild.ts ← run_xcodebuild ツール登録
    └── queue/
        ├── job-queue.ts      ← FIFO キュー + ジョブ管理
        └── job-runner.ts     ← xcodebuild プロセス spawn + 出力キャプチャ
```

## MCP ツール

### `run_xcodebuild`

**唯一の MCP ツール**。xcodebuild コマンドをそのまま実行する。

パラメータ:
- `args`: `string[]` — xcodebuild に渡す引数（例: `["-workspace", "MyApp.xcworkspace", "-scheme", "MyApp", "build"]`）
- `workingDirectory?`: `string` — xcodebuild を実行するディレクトリ（省略時はデーモンの CWD）

戻り値:
- xcodebuild の stdout + stderr（そのまま）
- exit code
- ジョブ ID（後で `get_job` で参照するため）

動作:
1. ジョブをキューに投入
2. キューが空いたら xcodebuild を spawn
3. 完了まで待機（Promise）
4. stdout/stderr + exit code をそのまま返す

### `get_job`

ジョブの状態とログを取得。長時間ビルドの途中確認用。

パラメータ:
- `jobId`: `string`

戻り値:
- ジョブ状態 (queued / running / completed / failed / cancelled)
- ログ（現時点まで）
- exit code（完了時）

### `list_jobs`

現在のジョブ一覧。

パラメータ:
- `status?`: `string` — フィルタ（"queued", "running" 等）

### `cancel_job`

ジョブをキャンセル。

パラメータ:
- `jobId`: `string`

## Daemon 構成

### HTTP サーバー

`node:http` ベース。

| パス | 機能 |
|------|------|
| `POST /mcp` | MCP Streamable HTTP (JSON-RPC リクエスト受付) |
| `GET /mcp` | MCP Streamable HTTP (SSE ストリーム) |
| `DELETE /mcp` | MCP セッション終了 |
| `GET /health` | ヘルスチェック |

### MCP サーバー初期化

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const server = new McpServer({ name: "xcode-remote", version: "0.1.0" });

// ツール登録
registerRunXcodebuildTool(server, queue);
registerGetJobTool(server, queue);
registerListJobsTool(server, queue);
registerCancelJobTool(server, queue);
```

## ジョブキュー

### JobQueue

```typescript
class JobQueue {
  submit(args: string[], cwd?: string): { jobId: string; completion: Promise<JobResult> }
  getJob(id: string): Job | undefined
  listJobs(statusFilter?: string[]): Job[]
  cancelJob(id: string): boolean
}
```

- インメモリ FIFO
- `maxConcurrency` (デフォルト 1) で同時実行制限
- `submit()` は即座に jobId を返しつつ、completion Promise で完了を待てる

### JobRunner

```typescript
class JobRunner {
  run(job: Job): Promise<void>
  cancel(jobId: string): void
}
```

- `spawn("xcodebuild", args, { cwd })` で実行（シェル経由なし）
- stdout/stderr を `job.log` に蓄積
- exit code を記録

### ジョブライフサイクル

`queued` → `running` → `completed` / `failed` / `cancelled`

### Job 型

```typescript
interface Job {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  args: string[];
  workingDirectory?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  log: string;         // stdout + stderr そのまま
  error?: string;      // spawn 自体のエラー
}
```

## 非同期フロー

```
Claude Code (Docker)
  → HTTP POST /mcp (JSON-RPC: tools/call "run_xcodebuild")
    → Daemon:
      1. JobQueue.submit(args)
      2. キューが空くまで待機 → xcodebuild spawn
      3. 完了まで Promise で待ち
      4. { stdout+stderr, exitCode, jobId } を返却
  ← JSON-RPC response
Claude Code に結果表示
```

## セキュリティ

- **シェルインジェクション防止**: `spawn("xcodebuild", args)` を配列引数で直接実行（シェル不使用）
- **コマンド固定**: 実行されるのは常に `xcodebuild` のみ。任意コマンド実行は不可
- **パス制限** (オプション): `XCODE_REMOTE_ALLOWED_PATHS` でアクセス可能なパスを制限
- **ネットワーク**: ファイアウォール設定で外部からのアクセスを遮断すること

## 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `XCODE_REMOTE_HOST` | `0.0.0.0` | バインドホスト |
| `XCODE_REMOTE_PORT` | `19418` | ポート |
| `XCODE_REMOTE_MAX_CONCURRENCY` | `1` | 最大同時実行数 |
| `XCODE_REMOTE_ALLOWED_PATHS` | なし | 許可パス（カンマ区切り） |

## Claude Code MCP 設定

Docker 内の `.mcp.json`:
```json
{
  "mcpServers": {
    "xcode-remote": {
      "type": "http",
      "url": "http://host.docker.internal:19418/mcp"
    }
  }
}
```

## 依存関係

### 本番
- `@modelcontextprotocol/sdk` — MCP サーバー SDK
- `zod` — ツール入力スキーマ（MCP SDK の peer dependency）

### 開発
- `typescript` ^5.7
- `tsx` — 開発時ホットリロード
- `@types/node` ^22

## 実装順序

### Phase 1: プロジェクト初期化
1. `package.json`, `tsconfig.json`, `.gitignore` 作成
2. 依存関係インストール

### Phase 2: MCP サーバースケルトン
3. HTTP サーバー + Streamable HTTP transport セットアップ (`src/server.ts`)
4. `/health` エンドポイント
5. echo 的なダミーツールで MCP 接続確認

### Phase 3: ジョブキュー
6. `JobQueue` + `JobRunner` 実装 (`src/queue/`)
7. `run_xcodebuild` ツール実装 (`src/tools/run-xcodebuild.ts`)

### Phase 4: ジョブ管理ツール
8. `get_job`, `list_jobs`, `cancel_job` ツール実装

### Phase 5: 検証
9. MCP Inspector で接続確認
10. Claude Code ローカルから実際にビルド実行
11. Docker 経由のフルフロー検証

## 検証方法

1. **MCP Inspector**: `npx @modelcontextprotocol/inspector` で Streamable HTTP 接続確認
2. **Claude Code ローカルテスト**:
   ```json
   { "mcpServers": { "xcode-remote": { "type": "http", "url": "http://localhost:19418/mcp" } } }
   ```
3. **ヘルスチェック**: `curl http://localhost:19418/health`
4. **Docker E2E**: Docker 内の Claude Code から `run_xcodebuild` でビルド実行を確認

## 技術的な注意点

- ESM only (`"type": "module"`)
- 開発時は `tsx watch src/index.ts` でホットリロード
- xcodebuild 出力はパースしない。LLM 側が理解する
- ログが巨大になりうるため、MCP レスポンスでは末尾を切り詰める（上限は要調整）
- MCP セッション管理は SDK の `StreamableHTTPServerTransport` が自動処理

## 主要ファイル

- `src/server.ts` — HTTP サーバー + MCP 統合の核心
- `src/queue/job-queue.ts` — ジョブキュー（submit が completion Promise を返す設計）
- `src/queue/job-runner.ts` — xcodebuild プロセス spawn
- `src/tools/run-xcodebuild.ts` — メインツール。キュー投入→await→結果返却
