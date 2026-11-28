---
name: w-quick
description: |
  小タスクを即Issue化しブランチ作成・実装開始します。
  Use when the user has a small task to tackle immediately (one-file fix, minor bug, quick tweak) and no Issue exists yet — creates the Issue, branch, and enters plan mode in one step.
  Do NOT use when picking up an existing task from the board (use w-active).
when_to_use: "小さな修正をすぐ始めたい、Issue 作成からブランチ作成まで一度に済ませたい"
allowed-tools: mcp__plugin_pecot-w_pecot-workflow__session_finish
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

### Step 1: Issue作成（issue_write）

公式の MCP の `issue_write` で、Issue を作る。基本形（親Epicなし）は、テンプレを通さない自由形式で作る。
書く前に、pecot-workflow の MCP ツール `issue_check` に、`template` を渡さずに通す。手順は [GitHub に公式の MCP と github-ops で書く](../w-help/references/github-write.md) の「Issue を作る」。

**本文の書き方:** テンプレを経由しないため、書いた本文がそのままIssue本文になる。読者は着手する実装者（直後の自分）と後から経緯を追う人。冒頭に要点を1行、達成したい状態を簡潔な箇条書きで書く。実装手順・ファイル名は書かない（planの領分）。段落で埋めない。箇条書きは項目間に空行を入れる。

**特徴:**

- タイトルは、本文の 1 行目の先頭 50 文字に `[Task]` を付けたもの。本文の末尾に、自由形式の定型の 1 行を足す。どちらも `issue_check` が確かめ、外れたら直す文を返す
- テンプレートの見出しは確かめない
- ブランチは作られない（Step 2 の github-ops の `link-branch` が作る）
- 固定設定: kind=task。置く列は種類の既定の `Ready`（Step 2 で `Active` へ動かす）
  - 起票時点が作業開始時点なので、Step 2 で active にする。詳細は [issue-flow-rules.md §4](../w-help/references/issue-flow-rules.md#起票時の既定-status)

**分類（`pecot-lane`）:** 利用者が分類の値を言ったときだけ、`project_fields` に書く。言っていなければ渡さず、尋ねもしない。

**リポジトリの特定方法:**

- pecot-workflow の MCP ツール `session_show` を使って、セッションの remote のリポを確かめ、それを `owner`・`repo` にする
- 詳細: [Issue/PR フロー基本ルール](../w-help/references/issue-flow-rules.md)

### Step 2: ブランチ作成とブランチ切り替え

**前提: Step 1でIssueが作成済みであること。**

`branch_check` に通してから、github-ops の `link-branch` で、作った Issue に紐づくブランチを作る。手順は [GitHub に公式の MCP と github-ops で書く](../w-help/references/github-write.md) の「作業を始める」にある。
続けて pecot-workflow の MCP ツール `session_start` を使って手元に作業を記録し、カードを `Active` へ動かす。

**ブランチ名の決め方:**

- `feat/` + タスクの簡潔な説明（英語、ケバブケース）+ `/<Issue 番号>`
- 例: `feat/add-user-authentication/123`, `feat/fix-login-bug/124`

`session_start` の結果に `leftovers` があれば、前にマージされた PR の手元の片付けが残っている。切り替えの前に、PR ごとに [マージされた後の片付け](references/after-merge.md) の「片付け」の節を行う。手元が wt ブランチに戻る。

作ったブランチに切り替える。

```bash
git fetch origin
git checkout feat/description/123
```

### Step 3: 調査

変更対象のファイルと周辺の既存パターンを読む。

### Step 4: 計画ドラフト作成

pecot-workflow の MCP サーバの resource `pecot-template://comment/plan` を読み、plan テンプレのファイルを作る。frontmatter の `owner`・`repo`・`issue_number` には、起票した Issue を書く。

計画を書く前に、[`w-help/references/plan-clarify.md`](../w-help/references/plan-clarify.md) に従って clarify を行う。Issue と依頼の曖昧な点を AskUserQuestion で聞き、答えを受けるたびに、できたファイルへ書く。

できたファイルに、テンプレの見出しと規則のとおりに計画を書く。

変更対象は作業中の worktree の remote のリポジトリ内に限る。ほかのリポの変更は計画から外し、パッチに退避して当該リポへの起票を提案する（判定手順: [issue-flow-rules.md §6](../w-help/references/issue-flow-rules.md)）。

### Step 5: 計画の投稿

書いた本文を、pecot-workflow の MCP ツール `issue_comment_check` に通す。通ったら、公式の MCP の `add_issue_comment` で Issue に投稿する。結果の `id` を、ファイルの `comment_id` に書く。

チェックで外れたら、指摘を直して通し直す。

### Step 6: プランモードで承認を得る

EnterPlanMode を呼び、投稿した計画で承認を得る。

承認までに計画を直したら、承認後に投稿したファイルも同じように直す。`issue_comment_check` に通し直し、`comment_id` のコメントを `update_issue_comment` で書き換える。

承認されたら、利用者への確認をせず、同じターンのまま main が実装を始める。サブエージェントは起動しない。
