# GitHub に公式の MCP と github-ops で書く

pecot-workflow は、GitHub に読み書きしない。スキルは GitHub の公式の MCP のツールで読み書きし、書く前に pecot-workflow のチェックのツールに通す。
チェックのツールは、書く手に渡すのと同じ値と、公式の MCP で読んだ結果（`reads`）を受け、pecot の決まりに合うかだけを返す。`problems` が空なら、同じ値をそのまま書く手に渡す。
公式の MCP に書く手が無い操作は、`pecot-github-ops.yml` の operation で書く。起動と結果の読み方は [github-ops で書く](github-ops.md) に書いてある。

| 書くもの | 先に通すチェック | 書く手 |
|---|---|---|
| Issue の作成・書き換え | `issue_check` | `issue_write` |
| 親 Epic | `issue_check`（作成と一緒に） | `issue_write` の `parent_*`、または `sub_issue_write` |
| 前提（blocked by） | `issue_check`（作成と一緒に）、`issue_dependency_check`（作成の後） | `issue_dependency_write` |
| ボードの欄（Issue を作るときの欄・`pecot-lane` など） | `issue_check` | `projects_write` |
| 前提の付け外しに伴う列 | `issue_dependency_check` | `projects_write` |
| 着手・PR の作成など、それ以外の列の移動 | `board_check` | `projects_write`（`update_project_item`） |
| コメント | `issue_comment_check` | `add_issue_comment`・`update_issue_comment` |
| Issue につないだブランチ（作業を始める） | `branch_check` | github-ops の `link-branch` |
| PR の作成・書き換え・マージ | `pr_check`（`create`・`update`・`merge`） | `create_pull_request`・`update_pull_request`・`merge_pull_request` |
| スタック PR の登録 | — | github-ops の `stack-register` |
| ボードの作成 | `project_check`（`create`） | `create_project` |
| ボードの欄 | `project_check`（`fields`） | github-ops の `project-fields` |
| ボードのビュー・リポのつなぎ | — | github-ops の `project-view`・`project-link` |
| リリース | `release_check` | github-ops の `release-create` |

公式のツールは、ツール名で指す。つなぎ先（claude.ai のコネクタ・手元の MCP サーバ・Actions の雛形のサーバ）で接続の名前が違っても、ツール名は同じだからだ。
公式のツールが無い、または読み取りだけのときは、書かずに止める。利用者に、GitHub の公式の MCP サーバを書き込みのできる形でつなぐよう伝える。つなぎ方は [w-help](../SKILL.md) の「公式の MCP をつなぐ」に書いてある。

## Issue を作る

1. テンプレートを読む。pecot-workflow の MCP サーバの resource `pecot-template://issue/<名前>` を `.pecot/tmp/output/` に写す。frontmatter と本文を埋める。frontmatter の鍵は、書く公式のツールの引数の名前になっている
2. 決まりに要るものを読む。書く値に関わるものだけを読む

   | 読むもの | 公式のツール |
   |---|---|
   | ボードの owner と番号 | pecot-workflow の `project_list` |
   | 親 Epic と、その sub-issue の題（題の番号） | `issue_read`（`get`・`get_sub_issues`） |
   | 前提の Issue の状態と、閉じる PR | `issue_read`（`get`） |
   | 前提の前提（循環） | `issue_dependency_read`（`get_blocked_by`） |
   | 親と前提のボードのカード | `projects_list`（`list_project_items`。query は `repo:<owner/repo> is:issue <番号>`） |
   | ボードの欄・Issue fields・Issue type の定義 | `projects_list`（`list_project_fields`）・`list_issue_fields`・`list_issue_types` |
   | 担当にできる人 | `list_repository_collaborators` |

3. `issue_check` に、`method: create`、frontmatter の値と本文、読んだ結果を渡す。外れた項目が返ったら、直して通し直す
4. 通した値で書く。順は次のとおり
   1. `issue_write`（`create`）。`issue_fields` が無ければ、親の `parent_*` も渡す。結果に `issue` が無ければ、作れていないので先へ進まない
   2. `issue_fields` があったときだけ、`sub_issue_write`（`add`）で親に付ける。`sub_issue_id` は、`issue_write` の結果の `issue.id`
   3. `blocked_by` の前提ごとに、`issue_dependency_write`（`add`・`type: blocked_by`）
   4. `projects_write` の `add_project_item` でボードに足し、`project_fields` を 1 つずつ `update_project_item` で書く
5. 担当を書いたときは、`issue_read`（`get`）で担当が残ったかを確かめる。残らなかった人は、利用者に伝える

一括で作るとき（w-issueize）は、全部の Issue を 1 回の `issue_check` に通してから、1 件ずつ書く。書いた Issue の番号で、後の Issue の本文の `{{issue:<key>}}` と `blocked_by` の key を置き換えてから書く。

## Issue を書き換える

`issue_check` に `method: update` で通してから、`issue_write`（`update`）で書く。ボードの欄は `projects_write` で書く。
置く列（`pecot-status`）・組み込みの `Status`・親・前提は、書き換えで変えない。列は下の「列を動かす」、前提は下の「前提を付け外しする」で変える。

## 前提を付け外しする

1. `issue_dependency_check` に、`issue_dependency_write` に渡すのと同じ値と、前提の種類（`wait`）を渡す
2. `issue_dependency_write` で付ける・外す
3. 結果に `body` があれば、それが `## Waits for merge` の節を直した本文なので、`issue_check`（`update`）に通して `issue_write`（`update`）で書く
4. 結果の `expected_status` があれば、`projects_write` で置く列を書く

## コメントを書く

