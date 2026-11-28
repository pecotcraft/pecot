---
name: w-backlog
description: |
  Epicを作成しBacklogに配置します。
  Use only when the user explicitly invokes /pecot-w:w-backlog or explicitly asks to register an Epic in the Backlog. Do not trigger autonomously from vague phrases like "plan a feature", "big initiative", or "add to roadmap".
  Do NOT use for breakdown (use w-breakdown), single subtasks (use w-ready/w-quick), or batch Issue creation from a plan (use w-issueize).
when_to_use: "Epic を Backlog に登録して、と明示的に頼まれたとき"
argument-hint: "[Epic の内容]"
---

# Epic作成ワークフロー

ユーザー指示からEpicを作成し、Issue本文を直接充実させてBacklogに配置する。実装コード・ブランチ作成・プルリクエスト作成は行わない。実装は `/pecot-w:w-ready` でサブタスクを作成し、`/pecot-w:w-active` で行う。

## 手順

### Step 1: ボードを確認する

pecot-workflow の MCP ツール `board_show` を使って、ボードの状態を確かめる。

| ステータス | 意味 |
|-----------|------|
| Active | 別ワークツリーで作業中 |
| Ready | 今、着手できるタスク |
| Blocked | 前提を待っているタスク（pecot が置く。ボードに無ければ、w-help の「ボードの欄を足す・直す」の手順で足す） |
| Pending | 人が後回しにした（Epic／タスク） |
| Backlog | Epic置き場 |

### Step 2: 既存Epicを確認

Backlog内に類似のEpicがないか確認する。

- 類似Epicがある場合は、統合や調整を提案する
- **重複を避けるための確認は必須**

### Step 3: 集約リポの事前確認

Epic の作成先を決めるため、pecot-workflow の MCP ツール `project_get` を使って、集約リポ（`aggregation_repo`）の設定を確かめる。

- **設定済み** → Step 4 へ進む
- **未設定** → AskUserQuestion で分岐:
  - 「先に集約リポを設定する（推奨）」→ `/pecot-w:w-onboarding` を案内してこのスキルを中断
  - 「このまま個別リポに Epic を作る（分散運用）」→ Step 4 へ進む（作成時 `owner`・`repo` 必須）

集約リポを後から追加すると、既存 Epic を移送する運用負荷が生じる。可能なら先に設定することを推奨する。

### Step 4: Epic Issueを作成

1. pecot-workflow の MCP サーバの resource `pecot-template://issue/epic` を読み、Epic のテンプレートのファイルを作る
2. できたファイルを編集する
   - YAMLフロントマターを設定する
   - Issue本文を記述する（テンプレ冒頭コメントの 読者:/書き方: に従う）
3. pecot-workflow の MCP ツール `issue_check` に通してから、公式の MCP の `issue_write` で作り、`projects_write` でボードに足して欄を書く。手順は [GitHub に公式の MCP と github-ops で書く](../w-help/references/github-write.md) の「Issue を作る」

ツールが出力したファイルのセクション構造を維持して本文を埋める。テンプレ冒頭コメントの `読者:`（Epic を分解する人）の判断に使われない情報は書かない。

**YAMLフロントマターの設定:**

`title`（必須）を、`[Epic]` で始めて設定する。

利用者が分類（`pecot-lane`）の値を言ったときだけ、`project_fields` に書く。言っていなければ空のままにし、尋ねもしない。

**リポジトリの特定方法:**

- 集約リポ設定済 → `owner`・`repo` に、pecot-workflow の MCP ツール `project_get`（`key: aggregation_repo`）の集約リポを書く
- 集約リポ未設定（Step 3 で「このまま個別リポに作る」を選んだ）→ `owner`・`repo` に、作るリポを書く
- ユーザーが実装リポ名を言及しても安易にそのリポにせず、まず集約リポ行きで提案する。例外的に集約リポ以外へ作る時のみ、そのリポを書く（`issue_check` は警告を出しつつ通す）
- 詳細マトリクス: [Issue/PR フロー基本ルール](../w-help/references/issue-flow-rules.md)

### Step 5: 完了報告

ユーザーに以下を報告:

- 作成したEpic Issue番号・タイトル
- Epic概要（何を実現するか）
- 次のステップの案内: **このEpicからタスクを切り出すには `/pecot-w:w-ready` を使用**
