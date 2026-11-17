---
name: w-onboarding
description: |
  新規プロジェクトをセットアップします。
  Use when the user is setting up a brand-new project for pecot from scratch — creates a GitHub Projects board, registers repositories, configures the project for pecot workflow management.
when_to_use: "pecot を新しいプロジェクトで使い始めたい、ボードを作って初期設定したい"
---

# オンボーディング

新規プロジェクトのセットアップを行う。本スキルの責務は **プロジェクト作成まで**。リポジトリ登録は `/pecot-w:w-repo-add` に委譲する。

前提: GitHub 認証が完了している（PAT or `gh auth login`）。

## 手順

### Step 1: 既存設定を探す

次の優先順位で既存設定を確認し、最初にマッチしたケースで対処する。

1. **カレントリポに設定あり** → pecot-workflow の MCP ツール `project_activate` を使って、その設定を有効にする → Step 3 へ
2. **兄弟リポに同一プロジェクトの設定あり** → コピーして activate → Step 3 へ
3. **GitHub 上に init 済みプロジェクトあり** → `project_activate` を使って、そのプロジェクトを有効にする（`host`・`owner`）→ Step 3 へ
4. **どれもない** → Step 2 へ

最初のチェックには、pecot-workflow の MCP ツール `project_list` を使う。

パターン 2 は、このスキルの base directory にある `scripts/detect-sibling-config.cjs` を動かし、その出力の行で決める。
作業ディレクトリはカレントリポのままにし、base directory から組んだ絶対パスで打つ。
`ls`・`cat` などで兄弟リポを調べて、スクリプトの代わりにしない。

```bash
node <このスキルの base directory>/scripts/detect-sibling-config.cjs
```

| 出力 | 対処 |
|---|---|
| `MATCH: <パス>` | そのファイルをコピーする |
| `複数見つかりました` と、パスの一覧 | AskUserQuestion でどれを使うかを選ばせ、選んだファイルをコピーする |
| `兄弟リポに一致する設定ファイルが見つかりませんでした` | パターン 3 へ |
| `ERROR:` で始まる行 | その行の理由を利用者に伝え、パターン 3 へ |

コピーは次のとおり。コピーしたら `project_activate` を使い（`project: "<コピーしたファイル名（拡張子なし）>"`）、Step 3 へ進む。
Step 3 の後、Step 4 の前に、pecot-workflow の MCP ツール `project_link` でカレントリポを登録する。

```bash
mkdir -p .pecot/config/projects
cp <出力のパス> .pecot/config/projects/
```

パターン 1・3 の検出手順は [既存設定検出の詳細](references/existing-config-detection.md) を参照。

### Step 2: プロジェクト新規作成

AskUserQuestion でプロジェクト名とワークフローサフィックスを質問する。

pecot-workflow の MCP ツール `project_create` を使って、プロジェクトを作る（`owner`・`title`・`host`・`suffix`）。

| 入力 | 説明 |
|------|------|
| `owner` | GitHub の owner（user or org）（必須） |
| `title` | GitHub Projects のプロジェクト名（必須） |
| `host` | GitHub ホスト（例: `github.com`, `ghes.example.com`） |
| `suffix` | ワークフローサフィックス（設定ファイル名・ラベル識別子に使用）（必須） |

### Step 3: Epic 集約リポの設定（任意）

マルチリポ運用では **Epic は 1 つの集約リポに集約するのが標準**。集約リポを設定すると pecot-workflow の MCP ツール `issue_create`（`type: "epic"`）の作成先が自動ルーティングされる。
未設定でも運用可能だが、その場合 Epic 作成時に毎回 `repo` の指定が必要で、運用者ごとに作成先がブレやすい。
後からの追加は既存 Epic の移送が必要で重いため、**オンボーディング時の設定を推奨** する。

概略フロー:

1. 現状確認: pecot-workflow の MCP ツール `project_get`（`key: "aggregation_repo"`）
2. AskUserQuestion Q1 で方針を選択: 使わない / 既存リポを指定（推奨） / 新規リポを作成 / 現状維持（既設定時のみ）
3. 選択に応じて集約リポを設定（既存リポ指定 / 新規リポ作成 / スキップ）
4. `project_get`（`key: "aggregation_repo"`）で設定値を再確認

AskUserQuestion Q1/Q2a/Q2b の仕様・`gh auth` 認証ガード・新規リポ作成の 3 コマンドシーケンス・`yes: true` 上書きの使い方は [集約リポ設定の詳細](references/aggregation-repo.md) を参照。

### Step 4: 動作確認

pecot-workflow の MCP ツール `board_show` を使って、作ったプロジェクトのボードが出ることを確かめる。

設定ファイルからボード URL を取得してユーザーに提示し、ブックマークを促す。
URL は、このスキルの base directory にある `scripts/board-url.cjs` を、カレントリポで動かして得る。出力の 1 行が URL。

```bash
node <このスキルの base directory>/scripts/board-url.cjs
```

### Step 5: 次ステップ案内

集約リポの設定状況に応じて案内を分岐する。設定は pecot-workflow の MCP ツール `project_get` で確かめる。

- 集約リポが設定済みのとき

  ```text
  プロジェクト作成が完了しました。
  次のステップ:
    - devcontainer を用意する（各リポを sibling clone し、コンテナ内で `/workspaces/<project>/base/<repo>` に整列するマウント構成が必要）
    - 初回リポジトリを登録: /pecot-w:w-repo-add
    - 任意: 列を自動で直すワークフローを置く（w-help の「ボードを自動で直すワークフロー」）

  Epic は集約リポ <owner/repo> に自動作成される。
  ```

- 集約リポが未設定のとき

  ```text
  プロジェクト作成が完了しました。
  次のステップ:
    - devcontainer を用意する（各リポを sibling clone し、コンテナ内で `/workspaces/<project>/base/<repo>` に整列するマウント構成が必要）
    - 初回リポジトリを登録: /pecot-w:w-repo-add
    - 任意: 列を自動で直すワークフローを置く（w-help の「ボードを自動で直すワークフロー」）

  Epic 作成時は repo: "<owner/repo>" で作成先を明示する。
  後から /pecot-w:w-onboarding を再実行するか、project_set（`key: "aggregation_repo"`）で設定できる。
  ```
