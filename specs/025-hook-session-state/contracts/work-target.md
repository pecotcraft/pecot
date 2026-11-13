# Contract: 作業中の Issue と MCP ツール

**Feature**: [../spec.md](../spec.md)

MCP ツールとフックが、作業中の Issue をどう求め、どう使うかを決める。テストの期待と `interface/authored.yaml` の項目は、この表から作る。

## 求め方

| remote | ブランチ | 作業中の Issue |
|---|---|---|
| `owner/repo` | `feat/x/387` | `owner/repo#387` |
| `owner/repo` | `feat/20261112-101500/412` | `owner/repo#412` |
| `owner/repo` | `main`・`wt4`・`025-hook-session-state` | 無い |
| `owner/repo` | `feat/x/387a`・`feat/387/x` | 無い（最後の区切りが数字だけでない） |
| `owner/repo` | detached HEAD | 無い |
| 読めない | `feat/x/387` | 無い |

古い版の `.pecot-active` が残っていても、読まない。

## `create_branch`

| 入力・状況 | 今 | 変更の後 |
|---|---|---|
| セッションのリポと Issue のリポが同じ | ブランチを作り、ボードを active にし、`.pecot-active` と題名を書く | ブランチを作り、ボードを active にし、題名のキャッシュと作業ディレクトリを作る |
| セッションのリポと Issue のリポが違う | 終了コード 2。`allow_cross_repo` で通る | 終了コード 2。通す入力は無い |
| `.pecot-active` が別の OPEN の Issue | 終了コード 2。`force_overwrite_active` で通る | 確かめない |
| `allow_cross_repo`・`force_overwrite_active` を渡す | 受ける | 未知の入力として弾く |
| 結果の行 | `set: work target owner/repo/N (work directory …)` | 作業対象を記録した、とは出さない。作業ディレクトリを作った行にする |

## `issue_quick`

| 入力・状況 | 今 | 変更の後 |
|---|---|---|
| ブランチを作った | `.pecot-active` と題名を書く。Epic・Tracker 以外なら `.pecot-quick-mode` を作る | 題名のキャッシュと作業ディレクトリを作る。`.pecot-quick-mode` は作らない |
| `no_branch` | `.pecot-active` と題名を書く | 作業ディレクトリだけを作る |
| ブランチの作成が API で失敗した | warning を出して続ける | 同じ |
| `repo` がセッションのリポと違い、ブランチを作る | 起票し、ブランチを作る | 起票の前に終了コード 2 で止める |
| `repo` がセッションのリポと違い、`no_branch` | 起票する | 同じ |
| 起票に成功した | `issue-pending` と `issue-create-slash-pending` を消す | 消さない（読む者がいない） |

## `pr_create`（下書き）

| 状況 | `Closes` の補完 |
|---|---|
| 作業中の Issue がある | `Closes #<番号>` |
| 作業中の Issue が無い | 補わない |
| `.pecot/state/` の無い clone で、紐づいたブランチにいる | `Closes #<番号>` |

実投稿に成功しても、`pr-create-slash-pending` は消さない（読む者がいない）。

## `pr_cleanup`

| 状況 | 今 | 変更の後 |
|---|---|---|
| 手元の片付けを終えた | `.pecot-active`・`.pecot-session-title`・`.pecot-quick-mode`・`.wip-branch-linked`・`merge-slash-pending` を消す | `.pecot-session-title` だけを消す |

## `session_status`

| 状況 | 出力 |
|---|---|
| 作業中の Issue がある | ブランチ、リポ、作業中の Issue（`owner/repo#N`）、その題名・状態・本文 |
| 作業中の Issue が無い | ブランチ、リポ、「無い」 |
| Issue を GitHub から読めない | warning を出し、題名の節を出さずに終了コード 0 |

フラグの表は出さない。

## `session_restore`

コマンドと MCP ツールを除く。呼ぶと、未知のコマンド・ツールとして扱われる。

## フック

| フック | 状況 | 出力 |
|---|---|---|
| `session-title` | 作業中の Issue があり、題名のキャッシュが同じ番号 | `#<番号> <題名>` |
| `session-title` | 作業中の Issue があり、題名のキャッシュが無いか別の番号 | `#<番号>` |
| `session-title` | 作業中の Issue が無い | 何も出さない |
| `exit-plan-remind` | 作業中の Issue が無い | 何も出さない |

出す条件のうち、ここに無いもの（同じ題名は送り直さない、など）は変えない。

## w-breakdown

| 手順 | 期待 |
|---|---|
| 対象の Epic を決めた | `issue_quick` を `parent_epic` 付きで呼ぶ。タスクが Epic の下にでき、Active に載る |
| タスクができた | 結果のブランチを checkout する |
| specify を始める | git 拡張は、今のブランチ名を受けて新しいブランチを作らない |
| 工程を終えた | 成果物を、タスクを閉じる PR にする |

## 文書

| 文書 | 変更の後 |
|---|---|
| `skills/w-active/SKILL.md` | `.pecot-active` の確認と `force_overwrite_active`・`allow_cross_repo` の記述が無い |
| `skills/w-quick/SKILL.md` | 別のリポの worktree で checkout する手順が無い。起票先は、セッションのリポにする |
| `skills/w-help/references/flags.md` | 残る状態のファイルだけを載せる |
| `skills/w-help/references/issue-flow-rules.md` §5・§6 | 作業中の Issue を、remote とブランチ名で説明する |
| `agents/w-implementer.md` | 編集してよいリポを、作業中の worktree の remote のリポとする |
| `skills/w-help/references/commands.md` | 生成し直す（`session restore` が消える） |
