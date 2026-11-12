# Contract: フックの振る舞い

**Feature**: [../spec.md](../spec.md)

利用者とエージェントから見たフックの振る舞いを、入力と出力の組で決める。テストの期待はこの表から作る。

## 止める・承認を求める

| 入力 | 今 | 変更の後 |
|---|---|---|
| MCP `pr_create`（実投稿） | ask（`/w-pr` の起点なら素通し） | 何も返さない |
| MCP `issue_create`・`issue_quick`（実投稿） | ask（起票系の起点なら素通し） | 何も返さない |
| Bash `gh pr merge` | ask（`/w-merge` の起点なら素通し） | 何も返さない |
| Bash `pecot …` | deny | 何も返さない |
| Bash `gh pr create`・`gh issue create` | deny | deny（変えない） |
| MCP GitHub の `create_pull_request` | deny | 何も返さない |
| Bash `git commit --no-verify` など（`git-no-verify-check` を有効にしたとき） | deny | deny。`-n` のまとめ書き・引用符・`core.hooksPath`・`SKIP=`・`HUSKY=0` も止める |
| Bash `git commit --no-verify` など（初期値の無効のとき） | deny | 何も返さない |
| Bash の大きすぎるコマンド | ask | 何も返さない（ガードを通さずに素通し） |

## 文脈を足す

| 入力 | 今 | 変更の後 |
|---|---|---|
| UserPromptSubmit（先頭が `/w-…`） | 決まりの 3 行を足す。`/w-quick`・`/w-ready` なら起票待ちのフラグを作る | 何も足さず、何も作らない |
| PreToolUse（Skill、pecot のスキル） | 決まりの 3 行を足す | 何も足さない（`.pecot` の初期化は今どおり） |
| PostToolUse（Skill、w-quick・w-ready） | 案内を足し、起票待ちのフラグを作る | 何も足さず、何も作らない |
| PreToolUse（Edit・`git checkout`、起票待ちのフラグあり） | リマインドを足す | 何も足さない |
| PreToolUse（Bash `git checkout`、untracked あり） | 警告を足す | 何も足さない |
| PreToolUse（Bash、`/tmp/x` を含む） | 置き換えを促す | 置き換えを促す（変えない） |
| PostToolUse（Bash、commit の成功） | commit の情報を足す。`auto-push` が有効なら push する | 何もしない |
| SessionStart | `git pull`、VS Code の情報、`.gitignore` の案内、更新の通知 | 案内はどれも出さない。`git pull` は `git-sync` を有効にしたときだけ（初期値は無効）。セッション名と `.gitignore` の補完は今どおり |
| SessionStart（compact） | 起動しない | `.gitignore` の補完だけ動く（セッション名は反映されない） |
| Stop | 置き場の誤りの通知、push の URL、通知音 | 何もしない（エントリを外す。通知は組み込みの設定に任せる） |
| Notification（許可待ち・入力待ち・質問） | 通知音 | 何もしない（エントリを外す） |

## 計画の承認の後の案内（Claude Code）

| 入力 | 出力 |
|---|---|
| w-active を起動したセッションで ExitPlanMode が成功 | 計画の更新と実装の引き継ぎの案内。フックは外れる |
| w-quick を起動したセッションで ExitPlanMode が成功 | 計画の更新の案内だけ。フックは外れる |
| どちらも起動していないセッションで ExitPlanMode が成功 | 何も出さない |
| 作業中の Issue が無い（ブランチ名の末尾が番号でない） | 何も出さない |

## 計画の承認の後の案内（Copilot CLI）

`hooks.json` のエントリは、Copilot CLI 向けの定義からも外す。
frontmatter のフックを読めば Claude Code と同じ。読まなければ出ない（そのとき対応を決める）。

## 設定

| 入力 | 期待 |
|---|---|
| 利用者の `hooks-config.json` に、撤廃したキーが残っている | エラーにせず無視する |
| `hooks-config.json.sample`・README の表・スクリプトの設定キー | 3 つが同じ集合になる |
| `git-sync`・`git-no-verify-check` を設定していない | 無効として動く |

## セッション名

| 入力 | 今 | 変更の後 |
|---|---|---|
| SessionStart（startup・resume・fork）・UserPromptSubmit | `.pecot-active` の番号と題名でセッション名を返す | ブランチ名の末尾の番号と、題名のキャッシュで返す |
| 同じ題名を既に送った | 返さない | 返さない（変えない） |
| Copilot CLI | 返さない | 返さない（変えない） |

作業中の Issue の求め方と、MCP ツールの振る舞いは [work-target.md](work-target.md) に置く。
