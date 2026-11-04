# 認証・設定ファイル

## 認証設定

`.pecot/config/.env`に設定（`cat`で内容確認）。

**必須スコープ**: `repo`, `read:org`, `project`

**トークン取得優先順位:**

1. 環境変数（`PECOT_GITHUB_*_TOKEN`）
2. `gh auth token`（フォールバック）

## 設定ファイル

| ファイル | 内容 |
|---------|------|
| `.pecot/config/hosts.json` | ホスト設定（トークン環境変数名、スコープ） |
| `.pecot/config/projects/*.json` | プロジェクト設定（自動生成、手動編集不要） |
