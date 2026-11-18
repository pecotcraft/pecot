# 既存設定検出の詳細

`/pecot-w:w-onboarding` Step 1 の補足。以下 4 パターンを優先順位順に確認し、最初にマッチしたケースで対処する。

## 1. カレントリポに設定あり

pecot-workflow の MCP ツール `project_list` を使う。

設定があれば、AskUserQuestion でどの設定を使うか確認する。pecot-workflow の MCP ツール `project_activate` を使ってその設定を有効にし、Step 3 へ進む。

## 2. 兄弟リポに同一プロジェクトの設定あり

SKILL.md の Step 1 のとおり、スキルの `scripts/detect-sibling-config.cjs` を動かし、その出力の行で決める。

## 3. GitHub 上に init 済みプロジェクトあり

AskUserQuestion でホスト・オーナーを確認してから検索する。pecot-workflow の MCP ツール `project_search` を使う（`host: "<host>"`・`owner: "<owner>"`）。

`initialized` が真の行があれば、AskUserQuestion で選択させる。`project_activate` を使って、番号の指定で有効にする（`project: "<番号>"`・`host`・`owner`）。

→ Step 3 へ。

## 4. どれもない → 新規作成

→ Step 2 へ。
