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
| `.pecot-active` | 作業中の Issue ref（`owner/repo/N`） | `pecot create-branch`、`pecot issue quick`、`pecot session restore` | `pecot create-branch`（別 Issue 上書きガード）、`pecot session status`、`pecot pr create --prepare`（Closes 補完）、`plan-mode-coordinator.sh`、`plan-flag-setter.sh`、`plan-issue-poster.sh`、`auto-push.sh`（post-tool-use） | `pecot pr merge`（`--skip-local-cleanup` なし） |
| `.pecot-session-title` | Claude Code のセッション名（`#<番号> <Issue タイトル>`。種別接頭辞なし・全体 40 文字） | `.pecot-active` と同じ 3 コマンド（`write_work_target`） | `session-title.sh`（SessionStart / UserPromptSubmit。`.pecot-active` の番号と一致するときだけ採用） | `pecot pr merge`（`.pecot-active` と同時） |
| `.pecot-quick-mode` | 空（存在のみ） | `pecot issue quick`（Epic 以外） | `exit-plan-mode-first-block.sh`、`plan-mode-reminder.sh`、`plan-issue-poster.sh` | `pecot pr merge`、`plan-issue-poster.sh`、`plan-post-fallback.sh` |
| `.plan-post-pending` | 1 行目 `<session_id>:<Issue ref>`、2 行目 計画ファイルの絶対パス | `plan-mode-coordinator.sh`、`plan-flag-setter.sh`（1 行目。いずれも `.pecot-active` があるとき）、`plan-path-recorder.sh`（2 行目。PreToolUse の ExitPlanMode） | `plan-post-fallback.sh`、`pecot session status` | `plan-issue-poster.sh`（投稿成功時・検証失敗時）、`plan-post-fallback.sh`（別セッションでの投稿成功時・検証失敗時） |
| `pr-create-slash-pending` | 空（存在のみ） | `create-slash-flag.sh`（`/pecot-w:w-pr` 起動時） | `external-post-check.sh` | `pecot pr create`（実投稿成功時）、`create-slash-cleanup.sh` |
| `issue-create-slash-pending` | 起点のスキル名 | `create-slash-flag.sh`（`/pecot-w:w-quick`・`w-ready`・`w-backlog`・`w-issueize` 起動時） | `external-post-check.sh` | `pecot issue quick`・`pecot issue create`（実投稿成功時）、`create-slash-cleanup.sh` |
| `issue-pending` | 起点のスキル名（`w-quick` / `w-ready`） | `pecot-issue-pending-state.sh`、`pecot-skill-reminder.sh` | `pecot-issue-pending-reminder.sh` | `pecot issue quick`・`pecot issue create`（実投稿成功時）、`issue-pending-cleanup.sh` |

- `.pecot-active` は `pecot pr merge` を通さずにマージした場合などに残り、CLOSED の Issue を指すことがある。`pecot session status -D .` で内容と Issue の OPEN/CLOSED を確認できる。消えた場合は `pecot session restore` でブランチ名から復元する（`--issue` で直接指定もできる）。
- `.plan-post-pending` は ExitPlanMode 後の計画投稿を待つ間だけ存在する。
  コンテキストクリアで同じセッションの投稿が行われなかった場合は、`plan-post-fallback.sh` が投稿する。
  動くのは、新しいセッションの最初の Stop（Claude Code のみ。`stop-plan-post.sh`、timeout 90 秒）である。
  投稿する内容は、旧セッションの PreToolUse(ExitPlanMode) が 2 行目に残した計画ファイルのパスから読む。
  first-block が deny した呼び出しでは、パスを残さない。
  投稿するのは、新セッションの transcript の先頭付近に、最初のユーザーメッセージ `Implement the following plan:` があるときだけである。
  このメッセージは、承認でクリアしたときだけ自動で投げられる。
  無ければ（単なる `/clear`・計画却下後の `/clear`・無関係なセッション）、投稿せずフラグを消す。
  同じセッションの Stop ではフラグを戻して何もしない。
  承認のクリアなのに計画ファイルが無い・空のときも消す。
  `pecot issue comment` が exit code 3（plan テンプレの検証失敗）で終わったときは、フラグを消す。
  このとき、`pecot issue comment --prepare -t plan` による手動投稿を systemMessage で案内する。
  それ以外の失敗（通信エラー等）では残し、次の Stop に再試行する。
- `pr-create-slash-pending` / `issue-create-slash-pending` が存在する間、`external-post-check.sh` は次のコマンドの確認を省く。
  対象は、対応する `pecot pr create` / `pecot issue quick`・`create` である。

## hooks だけが使う状態ファイル

| ファイル | 書き手 | 読み手 | 消し手 |
|----------|--------|--------|--------|
| `.exit-plan-confirmed` | `exit-plan-mode-first-block.sh` | `exit-plan-mode-first-block.sh` | `plan-flag-setter.sh` |
| `.auto-push-urls` | `auto-push.sh`（post-tool-use） | `auto-push.sh`（stop） | `auto-push.sh`（stop） |
| `session-title-sent` | `session-title.sh`（`<session_id>:<題名>`。`sessionTitle` を出した直後） | `session-title.sh`（同じ題名を同じセッションに再送しない） | なし（次の題名で上書き） |

## セッション境界での削除

SessionStart（startup / clear / resume のいずれも）で次のフラグを削除する。それ以外のフラグはセッションをまたいで残る。

| スクリプト | 削除対象 |
|------------|----------|
| `create-slash-cleanup.sh` | `pr-create-slash-pending`、`issue-create-slash-pending` |
| `issue-pending-cleanup.sh` | `issue-pending` |
