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

#### 2.1 CI を待つ

w-pr の Step 4 と同じコマンドで、CI を待つ。Claude Code では Bash の background 実行、GitHub Copilot CLI では非同期の実行で動かす。

```bash
gh pr checks <PR番号> --repo <owner>/<repo> --watch --fail-fast > /dev/null 2>&1; gh pr checks <PR番号> --repo <owner>/<repo>
```

- `no checks reported` が出たら、少しおいて打ち直す。2 回続いたら CI の無いリポとみなし、2.2 へ進む
- 落ちたら、PR の変更が原因なら直して push し、2.1 からやり直す。関係ない失敗は利用者に伝えて止まる

#### 2.2 マージ

pecot-workflow の MCP ツール `pr_merge` を使って、PR をマージする。結果に合う行を実行する。

| 結果 | 次の手順 |
|---|---|
| マージされた | 2.3 へ進む |
| merge queue に入った | 下のコマンドで、queue から出るまで待つ |
| スタックの最下段でないと止まった | 先にマージする PR を利用者に示して止まる。下の段の PR をマージしない |
| GitHub が拒んだ | 必須チェックが終わっていないなら、2.1 からやり直す。ほかの理由は利用者に伝えて止まる |

queue から出るまで、2.1 と同じ実行の仕方で待つ。`gh pr view --json` は queue の状態を持たないので、GraphQL で読む。

```bash
while [ "$(gh api graphql -F n=<PR番号> -f query='query($n:Int!){repository(owner:"<owner>",name:"<repo>"){pullRequest(number:$n){isInMergeQueue}}}' --jq .data.repository.pullRequest.isInMergeQueue)" = true ]; do sleep 30; done; gh pr view <PR番号> --repo <owner>/<repo> --json state -q .state
```

- `MERGED` なら 2.3 へ進む
- `OPEN` なら、queue のチェックが落ちたかコンフリクトで外された。原因を読んで直し、2.1 からやり直す

#### 2.3 片付け

pecot-workflow の MCP ツール `session_finish` を使って、マージ後の片付けをする。リモートブランチも消す（`delete_branch: true`）。

警告が出たら、その文に従って手で対応する。ワークツリー環境の手順は [ワークツリー環境での処理](references/worktree-handling.md) にある。

結果に判定の変化（`readinessChanges`）があれば、着手できるようになった Issue を利用者に伝える。
上に積んだ段（`restack`）があれば、その段の作業ディレクトリで載せ直しが要ることを利用者に伝える。ほかの作業ディレクトリには入らない。

### Step 3: 実装差分分析・Epicコメント

PR が閉じた Issue に親 Epic があるときだけ行う。親 Epic は、pecot-workflow の MCP ツール `issue_show` で確かめる。

PR が閉じた Issue は、片付けの結果の `closedIssues` の Issue と、`skippedIssues` の `already-closed` の Issue。
`already-closed` の Issue は、`pr_show` で読む PR の closing issues にあるものだけを数える。

1. マージした PR の変更と、Issue の本文の計画を比べる
2. pecot-workflow の MCP ツール `issue_comment` を使って、Epic 宛ての merge-diff テンプレのファイルを作る
3. テンプレのガイドに従って本文を書き、`issue_comment` を使って Epic に投稿する

計画どおりで差分が無いときも、その旨を投稿する。変更ファイルの一覧は本文に書かない。

### Step 4: speckit後続フェーズ通知（条件付き）

speckit 由来のタスクで、後続のフェーズに影響する変更があるときだけ行う。speckit 由来とは、Issue の本文か、親 Epic のほかのサブタスクが `specs/`・`.specify/` に触れているものを指す。

1. 通知する Issue を選ぶ。片付けの結果に判定の変化（`readinessChanges`）があれば、その Issue を選ぶ。無ければ、`issue_show` を使って親 Epic を読み、現在のタスク以外の OPEN のサブタスクを選ぶ
2. `issue_comment` を使って、その Issue 宛ての precede-notify テンプレのファイルを作る
3. テンプレのガイドに従って本文を書き、`issue_comment` を使って投稿する
