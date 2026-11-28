---
name: w-onboarding
description: |
  新規プロジェクトをセットアップします。
  Use when the user is setting up a brand-new project for pecot from scratch — creates a GitHub Projects board, registers repositories, configures the project for pecot workflow management.
when_to_use: "pecot を新しいプロジェクトで使い始めたい、ボードを作って初期設定したい"
---

# オンボーディング

新規プロジェクトのセットアップを行う。本スキルの責務は **プロジェクト作成まで**。リポジトリ登録は `/pecot-w:w-repo-add` に委譲する。

前提: GitHub の公式の MCP サーバが、書き込みのできる形でつながっている。つなぎ方は [w-help](../w-help/SKILL.md) の「公式の MCP をつなぐ」にある。

## 手順

### Step 1: 既存設定を探す

次の優先順位で既存設定を確認し、最初にマッチしたケースで対処する。

1. **カレントリポに設定あり** → その設定を有効にする → Step 3 へ
2. **兄弟リポに同一プロジェクトの設定あり** → コピーして有効にする → Step 3 へ
3. **GitHub 上に pecot の欄を持つボードあり** → そのボードを有効にする → Step 3 へ
4. **どれもない** → Step 2 へ

最初のチェックには、pecot-workflow の MCP ツール `project_list` を使う。

設定やボードを有効にするときは、pecot-workflow の MCP ツール `project_activate` に、公式の MCP で読んだボードを `reads` で渡す。

| `reads` | 公式のツール |
|---|---|
| `project` | `projects_get`（`get_project`）。`project` に番号か設定ファイルを渡すとき |
| `projects` | `projects_list`（`list_projects`。全ページ）。`project` にタイトルを渡すとき |
| `fields` | `projects_list`（`list_project_fields`） |
| `views` | `projects_list`（`list_project_views`） |

有効にしたら、Step 3 へ進む前に、ボードに `pecot-lane` があるかを見る。

1. 読んだ `fields` に `pecot-lane` が無ければ、ボードを領域のレーンで分けるかを利用者に聞く
   - 分けるなら、Step 2 と同じく `lanes` の値を決め、Step 2 の「欄とビューを作る」の手順で `pecot-lane` を足す
   - 欄を足したら、`project_activate` を読み直した `fields` で呼び直す
2. `pecot-lane` があれば、聞かずに Step 3 へ進む

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
Step 3 の後、Step 4 の前に、`/pecot-w:w-repo-add` の Step 3 の手順でカレントリポを登録する。

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

#### ボードを作る

1. owner と、その種類（組織または個人。`owner_type`）を決める。カレントリポの owner を既定にする
2. `projects_list`（`list_projects`）で、同じ owner のボードを全ページ読む
3. pecot-workflow の MCP ツール `project_check` に、読んだボード（`reads.projects`）を渡す。`method: "create"`・`owner`・`owner_type`・`title`（プロジェクト名）も渡す。`problems` が返ったら、利用者に示して名前を決め直す
4. `projects_write`（`create_project`）で、同じ `owner`・`owner_type`・`title` のボードを作る。結果の `number` を控える

#### 欄とビューを作る

欄とビューは、github-ops の `project-fields`・`project-view` で書く。手順は [github-ops で書く](../w-help/references/github-ops.md)。

1. カレントリポに `pecot-github-ops.yml` があるかを、pecot-workflow の MCP ツール `workflow_doctor`（`name: "github-ops"`）で見る
   - 無ければ、`workflow_install`（`name: "github-ops"`）で置く。App の variable と secret の登録と、既定のブランチへの取り込みを利用者に頼み、終わるまで待つ。要るものは、雛形の先頭のコメントと [github-ops で書く](../w-help/references/github-ops.md) にある
   - github-ops が扱うのは、リポと同じ組織のボードだけになる。個人のアカウントのボードは、3 の `problems` に挙がった欄と選択肢を、利用者に GitHub の画面で足してもらう
