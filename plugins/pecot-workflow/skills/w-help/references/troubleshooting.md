# トラブルシューティング

## 認証エラー

```bash
gh auth token               # トークン確認
gh auth refresh -s project   # projectスコープ追加
```

## プロジェクトが見つからない

- 一覧確認: `project_list` を引数なしで呼ぶ
- 検索: `project_search` を `owner: "<owner>"` で呼ぶ

## フィールドが見つからない

`project_init` を `owner: "<owner>"`・`name: "<project-name>"`・`suffix: "<suffix>"` で呼ぶ。
