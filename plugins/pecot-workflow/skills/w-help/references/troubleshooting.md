# トラブルシューティング

## 認証エラー

```bash
gh auth token               # トークン確認
gh auth refresh -s project   # projectスコープ追加
```

## プロジェクトが見つからない

- 一覧確認: pecot-workflow の MCP ツール `project_list` を使う
- 検索: pecot-workflow の MCP ツール `project_search` を使う（`owner: "<owner>"`）

## フィールドが見つからない

pecot-workflow の MCP ツール `project_init` を使う（`owner`・`name`）。

## 旧い形のボードを移す

`board_show`・`board_sync` が、旧い名前の進行の欄や、pecot が使わないフィールド（`pecot-priority`・`pecot-size`）を warning で知らせたときに行う。

1. pecot-workflow の MCP ツール `project_init` を、`confirm_delete` を付けずに使う（`owner`・`name`）。名前を移し、設定ファイルを書き直す
2. 結果の `migration.pending_delete` に名前があれば、その名前を利用者に示し、消してよいか承認を得る。消すと、各 Item のそのフィールドの値も消え、戻せない
3. 承認を得たら、`project_init` を `confirm_delete: true` で使う。消したフィールドは `migration.deleted` に並ぶ