2. `projects_list`（`list_project_fields`）で、ボードの欄を読む
3. `project_check` に、`method: "fields"`・`owner`・`project`（ボードの番号）・`lanes` と、読んだ欄（`reads.fields`）を渡す
   - `problems` に挙がった欄と選択肢を、github-ops の `project-fields` の `changes` の形で組み立て、`changes` に入れて通し直す。`problems` が空になるまで繰り返す
   - `deletable` の欄は、利用者が消すと決めたときだけ `changes` に入れる。消すと、その欄の値がすべてのカードから消える
4. github-ops の `project-fields` を、`params` に `project` と、通した `changes` を入れて起動する
5. `lanes` を決めたときは、github-ops の `project-view` を、`params` を次の形にして起動する。結果の `url` を Step 4 で示す

   ```text
   {"project": <ボードの番号>, "name": "Lanes", "column": "pecot-status", "row": "pecot-lane"}
   ```

6. `project_activate` に、`project`（ボードの番号）・`owner`・`owner_type`・`host` と、読み直したボード・欄・ビュー（`reads`）を渡して、設定ファイルを作る

### Step 3: Epic 集約リポの設定（任意）

マルチリポ運用では **Epic は 1 つの集約リポに集約するのが標準**。集約リポを設定すると、w-backlog が Epic をそのリポに作る。pecot-workflow の MCP ツール `issue_check` は、Epic を集約リポの外に作ろうとすると警告する。
未設定でも運用可能だが、その場合 Epic 作成時に毎回作成先のリポを決める必要があり、運用者ごとに作成先がブレやすい。
後からの追加は既存 Epic の移送が必要で重いため、**オンボーディング時の設定を推奨** する。

概略フロー:

1. 現状確認: pecot-workflow の MCP ツール `project_get`（`key: "aggregation_repo"`）
2. AskUserQuestion Q1 で方針を選択: 使わない / 既存リポを指定（推奨） / 新規リポを作成 / 現状維持（既設定時のみ）
3. 選択に応じて集約リポを設定（既存リポ指定 / 新規リポ作成 / スキップ）
4. `project_get`（`key: "aggregation_repo"`）で設定値を再確認

AskUserQuestion Q1/Q2a/Q2b の仕様・新規リポ作成の手順・`yes: true` 上書きの使い方は [集約リポ設定の詳細](references/aggregation-repo.md) を参照。

### Step 4: 動作確認

`projects_list`（`list_project_fields`）でボードの欄を読み直し、`project_check`（`method: "fields"`）に渡す。`problems` が空なら、ボードに pecot の欄がそろっている。

設定ファイルからボード URL を取得してユーザーに提示し、ブックマークを促す。
URL は、このスキルの base directory にある `scripts/board-url.cjs` を、カレントリポで動かして得る。出力の 1 行が URL。

```bash
node <このスキルの base directory>/scripts/board-url.cjs
```

Step 2 で `Lanes` のビューを作ったときは、`project-view` の結果の `url` を示し、領域ごとのレーンで見られることを伝える。

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

1. 雛形の一覧の `board-sync`・`review`・`handoff`・`auto`・`github-ops` ごとに、pecot-workflow の MCP ツール `workflow_doctor` を使う
   - ファイルの項目が `missing` の雛形は飛ばす
   - 止まったら、止まった理由を示して Step 7 へ進む
2. 次の項目のどちらかが `outdated` の雛形を集める。無ければ Step 7 へ進む
   - `workflow template <名前>`
   - `<置き先> calls the pecot actions, not npx @pecot/workflow-mcp`
3. 既定のブランチの最新から作業ブランチ `chore/update-pecot-workflows` を作って切り替える
4. 集めた雛形ごとに、pecot-workflow の MCP ツール `workflow_install` を `force: true` で使い、置き直す
   - 結果に `removedLines` があれば、利用者が足していた行として示す
   - `github-not-found` で止まったら、pecot の action のリリースがまだ無いので、その旨を示して Step 7 へ進む
5. 置き直したファイルをコミットして push し、PR を出す
   - [PR を作る・書き換える](../w-help/references/github-write.md#pr-を作る書き換える) の手順で、`pr_check` に通してから `create_pull_request` で作る
   - 紐づく Issue は無いので、本文の末尾の `Closes #` の行を消す
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
