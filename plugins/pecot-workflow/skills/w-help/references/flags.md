# フラグ一覧

pecot の CLI・MCP ツールと hooks は、セッションの作業対象やモードを `.pecot/state/` 配下のフラグファイルで共有する。
フラグはプロジェクトルート（worktree）ごとに独立する。

## プロジェクトルートの解決

CLI と MCP ツールはコマンドの cwd の git toplevel（環境変数 `CLAUDE_PROJECT_DIR` があればそれ）を基準にする。
hooks は hook 入力の `cwd` の git toplevel を基準にする。
どちらも、その直下の `.pecot/state/` を読み書きする。Bash ツールの PreToolUse は実行前の cwd で発火するため `cd` を含むコマンドでは hook と CLI の基準がずれる。
ネストした clone 内で発火した hook はその clone を基準にする。

## CLI と hooks が共有するフラグ

| フラグ | 内容 | 書き手 | 読み手 | 消し手 |
|--------|------|--------|--------|--------|
| `.pecot-active` | 作業中の Issue ref（`owner/repo/N`） | `create_branch`、`issue_quick`、`session_restore` | `create_branch`（別 Issue 上書きガード）、`session_status`、`pr_create`（`prepare: true`。Closes 補完）、`exit-plan-remind.sh`、`auto-push.sh`（post-tool-use） | `pr_cleanup`（`skip_local_cleanup` なし） |
| `.pecot-session-title` | Claude Code のセッション名（`#<番号> <Issue タイトル>`。種別接頭辞なし・全体 40 文字） | `.pecot-active` と同じ 3 ツール（`write_work_target`） | `session-title.sh`（SessionStart / UserPromptSubmit。`.pecot-active` の番号と一致するときだけ採用） | `pr_cleanup`（`.pecot-active` と同時） |
| `.pecot-base` | 着手時に選んだ base（`<branch> <sha> [<owner/repo#N>]`。積んだときだけ末尾に積んだ先の Issue） | `create_branch` | `session_status`（`## Stack`） | `pr_cleanup`（`.pecot-active` と同時） |
| `.wip-branch-linked` | Issue に紐づけ済みの WIP ブランチ名（`wip/<ブランチ名>`） | `auto-push.sh`（post-tool-use） | `auto-push.sh`（同じ名前なら紐づけを飛ばす） | `pr_cleanup`（`skip_local_cleanup` なし） |
| `.pecot-quick-mode` | 空（存在のみ） | `issue_quick`（Epic 以外） | `exit-plan-remind.sh` | `pr_cleanup`、`exit-plan-remind.sh` |
| `pr-create-slash-pending` | 空（存在のみ） | `create-slash-flag.sh`（`/pecot-w:w-pr` 起動時） | `pecot-post-ask.sh` | `pr_create`（実投稿成功時）、`create-slash-cleanup.sh` |
| `issue-create-slash-pending` | 起点のスキル名 | `create-slash-flag.sh`（`/pecot-w:w-quick`・`w-ready`・`w-backlog`・`w-issueize` 起動時） | `pecot-post-ask.sh` | `issue_quick`・`issue_create`（実投稿成功時）、`create-slash-cleanup.sh` |
| `merge-slash-pending` | 空（存在のみ） | `create-slash-flag.sh`（`/pecot-w:w-merge` 起動時） | `external-post-check.sh` | `pr_cleanup`（片付けの成功時）、`create-slash-cleanup.sh` |
| `issue-pending` | 起点のスキル名（`w-quick` / `w-ready`） | `pecot-issue-pending-state.sh`、`pecot-skill-reminder.sh` | `pecot-issue-pending-reminder.sh` | `issue_quick`・`issue_create`（実投稿成功時）、`issue-pending-cleanup.sh` |

- `.pecot-active` は `pr_cleanup` を通さずに片付けた場合などに残り、CLOSED の Issue を指すことがある。`session_status`（`directory: "."`）で内容と Issue の OPEN/CLOSED を確認できる。消えた場合は `session_restore` でブランチ名から復元する（`issue` で直接指定もできる）。
- スラッシュコマンド起点のフラグが存在する間、`pecot-post-ask.sh`（MCP ツール）と `external-post-check.sh`（`gh`）は対応する呼び出しの確認を省く。
  - `pr-create-slash-pending`: `pr_create`（`pecot-post-ask.sh` が読む）
  - `issue-create-slash-pending`: `issue_quick`・`issue_create`（`pecot-post-ask.sh` が読む）
  - `merge-slash-pending`: `gh pr merge`（`external-post-check.sh` が読む）

## hooks だけが使う状態ファイル

| ファイル | 書き手 | 読み手 | 消し手 |
|----------|--------|--------|--------|
| `.auto-push-urls` | `auto-push.sh`（post-tool-use） | `auto-push.sh`（stop） | `auto-push.sh`（stop） |
| `session-title-sent` | `session-title.sh`（`<session_id>:<題名>`。`sessionTitle` を出した直後） | `session-title.sh`（同じ題名を同じセッションに再送しない） | なし（次の題名で上書き） |

## セッション境界での削除

SessionStart（startup / clear / resume のいずれも）で次のフラグを削除する。それ以外のフラグはセッションをまたいで残る。

| スクリプト | 削除対象 |
|------------|----------|
| `create-slash-cleanup.sh` | `pr-create-slash-pending`、`issue-create-slash-pending`、`merge-slash-pending` |
| `issue-pending-cleanup.sh` | `issue-pending` |
