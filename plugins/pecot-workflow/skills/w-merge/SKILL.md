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

引数 `owner/repo/PR番号` 形式（例: `acme-labs/ai-engineer-starter-kit/759`）を受け取る。省略された場合は、直前の会話から対象 PR が一意に特定できる（同じセッションで作成・レビューした PR が 1 件しかない等）ならそれを採用して進んでよい。曖昧な場合にのみユーザーに確認する。

```bash
pecot pr read <owner>/<repo>/<PR番号>
```

PRがマージ可能な状態であることを確認する。続いて、ローカルに取り込んでいない変更がないかを確認する。

```bash
pecot pr preflight -D .
```

exit 1 なら出力を見て解決し、再実行してからマージに進む。

### Step 2: マージと片付け

#### 2.1 マージ

```bash
gh pr merge <PR番号> --repo <owner>/<repo> --squash
```

- merge queue のないリポでは、その場でマージされる
- merge queue のあるリポでは、PR を queue に入れて終わる。マージはこの後に GitHub が行う
- 必須チェックが終わっていないときは、auto-merge の予約になる

#### 2.2 マージを待つ

Claude Code では Monitor ツールで次の until ループを動かし、抜けるまで待つ。`<owner>` などは置き換える。

```bash
until s=$(gh api graphql -F o=<owner> -F r=<repo> -F n=<PR番号> \
  -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){state isInMergeQueue autoMergeRequest{enabledAt}}}}' \
  --jq '.data.repository.pullRequest | "\(.state) \(.isInMergeQueue) \(.autoMergeRequest != null)"'); \
  case "$s" in MERGED*|CLOSED*|"OPEN false false") true ;; *) false ;; esac; do sleep 30; done; echo "$s"
```

- `MERGED ...` で抜けたら 2.3 へ進む
- `OPEN false false` で抜けたら、queue から外れている（CI の失敗など）。`gh pr checks <PR番号> --repo <owner>/<repo>` で落ちたチェックを読んでユーザーに伝え、片付けをせずに止まる。直して push し、2.1 からやり直す
- `CLOSED ...` で抜けたら、ユーザーに伝えて止まる
- GitHub Copilot CLI など Monitor のない環境では、数分おいて 2.3 を打ち直す。未マージなら exit 1 で何もしない

#### 2.3 片付け

```bash
pecot pr cleanup <owner>/<repo>/<PR番号> --delete-branch
```

> 注意: マージ後の片付けは必ず `pecot pr cleanup` で行う。`gh pr merge` の `--delete-branch` は使わない（ローカルの片付けとフラグの削除が漏れる）

`pecot pr cleanup` は PR が MERGED のときだけ動く。それ以外は何もせず exit 1 で終わる。

**オプション**:

- `--delete-branch, -d`: リモートブランチを削除（デフォルトで付与）
- `--dry-run, -n`: ドライラン（実際には片付けない）
- `--skip-local-cleanup`: ローカルの後処理をスキップする

### Step 3: ローカルクリーンアップの確認

`pr cleanup` コマンドが自動的に以下を実行する。

- WT環境では、wtXブランチへ切替 → `git pull origin <開発ブランチ>` → ローカルフィーチャーブランチ削除
- 通常環境では、開発ブランチへ切替 → `git pull` → ローカルフィーチャーブランチ削除
- クロスリポでは、現在のリポとPRのリポが異なる場合、ローカルクリーンアップはスキップされる

出力を確認し、エラーがあれば以下で手動対応:

- ワーキングツリーが汚れている場合: `git stash` してから再実行
- `--skip-local-cleanup` でローカル後処理をスキップし、手動で対応

> 注意: ワークツリー環境では`wtX`ブランチ（ベースブランチ）を削除しない。`cd`コマンドで他のワークツリーやmainワークツリーに移動しない

詳細: [ワークツリー環境での処理](references/worktree-handling.md)

### Step 4: 実装差分分析・Epicコメント

マージしたPRの実装内容と、サブタスクIssueに記載された実装計画を比較し、差分をEpicにコメントする。

スキップ条件は次のとおりで、いずれかに該当する場合は Step 4-5 をスキップする。

- `pr cleanup` の出力に「クローズしたIssue」がない（Issue未紐付けPR）
- クローズしたIssueに `Parent:` フィールドがない（独立タスク、フォローアップ修正等）

#### 4.1 サブタスクIssueの確認

`pr cleanup` の出力からクローズしたIssue番号を取得し、Issueを読む。

```bash
pecot issue read <owner>/<repo>/<issue_number>
```

- `Parent:` フィールドから親EpicのIssue番号を取得 → なければ **Step 4-5 をスキップ**

#### 4.2 実装内容の把握

マージされたPRの変更内容を把握する。ここで集めた事実は 4.3 の Variance
（計画と実績の差分）を判断するために使う。変更ファイル一覧そのものはコメント本文に転記しない
（PR の Files changed が見せる）。

- PRの変更ファイル一覧（`pr cleanup` の出力やgit logから）
- 実際に変更されたモジュール・関数

#### 4.3 差分サマリーの生成

Issue本文の計画と実際の変更を比較し、テンプレ実体に従ってサマリーを生成する。

```bash
pecot issue comment --prepare -t merge-diff --issue <owner>/<repo>/<epic番号>
```

- 出力されたファイル冒頭の `<!-- 読者:/書き方: -->` コメントに従い、必須見出しを維持したまま本文を埋める
- 見出しレベル・記号・節構成はテンプレを基準とする。SKILL.md にはフォーマット例示を持たない

#### 4.4 Epicにコメント投稿

4.3 で編集したファイルを投稿する。

```bash
pecot issue comment <編集後ファイル>
```

> 注意: `pecot issue comment` 以外の方法（MCP等）でIssueコメントを投稿しない

差分がまったくない（計画通り）の場合も、「計画通り完了」のコメントを投稿する。

### Step 5: speckit後続フェーズ通知（条件付き）

**この工程はspeckit由来のタスクの場合のみ実行する。**

#### speckit由来の判定条件

以下のいずれかに該当する場合、speckit由来と判定:

- Issue本文に `.specify/` パスへの言及がある
- 親Epicの他のサブタスクがspeckit形式（`[Task] #XXX-NN:` または枝付きの `[Task] #XXX-NNa:` 形式でorder付き、かつ `specs/` への言及がある）

#### 5.1 後続フェーズの特定

```bash
pecot issue read <owner>/<repo>/<epic番号>
```

`Sub-issues:` セクションから次を行う。

1. 現在のタスクを特定（タイトルの `#XXX-NN` で識別。枝の文字がある場合は `#XXX-NNa` まで含める）
2. 現在のタスク以外の OPEN なサブタスクを抽出（orderの大小は問わない）

#### 5.2 影響コメントの投稿

後続フェーズに影響する変更がある場合、テンプレ実体に従って影響コメントを生成・投稿する。

```bash
pecot issue comment --prepare -t precede-notify --issue <owner>/<repo>/<後続issue番号>
# 出力された .pecot/tmp/output/ 配下の md を編集後:
pecot issue comment <編集後ファイル>
```

- フォーマットはテンプレ実体に従う。SKILL.md にはフォーマット例示を持たない

影響がない場合はコメント不要。
