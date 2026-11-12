---
name: w-ready
description: |
  EpicまたはTrackerのサブタスクを1件作成しReadyに配置します。
  Use when the user wants to create a single subtask Issue under an existing Epic or Tracker in Ready status. Planning-only — no code, no branches. Picked up later with w-active.
  Do NOT use for batch creation (use w-issueize), Epics (use w-backlog), or immediate implementation (use w-quick).
when_to_use: "Epic または Tracker の次のサブタスクを 1 件作りたい、Ready に積みたい"
---

# 作業準備：サブタスクIssueを作成してReadyに配置

Epic の AS-IS・TO-BE・GAP と現状のコンテキストをもとに、AIが次のサブタスク1件を計画し、Epic配下のIssueとして登録してReadyに置く。
親が Tracker（security alert など）のときは、GAP の代わりに一覧の行から1件を選んで計画する。実装・ブランチ作成・PR作成は行わない。実装は `/pecot-w:w-active` で行う。

> 注意: 既存サブタスクの完了状況をユーザーに報告したり、「Epicを閉じますか」等を提案してはならない。直前タスクが完了済みなのはこのスキルを呼ぶ前提であり、特筆事項ではない。

## 手順

### Step 1: ボードを確認する

対象Epic・Trackerの配下に既にReady・Active・Pendingのサブタスクがないかを確認し、二重登録を避ける。`project_info` を引数なしで呼ぶ。

### Step 2: 対象Epic・Trackerを特定

ユーザーの指示から対象Epicまたは Tracker を特定する。

**Epicの特定方法:**

1. ユーザーが明示的にEpic番号を指定している場合はその値を使用
2. ユーザーがEpicタイトルを指定している場合はボードから検索
3. 不明な場合は **AskUserQuestion** ツールでBacklog内のEpicとTrackerをリストアップして選択させる

Epic・Tracker詳細を取得する。`issue_read` を `issue_ref: "owner/repo/XXX"` で呼ぶ。

### Step 3: 次のサブタスクをAIが計画する

親が Tracker のときは GAP が無い。本文の一覧の行から1件を選び、その alert を直す作業を計画する。

Epic の GAP（AS-IS と TO-BE の状態差）と現状コンテキストをもとに、AIが次に着手すべき1件を計画する。

**計画の流れ:**

1. Epic の AS-IS・TO-BE・GAP を読み取り、「次にやるべきこと」をAIが判断する
2. 既存サブタスク一覧を確認してorder番号の続番を決める
3. サブタスク1件分のタイトル・概要・ゴールを具体的に策定する

> 注意: 既存サブタスクはorder続番の決定のためだけに参照する。Epic本文にタスク計画は載っていないので本文からタスクを抽出しようとしない。全CLOSEDは通常状態であり評価・報告はしない。
>
> **orderについて**: `order` は親Epicに紐づくサブタスクの段。枝つきの既存番号（`NNa`）は段 NN として数え、続番は最大の段 + 1 にする。w-ready は枝を付けない。タイトルに `[Task] #353-01: タスク名` 形式のプレフィックスが自動生成される。`parent_epic` を指定する場合は `order`（1以上の整数）が必須。

### Step 4: サブタスクIssueを1件作成

**リポジトリの特定方法:**

- サブタスクの `repo` は **実装するリポ** を指定する。Epic が `aggregation_repo` にあっても、サブタスクは `aggregation_repo` に作らない（明示的に例外指示がある場合を除く）
- 判断材料: Epic タイトル / 本文の「対象リポ」記述、または親 Epic を読んだ上でユーザーに確認する
- 詳細: [Issue/PR フロー基本ルール](../w-help/references/issue-flow-rules.md)

タイプに応じて選び、テンプレートを準備する。

`issue_create` を `prepare: true`・`repo: "<owner/repo>"` と次の `template` で呼ぶ。

- 機能追加・改善: `template: "task"`
- バグ修正: `template: "bug"`

出力されたファイルを編集する。本文はテンプレ冒頭コメントの `読者:` に照らして載せる情報を取捨し、`書き方:` の規約に従う。
`title`（必須）と `parent_epic`（必須）を設定する。`repository` は `repo` で設定済み。

`parent_epic` は full path `owner/repo/N` を推奨。詳細は [Issue/PR フロー基本ルール](../w-help/references/issue-flow-rules.md)。

ファイル編集後に投稿する。`issue_create` を `files: ["<ファイルパス>"]` で呼ぶ。

### Step 5: 完了報告

作成したIssue番号・タイトルと、タスクで何を実現するかを1段落で報告する。実装を始めるには `/pecot-w:w-active` を使うよう案内する。
