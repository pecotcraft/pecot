# Issue の機能を名前で指定する

Issue には、ボードのフィールド・Issue fields・担当者・マイルストーン・Issue type・ラベルなどの機能が付く。
pecot-workflow の MCP ツールで、どの機能にも名前で値を入れられる。

| やりたいこと | 使うツール |
|---|---|
| そのリポの Issue に付けられる機能と、取りうる値を知る | `issue_attributes` |
| 起票と同時に値を入れる | `issue_create` の `attributes`。ファイルから起票するときは、フロントマターの `attributes` |
| 起票済みの Issue の値を変える・外す | `issue_edit` |
| 入っている値を見る | `issue_show` の `attributes` |

- 値を入れる前に、`issue_attributes` で名前と取りうる値を確かめる。名前はボードや Issue fields の表示のとおりに書く
- どの機能を使うかは、プロジェクトが決める。指定しなかった機能は空のままで、pecot は値を求めない
- 進行の欄と組み込みの Status は、`board_move` で動かす。親 Epic は `issue_create` の `parent_epic`、前提は `issue_block` で付ける
