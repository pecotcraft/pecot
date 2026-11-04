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

## pecot CLI ランチャー

pecot CLI は実行環境ごとにランチャーを変数化してから使う。

Claude Code:

```bash
PECOT=pecot
```

GitHub Copilot CLI は shell tool の PATH にプラグイン `bin/` が入らないため、最初からインストール済み wrapper を使う。

```bash
PECOT="$HOME/.copilot/installed-plugins/pecot/pecot-w/bin/pecot"
```

以降の pecot CLI コマンド例は必ず `$PECOT ...` として実行する。

1ファイル修正や小さなバグ修正など、簡単なタスクを即座にIssue化してブランチ作成→調査→計画ドラフト作成→プランモードで計画を最終化する。Issue作成・ブランチ作成が完了するまで実装作業には着手しない。

## 手順

### Step 1: Issue作成（pecot issue quick）

> **ガード**: Issue 番号 `#NNN`（`#\d+` 形式）を出力で確認するまで、Edit / Write / MultiEdit / NotebookEdit / EnterPlanMode / `git checkout` / `git switch` を呼ばない。Issue 起票よりも前にコード編集・ブランチ切り替え・プランモード移行を行うことは禁止。
>
> このステップは絶対にスキップしてはならない。Issue作成コマンドを実行し、Issue番号が出力されたことを確認してから次に進むこと。Issue作成前にコードを編集することは禁止。

```bash
# 基本形（親Epicなし）
$PECOT issue quick -r owner/repo -m "ユーザー指示の要約"
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

下書きの文章規則は、Claude Code で pecot-visual を入れた環境なら、下書きを Write / Edit した直後に確かめられる。
違反があると `[text-lint] Writing-rule violations in` で始まる通知が返る。指摘の行の文を書き直す。
下書きは書き込みで止まらず、投稿の CLI も文面を確かめない。投稿前に直す。何も返らないことは、違反が無いことを意味しない。
`[text-lint] Not checked` は、確認していないという通知を表す。
違反が多いと先頭 100 行だけが返る。直して保存し直すと、残りが返る。
関門（pre-commit と commit-msg）を入れたリポでは、commit する文書とコミットメッセージが止まる。
出力の形はリポで異なる。例は `<path>:<line>:<col> <ruleId> <message>` と、ファイル名の行に続く `行:列 error メッセージ 規則名` の 2 形がある。
どちらも、指摘された行の文を直す。
規則・除外は変えない。無効化コメントと `--no-verify` にも触れない。

`pecot issue quick -m` で渡す本文はファイルを経ないので、hook は確かめない。投稿前に、上の規則に照らして自分で読み直す。

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

**前提: Step 2でブランチ切り替え済みであること。**

ブランチ切り替えが完了したら、まず**通常モードのまま**軽く調査する。この段階では
EnterPlanMode を呼ばない。

quick は小タスク前提なので、変更対象ファイルとその周辺の既存パターンを読み取りで
把握する程度でよい。得た事実が次の計画ドラフトのもとになる。

### Step 4: 計画ドラフト作成

**前提: Step 3で調査済みであること。**

調査結果をもとに、**通常モードのまま**実装計画のドラフトを作成する。小タスクなので
簡潔でよいが、`## PECOT-Workflow` セクション（E2E）を
概形として含める。書式全文はこの SKILL.md から複製しない。
書式への最終適合は次の Step 5 のプランモード側で行う。

ドラフト本体の書式は、`$PECOT issue comment --prepare -t plan` で得る plan テンプレが決める。

### Step 5: プランモードに入る

**前提: Step 4で計画ドラフト作成済みであること。**

ドラフトが固まったら、**必ずプランモードで計画を最終化する。** プランモードは
**計画最終化と承認の窓**で、ドラフト完成後に呼ぶ最終ステップとして扱う。

**必須**: 以下のツールを呼び出してプランモードに入ること。

```
EnterPlanMode tool:
  (パラメータなし)
```
