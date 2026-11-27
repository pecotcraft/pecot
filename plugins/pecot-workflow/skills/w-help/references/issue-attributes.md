# Issue の機能を名前で指定する

Issue には、ボードのフィールド・Issue fields・担当者・マイルストーン・Issue type・ラベルなどの機能が付く。
どの機能も、GitHub の公式の MCP のツールで、名前で値を入れる。書く前に pecot-workflow の `issue_check` に通すと、名前と値が定義に合うかを確かめ、外れたら候補を返す。

| やりたいこと | 使うツール |
|---|---|
| そのリポの Issue に付けられる機能と、取りうる値を知る | `projects_list`（`list_project_fields`）・`list_issue_fields`・`list_issue_types` |
| 起票と同時に値を入れる | テンプレートの `issue_fields`・`project_fields`・`labels`・`assignees`・`milestone`・`type` に書き、`issue_check` に通す |
| 起票済みの Issue の値を変える・外す | `issue_check`（`update`）に通してから、`issue_write`（`update`）・`projects_write`（`update_project_item`） |
| 入っている値を見る | `issue_read`（`get`）・`projects_list`（`list_project_items`） |

- 名前はボードや Issue fields の表示のとおりに書く。値を外すときは、`issue_fields` は `delete: true`、ボードの欄は `value` に null を書く
- どの機能を使うかは、プロジェクトが決める。指定しなかった機能は空のままで、pecot は値を求めない
- 進行の欄と組み込みの Status は、`board_move` で動かす。親 Epic と前提は、起票のときのテンプレートか、[Issue とコメントを公式の MCP で書く](issue-write.md) の「前提を付け外しする」で付ける
- 手順の全体は [Issue とコメントを公式の MCP で書く](issue-write.md)
