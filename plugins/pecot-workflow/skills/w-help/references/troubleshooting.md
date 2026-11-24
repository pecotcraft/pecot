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