1. resource `pecot-template://comment/<名前>` を写して本文を書く
2. `issue_comment_check` に通す
3. 初めて書くときは `add_issue_comment`、書き直すときは `update_issue_comment` で書く。初めて書いたら、結果の `id` を、ファイルの `comment_id` に書いておく

## 列を動かす

1. ボードの owner と番号を pecot-workflow の `project_list` で読む。`projects_list` で、ボードの欄（`list_project_fields`）と、動かす Issue のカード（`list_project_items`）を読む。`Ready`・`Blocked` へ動かすときは、Issue と前提も読む（`issue_read`・`issue_dependency_read`）
2. `board_check` に、`update_project_item` に渡すのと同じ値と、読んだ結果を渡す
3. `projects_write` の `update_project_item` で書く。カードがボードに無いときは、先に `add_project_item` で足す

## 作業を始める

Issue につないだブランチを作り、手元に作業を記録し、カードを `Active` へ動かす。

1. 作業の Issue と前提を読む
   - `issue_read`（`get`）で、作業の Issue と、前提の Issue を 1 つずつ読む
   - `issue_dependency_read`（`get_blocked_by`）で、作業の Issue の前提を読む
   - 前提が `Pending` の列にあるかも見るときは、`projects_list` で前提のカード（`list_project_items`）と欄（`list_project_fields`）も読む
2. `branch_check` に、github-ops の `link-branch` に渡す `issue`・`branch`・`base` と、リポの `owner`・`repo`、読んだ結果（`reads`）を渡す
   - `branch` は、`feat/` などの接頭辞と短い英語のケバブケースの説明に、`/<Issue番号>` を続けた名前にする
   - `base` は、まず省いて通す。`problems` の `base` の項目の `candidates` を `base` にして通し直す。前提の上にスタックするときは前提のブランチ、ほかは開発ブランチになる
   - 前提が残っているなど、`problems` が返ったら、利用者に示して止まる。前提を外さない
3. github-ops の `link-branch` で作る。手順は [github-ops で書く](github-ops.md)
4. `session_start` に、`issue_ref`・Issue の題（`title`）と、`link-branch` の結果の `base`・`sha` を渡す。`branch_check` が `stacked_on` を返したときは、それも渡す
   - `reads.pull_requests` に、今のブランチの PR を `list_pull_requests`（`head` に `<owner>:<今のブランチ>`、`state: all`）で読んで渡す。前にマージされた PR の片付けが残っていれば、結果の `leftovers` に出る
5. [列を動かす](#列を動かす) の手順で、カードを `Active` へ動かす

## PR を作る・書き換える

1. resource `pecot-template://pr/create` を `.pecot/tmp/output/` に写し、frontmatter と本文を埋める。frontmatter の鍵は `create_pull_request` の引数の名前になっている。
   差し替えたテンプレート（`.github/pull_request_template.md` など）を使うときは、`template` にそのパスを書く
   - `base` は、`session_show` の `baseBranch` から、先頭の remote の名前と `/` を除いたブランチにする
   - 本文の末尾の `Closes #` に、作業中の Issue の番号を書く
2. 決まりに要るものを読む
   - head のブランチ名の末尾の番号の Issue を `issue_read`（`get`）で読む
   - スタックしたブランチでは、親のブランチの PR を `list_pull_requests`（`head` に `<owner>:<base>`、`state: all`）で読む
3. `pr_check` に `method: create` で、frontmatter の値・本文（`body`）・読んだ結果（`reads`）を渡す。外れた項目が返ったら、直して通し直す
   - `base-mismatch` には、`candidates` のブランチに直す
   - 親の PR が開いていないと返ったら、利用者に示して止まる。`base` を自分の判断で書き換えない
4. 通した値で `create_pull_request` に渡す。`template` と `screenshot` は渡さない
5. スタックしたブランチでは、github-ops の `stack-register` で、作った PR（`pr`）を親の PR（`parent_pr`）のスタックに入れる
6. [列を動かす](#列を動かす) の手順で、作業の Issue のカードを `In Review` へ動かす

書き換えは、`pull_request_read`（`get`）で PR を読み、`pr_check` に `method: update` で通してから、`update_pull_request` で書く。

## PR をマージする

1. マージする PR と、その base を head に持つ開いた PR を読む
   - マージする PR は `pull_request_read`（`get`）で読む
   - base を head に持つ PR は `list_pull_requests`（`head` に `<owner>:<base>`、`state: open`）で読む
2. `pr_check` に `method: merge` で、`merge_pull_request` に渡す `pullNumber`・`merge_method`・`expectedHeadSha` と、読んだ結果を渡す
3. `merge_pull_request` でマージする。merge queue のリポで断られたら、利用者に GitHub の画面でマージを頼む

## ボードを作る

1. `projects_list`（`list_projects`）で、同じ owner のボードを読む
2. `project_check` に `method: create` で、`create_project` に渡す値と読んだ結果を渡してから、`create_project` で作る
3. `projects_list`（`list_project_fields`）で欄を読み、同梱の欄の定義から github-ops の `project-fields` の `changes` を組み立てる
4. `project_check` に `method: fields` で、`changes` と読んだ欄を渡す。`problems` に挙がった欄と選択肢を `changes` に足して通し直す。`deletable` の欄は、利用者が消すと決めたときだけ `changes` に入れる
5. github-ops の `project-fields`、続けて `project-view` を起動する

## リリースを作る

1. alert と、同じタグのリリースを読む
   - alert は `list_dependabot_alerts`・`list_code_scanning_alerts`・`list_secret_scanning_alerts` で読む
   - 同じタグのリリースは `get_release_by_tag` で読む
2. `release_check` に、github-ops の `release-create` に渡す `tag`・`sha`・`body`・`name`・`prerelease` と、読んだ結果を渡す
3. github-ops の `release-create` で作る
