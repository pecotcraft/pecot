---
name: w-merge
description: |
  PRをマージしブランチ削除・後処理を実行します。
  Use when the user wants to merge a PR and run post-merge cleanup (branch delete, worktree switch-back, pull latest). Triggers: "merge", "merge the PR".
  Do NOT use for creating PRs (use w-pr) or release merges from develop to main (use w-release).
when_to_use: "PR をマージしたい、マージ後のブランチ削除と後片付けをしたい"
---
# PRマージ

PRをマージし、マージ後にブランチ削除とワークツリー環境の後処理を実行します。

## 手順

### Step 1: PR状態確認

対象の PR は、引数の `owner/repo/PR番号` で受け取る。省略されたら、直前の会話から一意に決まる PR を使う。決まらないときだけユーザーに確認する。

pecot-workflow の MCP ツール `pr_show` を使って、PR がマージ可能な状態かを確かめる。
続いて、pecot-workflow の MCP ツール `pr_check` を使って、ローカルに取り込んでいない変更が無いかを確かめる。指摘があれば、解決してからマージに進む。

### Step 2: マージと片付け

#### 2.1 マージ

```bash
gh pr merge <PR番号> --repo <owner>/<repo> --squash
```

merge queue のあるリポや、必須チェックが終わっていない PR では、その場ではマージされない。2.2 で待つ。

#### 2.2 マージを待つ

Claude Code では Monitor ツールで、次のスクリプトを動かして待つ。期限（timeout_ms）は 30 分（1800000）で渡す。期限で止まったら、同じコマンドで起動し直す。

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/merge-wait.sh" <owner>/<repo>/<PR番号>
```

スクリプトは、抜けた理由を 1 行目に、最後の状態を 2 行目以降に出す。理由に合う行を実行する。

| 1 行目の理由 | 次の手順 |
|---|---|
| `merged` | 2.3 へ進む |
| `conflicting` | `origin/main` を取り込み直し、コンフリクトを直して push する |
| `required-failed` | 落ちたチェックを読んでユーザーに伝える。直して push する |
| `not-queued` | 落ちたチェックがあれば直して push し、2.1 からやり直す。無ければ理由をユーザーに伝えて止まる |
| `stalled` | 状態をユーザーに伝える。queue の中か、チェックが進んでいるなら、待ち直しを勧める |
| `closed`・`blocked`・`query-failed` | 出力をユーザーに伝えて止まる |

- push した後は、2 行目の `auto-merge=` が `true` なら 2.2 から、`false` なら 2.1 からやり直す
- CI や queue が 15 分を超えるリポでは、`--stall-minutes <分>` を付けて起動する
- GitHub Copilot CLI など Monitor のない環境では、数分おいて 2.3 をやり直す

#### 2.3 片付け

pecot-workflow の MCP ツール `session_finish` を使って、マージ後の片付けをする。リモートブランチも消す（`delete_branch: true`）。

警告が出たら、その文に従って手で対応する。ワークツリー環境の手順は [ワークツリー環境での処理](references/worktree-handling.md) にある。

### Step 3: 実装差分分析・Epicコメント

片付けで閉じた Issue に親 Epic があるときだけ行う。親 Epic は、pecot-workflow の MCP ツール `issue_show` で確かめる。

1. マージした PR の変更と、Issue の本文の計画を比べる
2. pecot-workflow の MCP ツール `issue_comment` を使って、Epic 宛ての merge-diff テンプレのファイルを作る
3. テンプレのガイドに従って本文を書き、`issue_comment` を使って Epic に投稿する

計画どおりで差分が無いときも、その旨を投稿する。変更ファイルの一覧は本文に書かない。

### Step 4: speckit後続フェーズ通知（条件付き）

speckit 由来のタスクで、後続のフェーズに影響する変更があるときだけ行う。speckit 由来とは、Issue の本文か、親 Epic のほかのサブタスクが `specs/`・`.specify/` に触れているものを指す。

1. `issue_show` を使って親 Epic を読み、現在のタスク以外の OPEN のサブタスクを選ぶ
2. `issue_comment` を使って、その Issue 宛ての precede-notify テンプレのファイルを作る
3. テンプレのガイドに従って本文を書き、`issue_comment` を使って投稿する
