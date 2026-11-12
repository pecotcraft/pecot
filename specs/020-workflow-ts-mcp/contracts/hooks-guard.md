# Contract: hooks のガード

hooks の本体は shell と jq のまま（FR-013）。判定の入力を Bash の文字列から MCP の `tool_input` に移す。

## ツール名の取り出し

`PECOT_HOOK_TOOL_NAME` から `<tool>` を取り出してから判定する。取り出した名前が 34 個のツール名にあるときだけ判定し、無ければ素通しにする。

| クライアント | 形 | 例 |
|---|---|---|
| Claude Code | `mcp__plugin_pecot-w_pecot-workflow__<tool>` | `mcp__plugin_pecot-w_pecot-workflow__issue_create` |
| Claude Code（プラグインの外で登録したとき） | `mcp__pecot-workflow__<tool>` | `mcp__pecot-workflow__issue_create` |
| Copilot CLI | `pecot-workflow-<tool>` | `pecot-workflow-issue_create` |

Copilot CLI の形は、2026-11-12 に Copilot CLI 1.0.107 と 1.0.109 の実物で確かめた（research R-5）。`tool_name` はこの形、`tool_input` はオブジェクトで届く。

Copilot CLI の matcher `pecot-workflow-.*` は、playwright のツールにも当たる。
例は `pecot-workflow-playwright-browser_click`。
接頭辞を外すと `playwright-browser_click` になる。34 個のツール名に無いので素通しになる。
Claude Code の接頭辞は `pecot-workflow__` で終わるので、playwright のツールには当たらない。

matcher は `hooks.json` の `mcp__.*` のままで足りる。Copilot CLI 向けの matcher には `pecot-workflow-.*` を足す。置き場は `com.github.copilot/hooks/hooks.json`（`hooks/hooks-copilot.json` から移す）。
hooks の定義を移すときも、イベント名は `PreToolUse` のままにする。`preToolUse` にすると、入力の欄が `tool_name`・`tool_input` から `toolName`・`toolArgs` に変わる。
今の `hooks-copilot.json` の matcher は `mcp__.*|github-mcp-server-create_pull_request`。

## 投稿の ask（`lib/mcp-handlers/pecot-post-ask.sh`）

`external-post-check.sh` にあった pecot の判定を移した。理由の文は `lib/core/mcp-guidance.sh` の `mcp_guidance_post_ask_issue`・`mcp_guidance_post_ask_pr` が持つ。

移行前の文との違いは 1 点だけ。`pecot issue create --prepare`・`--dry-run` などのフラグの案内を、MCP の入力（`prepare: true`・`dry_run: true`）に替えた。

| ツール | 素通しの条件 | それ以外 |
|---|---|---|
| `issue_create` | `tool_input.prepare == true`、スラッシュコマンドのフラグがある、config キーが false | ask（`pecot-issue-create-ask` の文言） |
| `issue_quick` | スラッシュコマンドのフラグがある、config キーが false。入力に `prepare` が無いので、`prepare` では素通しにしない | ask（`pecot-issue-create-ask` の文言） |
| `pr_create` | `tool_input.prepare == true` か `tool_input.dry_run == true`、フラグがある、config キーが false | ask（`pecot-pr-create-ask` の文言） |

`mcp-dispatcher.sh` の順は、`pr-create-block.sh`（deny）→ `pecot-post-ask.sh`（ask）→ `context7-allow.sh`（allow）。deny > ask > allow を保つ。

スラッシュコマンドのフラグは、今と同じく CLI が実投稿の成功時に消す。MCP 経由でも同じ `run` を通るので変わらない。

## 入れる時期

この表を正にする。

| 判定 | フェーズ 8 | フェーズ 11（切り替え） |
|---|---|---|
| 投稿の ask（MCP） | 入れる。MCP サーバが未登録なので発火しない | そのまま |
| Bash の `pecot` の deny | `lib/core/pecot-cli-deny.sh` とテストだけを入れる | `lib/adapters/claude-bash-guards.sh` から呼ぶ（`pre-tool-use-bash.sh` にはロジックを置けない）。順は `git-no-verify-check.sh` の後、`external-post-check.sh` の前で、deny が ask と allow より先になる |
| `external-post-check.sh` の pecot の判定 | 残す | 外す |
| 案内文 | 書き換えた文を `lib/core/mcp-guidance.sh` に用意し、テストで固定する | 呼ぶ側を差し替える |
| Copilot CLI の matcher | 足さない | `pecot-workflow-.*` を足し、`hooks-copilot.json` を移す |

