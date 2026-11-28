# フラグ一覧

pecot-workflow の MCP ツールと hooks は、セッションの作業対象やモードを `.pecot/state/` 配下のフラグファイルで共有する。
フラグはプロジェクトルート（worktree）ごとに独立する。

## プロジェクトルートの解決

MCP ツールはサーバの cwd の git toplevel（環境変数 `CLAUDE_PROJECT_DIR` があればそれ）を基準にする。
hooks は hook 入力の `cwd` の git toplevel を基準にする。
どちらも、その直下の `.pecot/state/` を読み書きする。
ネストした clone 内で発火した hook はその clone を基準にする。

## MCP ツールと hooks が共有するフラグ

表の `session_start`・`pr_check` などは、pecot-workflow の MCP ツールの名前。

| フラグ | 内容 | 書き手 | 読み手 | 消し手 |
|--------|------|--------|--------|--------|
| `.pecot-session-title` | Claude Code のセッション名（`#<番号> <Issue タイトル>`。種別接頭辞なし・全体 40 文字） | `session_start` | `session-title.sh`（SessionStart / UserPromptSubmit。ブランチ名の末尾の番号と一致するときだけ採用） | `session_finish`（終えた PR の Issue の記録のときだけ） |
| `.pecot-base` | 着手時に選んだ base（`<branch> <sha> [<owner/repo#N>]`。スタックしたときだけ末尾にスタック先の Issue） | `session_start`・`pr_restack` | `session_show`・`pr_check`・`pr_restack` | `session_finish`（`.pecot-session-title` が終えた PR の Issue のときだけ） |

- `.pecot-base` が無い作業ディレクトリ（別の worktree や clone で checkout したブランチ）では、作業中の Issue の判定と git からスタック先を求める。求めた結果は書かない
- 作業中の Issue は、フラグではなく git の remote（origin、無ければ最初）とブランチ名の末尾の `/<番号>` から求める。pecot-workflow の MCP ツール `session_show` で、Issue と OPEN/CLOSED を確認できる。

- 後片付けの前に次の Issue に着手したときは、`.pecot-session-title` が次の Issue の番号になる。`session_finish` は、そのときの 2 つの記録を消さずに残す

## MCP ツールだけが使う状態ファイル

| ファイル | 内容 | 書き手 | 読み手 | 消し手 |
|----------|------|--------|--------|--------|
| `.pecot-restack` | 衝突で止まったスタックし直しの途中の記録 | `pr_restack` | `pr_restack`（`continue`・`abort`） | `pr_restack`（続行か取りやめ） |

## hooks だけが使う状態ファイル

| ファイル | 書き手 | 読み手 | 消し手 |
|----------|--------|--------|--------|
| `session-title-sent` | `session-title.sh`（`<session_id>:<題名>`。`sessionTitle` を出した直後） | `session-title.sh`（同じ題名を同じセッションに再送しない） | なし（次の題名で上書き） |
| `.plugin-sync-version` | `pecot-dir-init.sh`（`.pecot` の初期化の後） | `pecot-dir-init.sh`（`plugin.json` より新しければ初期化を省く） | なし |
