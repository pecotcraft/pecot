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

### Step 1: Issue作成（pecot issue quick）

> **ガード**: Issue 番号 `#NNN`（`#\d+` 形式）を出力で確認するまで、Edit / Write / MultiEdit / NotebookEdit / EnterPlanMode / `git checkout` / `git switch` を呼ばない。Issue 起票よりも前にコード編集・ブランチ切り替え・プランモード移行を行うことは禁止。
>
> このステップは絶対にスキップしてはならない。Issue作成コマンドを実行し、Issue番号が出力されたことを確認してから次に進むこと。Issue作成前にコードを編集することは禁止。

```bash
# 基本形（親Epicなし）
pecot issue quick -r owner/repo -m "ユーザー指示の要約"
```

**`-m` の書き方:** テンプレを経由しないため `-m` の内容がそのままIssue本文になる。読者は着手する実装者（直後の自分）と後から経緯を追う人。冒頭に要点を1行、達成したい状態を簡潔な箇条書きで書く。実装手順・ファイル名は書かない（planの領分）。段落で埋めない。箇条書きは項目間に空行を入れる。

**成功確認:** コマンド出力にIssue番号（`#XXX`）が含まれていること。

**特徴:**

- タイトル自動生成
- テンプレート検証スキップ
- ブランチも自動作成（`feat/{YYYYMMDD-HHMMSS}/{issue_number}`）
- 固定設定: type=task, status=active, priority=medium, size=s
  - status=active にするのは、起票時点が作業開始時点であるため。詳細は [issue-flow-rules.md §4](../w-help/references/issue-flow-rules.md#起票時の既定-status)

**リポジトリの特定方法:**

- ユーザーが明示的に指定している場合はその値を使用
- 指定がない場合は AskUserQuestion で起票先リポジトリを確認する。または `pecot project show-aggregation-repo` を実行して根拠を得てから決める（推測で `-r` を埋めない）
- 詳細: [Issue/PR フロー基本ルール](../w-help/references/issue-flow-rules.md)

### Step 2: ブランチ切り替え

**前提: Step 1でIssueが作成済みであること。**

CLIの案内メッセージに従ってブランチを切り替える。

```bash
git fetch origin
git checkout feat/{YYYYMMDD-HHMMSS}/{issue_number}
```

**ワークツリー環境の場合:**

CLIがWT名を含む案内メッセージ（例: `作業対象リポジトリのワークツリー(wt2)で以下を実行してください`）を表示する。
案内メッセージに表示されたWT名と同名のワークツリーで `git checkout` を実行する。

案内されたWT名が作業対象リポジトリに存在しない場合は、
`/pecot-w:w-worktree-add` コマンドでWT作成を案内するか、作業を中止する。

### Step 3: 調査

通常モードのまま、変更対象のファイルと周辺の既存パターンを読む。EnterPlanMode を呼ばない。

### Step 4: 計画ドラフト作成

次のコマンドで plan テンプレのファイルを作り、テンプレの見出しと規則のとおりに計画を書く。

```bash
pecot issue comment --prepare -t plan -i <owner/repo/Issue番号>
```

変更対象は active Issue のリポジトリ内に限る。ほかのリポの変更は計画から外し、パッチに退避して当該リポへの起票を提案する（判定手順: [issue-flow-rules.md §6](../w-help/references/issue-flow-rules.md)）。

### Step 5: 計画の投稿

通常モードのまま、計画を Issue に投稿する。EnterPlanMode を呼ばない。

```bash
pecot issue comment <書いたファイル>
```

exit 3 で止まったら、指摘を直して打ち直す。

### Step 6: プランモードで承認を得る

EnterPlanMode を呼び、投稿した計画で承認を得る。

```
EnterPlanMode tool:
  (パラメータなし)
```

承認までに計画を直したら、承認後に投稿したファイルも同じように直し、Step 5 のコマンドを打ち直す。投稿したコメントが書き換わる。

承認後は、サブエージェントを起動せず main が実装する。
