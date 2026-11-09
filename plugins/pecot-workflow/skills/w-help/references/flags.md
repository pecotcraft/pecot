# フラグ一覧

pecot の CLI と hooks は、セッションの作業対象やモードを `.pecot/state/` 配下のフラグファイルで共有する。
フラグはプロジェクトルート（worktree）ごとに独立する。

## プロジェクトルートの解決

CLI はコマンドの cwd の git toplevel（環境変数 `CLAUDE_PROJECT_DIR` があればそれ）を基準にする。
hooks は hook 入力の `cwd` の git toplevel を基準にする。
どちらも、その直下の `.pecot/state/` を読み書きする。Bash ツールの PreToolUse は実行前の cwd で発火するため `cd` を含むコマンドでは hook と CLI の基準がずれる。
ネストした clone 内で発火した hook はその clone を基準にする。

## CLI と hooks が共有するフラグ

| フラグ | 内容 | 書き手 | 読み手 | 消し手 |
|--------|------|--------|--------|--------|
| `.pecot-active` | 作業中の Issue ref（`owner/repo/N`） | `pecot create-branch`、`pecot issue quick`、`pecot session restore` | `pecot create-branch`（別 Issue 上書きガード）、`pecot session status`、`pecot pr create --prepare`（Closes 補完）、`exit-plan-remind.sh`、`auto-push.sh`（post-tool-use） | `pecot pr cleanup`（`--skip-local-cleanup` なし） |
| `.pecot-session-title` | Claude Code のセッション名（`#<番号> <Issue タイトル>`。種別接頭辞なし・全体 40 文字） | `.pecot-active` と同じ 3 コマンド（`write_work_target`） | `session-title.sh`（SessionStart / UserPromptSubmit。`.pecot-active` の番号と一致するときだけ採用） | `pecot pr cleanup`（`.pecot-active` と同時） |
| `.wip-branch-linked` | Issue に紐づけ済みの WIP ブランチ名（`wip/<ブランチ名>`） | `auto-push.sh`（post-tool-use） | `auto-push.sh`（同じ名前なら紐づけを飛ばす） | `pecot pr cleanup`（`--skip-local-cleanup` なし） |
| `.pecot-quick-mode` | 空（存在のみ） | `pecot issue quick`（Epic 以外） | `exit-plan-remind.sh` | `pecot pr cleanup`、`exit-plan-remind.sh` |
| `pr-create-slash-pending` | 空（存在のみ） | `create-slash-flag.sh`（`/pecot-w:w-pr` 起動時） | `external-post-check.sh` | `pecot pr create`（実投稿成功時）、`create-slash-cleanup.sh` |
| `issue-create-slash-pending` | 起点のスキル名 | `create-slash-flag.sh`（`/pecot-w:w-quick`・`w-ready`・`w-backlog`・`w-issueize` 起動時） | `external-post-check.sh` | `pecot issue quick`・`pecot issue create`（実投稿成功時）、`create-slash-cleanup.sh` |
| `merge-slash-pending` | 空（存在のみ） | `create-slash-flag.sh`（`/pecot-w:w-merge` 起動時） | `external-post-check.sh` | `pecot pr cleanup`（片付けの成功時）、`create-slash-cleanup.sh` |
| `issue-pending` | 起点のスキル名（`w-quick` / `w-ready`） | `pecot-issue-pending-state.sh`、`pecot-skill-reminder.sh` | `pecot-issue-pending-reminder.sh` | `pecot issue quick`・`pecot issue create`（実投稿成功時）、`issue-pending-cleanup.sh` |

- `.pecot-active` は `pecot pr cleanup` を通さずに片付けた場合などに残り、CLOSED の Issue を指すことがある。`pecot session status -D .` で内容と Issue の OPEN/CLOSED を確認できる。消えた場合は `pecot session restore` でブランチ名から復元する（`--issue` で直接指定もできる）。
- スラッシュコマンド起点のフラグが存在する間、`external-post-check.sh` は対応するコマンドの確認を省く。
  - `pr-create-slash-pending`: `pecot pr create`
  - `issue-create-slash-pending`: `pecot issue quick`・`create`
  - `merge-slash-pending`: `gh pr merge`

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
