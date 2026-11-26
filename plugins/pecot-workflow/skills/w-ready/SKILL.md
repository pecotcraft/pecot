---
name: w-ready
description: |
  EpicまたはTrackerのサブタスクを1件作成し、前提に応じてReadyかBlockedに配置します。
  Use when the user wants to create a single subtask Issue under an existing Epic or Tracker, with its prerequisites (placed in Ready, or in Blocked while a prerequisite is pending). Planning-only — no code, no branches. Picked up later with w-active.
  Do NOT use for batch creation (use w-issueize), Epics (use w-backlog), or immediate implementation (use w-quick).
when_to_use: "Epic または Tracker の次のサブタスクを 1 件作りたい、前提を付けてボードに積みたい"
---

# 作業準備：サブタスクIssueを作成して、Ready か Blocked に配置

Epic の AS-IS・TO-BE・GAP と現状のコンテキストをもとに、AIが次のサブタスク1件を計画し、Epic配下のIssueとして登録する。
先に終える Issue があれば前提（`blocked_by`）に書く。置く列は CLI が決め、前提が済んでいなければ `Blocked`、そのほかは `Ready` に入る。
親が Tracker（security alert など）のときは、GAP の代わりに一覧の行から1件を選んで計画する。実装・ブランチ作成・PR作成は行わない。実装は `/pecot-w:w-active` で行う。

## 手順

### Step 1: ボードを確認する

対象Epic・Trackerの配下に既にReady・Active・Pendingのサブタスクがないかを確認し、二重登録を避ける。確認には pecot-workflow の MCP ツール `board_show` を使う。

### Step 2: 対象Epic・Trackerを特定

ユーザーの指示から対象Epicまたは Tracker を特定する。

**Epicの特定方法:**

1. ユーザーが明示的にEpic番号を指定している場合はその値を使用
2. ユーザーがEpicタイトルを指定している場合はボードから検索
3. 不明な場合は **AskUserQuestion** ツールでBacklog内のEpicとTrackerをリストアップして選択させる

pecot-workflow の MCP ツール `issue_show` を使って、Epic・Tracker の詳細を読む。

### Step 3: 次のサブタスクをAIが計画する

親が Tracker のときは GAP が無い。本文の一覧の行から1件を選び、その alert を直す作業を計画する。

Epic の GAP（AS-IS と TO-BE の状態差）と現状コンテキストをもとに、AIが次に着手すべき1件を計画する。

**計画の流れ:**

1. Epic の AS-IS・TO-BE・GAP を読み取り、「次にやるべきこと」をAIが判断する
2. サブタスク1件分のタイトル・概要・ゴールを具体的に策定する
3. 前提を決める。Epic の開いたサブタスクとほかの Issue から、このサブタスクより先に終える Issue を選ぶ

前提は `blocked_by` に書く。1 つの前提が 1 要素で、`issue` に `owner/repo/N` を書く。
種類は、[Issue/PR フロー基本ルール](../w-help/references/issue-flow-rules.md) の「前提（`blocked_by`）と種類」で決める。

| 種類 | 当たるとき | 書き方 |
|---|---|---|
| スタック可 | 前提の変更を、手元のブランチか試験環境で動かして、実装と確認ができる | `wait` を書かない |
| スタック不可 | 前提の変更が開発ブランチに入っていないと、手元のブランチと試験環境のどちらでも、実装か確認ができない | `wait: merge` と、待つ理由の 1 文の `reason` |

- 前提が無ければ、`blocked_by` は `[]` のままにする
- 前提か種類を決められないときは、候補の Issue と迷う理由を地の文で示し、ユーザーに確かめる
- 新しいサブタスクを、既存の Issue の前提にしたいときは、投稿の後に pecot-workflow の MCP ツール `issue_block` で付ける。既存の Issue のファイルを作り直さない

タイトルの番号（`[Task] #353-03: タスク名`）は、CLI が既存のサブタスクの最大の次から振る。`order`・`status` は書かない。

### Step 4: サブタスクIssueを1件作成

**リポジトリの特定方法:**

- サブタスクの `repository` は **実装するリポ** を指定する。Epic が `aggregation_repo` にあっても、サブタスクは `aggregation_repo` に作らない（明示的に例外指示がある場合を除く）
- 判断材料: Epic タイトル / 本文の「対象リポ」記述、または親 Epic を読んだ上でユーザーに確認する
- 詳細: [Issue/PR フロー基本ルール](../w-help/references/issue-flow-rules.md)

タイプに応じて選び、テンプレートを準備する。

pecot-workflow の MCP サーバの resource を読み、テンプレートのファイルを作る。resource は次から選ぶ。

- 機能追加・改善: `pecot-template://issue/task`
- バグ修正: `pecot-template://issue/bug`

できたファイルを編集する。本文はテンプレ冒頭コメントの `読者:` に照らして載せる情報を取捨し、`書き方:` の規約に従う。
`title`（必須）・`repository`（必須。上の実装するリポ）・`parent_epic`（必須）を設定し、Step 3 の前提を `blocked_by` に書く。

`parent_epic` は full path `owner/repo/N` を推奨。詳細は [Issue/PR フロー基本ルール](../w-help/references/issue-flow-rules.md)。

投稿の前に、pecot-workflow の MCP ツール `issue_check` を使って、番号と前提を確かめる。
結果の番号と前提を、地の文でユーザーに示す。前提が Step 3 で決めたものと食い違えば、ファイルを直してもう一度確かめる。

確かめたら、同じファイルで `issue_create` を使って投稿する。

### Step 5: 完了報告

作成したIssue番号・タイトルと、タスクで何を実現するかを1段落で報告する。あわせて、投稿の結果から置いた列を伝える。
投稿の結果に列が書かれていないときは、列に置けなかったことと、警告があればその文を伝える。

- `Ready` に置いたとき: 実装を始めるには `/pecot-w:w-active` を使うよう案内する
- `Blocked` に置いたとき: 待つ前提の Issue と種類を伝える。スタック可の前提は PR が出たとき、スタック不可の前提はマージされたときに、`Ready` に移る
