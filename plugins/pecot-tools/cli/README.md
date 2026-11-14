# @pecot/pecot-tools-cli

pecot-tools プラグインの MCP サーバ本体です。許可リストで限定した awscli コマンドを
MCP ツールとして公開します。

## コマンド

CLI が持つのは次の 2 つだけです。

| コマンド | 内容 |
|:--------|:----|
| `pecot-tools mcp` | stdio（stdin / stdout）で待ち受ける MCP サーバとして起動する。オプションは無い |
| `pecot-tools --version` | プラグインの版を出力する（`.claude-plugin/plugin.json` を直読みする） |

MCP サーバ名は `pecot-tools` です。`.mcp.json` の `mcpServers` の登録キーと揃えてあります。
クライアント側のツール名の名前空間（`mcp__plugin_pecot-t_pecot-tools__*`）も、この名前から決まります。

`mcp` 実行中の stdout は JSON-RPC が専有します。診断行はすべて stderr へ出ます。

## 上限と既定値

| 項目 | 値 | 定義箇所 |
|:----|:--|:----|
| ツール 1 回の制限時間 | 120 秒 | `src/mcp/tools/_shared.ts` の `TOOL_TIMEOUT_MS` |
| `aws --version` プローブの待ち時間 | 15 秒 | `src/infra/awscli.ts` の `PROBE_TIMEOUT_MS` |
| SSO の開始から時間切れまで | 10 分 | `src/infra/sso/login-registry.ts` の `SSO_LOGIN_TIMEOUT_MS` |
| SSO の URL・コード確定待ち | 15 秒 | `src/infra/sso/login-registry.ts` の `SSO_PROMPT_TIMEOUT_MS` |
| `tools/call` の同時実行数 | 4 | `src/mcp/server.ts` の `CONCURRENCY_LIMIT` |
| progress ハートビートの周期 | 10 秒 | `src/mcp/server.ts` の `PROGRESS_HEARTBEAT_INTERVAL_MS` |
| 応答に載せる出力の上限 | 256 KiB | `src/infra/awscli.ts` の `OUTPUT_LIMIT_BYTES` |
| 子プロセス出力の捕捉上限 | 1 MiB | `src/infra/awscli.ts` の `CAPTURE_LIMIT_BYTES` |
| 要求する awscli の最低版 | 2.22.0 | `src/infra/awscli.ts` の `MINIMUM_VERSION` |

出力が 256 KiB を超えたときは先頭側だけを載せます。
成功時は `data` が `{ output: <先頭のみ>, truncated: true }` に変わります（JSON への解釈は行いません）。
失敗時は `stderr` を切り詰めたうえで、`message` に切り詰めた旨を足します。捕捉上限を超えた分は子プロセスの読み取り時点で
捨てるため、応答に必要な範囲は必ず残ります。

`max_items` には上限を設けていません（下限 1 のみ）。件数の制御は awscli 側と AWS API 側に委ねます。

## ツール応答の exitCode

ツール応答の `exitCode` は awscli の終了コードをそのまま返します（`252` / `253` / `255` などが
そのまま出ます）。awscli の終了コードに由来しないのは次の 4 値だけです。

| 値 | 状況 |
|--:|:----|
| 2 | 実行前に拒否した（許可リスト外・入力の書式違反・S3 の方向不正など。awscli は起動しない） |
| 124 | 制限時間を超えて打ち切った |
| 127 | awscli が PATH に無い、または最低版を満たさない |
| 1 | 終了コードを持たない失敗（シグナル終了、awscli を起動しない SSO の状態遷移） |

4 値の定義は `src/mcp/tools/_shared.ts` にあります。

- 2: `PRE_EXECUTION_EXIT_CODE`
- 124: `TIMEOUT_EXIT_CODE`
- 127: `COMMAND_NOT_FOUND_EXIT_CODE`
- 1: `UNKNOWN_FAILURE_EXIT_CODE`

サーバプロセス自体の終了コードはこれとは別の体系です。
`pecot-tools mcp` は、正常終了で 0、起動失敗（transport 接続エラー・stdout への書き込み失敗）で 1 を返します。
SIGTERM で 143、SIGINT で 130 を返します（`src/mcp/serve.ts`）。
ツール応答の `exitCode` と混同しないでください。

## ツールと失敗種別

公開する 26 ツールの一覧（対応する awscli コマンド・種別・読取専用・ページング）と、失敗した応答の
`kind` 9 値の一覧は
[../scripts/release/mcp-dist-README.md](../scripts/release/mcp-dist-README.md) にあります。
このファイルは npm のパッケージ `@pecot/tools-mcp` の README として配布され、両方の一覧の原本です。

## 開発

コマンドと手順はプラグインの [README](../README.md) に記載しています。
