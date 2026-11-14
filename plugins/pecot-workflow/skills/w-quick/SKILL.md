---
name: w-quick
description: |
  小タスクを即Issue化しブランチ作成・実装開始します。
  Use when the user has a small task to tackle immediately (one-file fix, minor bug, quick tweak) and no Issue exists yet — creates the Issue, branch, and enters plan mode in one step.
  Do NOT use when picking up an existing task from the board (use w-active).
when_to_use: "小さな修正をすぐ始めたい、Issue 作成からブランチ作成まで一度に済ませたい"
argument-hint: "[タスクの内容]"
---

# 簡単なタスクの即Issue化

1ファイル修正や小さなバグ修正など、簡単なタスクを即座にIssue化してブランチ作成→調査→計画を書く→Issue に投稿→プランモードで承認を得る。Issue作成・ブランチ作成が完了するまで実装作業には着手しない。

## 手順

### Step 1: 起票の前の確認とIssue作成（issue_create）

#### 起票の前の確認

`session_start`（Step 2）は、Issue を作った後に、結果の `exit code: 2` の行を出して止まることがある。作ってから止まらないよう、Issue を作る前に確かめる。

- 作業ディレクトリのリポが Issue のリポと違うとき
- `.pecot-active` に別の OPEN の Issue が残っているとき

`session_show` を `directory: "."` で呼び、`.pecot-active` の内容と `## Active Issue` の OPEN/CLOSED を見る。起票先のリポ（下の「リポジトリの特定方法」）と、作業ディレクトリのリポも比べる。

- 別の OPEN の Issue が残っていたら、前の Issue を片付けてから始める。stale だと確信できるときだけ、Step 2 で `force_overwrite_active: true` を付ける
- 起票先のリポが作業ディレクトリのリポと違うときは、起票先のリポの worktree でセッションを始め直す。始め直せないときだけ、Step 2 で `allow_cross_repo: true` を付ける

> **ガード**: Issue 番号が入った `created: Issue <owner/repo/N>` の行を出力で確認するまで、Edit / Write / MultiEdit / NotebookEdit / EnterPlanMode / `git checkout` / `git switch` を呼ばない。Issue 起票よりも前にコード編集・ブランチ切り替え・プランモード移行を行うことは禁止。

#### Issue作成

基本形（親Epicなし）は、`issue_create` を `freeform: true`・`repo: "owner/repo"`・`message: "ユーザー指示の要約"` で呼ぶ。

**`message` の書き方:** テンプレを経由しないため `message` の内容がそのままIssue本文になる。読者は着手する実装者（直後の自分）と後から経緯を追う人。冒頭に要点を1行、達成したい状態を簡潔な箇条書きで書く。実装手順・ファイル名は書かない（planの領分）。段落で埋めない。箇条書きは項目間に空行を入れる。

**成功確認:** 結果に `created: Issue <owner/repo/N>` の行があること。`N` が Issue 番号になる。

**特徴:**

- タイトル自動生成
- テンプレート検証スキップ
- ブランチは作られない（Step 2 の `session_start` が作る）
- 固定設定: type=task, priority=medium, size=s。status は型の既定（`session_start` が active にする）
  - 起票時点が作業開始時点なので、Step 2 で active にする。詳細は [issue-flow-rules.md §4](../w-help/references/issue-flow-rules.md#起票時の既定-status)

**リポジトリの特定方法:**

- ユーザーが明示的に指定している場合はその値を使用
- 指定がない場合は AskUserQuestion で起票先リポジトリを確認する。または `project_get` を `key: "aggregation_repo"` で呼んで根拠を得てから決める（推測で `repo` を埋めない）
- 詳細: [Issue/PR フロー基本ルール](../w-help/references/issue-flow-rules.md)

### Step 2: ブランチ作成（session_start）とブランチ切り替え

**前提: Step 1でIssueが作成済みであること。**

`session_start` を `issue_ref: "owner/repo/N"`・`branch: "feat/description"` で呼ぶ。`base` は渡さない。base は CLI が選ぶ。

**ブランチ名の決め方:**

- `feat/` + タスクの簡潔な説明（英語、ケバブケース）
- 例: `feat/add-user-authentication`, `feat/fix-login-bug`

結果の `created: branch <ブランチ名> in <owner/repo> from <base>` の行から、ブランチ名とリポを読み、ブランチを切り替える。

```bash
git fetch origin
git checkout feat/description
```

**ワークツリー環境の場合:**

`<owner/repo>` のワークツリーのうち、今のワークツリーと同じ WT 名のもので `git checkout` を実行する。

同じ WT 名のワークツリーが `<owner/repo>` に存在しない場合は、
`/pecot-w:w-worktree-add` コマンドでWT作成を案内するか、作業を中止する。

### Step 3: 調査

通常モードのまま、変更対象のファイルと周辺の既存パターンを読む。EnterPlanMode を呼ばない。

### Step 4: 計画ドラフト作成

plan テンプレのファイルを作り、テンプレの見出しと規則のとおりに計画を書く。
`issue_comment` を `prepare: true`・`template: "plan"`・`issue_ref: "<owner/repo/Issue番号>"` で呼ぶと、ファイルができる。

変更対象は active Issue のリポジトリ内に限る。ほかのリポの変更は計画から外し、パッチに退避して当該リポへの起票を提案する（判定手順: [issue-flow-rules.md §6](../w-help/references/issue-flow-rules.md)）。

### Step 5: 計画の投稿

通常モードのまま、計画を Issue に投稿する。EnterPlanMode を呼ばない。`issue_comment` を `file: "<書いたファイル>"` で呼ぶ。

結果に `exit code: 3` の行が出て止まったら、指摘を直して呼び直す。

### Step 6: プランモードで承認を得る

EnterPlanMode を呼び、投稿した計画で承認を得る。

```
EnterPlanMode tool:
  (パラメータなし)
```

承認までに計画を直したら、承認後に投稿したファイルも同じように直し、Step 5 の呼び出しをやり直す。投稿したコメントが書き換わる。

承認後は、サブエージェントを起動せず main が実装する。
