# トラブルシューティング

## 認証エラー

```bash
gh auth token               # トークン確認
gh auth refresh -s project   # projectスコープ追加
```

## プロジェクトが見つからない

```bash
pecot project list            # 一覧確認
pecot project search <owner>  # 検索
```

## フィールドが見つからない

```bash
pecot project init <owner> <project-name>
```
