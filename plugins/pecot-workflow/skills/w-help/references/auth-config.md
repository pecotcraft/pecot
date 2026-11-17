# 認証・設定ファイル

## 認証設定

`.pecot/config/.env`に設定（`cat`で内容確認）。

`.pecot/config/` の無い clone では `.env` を作らない。`gh auth login` でログインするか、pecot を起こす前（MCP ではセッションを起こす前）に環境変数を設定する。

**必須スコープ**: `repo`, `read:org`, `project`

**トークン取得優先順位:**

1. 環境変数（`PECOT_GITHUB_*_TOKEN`）
2. `gh auth token`（フォールバック）

## 設定ファイル

| ファイル | 内容 |
|---------|------|
| `.pecot/config/hosts.json` | ホスト設定（トークン環境変数名、スコープ） |
| `.pecot/config/projects/*.json` | プロジェクト設定（自動生成、手動編集不要） |
