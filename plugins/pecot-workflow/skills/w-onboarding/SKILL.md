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

1. **カレントリポに設定あり** → `project_activate` を `project: "<設定ファイル名>"` で呼ぶ → Step 3 へ
2. **兄弟リポに同一プロジェクトの設定あり** → コピーして activate → Step 3 へ
3. **GitHub 上に init 済みプロジェクトあり** → `project_activate` を `host: "<host>"`・`owner: "<owner>"` で呼ぶ → Step 3 へ
4. **どれもない** → Step 2 へ

最初のチェックには、`project_list` を引数なしで呼ぶ。

各パターンの検出手順・兄弟リポを走査するスクリプトの詳細は [既存設定検出の詳細](references/existing-config-detection.md) を参照。

### Step 2: プロジェクト新規作成

AskUserQuestion でプロジェクト名とワークフローサフィックスを質問する。

`project_create` でプロジェクトを作成する（create = プロジェクト作成 + フィールド追加 + activate を実行）。`owner: "<owner>"`・`title: "<プロジェクト名>"`・`host: "<host>"`・`suffix: "<suffix>"` で呼ぶ。

| 入力 | 説明 |
|------|------|
| `owner` | GitHub の owner（user or org）（必須） |
| `title` | GitHub Projects のプロジェクト名（必須） |
| `host` | GitHub ホスト（例: `github.com`, `ghes.example.com`） |
| `suffix` | ワークフローサフィックス（設定ファイル名・ラベル識別子に使用）（必須） |

### Step 3: Epic 集約リポの設定（任意）

マルチリポ運用では **Epic は 1 つの集約リポに集約するのが標準**。集約リポを設定すると `issue_create`（`type: "epic"`）の作成先が自動ルーティングされる。
未設定でも運用可能だが、その場合 Epic 作成時に毎回 `repo` の指定が必要で、運用者ごとに作成先がブレやすい。
後からの追加は既存 Epic の移送が必要で重いため、**オンボーディング時の設定を推奨** する。

概略フロー:

1. 現状確認: `aggregation_show`
2. AskUserQuestion Q1 で方針を選択: 使わない / 既存リポを指定（推奨） / 新規リポを作成 / 現状維持（既設定時のみ）
3. 選択に応じて集約リポを設定（既存リポ指定 / 新規リポ作成 / スキップ）
4. `aggregation_show` で設定値を再確認

AskUserQuestion Q1/Q2a/Q2b の仕様・`gh auth` 認証ガード・新規リポ作成の 3 コマンドシーケンス・`yes: true` 上書きの使い方は [集約リポ設定の詳細](references/aggregation-repo.md) を参照。

### Step 4: 動作確認

`project_info` を引数なしで呼ぶ。プロジェクト設定が表示されることを確認する。

設定ファイルからボード URL を取得してユーザーに提示し、ブックマークを促す。

```bash
board_url=$(node --input-type=commonjs -e '
const fs = require("node:fs"), path = require("node:path");
const fail = (msg) => { console.error(msg); process.exit(1); };
const active = path.resolve(".pecot/config/projects/.active");
let target;
try {
  target = path.resolve(path.dirname(active), fs.readFileSync(active, "utf8").trim());
} catch {
  fail("アクティブなプロジェクトの指定を読めません: " + active);
}
let url;
try {
  url = (JSON.parse(fs.readFileSync(target, "utf8")).project || {}).board_url;
} catch {
  fail("プロジェクト設定を読めません（ファイルが無い、または JSON が壊れています）: " + target);
}
if (typeof url !== "string" || url === "") fail("project.board_url がありません: " + target);
console.log(url);
') || exit 1
printf '%s\n' "$board_url"
```

### Step 5: 次ステップ案内

集約リポの設定状況に応じて案内を分岐する。`aggregation_show` の結果で確認できる。

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
  後から /pecot-w:w-onboarding を再実行するか、aggregation_set で設定できる。
  ```
