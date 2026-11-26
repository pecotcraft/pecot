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
3. **GitHub 上に init 済みプロジェクトあり** → `project_search` で探し、`project_activate` を使って、そのプロジェクトを有効にする → Step 3 へ
4. **どれもない** → Step 2 へ

最初のチェックには、pecot-workflow の MCP ツール `project_list` を使う。

パターン 1〜3 で有効にしたら、Step 3 へ進む前に、ボードに `pecot-lane` があるかを見る。

1. pecot-workflow の MCP ツール `project_search` で、有効にしたボードのタイトルを得る。`active` が真の行のタイトルを使う
   - `host`・`owner` は、パターン 3 では検索に渡した値、パターン 1・2 では `project_activate` の結果の `configPath` のファイルの値にする
2. pecot-workflow の MCP ツール `project_init` を、`lanes` を渡さずに使う（`owner`・`name`: 1. のタイトル・`host`）
3. 結果の `fields` の `pecot-lane` が `skip` なら、ボードを領域のレーンで分けるかを利用者に聞く
   - 分けるなら、Step 2 と同じく `lanes` の値を決め、`lanes` を足して `project_init` をもう一度使う
   - `skip` でなければ、聞かずに Step 3 へ進む

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

AskUserQuestion でプロジェクト名を質問する。

続けて、AskUserQuestion でボードを分ける領域（`lanes` の値）を決める。

- 値は、作業を分けたい単位（プラグイン・チーム・サービスなど）にする
- 候補は、カレントリポのディレクトリの分け方（`plugins/` `packages/` `services/` などの下の名前）から挙げる
- GitHub の画面に出るので、英語の名前にする

pecot-workflow の MCP ツール `project_create` を使って、プロジェクトを作る（`owner`・`title`・`host`・`lanes`）。

| 入力 | 説明 |
|------|------|
| `owner` | GitHub の owner（user or org）（必須） |
| `title` | GitHub Projects のプロジェクト名（必須） |
| `host` | GitHub ホスト（例: `github.com`, `ghes.example.com`） |
| `lanes` | `pecot-lane` の値。決めた領域の名前 |

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

`project_create`・`project_init` の結果の `view.url` を示し、領域ごとのレーンで見る `Lanes` のビューを開けることを伝える。
`view.manual_steps` が返ったときは、ビューを作れなかったので、その手順を示す。

### Step 5: 自動レビューを入れる（任意）

PR を作ると GitHub Actions の上で w-review のレビューを回すワークフローを、カレントリポに入れるかを決める。

1. pecot-workflow の MCP ツール `workflow_doctor`（`name: "review"`）を使い、雛形が置かれているかを見る
   - 見るのは、`items` のうち `name` が `.github/workflows/pecot-review.yml` の項目
   - 雛形が置かれているかを読めずに止まったら（カレントが git のリポでない、GitHub に届かないなど）、止まった理由を示して Step 6 へ進む
   - そのときは、後から `workflow_install`・`workflow_doctor` で入れられることと、[自動レビューのワークフロー](../w-help/references/review-workflow.md) を案内する
2. その `state` が `missing` でなければ、聞かずに `items` を示して Step 6 へ進む
   - `workflow template review` の項目が `outdated` なら、`workflow_install` の `force: true` で更新できることを添える
3. `missing` なら、AskUserQuestion で「カレントリポ `<owner/repo>` に自動レビューを入れるか」を聞く。入れないなら、何もせずに Step 6 へ進む
4. 入れるなら、pecot-workflow の MCP ツール `workflow_install`（`name: "review"`）で雛形を置く
5. 利用者が画面で行う設定を、次の順に示す
   1. Claude の GitHub App をリポに入れる
   2. モデルの認証の secret `CLAUDE_CODE_OAUTH_TOKEN` を登録する（`claude setup-token` で作り、1 行で貼る）
   3. 雛形をコミットし、既定のブランチへ入れる

   権限を絞りたい利用者だけ、自前の GitHub App を足せることを 1 行で添える。詳しい手順と運用は、[自動レビューのワークフロー](../w-help/references/review-workflow.md) にあることを示す

   同じ認証で、引き継ぎのワークフローも `workflow_install`（`name: "handoff"`）で入れられることを 1 行で添える。マージした結果を Epic に書くもので、[引き継ぎのワークフロー](../w-help/references/handoff-workflow.md) を示す
6. 設定の順を示したら、このターンを終えて利用者の返事を待つ。Step 6 へは進まない
7. 後で設定すると答えたら、`workflow_doctor` を呼ばずに、後から `workflow_doctor`（`name: "review"`）で確かめられることを添えて Step 6 へ進む
8. 利用者が設定を終えたら、`workflow_doctor` で確かめる。`items` のうち `state` が `missing` か `outdated` の項目の `name` を示す。`skipped` は足りないと数えない
9. 足りないものが無ければ、既定のブランチへ入れるまで動かないことを添えて、Step 6 へ進む

### Step 6: 古い雛形を置き換える

前にカレントリポへ置いた雛形が古ければ、新しい雛形へ置き換える PR を出す。古い雛形は `@pecot/workflow-mcp` を npx で呼んでおり、新しい雛形は pecot の action を呼ぶ。

1. 雛形の一覧の `board-sync`・`review`・`handoff`・`auto` ごとに、pecot-workflow の MCP ツール `workflow_doctor` を使う
   - ファイルの項目が `missing` の雛形は飛ばす
   - 止まったら、止まった理由を示して Step 7 へ進む
2. 次の項目のどちらかが `outdated` の雛形を集める。無ければ Step 7 へ進む
   - `workflow template <名前>`
   - `<置き先> calls the pecot actions, not npx @pecot/workflow-mcp`
3. 既定のブランチの最新から作業ブランチ `chore/update-pecot-workflows` を作って切り替える
4. 集めた雛形ごとに、pecot-workflow の MCP ツール `workflow_install` を `force: true` で使い、置き直す
   - 結果に `removedLines` があれば、利用者が足していた行として示す
   - `github-not-found` で止まったら、pecot の action のリリースがまだ無いので、その旨を示して Step 7 へ進む
5. 置き直したファイルをコミットして push し、pecot-workflow の MCP ツール `pr_create` で PR を出す
   - `no_issue_ref: true` を渡す。紐づく Issue は無い
   - 本文には、置き直した雛形の名前と、npx の行が pecot の action の呼び出しに替わったことを書く
6. PR の URL を示し、GitHub の画面でマージすると新しい雛形で動くことを添えて、Step 7 へ進む

### Step 7: 次ステップ案内

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
