---
name: w-handoff
description: |
  マージされたPRの結果を、Epicと後続のIssueにコメントで引き継ぎます。引き継ぎのワークフローが起こします。
  Runs inside the pecot handoff workflow on GitHub Actions after a pull request is merged — compares the merged changes with the plan and posts a merge-diff comment on the parent Epic, and a precede-notify comment on the later tasks when a speckit task affects them. It does not clean up branches or Issues. Not for a local session.
when_to_use: "引き継ぎのワークフローが、マージされた PR の結果を Epic と後続の Issue に書くとき"
---

# マージの引き継ぎ

引き継ぎのワークフロー（GitHub Actions）が、PR がマージされたときに起こす。マージした結果と計画の違いを親 Epic に書き、後続のタスクに影響があれば、その Issue にも書いて終わる。

Epic と後続へのコメントは、このスキルだけが書く。Issue のクローズとブランチの削除は、ボードの同期のワークフローと、PR を出したセッションが行う。このスキルでは行わない。

## 手順

引数は、マージされた PR の `owner/repo/N`。

引数の `project=<名前>` は使わない。このスキルが使う pecot-workflow の MCP ツール（`issue_comment_check`）は、ボードの設定を読まない。

Issue とコメントは、GitHub の公式の MCP のツールで読み書きする。書く前に pecot-workflow のチェックのツールに通す。手順は [GitHub に公式の MCP と github-ops で書く](../w-help/references/github-write.md)。

### Step 1: PR と閉じた Issue と親 Epic を読む

公式の MCP の `pull_request_read`（`get`）で、引数の PR を読む。

PR が閉じた Issue を、次の 2 つを合わせて求める。重なる Issue は 1 つに数える。

- head ブランチ（`head.ref`）の名前の末尾が `/<番号>` なら、同じリポのその番号の Issue
- PR の本文の閉じるキーワード（`Closes #N`・`Fixes #N`・`Resolves #N` など）が指す、同じリポの Issue。公式の MCP は、PR が閉じる Issue を返さないためだ

PR が閉じた Issue を、公式の MCP の `issue_read` で 1 つずつ読む。本文は `get`、コメントは `get_comments` で読む。`get` の結果の `parent` が、その Issue の親 Epic になる。ただし、`parent` の `title` が `[Tracker]` で始まるものは Tracker なので、親 Epic に数えない。

親 Epic を持つ Issue が 1 つも無ければ、何も投稿せずに終える。PR の閉じた Issue が無いときも同じ。

### Step 2: Epic に merge-diff を投稿する

親 Epic ごとに、1 つの merge-diff を投稿する。同じ Epic の下の Issue を PR が 2 つ以上閉じたときは、まとめて 1 つにする。

1. PR の変更を `gh pr diff <PR番号> --repo <owner/repo>` で読む。長い diff がファイルとして渡されたときは、そのファイルを `Read` で読む
2. Step 1 で読んだ Issue のコメントから、計画のコメントを探す。計画のコメントは、`## Plan` と `## PECOT-Workflow` の 2 つの見出しを持つ。複数あれば、新しい方を使う。見つからなければ、Issue の本文を計画として読む
3. PR の変更と計画を比べる
4. pecot-workflow の MCP サーバの resource `pecot-template://comment/merge-diff` を読み、そのガイドに従って本文を書く
5. 本文をファイルへ写さず、Epic の `owner`・`repo`・`issue_number` と一緒に、pecot-workflow の MCP ツール `issue_comment_check` に渡す。通ったら、公式の MCP の `add_issue_comment` で投稿する。Epic の owner と repo は、`parent` の `url` から取る

計画どおりで違いが無いときも、その旨を投稿する。変更ファイルの一覧は本文に書かない。

### Step 3: 後続の Issue に precede-notify を投稿する

speckit 由来のタスクで、後続のタスクに影響する変更があるときだけ行う。speckit 由来とは、PR が閉じた Issue の本文か、親 Epic のほかのサブタスクが `specs/`・`.specify/` に触れているものを指す。どちらでもなければ、ここで終える。

1. 親 Epic の sub-issue を `issue_read`（`get_sub_issues`）で読む。OPEN のものの前提を、`issue_dependency_read`（`get_blocked_by`）で 1 つずつ読む。Step 1 で求めた PR が閉じた Issue は、まだ OPEN でも候補から除く。ボードの同期のワークフローが、並んで閉じている途中のことがあるためだ
2. 通知する Issue を選ぶ。前提に、PR が閉じた Issue を持つものを選ぶ。無ければ、1 で残った OPEN のサブタスクのすべてを選ぶ
3. 選んだ Issue のうち、Step 2 で読んだ変更の影響を受けるものだけに絞る。影響を受けるものが無ければ、ここで終える
4. pecot-workflow の MCP サーバの resource `pecot-template://comment/precede-notify` を読む。そのガイドに従って、Issue ごとに本文を書く
5. 本文をファイルへ写さず、その Issue の `owner`・`repo`・`issue_number` と一緒に `issue_comment_check` へ渡す。通ったら、`add_issue_comment` で投稿する

投稿したら終わる。ファイルを書き換えず、Issue を閉じず、ブランチも消さない。
