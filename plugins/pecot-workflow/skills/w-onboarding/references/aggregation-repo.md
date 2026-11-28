# Epic 集約リポ設定の詳細

`/pecot-w:w-onboarding` Step 3 の補足。集約リポ (`aggregation_repo`) を設定すると、w-backlog が Epic をそのリポに作る。pecot-workflow の MCP ツール `issue_check` は、Epic を集約リポの外に作ろうとすると警告する。

## 4.0 現状確認

pecot-workflow の MCP ツール `project_get` を使う（`key: "aggregation_repo"`）。

- 未設定なら Step 3 の Q1 は通常 3 択。
- 既設定なら Q1 に「現状維持 `<現在値>`」を追加。以降で**上書き**する場合は `yes: true` を付与する。付けなくても上書きされ、`yes` は警告の末尾のヒントを消すだけである。
  設定には pecot-workflow の MCP ツール `project_set` を使う（`key: "aggregation_repo"`・`value`・`yes: true`）。

## 4.1 AskUserQuestion Q1: 方針選択

- header: "Epic集約リポ"
- question: "Epic の集約方針（Epic の作成先を 1 リポにするか）"
- options:
  - label: "使わない", description: "Epic は都度作成先のリポを決める。後から設定変更可能"
  - label: "既存リポを指定（推奨）", description: "登録済みリポ、または任意の owner/repo を集約リポとして宣言"
  - label: "新規リポを作成", description: "`<project>-roadmap` 等の専用リポを作成して集約に設定"
  - label: "現状維持 `<現在値>`", description: "既設定のまま変更しない（4.0 で設定済を検出した場合のみ表示）"

分岐:

- 「使わない」「現状維持」→ Step 4 へ（追加の AskUserQuestion なし）
- 「既存リポを指定」→ 4.2a
- 「新規リポを作成」→ 4.2b

## 4.2a 既存リポを指定

pecot-workflow の MCP ツール `board_show` を使って、登録済みのリポジトリから候補を取得する。

AskUserQuestion Q2a で選択:

- header: "集約リポ"
- question: "集約リポにするリポジトリ"
- options:
  - 登録済みリポジトリを 1 件ずつ列挙（例: `<owner>/<repoA>`, `<owner>/<repoB>` …）
  - label: "別のリポジトリ（自由入力）", description: "登録済み以外の `owner/repo` を入力"

選択結果で設定する。`project_set` を使う（`key: "aggregation_repo"`・`value: "<owner/repo>"`）。

4.0 で既設定を検出済なら `yes: true` を付与する。

→ 4.3 へ。

## 4.2b 新規リポを作成

AskUserQuestion で以下 2 問を **1 回の呼び出しで** 質問する（`w-repo-add` Step 2.3 と同じパターン）:

質問 1: リポジトリ名

- header: "リポジトリ名"
- question: "集約リポの `owner/repo` を決めてください。"
- options:
  - label: "`<owner>/<project>-roadmap`（推奨）", description: "プロジェクト名を付けた専用ロードマップリポを作成"
  - label: "その他", description: "自由入力（例: `<owner>/roadmap`）"

質問 2: 可視性

- header: "可視性"
- question: "新規リポの可視性"
- options:
  - label: "`private`（推奨）", description: "プロジェクト関係者のみに限定"
  - label: "`public`", description: "誰でも閲覧可能"
  - label: "`internal`", description: "organization メンバーのみ閲覧可能（org 配下のみ）"

ヒアリング結果を使って、次の 4 つを **この順序で** 実行する。

1. 公式の MCP の `create_repository` でリポを作る（`name`・`private`・`autoInit: true`。owner が組織なら `organization` も渡す）
   - `internal` を選んだときは、`create_repository` では作れない。利用者に `https://<host>/new` で、owner と名前を合わせ、可視性を Internal にし、README を付けて作ってもらう
2. pecot-workflow の MCP ツール `project_link` を使う（`repo: "<owner/repo>"`・`develop_branch: "main"`）
3. github-ops の `project-link` で、リポをボードにつなぐ（`params` に `project`・`repo`）。手順は [github-ops で書く](../../w-help/references/github-ops.md)
4. `project_set` を使う（`key: "aggregation_repo"`・`value: "<owner/repo>"`）

- `autoInit: true` は空リポ回避（README が無い空リポは clone できず、以降の Epic 作成も失敗しやすい）。
- 4.0 で既に集約リポが設定済みの場合、4 つ目の呼び出しに `yes: true` を足す。
- 新規リポは集約（ロードマップ）専用のため `release_branch` / `changelog_file` は指定しない。

## 4.3 確認

`project_get` を使う（`key: "aggregation_repo"`）。

意図した `owner/repo` が入っていれば Step 4 へ進む。