フェーズ 8 が `mcp-dispatcher.sh` を変えるときは、既存の pytest（`hooks/tests/test_pre_mcp.py` など）も同じ PR で直す。

## Bash の `pecot` の deny（`lib/core/pecot-cli-deny.sh`）

| 入力 | 判定 |
|---|---|
| セグメントの先頭が `pecot` / `$PECOT` / `"$PECOT"` / `bin/pecot` のフルパス / クオート付きのパス（`"${CLAUDE_PLUGIN_ROOT}/bin/pecot"` を含む） | deny。理由に対応するツール名を入れる（例: `pecot issue read` → `issue_read`） |
| 上の形でサブコマンドが分からない（`pecot` だけ、`pecot --help`） | deny。理由には MCP ツールの一覧を使うよう書く |
| それ以外 | 今の判定へ進む |

セグメントの分け方は、今の `external-post-check.sh` の処理を `lib/core/command-segments.sh` に移して共有する。サブコマンド別の許可・阻止は持たない。
起動形は、`pecot` の後ろに語の境界（空白か行末）を求め、パスの部分に `=` を含めない。`pecot` を起動していないコマンドを止めないためだ。共有の `_PECOT` は、読む先が無くなったので消した。例は `CLAUDE_PROJECT_DIR=/…/pecot bash run.sh`・`pecot-tools aws s3 ls`・`/…/pecot/…/run-tests.sh`。

クオートとヒアドキュメントは、deny が自分で読む（共有のクオートの正規化は使わない）。

