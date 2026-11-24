---
name: w-active
description: |
  Readyタスクを選択しブランチ作成・実装開始します。
  Use when the user wants to start an existing Ready task — picks the Issue, creates a feature branch, enters plan mode. Triggers: "next task", "pick a task", "start implementing".
  Do NOT use for new tasks from scratch (use w-quick) or for Issue-only creation (use w-ready).
when_to_use: "Ready のタスクに着手したい、次のタスクを始めたい、Issue の実装を開始したい"
hooks:
  PostToolUse:
    - matcher: "ExitPlanMode"
      hooks:
        - type: command
          command: '"${CLAUDE_PLUGIN_ROOT}"/hooks/post-tool-use-exit-plan-mode.sh --mode=active'
          timeout: 10
          once: true
---

# Readyからタスクを実装

**Readyステータスのタスクから1個選択→ブランチ作成→調査→計画を書く→レビュー→Issue に投稿→プランモードで承認を得る→承認されたらそのまま実装。**

## 手順

### Step 1: 事前確認と、着手できるタスクの一覧

#### 着手前の確認

未コミットの差分が残っていたら、commit / stash / 破棄で clean にしてから着手する。前の Issue の差分なら、先にその Issue を終える。

詳細根拠は [`w-help/references/issue-flow-rules.md`](../w-help/references/issue-flow-rules.md) §5。

#### 着手できるタスクの一覧

pecot-workflow の MCP ツール `board_show` を使って、いま着手できる Issue を調べる。
着手できる Issue だけを、次の表で利用者に示す。ほかの Issue は載せない。

| 番号 | タイトル |
|---|---|
| #123 | Issue のタイトル |

別の Issue の上にスタックして着手するものは、タイトルの後ろに「（#N の上にスタックする）」と添える。
表の後に、どれに着手するかを地の文で尋ねる。AskUserQuestion は使わない。

### Step 2: 対象タスクを確認

pecot-workflow の MCP ツール `issue_show` を使って、利用者が選んだ Issue の内容を確かめる。

### Step 3: ブランチ作成

pecot-workflow の MCP ツール `session_start` を使って、Issue に紐づくブランチを作る。`base` は渡さない。スタック先はツールが選ぶ。
ブランチは GitHub 側にベースの先頭から作られるので、手元のブランチを先に最新化しなくてよい。

**ブランチ名の決め方:**

- `feat/` + タスクの簡潔な説明（英語、ケバブケース）
- 例: `feat/add-user-authentication`, `feat/fix-login-bug`

ツールが止まったら、エラーの案内を利用者に示して止まる。エージェントの判断で先へ進めない。

- 前提を外さない。前提を見直すかどうかは利用者が決める
- `base` を渡さない

### Step 4: 前の PR の後片付けの取りこぼし

`session_start` の結果に `leftovers` があれば、前にマージされた PR の後片付けが残っている。切り替えの前に、PR ごとに [マージされた後の片付け](references/after-merge.md) に従って済ませる。

- `cleanup` が真なら、片付けの節から行う。手元が wt ブランチに戻る
- `cleanup` が偽なら、片付けの節を飛ばし、merge-diff の節だけを行う

`leftovers` が無ければ、何もせずに Step 5 へ進む。

### Step 5: ブランチ切り替え

作ったブランチに切り替える。**ブランチを作ったリポジトリの** ワークツリーで実行すること。
別の Issue の上にスタックして着手したときは、その旨を利用者に伝える。

```bash
git fetch origin
git checkout feat/description/XXX
```

### Step 6: 調査

Issue の Tasks / Acceptance を起点に、変更対象のファイル・既存の実装と命名・テストの構成を読む。コードは編集しない。

### Step 7: 計画ドラフト作成

pecot-workflow の MCP サーバの resource `pecot-template://comment/plan` を読み、plan テンプレのファイルを作る。frontmatter の `issue_ref` には、active Issue を書く。

計画を書く前に、[`w-help/references/plan-clarify.md`](../w-help/references/plan-clarify.md) に従って clarify を行う。Issue と依頼の曖昧な点を AskUserQuestion で聞き、答えを受けるたびに、できたファイルへ書く。

できたファイルに、テンプレの見出しと規則のとおりに計画を書く。

w-issueize で作ったフェーズの Issue は、Artifacts に speckit の一式（`specs/NNN-*/`）を持つ。一式が active Issue のリポにあるときは、このフェーズの Tasks に並ぶタスクを、その一式の tasks.md で `[x]` にする変更を Files に入れる。
tasks.md のチェックはタスクの単位の進捗で、並行で進められるタスクを探すときに読む。この PR のマージでフェーズの Issue が閉じるのと同時に、tasks.md のチェックもそろう。

変更対象は active Issue のリポジトリ内に限る。ほかのリポの変更は計画から外し、パッチに退避して当該リポへの起票を提案する（判定手順: [issue-flow-rules.md §6](../w-help/references/issue-flow-rules.md)）。

### Step 8: レビュー（一巡 1 回）

書いた計画をレビューしてもらう。

- `Agent` ツールで w-plan-reviewer を 1 回起こし、計画のファイルのパスを渡してレビューを依頼する。agent teams が有効なら `name: w-plan-reviewer` を付ける。視点は w-plan-reviewer の定義が持つ
- 指摘を計画に反映してから次の Step へ進む

レビューは一巡 1 回で、反映後の再レビューは不要。追質問は `SendMessage` で送る。

### Step 9: 計画の投稿

`issue_comment` を使って、書いたファイルを Issue に投稿する。

本文の検証で止まったら、指摘を直して投稿し直す。

### Step 10: プランモードで承認を得る

EnterPlanMode を呼び、投稿した計画で承認を得る。

承認までに計画を直したら、承認後に投稿したファイルも同じように直し、Step 9 をやり直す。投稿したコメントが書き換わる。

### Step 11: 実装

承認されたら、同じターンのまま実装を始める。承認が実装の開始の合図なので、利用者への確認はしない。承認の後で止まらない。

main が実装するか、w-implementer に任せるかは、[`w-help/references/subagent-usage.md`](../w-help/references/subagent-usage.md) の「実装と修正を委譲する条件」で決める。

実装の後、計画の CUJ を main が [`w-help/references/cuj-run.md`](../w-help/references/cuj-run.md) に従って流す。
