# Contract: pecot-workflow の MCP ツール

ツールの一覧・入力・振る舞いの正は `plugins/pecot-workflow/interface/` の定義書です。この文書と食い違うときは、定義書に従います（FR-021）。

## サーバ

| 項目 | 値 |
|---|---|
| サーバ名 | `pecot-workflow` |
| 起動 | `bin/pecot mcp`（stdio）。フェーズ 9 の開発用の登録は、`build-cli` の後の `node <作業ツリー>/plugins/pecot-workflow/cli-node/dist/cli.js mcp` の直接の起動 |
| Claude Code の登録 | `.mcp.json` の `mcpServers.pecot-workflow`。`command` は `${CLAUDE_PLUGIN_ROOT}/bin/pecot`、`args` は `["mcp"]`。今ある `context7` と `pecot-workflow-playwright` は残す |
| Copilot CLI の登録 | root の `mcp.json`（Agent Plugins 1.0）。`command` は `./bin/pecot`、`args` は `["mcp"]`、`type` は `stdio`。`env` は付けない（research R-11）。`context7` と `pecot-workflow-playwright` も持つ（3 サーバ） |
| 単体配布の登録 | npm の `@pecot/workflow-mcp`。`command` は `npx`、`args` は `["-y", "@pecot/workflow-mcp"]`。hooks は含まない（research R-14） |
| データ置き場 | `CLAUDE_PLUGIN_DATA` → `PLUGIN_DATA` → 既定の場所（今の `bin/_lib.sh` の順） |
| クライアントに見える名前 | Claude Code は `mcp__plugin_pecot-w_pecot-workflow__<tool>`、Copilot CLI は `pecot-workflow-<tool>`（research R-5） |
| Copilot CLI の版 | 1.0.106 以降（`COPILOT_SESSION_CWD` を渡す版。research R-5） |

## 対象のリポ

`pecot mcp` は、起動のときに 1 回だけセッションのディレクトリを決め、そこへ移ってから待ち受ける。コマンドは、移った先の cwd からリポを決める。上の行から順に当てはめる。

| 順 | 条件 | 動き |
|---|---|---|
| 1 | cwd がプラグインの root の中でない（変数が無いときを含む） | cwd のまま（Claude Code・`--additional-mcp-config`・直接の起動） |
| 2 | 中にあり、`COPILOT_SESSION_CWD` が実在するディレクトリ | そこへ移る |
| 3 | 中にあり、`COPILOT_SESSION_CWD` があるが、ディレクトリが無い | 決められない |
| 4 | 中にあり、`COPILOT_SESSION_CWD` も `COPILOT_PLUGIN_ROOT` も無く、`CLAUDE_PROJECT_DIR` が実在するディレクトリ | そこへ移る |
| 5 | 中にあり、上のどれでもない | 決められない |

- プラグインの root は、`PLUGIN_ROOT`（Agent Plugins 1.0 の仕様が約束する変数）と `CLAUDE_PLUGIN_ROOT` の指す先。cwd がどちらかの中にあれば「中」とする
- `COPILOT_PLUGIN_ROOT` があるのは、Copilot CLI が起動したとき。そのときは、シェルから継いだ `CLAUDE_PROJECT_DIR` を使わない
- 「中」は、実体パス（symlink を解決したもの）が同じか、その下にあること。相対パスの変数は、移る前の cwd を起点にして絶対パスへ直す。空の変数は無いものとして扱う
- 移れなかったとき（権限など）、cwd を読めないとき、実体パスを解決できないときも「決められない」にする
- 「決められない」ときもサーバは起動し、`tools/list` は 34 個を返す。ツールの呼び出しは、コマンドを呼ばずに `cannot determine the target repository` で始まる理由と `exit code: 1` を、失敗の結果で返す
- 変数は起動のときの値。セッションの途中で作業ディレクトリが変わっても、サーバは追わない
- `bin/pecot` は、`exec` までに cwd を変えず、`COPILOT_SESSION_CWD` を消さず、`CLAUDE_PLUGIN_ROOT` にプラグインの本体を入れる

## hooks のガードを持つツール

| ツール | CLI | hooks のガード |
|---|---|---|
| `issue_create` | `pecot issue create` | ask（`prepare` が true なら素通し） |
| `issue_quick` | `pecot issue quick` | ask（入力に `prepare` が無いので、常に ask） |
| `pr_create` | `pecot pr create` | ask（`prepare` か `dry_run` が true なら素通し） |
| `worktree_link` | `pecot worktree link` | 入力 `force`（定義書にある。既定 false）。MCP ツールは標準入力を持たないので、`force` が false で上書きの確認が要るときは、入力の終端と同じく中止する（research R-7） |

グローバルオプション `--repo` は、全ツールの入力 `repo`（省略可）で受ける。`--show-repo` と `--version` はツールにしない（CLI の表示用）。
自分の `--repo` を持つ 4 個（`issue_create`・`issue_quick`・`pr_create`・`project_info`）は例外で、入力 `repo` はコマンド自身のオプションの値になる。グローバルの `--repo` は合成しない。

## 結果

[data-model.md](../data-model.md) の ToolResult。`content[0].text` は CLI の stdout と同じ文字列。

## 確かめること

| 確認 | 方法 |
|---|---|
| ツールの数と名前 | `tools/list` が定義書（`interface/generated.json`）の 34 項目と一致する。切り替えの後は、各項目の `surfaces.mcp.tool` と一致する |
| 未知のキーの宣言 | `tools/list` の生の入力（`normalizeInput` を通す前）に `additionalProperties: false` がある。サーバは未知のキーを誤りにするので、公開する形も同じにする |
| 対象のリポ | プラグインの root の役の git リポを cwd と `CLAUDE_PLUGIN_ROOT` にし、`COPILOT_SESSION_CWD` に別の git リポを渡して起動する。`session_status` の `Repository` が `COPILOT_SESSION_CWD` のリポになる |
| 決められないとき | 同じ起動から `COPILOT_SESSION_CWD` を外す。`COPILOT_PLUGIN_ROOT` があるときは、`CLAUDE_PROJECT_DIR` があっても同じ。どのツールも理由を失敗で返し、コマンドを呼ばない。`tools/list` は変わらない |
| 中断 | 待ち行列の呼び出しは、順番が来た時点で `notifications/cancelled` か接続の切断で中断済みなら、本体を呼ばない。実行中の 1 件は完了まで動く |
| 入力の対応 | `tools/list` の入力を `normalizeInput` を通した形にして、定義書の `input` と比べる。各ツールのプロパティが、CLI のオプション（`--show-repo`・`--version` を除く）と 1 対 1 |
| 結果の同一性 | 前後比較のシナリオのうち MCP に写せる全件（[parity.md](./parity.md)）を MCP 経由でも流し、結果の `_meta['io.github.pecotcraft/outcome']` の `stdout`・`stderr`・`exitCode` と、golden の `requests`・`files` が一致する |