| 形 | 扱い |
|---|---|
| ヒアドキュメント（`<<`・`<<-`。区切り語のクオートの有無を問わない）の本文の行 | 判定しない。終端の後ろの行は判定する |
| `<<<`（here-string）と、クオートの中の `<<` | ヒアドキュメントと扱わない |
| 区切り語が数字で始まる `<<` | ヒアドキュメントと扱わず、本文の行も判定する（`$((1<<2))` の後ろの行を通さないため） |
| 空白・`;`・`&`・`\|`・`(`・`)`・バッククォートのどれかを含むクオートの範囲 | 判定から外す。例は `grep -E "gh\|pecot" plugins/` |
| 上の文字を含まないクオート（`"$PECOT"`・`"${CLAUDE_PLUGIN_ROOT}/bin/pecot"`） | クオートだけを外して判定する |
| クオートの外で語頭にある `#` から行末まで（コメント） | 判定しない。末尾が `\` でも継続にしない（bash はコメントを継続しないので、次の行は本物の起動） |
| ヒアドキュメントを始める行の末尾が `\` の形 | 本文の行に入った時点で継続を戻す。終端の次の行は、前の行とつなげず判定する |
| 行末の `\` と改行 | 空白 1 つに畳み、前後の行を 1 つのコマンドとして判定する。継続行の先頭が `…/pecot` で終わる語（`git worktree add \` の次の行が `/workspaces/wt3/pecot` など）を、起動と誤らないため |

有効・無効は config キー `pecot-cli-deny`（既定 `true`）で切り替える（`pecot_hook_enabled`）。`hooks-config.json.sample` と `hooks/README.md` に載せる。

次の形は素通しになる。テストで今の姿を固定している。塞ぐのは別の Issue にする。

- セグメントの先頭に起動形が来ない形。`${PECOT} …`、`time`・`env`・`command`・`exec`・`sudo`・`xargs`・`!` の後ろ、`bash -c "pecot …"`、`{ pecot …; }`、`if pecot …; then`
- 環境変数の前置きが大文字と `_` だけでない形（`foo=1 pecot …`・`X1=1 pecot …`）
- `pecot` の直後に空白が無い形（`pecot>out issue read 1`）
- 空白を含むパスをクオートした起動形（`"/my dir/bin/pecot" issue read 1`）

グローバルの `--repo` が前に来る形（`pecot --repo o/r issue read 1`）は読み飛ばさず、一覧の文で deny する。
グループ付きのコマンドは、グループとサブコマンドをつなげてツール名にする。

| Bash の起動 | ツール名 |
|---|---|
| `pecot issue read` | `issue_read` |
| `pecot security sync` | `security_sync` |
| `pecot dependabot sync` | `dependabot_sync` |
| `pecot add-to-project` | `add_to_project` |

`external-post-check.sh` には `gh pr merge` の ask だけが残る。

## 案内文の書き換え

実物（`plugins/pecot-workflow/hooks/`）で `pecot` を案内している箇所は、次のとおり。

| 置き場 | 今 | 移行後 |
|---|---|---|
| `lib/core/gh-command-check.sh`（54・66〜67 行） | `pecot pr create`、`pecot issue quick`、`pecot issue create` | `pr_create`、`issue_quick`、`issue_create` |
| `lib/core/git-worktree-branch-check.sh`（85 行） | `"${CLAUDE_PLUGIN_ROOT}/bin/pecot" delete-branch <owner/repo> <branch>` | `delete_branch`（入力は `repo_ref` と `branch`） |
| `lib/pre-tool-use/pecot-issue-pending-reminder.sh`（43・51・55・60 行） | `pecot issue quick`、`pecot issue create --prepare`、`pecot issue create <file path>` | `issue_quick`、`issue_create`（`prepare: true` で下書き、次にファイルを渡して投稿） |
| `lib/core/external-post-check.sh` の `ISSUE_MSG`・`CREATE_MSG`（131〜142 行） | `pecot issue quick` / `create`、`pecot pr create` | フェーズ 11 で外した。ask の文は `mcp-guidance.sh` の `mcp_guidance_post_ask_issue`・`mcp_guidance_post_ask_pr` に置き、`pecot-post-ask.sh` が呼ぶ |
| `lib/core/external-post-check.sh` の `GH_MSG`（144〜148 行） | `pecot pr cleanup` | `pr_cleanup`（この判定はフェーズ 11 の後も残る） |
| `templates/exit-plan-comment-update.md` | `pecot issue comment <that file>` | `issue_comment` |
| `hooks/README.md`（71〜75・86〜113・123・172〜174・252 行） | `pecot` コマンド | ツール名 |

次のものは案内文ではないので、書き換えない。

- `lib/session-start/git-sync.sh:19` の `uvx` を確かめる処理は、コメントだけが `pecot CLI` に触れている
- `workflow-compliance-injector.sh`・`pecot-skill-compliance.sh` の文は、スキルの名前だけを案内する

`plan-issue-poster.sh` と `plan-post-result.sh` は、リポに無い。計画の Issue への投稿は、確認の前にエージェントが済ませる（w-active / w-quick の手順）。

### 移行後の文の置き場とテスト

- 移行後の文は `hooks/lib/core/mcp-guidance.sh` に、文ごとの関数として置く。フェーズ 8 で作る
- 固定するテストは `cli-node/tests/hooks/mcp-guidance.test.ts`。各関数の出力に、対応するツール名があり、`pecot` で始まる起動形が無いことを確かめる
- フェーズ 11 で、上の表の 5 つのスクリプトとテンプレートが、この関数を呼ぶ形に替える。`hooks/README.md` の表も同じ変更で直す

### hooks の中からの CLI の呼び出し

実物では、hooks のスクリプトが `bin/pecot` を実行する箇所は無い。
`git grep -n 'bin/pecot' -- plugins/pecot-workflow/hooks` の該当は、テストを除くと、コメントと案内文だけ。
`exit-plan-remind.sh` は、承認後の計画が変わっていれば、`issue_comment` で打ち直すよう案内する。フェーズ 11 の後も、hooks の中に Bash の `pecot` の実行を足さない。

## テスト

| 確認 | 方法 |
|---|---|
| 今の阻止の条件 | 今の pytest のケースを vitest に移し、MCP の入力 JSON で同じ判定と文言になる |
| 34 個に無い名前 | `pecot-workflow-playwright-browser_click` などは、2 つのクライアントの形のどちらでも素通しになる |
| 2 つのクライアントの名前 | 各ケースを両方のツール名の形で流す |
| Bash の deny | 定義書にあるサブコマンドの起動形それぞれで deny され、理由に対応するツール名がある |
| 件数 | 移行元の pytest のケースとの対応で比べる。`scripts/ci/compare_junit.py` で、pytest の JUnit と vitest の JUnit（`cli-node/test-results/junit-hooks.xml`）をファイルごとに比べる。フェーズ 8 が足した新しいケースは、`hooks.testCount`（1,569 件）との比較から除く |
| 起動スクリプト | テストが起動するスクリプトの一覧が `hooks.scripts` を全部含む（消したスクリプトを除く） |
