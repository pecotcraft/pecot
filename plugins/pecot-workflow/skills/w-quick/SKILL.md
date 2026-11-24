---
name: w-quick
description: |
  小タスクを即Issue化しブランチ作成・実装開始します。
  Use when the user has a small task to tackle immediately (one-file fix, minor bug, quick tweak) and no Issue exists yet — creates the Issue, branch, and enters plan mode in one step.
  Do NOT use when picking up an existing task from the board (use w-active).
when_to_use: "小さな修正をすぐ始めたい、Issue 作成からブランチ作成まで一度に済ませたい"
allowed-tools: mcp__plugin_pecot-w_pecot-workflow__session_finish mcp__plugin_pecot-w_pecot-workflow__pr_show mcp__plugin_pecot-w_pecot-workflow__issue_show mcp__plugin_pecot-w_pecot-workflow__issue_comment
argument-hint: "[タスクの内容]"
hooks:
  PostToolUse:
    - matcher: "ExitPlanMode"
      hooks:
        - type: command
          command: '"${CLAUDE_PLUGIN_ROOT}"/hooks/post-tool-use-exit-plan-mode.sh --mode=quick'
          timeout: 10
          once: true
---

# 簡単なタスクの即Issue化

1ファイル修正や小さなバグ修正など、簡単なタスクを即座にIssue化してブランチ作成→調査→計画を書く→Issue に投稿→プランモードで承認を得て、そのまま実装する。Issue作成・ブランチ作成が完了するまで実装作業には着手しない。

## 手順

### Step 1: Issue作成（issue_create）

pecot-workflow の MCP ツール `issue_create` を使って、Issue を作る。基本形（親Epicなし）は、テンプレを通さずに `freeform: true` と `message` で作る。

**`message` の書き方:** テンプレを経由しないため `message` の内容がそのままIssue本文になる。読者は着手する実装者（直後の自分）と後から経緯を追う人。冒頭に要点を1行、達成したい状態を簡潔な箇条書きで書く。実装手順・ファイル名は書かない（planの領分）。段落で埋めない。箇条書きは項目間に空行を入れる。

**特徴:**

- タイトルは `message` の 1 行目から自動で作る
- テンプレート検証スキップ
- ブランチは作られない（Step 2 の `session_start` が作る）
- 固定設定: type=task, priority=medium, size=s。status は型の既定（`session_start` が active にする）
  - 起票時点が作業開始時点なので、Step 2 で active にする。詳細は [issue-flow-rules.md §4](../w-help/references/issue-flow-rules.md#起票時の既定-status)

**リポジトリの特定方法:**

- pecot-workflow の MCP ツール `session_show` を使って、セッションの remote のリポを確かめ、それを `repo` にする
- 詳細: [Issue/PR フロー基本ルール](../w-help/references/issue-flow-rules.md)

### Step 2: ブランチ作成（session_start）とブランチ切り替え

**前提: Step 1でIssueが作成済みであること。**

pecot-workflow の MCP ツール `session_start` を使って、作った Issue に紐づくブランチを作る。`base` は渡さない。スタック先はツールが選ぶ。

**ブランチ名の決め方:**

- `feat/` + タスクの簡潔な説明（英語、ケバブケース）
- 例: `feat/add-user-authentication`, `feat/fix-login-bug`

`session_start` の結果に `leftovers` があれば、前にマージされた PR の後片付けが残っている。切り替えの前に、PR ごとに [マージされた後の片付け](references/after-merge.md) に従って済ませる。

- `cleanup` が真なら、片付けの節から行う。手元が wt ブランチに戻る
- `cleanup` が偽なら、片付けの節を飛ばし、merge-diff の節だけを行う

作ったブランチに切り替える。

```bash
git fetch origin
git checkout feat/description
```

### Step 3: 調査

変更対象のファイルと周辺の既存パターンを読む。

### Step 4: 計画ドラフト作成

pecot-workflow の MCP サーバの resource `pecot-template://comment/plan` を読み、plan テンプレのファイルを作る。frontmatter の `issue_ref` には、起票した Issue を書く。

計画を書く前に、[`w-help/references/plan-clarify.md`](../w-help/references/plan-clarify.md) に従って clarify を行う。Issue と依頼の曖昧な点を AskUserQuestion で聞き、答えを受けるたびに、できたファイルへ書く。

できたファイルに、テンプレの見出しと規則のとおりに計画を書く。

変更対象は作業中の worktree の remote のリポジトリ内に限る。ほかのリポの変更は計画から外し、パッチに退避して当該リポへの起票を提案する（判定手順: [issue-flow-rules.md §6](../w-help/references/issue-flow-rules.md)）。

### Step 5: 計画の投稿

`issue_comment` を使って、書いたファイルを Issue に投稿する。

本文の検証で止まったら、指摘を直して投稿し直す。

### Step 6: プランモードで承認を得る

EnterPlanMode を呼び、投稿した計画で承認を得る。

承認までに計画を直したら、承認後に投稿したファイルも同じように直し、Step 5 の呼び出しをやり直す。投稿したコメントが書き換わる。

承認されたら、利用者への確認をせず、同じターンのまま main が実装を始める。サブエージェントは起動しない。
