# Issue とコメントを公式の MCP で書く

pecot-workflow は、GitHub の Issue に読み書きしない。スキルは GitHub の公式の MCP のツールで読み書きし、書く前に pecot-workflow のチェックのツールに通す。
チェックのツールは、書く公式のツールに渡すのと同じ値を受け、pecot の決まりに合うかだけを返す。

| 書くもの | 先に通すチェック | 書く公式のツール |
|---|---|---|
| Issue の作成・書き換え | `issue_check` | `issue_write` |
| 親 Epic | `issue_check`（作成と一緒に） | `issue_write` の `parent_*`、または `sub_issue_write` |
| 前提（blocked by） | `issue_check`（作成と一緒に）、`issue_dependency_check`（作成の後） | `issue_dependency_write` |
| ボードの欄（置く列・`pecot-lane` など） | `issue_check`・`issue_dependency_check` | `projects_write` |
| コメント | `issue_comment_check` | `add_issue_comment`・`update_issue_comment` |

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
置く列（`pecot-status`）・組み込みの `Status`・親・前提は、書き換えで変えない。列は `board_move`、前提は下の「前提を付け外しする」で変える。

## 前提を付け外しする

1. `issue_dependency_check` に、`issue_dependency_write` に渡すのと同じ値と、前提の種類（`wait`）を渡す
2. `issue_dependency_write` で付ける・外す
3. 結果に `body` があれば、それが `## Waits for merge` の節を直した本文なので、`issue_check`（`update`）に通して `issue_write`（`update`）で書く
4. 結果の `expected_status` があれば、`projects_write` で置く列を書く

## コメントを書く

1. resource `pecot-template://comment/<名前>` を写して本文を書く
2. `issue_comment_check` に通す
3. 初めて書くときは `add_issue_comment`、書き直すときは `update_issue_comment` で書く。初めて書いたら、結果の `id` を、ファイルの `comment_id` に書いておく
