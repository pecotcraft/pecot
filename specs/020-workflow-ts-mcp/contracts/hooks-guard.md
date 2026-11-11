# Contract: hooks のガード

hooks の本体は shell と jq のまま（FR-013）。判定の入力を Bash の文字列から MCP の `tool_input` に移す。

## ツール名の取り出し

`PECOT_HOOK_TOOL_NAME` から `<tool>` を取り出してから判定する。

| クライアント | 形 | 例 |
|---|---|---|
| Claude Code | `mcp__plugin_pecot-w_pecot-workflow__<tool>` | `mcp__plugin_pecot-w_pecot-workflow__issue_create` |
| Copilot CLI | `pecot-workflow-<tool>` | `pecot-workflow-issue_create` |

matcher は `hooks.json` の `mcp__.*` のままで足りる。Copilot CLI 向けの matcher には `pecot-workflow-.*` を足す。置き場は `com.github.copilot/hooks/hooks.json`（`hooks/hooks-copilot.json` から移す）。

## 投稿の ask（`lib/mcp-handlers/pecot-post-ask.sh`）

今の `external-post-check.sh` の pecot 部分を移す。理由の文言は今と同じ。

| ツール | 素通しの条件 | それ以外 |
|---|---|---|
| `issue_create` / `issue_quick` | `tool_input.prepare == true`、スラッシュコマンドのフラグがある、config キーが false | ask（`pecot-issue-create-ask` の文言） |
| `pr_create` | `tool_input.prepare == true` か `tool_input.dry_run == true`、フラグがある、config キーが false | ask（`pecot-pr-create-ask` の文言） |

`mcp-dispatcher.sh` の順は、`pr-create-block.sh`（deny）→ `pecot-post-ask.sh`（ask）→ `context7-allow.sh`（allow）。deny > ask > allow を保つ。

スラッシュコマンドのフラグは、今と同じく CLI が実投稿の成功時に消す。MCP 経由でも同じ `run` を通るので変わらない。

## 入れる時期

| 判定 | フェーズ 8 | フェーズ 11（切り替え） |
|---|---|---|
| 投稿の ask（MCP） | 入れる。MCP サーバが未登録なので発火しない | そのまま |
| Bash の `pecot` の deny | `lib/core/pecot-cli-deny.sh` とテストだけを入れる | `pre-tool-use-bash.sh` から呼ぶ |
| `external-post-check.sh` の pecot の判定 | 残す | 外す |
| 案内文 | 書き換えた文を用意し、テストで固定する | 差し替える |

## Bash の `pecot` の deny（`lib/core/pecot-cli-deny.sh`）

| 入力 | 判定 |
|---|---|
| セグメントの先頭が `pecot` / `$PECOT` / `"$PECOT"` / `bin/pecot` のフルパス / クオート付きのパス | deny。理由に対応するツール名を入れる（例: `pecot issue read` → `issue_read`） |
| 上の形でサブコマンドが分からない（`pecot` だけ、`pecot --help`） | deny。理由には MCP ツールの一覧を使うよう書く |
| それ以外 | 今の判定へ進む |

セグメントの分け方と起動形の見つけ方は、今の `external-post-check.sh` の処理を使う。サブコマンド別の許可・阻止は持たない。

`external-post-check.sh` には `gh pr merge` の ask だけが残る。

## 案内文の書き換え

| 置き場 | 今 | 移行後 |
|---|---|---|
| `lib/core/gh-command-check.sh` | `PECOT=pecot` と Copilot 用の別ランチャーの説明 | `issue_create` / `pr_create` を使うよう案内 |
| `lib/pre-tool-use/pecot-issue-pending-reminder.sh` | `pecot issue quick` または `pecot issue create` | `issue_quick` または `issue_create` |
| `lib/post-tool-use/plan-issue-poster.sh` の失敗時の案内 | `"${CLAUDE_PLUGIN_ROOT}/bin/pecot" issue comment ...` | `issue_comment`（`prepare: true` で下書き、次にファイルを渡して投稿） |
| `hooks/templates/*.md` | `pecot` コマンド | MCP ツール名 |

hooks の中から CLI を呼ぶ処理（`plan-post-result.sh` の `pecot issue comment`）は、Node の CLI をそのまま呼ぶ。Bash ツールを通らないので deny の対象にならない。

## テスト

| 確認 | 方法 |
|---|---|
| 今の阻止の条件 | 今の pytest のケースを vitest に移し、MCP の入力 JSON で同じ判定と文言になる |
| 2 つのクライアントの名前 | 各ケースを両方のツール名の形で流す |
| Bash の deny | 定義書にあるサブコマンドの起動形それぞれで deny され、理由に対応するツール名がある |
| 件数 | vitest の件数が `baseline.json` の `hooks.testCount` 以上 |
| 起動スクリプト | テストが起動するスクリプトの一覧が `hooks.scripts` を全部含む（消したスクリプトを除く） |
