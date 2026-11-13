---
name: w-active
description: |
  Readyタスクを選択しブランチ作成・実装開始します。
  Use when the user wants to start an existing Ready task — picks the Issue, creates a feature branch, enters plan mode. Triggers: "next task", "pick a task", "start implementing".
  Do NOT use for new tasks from scratch (use w-quick) or for Issue-only creation (use w-ready).
when_to_use: "Ready のタスクに着手したい、次のタスクを始めたい、Issue の実装を開始したい"
---

# Readyからタスクを実装

**Readyステータスのタスクから1個選択→ブランチ作成→調査→計画を書く→レビュー→Issue に投稿→プランモードで承認を得る。**

## 手順

### Step 1: 事前確認とプロジェクト情報表示

#### 着手前の確認

`create_branch` は、次のときに、結果の `exit code: 2` の行を出して止まる。

- 作業ディレクトリのリポが Issue のリポと違うとき
- `.pecot-active` に別の Issue が残っているとき
- Issue の判定が blocked のとき
- `base` を渡していて、判定の積む先と違うとき

先に `session_status` を `directory: "."` で呼んで確かめる。

`.pecot-active` の内容と `## Active Issue` の OPEN/CLOSED が出る。違反時の対応:

1. `.pecot-active` に OPEN な別 Issue ref が残っている場合、`create_branch` は `exit code: 2` で止まる。前 Issue を片付けてから着手する。stale だと確信できるケースのみ `force_overwrite_active: true` を付ける。
2. CWD のリポが対象 Issue の `owner/repo` と異なる場合、`create_branch` は `exit code: 2` で止まる。対象リポの worktree（`<project-root>/base/<repo>/` または `<project-root>/<wtN>/<repo>/`）でセッションを始め直してから着手する。
   MCP ツールはセッションを始めたディレクトリのリポを見るので、`cd` では変わらない。
   始め直せないときだけ `allow_cross_repo: true` を付ける。
3. 判定が blocked のとき、`create_branch` は `exit code: 2` で止まり、出力に `is blocked by` が出る。出力の案内の行（`issue unblock ...` の行。待つ理由がマージのときは `issue block ... --wait stack` の行も）を、そのまま利用者に示す。前提を見直すかどうかは利用者が決める。エージェントの判断で前提を外さない。
4. 未コミット差分が新 Issue のスコープ外にある場合、CLI ガードの対象外になる。commit / stash / 破棄で clean にしてから着手する。前 Issue 由来なら先にその Issue を完了させる。

詳細根拠は [`w-help/references/issue-flow-rules.md`](../w-help/references/issue-flow-rules.md) §5。

#### プロジェクト情報表示

ボード状態とIssue一覧を確認し、どのタスクを選択するか判断する。`project_info` を引数なしで呼ぶ。

出力の判定の列（`Readiness`）、列を直した行（`moved:`）、食い違いの警告（`warning:`）を、利用者に伝える。

### Step 2: 対象タスクを確認

ユーザーが選択したタスクのIssue内容を確認する。`issue_read` を `issue_ref: "owner/repo/XXX"` で呼ぶ。

利用者がタスクを選ぶ材料に、判定（`startable`・`stackable`・`blocked`）を示す。`Blocked` の Issue が選ばれたら、理由を伝えて止める。

### Step 3: ベースブランチを最新化

ブランチ作成前に、現在のブランチを最新化する。

```bash
git pull
```

### Step 4: ブランチ作成

`create_branch` を `issue_ref: "owner/repo/XXX"`・`branch_name: "feat/description"` で呼ぶ。`base` は渡さない。base は CLI が選ぶ。

**ブランチ名の決め方:**

- `feat/` + タスクの簡潔な説明（英語、ケバブケース）
- 例: `feat/add-user-authentication`, `feat/fix-login-bug`

### Step 5: ブランチ切り替え

`create_branch` の結果の `created: branch <ブランチ名> in <owner/repo> from <base>` の行を読む。
ブランチ名とリポを取り出し、ブランチを切り替える。
行に `(stacked on #N)` があれば、#N の上に積んで着手した旨を利用者に伝える。
**そのリポジトリの** ワークツリーで実行すること。

```bash
git fetch origin
git checkout feat/description/XXX
```

**CWDと対象リポジトリが異なる場合:**

`created: branch` の行の `in <owner/repo>` は、ブランチを作成したリポジトリを指す。
CWDが別リポジトリであっても、そのリポジトリのワークツリーで `git checkout` を実行する。
ワークスペース内に該当リポジトリのワークツリーがあれば、そのディレクトリで実行すればよい。

今のワークツリーと同じ WT 名のワークツリーが作業対象リポジトリに存在しない場合は、
`/pecot-w:w-worktree-add` コマンドでWT作成を案内するか、作業を中止する。

### Step 6: 調査

通常モードのまま、Issue の Tasks / Acceptance を起点に、変更対象のファイル・既存の実装と命名・テストの構成を読む。EnterPlanMode を呼ばない。コードは編集しない。

### Step 7: 計画ドラフト作成

plan テンプレのファイルを作り、テンプレの見出しと規則のとおりに計画を書く。
`issue_comment` を `prepare: true`・`template: "plan"`・`issue: "<owner/repo/Issue番号>"` で呼ぶと、ファイルができる。

w-issueize で作ったフェーズの Issue は、Artifacts に speckit の一式（`specs/NNN-*/`）を持つ。一式が active Issue のリポにあるときは、このフェーズの Tasks に並ぶタスクを、その一式の tasks.md で `[x]` にする変更を Files に入れる。
tasks.md のチェックはタスクの単位の進捗で、並行で進められるタスクを探すときに読む。この PR のマージでフェーズの Issue が閉じるのと同時に、tasks.md のチェックもそろう。

変更対象は active Issue のリポジトリ内に限る。ほかのリポの変更は計画から外し、パッチに退避して当該リポへの起票を提案する（判定手順: [issue-flow-rules.md §6](../w-help/references/issue-flow-rules.md)）。

### Step 8: レビュー（通常モード・一巡 1 回）

通常モードのまま、書いた計画をレビューしてもらう。EnterPlanMode を呼ばない。

- w-tech-advisor を `Agent` ツールの単発 spawn でレビュー依頼する
- w-e2e-planner を `Agent` ツールの単発 spawn でレビュー依頼する
- 2 者の並列 spawn を既定とする。直列にする場合のみ、理由を `w-tech-advisor` の Goal 末尾に括弧書きで添える（例: `(直列の理由: ...)`）。Goal は spawn prompt の冒頭行を指す
- 1 メッセージ内の複数 `Agent` 呼び出しで spawn する。別メッセージで順に spawn すると直列になる。
- 指摘を計画に反映してから次の Step へ進む

レビューは一巡 1 回で、反映後の再レビューは不要。追質問は `SendMessage` で送る。

### Step 9: 計画の投稿

通常モードのまま、計画を Issue に投稿する。EnterPlanMode を呼ばない。`issue_comment` を `file: "<書いたファイル>"` で呼ぶ。

結果に `exit code: 3` の行が出て止まったら、指摘を直して呼び直す。

### Step 10: プランモードで承認を得る

EnterPlanMode を呼び、投稿した計画で承認を得る。

```
EnterPlanMode tool:
  (パラメータなし)
```

承認までに計画を直したら、承認後に投稿したファイルも同じように直し、Step 9 の呼び出しをやり直す。投稿したコメントが書き換わる。
