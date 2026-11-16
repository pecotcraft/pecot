# フラグ一覧

pecot の CLI・MCP ツールと hooks は、セッションの作業対象やモードを `.pecot/state/` 配下のフラグファイルで共有する。
フラグはプロジェクトルート（worktree）ごとに独立する。

## プロジェクトルートの解決

CLI と MCP ツールはコマンドの cwd の git toplevel（環境変数 `CLAUDE_PROJECT_DIR` があればそれ）を基準にする。
hooks は hook 入力の `cwd` の git toplevel を基準にする。
どちらも、その直下の `.pecot/state/` を読み書きする。Bash ツールの PreToolUse は実行前の cwd で発火するため `cd` を含むコマンドでは hook と CLI の基準がずれる。
ネストした clone 内で発火した hook はその clone を基準にする。

## CLI と hooks が共有するフラグ

表の `session_start`・`pr_create` などは、pecot-workflow の MCP ツールの名前。

| フラグ | 内容 | 書き手 | 読み手 | 消し手 |
|--------|------|--------|--------|--------|
| `.pecot-session-title` | Claude Code のセッション名（`#<番号> <Issue タイトル>`。種別接頭辞なし・全体 40 文字） | `session_start` | `session-title.sh`（SessionStart / UserPromptSubmit。ブランチ名の末尾の番号と一致するときだけ採用） | `session_finish` |
| `.pecot-base` | 着手時に選んだ base（`<branch> <sha> [<owner/repo#N>]`。積んだときだけ末尾に積んだ先の Issue） | `session_start` | `session_show` | `session_finish` |
| `.wip-branch-linked` | Issue に紐づけ済みの WIP ブランチ名（`wip/<ブランチ名>`） | `auto-push.sh`（post-tool-use） | `auto-push.sh`（同じ名前なら紐づけを飛ばす） | `session_finish`（`skip_local_cleanup` なし） |
| `.pecot-quick-mode` | 空（存在のみ） | `issue_create`（`freeform: true`・Epic 以外） | `exit-plan-remind.sh` | `session_finish`、`exit-plan-remind.sh` |
| `issue-pending` | 起点のスキル名（`w-quick` / `w-ready`） | `pecot-issue-pending-state.sh`、`pecot-skill-reminder.sh` | `pecot-issue-pending-reminder.sh` | `issue_create`（実投稿成功時）、`issue-pending-cleanup.sh` |

- 作業中の Issue は、フラグではなく git の remote（origin、無ければ最初）とブランチ名の末尾の `/<番号>` から求める。pecot-workflow の MCP ツール `session_show` で、Issue と OPEN/CLOSED を確認できる。

## hooks だけが使う状態ファイル

| ファイル | 書き手 | 読み手 | 消し手 |
|----------|--------|--------|--------|
| `.auto-push-urls` | `auto-push.sh`（post-tool-use） | `auto-push.sh`（stop） | `auto-push.sh`（stop） |
| `session-title-sent` | `session-title.sh`（`<session_id>:<題名>`。`sessionTitle` を出した直後） | `session-title.sh`（同じ題名を同じセッションに再送しない） | なし（次の題名で上書き） |

## セッション境界での削除

SessionStart（startup / clear / resume のいずれも）で次のフラグを削除する。それ以外のフラグはセッションをまたいで残る。

| スクリプト | 削除対象 |
|------------|----------|
| `issue-pending-cleanup.sh` | `issue-pending` |
