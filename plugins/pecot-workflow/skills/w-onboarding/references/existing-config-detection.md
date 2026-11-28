# 既存設定検出の詳細

`/pecot-w:w-onboarding` Step 1 の補足。以下 4 パターンを優先順位順に確認し、最初にマッチしたケースで対処する。

## 1. カレントリポに設定あり

pecot-workflow の MCP ツール `project_list` を使う。

設定があれば、AskUserQuestion でどの設定を使うか確認する。設定ファイルの owner と番号のボードを、公式の MCP で読む。
`projects_get` の `get_project` と、`projects_list` の `list_project_fields`・`list_project_views` を使う。
pecot-workflow の MCP ツール `project_activate` に、設定の名前（`project`）と読んだ結果（`reads`）を渡して有効にし、Step 3 へ進む。

## 2. 兄弟リポに同一プロジェクトの設定あり

SKILL.md の Step 1 のとおり、スキルの `scripts/detect-sibling-config.cjs` を動かし、その出力の行で決める。

## 3. GitHub 上に pecot の欄を持つボードあり

AskUserQuestion でホスト・オーナーを確認してから、公式の MCP の `projects_list`（`list_projects`）で、そのオーナーのボードを全ページ読む。

ボードごとに `projects_list`（`list_project_fields`）で欄を読み、`pecot-status` の欄があるボードを AskUserQuestion で選択させる。
選んだボードを `projects_get`（`get_project`）と `projects_list`（`list_project_views`）でも読む。
`project_activate` に、番号（`project: "<番号>"`）・`host`・`owner`・`owner_type` と、読んだ結果（`reads`）を渡して有効にする。

→ Step 3 へ。

## 4. どれもない → 新規作成

→ Step 2 へ。
