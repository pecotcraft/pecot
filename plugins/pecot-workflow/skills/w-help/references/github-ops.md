# github-ops で書く

公式の MCP に書く手が無い操作は、導入先のリポの `pecot-github-ops.yml` が 1 つずつ行う。スキルは、公式の MCP の Actions のツールで起動し、job のログから結果を読む。
利用者に起動を頼まない。スキルが起動して、結果を読んで先へ進む。

| operation | 使う場面 | 先に通すチェック |
|---|---|---|
| `link-branch` | Issue につないだブランチを作る | `branch_check` |
| `stack-register` | 子 PR を親 PR のスタックに登録する | — |
| `project-fields` | ボードの欄を作る・直す | `project_check`（`fields`） |
| `project-view` | ボードのビューを作る | — |
| `project-link` | リポをボードにつなぐ | — |
| `repo-settings` | 既定のブランチと「head ブランチを自動で消す」の設定を読む | — |
| `workflow-doctor` | secret と variable の名前と、置いた雛形を読む | — |
| `release-create` | リリースを作る | `release_check` |
| `pr-attach` | gh が動かないクラウドのスレッドで、PR の本文に画像を載せる（w-pr） | — |

operation ごとの params と result は、pecotcraft/pecot の `actions/README.md` の「github-ops の操作」にある。

## 起動して結果を読む

1. `request_id` を決める。同じ operation を何度起動しても見分けられる、短い一意の値にする
2. `actions_run_trigger`（`run_workflow`）で起動する
   - `workflow_id` は `pecot-github-ops.yml`、`ref` はリポの既定のブランチにする
   - `inputs` に `operation`・`request_id`・`params`（JSON の文字列）を渡す
3. `actions_list`（`list_workflow_runs`）で、実行の名前が `pecot github-ops <operation> <request_id>` のものを探す
4. `actions_get`（`get_workflow_run`）で、終わるまで読み直す
5. `get_job_logs` で job のログを読み、`PECOT_RESULT` で始まる行の JSON を取る。行の先頭に時刻が付いていれば、外して読む
6. JSON が `"ok": true` なら、`result` を次の手順に渡す

## 止めるとき

次のときは先へ進まず、実行の URL を利用者に示して止まる。

- JSON が `"ok": false`。`error.kind` と `error.message` も示す
- 起動から 10 分たっても終わらない
- 実行が見つからない。リポに `pecot-github-ops.yml` が無ければ、`workflow_install` で置くよう伝える

`error.kind` ごとの直し方は次のとおり。

| `error.kind` | 直し方 |
|---|---|
| `invalid-input` | params の形を直す。先に通すチェックがある operation は、チェックに通し直す |
| `order-conflict` | スタックの順が合わない。`message` の PR の並びを利用者に示し、どう直すかを決めてもらう |
| `github-auth` | App の variable と secret、App の権限を確かめるよう伝える。`pr-attach` では secret `PECOT_ATTACH_TOKEN` の PAT を確かめる。要るものは雛形の先頭のコメントにある |
| `github-api` | GitHub が断った。`message` を示す。5xx のときは、次の節に従ってやり直す |

## やり直す前に確かめる

GitHub が 5xx を返しても、書き込みが済んでいることがある。やり直す前に、書いたものを読んで確かめる。

| operation | 読むもの |
|---|---|
| `link-branch` | `list_branches` でブランチがあるか |
| `stack-register` | 子 PR の base（`pull_request_read`） |
| `project-fields`・`project-view` | `projects_list`（`list_project_fields`）・`projects_get` |
| `release-create` | `get_release_by_tag` |
| `pr-attach` | `pull_request_read` で、本文の画像の参照が user-attachments の URL に変わったか。一時ブランチは消えているので、やり直すときは `push-attach.cjs` から打ち直す |

書けていれば、やり直さずに先へ進む。書けていなければ、同じ params で起動し直す。
