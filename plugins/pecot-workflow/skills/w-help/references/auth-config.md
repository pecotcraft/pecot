# 認証・設定ファイル

## 認証設定

`.pecot/config/.env`に設定（`cat`で内容確認）。

`.pecot/config/` の無い clone では `.env` を作らない。`gh auth login` でログインするか、pecot を起こす前（MCP ではセッションを起こす前）に環境変数を設定する。

**必須スコープ**: `repo`, `read:org`, `project`

**トークン取得優先順位:**

1. 環境変数（`PECOT_GITHUB_*_TOKEN`）
2. `gh auth token`（フォールバック）

## エージェント用の認証

GitHub Actions の上で動く自動処理（自動レビューなど）が、同じ名前で読む変数と secret。
Settings > Secrets and variables > Actions に、リポか organization の単位で置く。

| 名前 | 種類 | 中身 |
|---|---|---|
| `PECOT_AGENT_APP_CLIENT_ID` | 変数 | 任意。権限を絞りたいときに作る GitHub App の Client ID |
| `PECOT_AGENT_APP_PRIVATE_KEY` | secret | 任意。その App の秘密鍵。Client ID を置いたときは要る |
| `CLAUDE_CODE_OAUTH_TOKEN` | secret | モデルの利用の認証。既定。`claude setup-token` で作る |
| `PECOT_AGENT_ANTHROPIC_FEDERATION_RULE_ID`・`_ORGANIZATION_ID`・`_SERVICE_ACCOUNT_ID`・`_WORKSPACE_ID` | 変数 | Workload Identity Federation。`CLAUDE_CODE_OAUTH_TOKEN` が無いときに使う。4 つすべてが要る |

- 自前の App を置かなければ、自動レビューの GitHub のトークンは Claude の GitHub App が出す。App をリポに入れるだけで、名前は何も登録しない
- 引き継ぎのワークフローは、自前の App を置かなければ、実行の `GITHUB_TOKEN` を使う。Claude の GitHub App は要らない
- 自前の App を置くときは、App にインストールで与える権限を、使う自動処理が要る権限の合計にする。ワークフローは、トークンを発行するときに、自分に要る権限だけに絞る
- そろっているかは MCP ツール `workflow_doctor` で確かめる。一覧を読むには、手元のトークンに次の権限が要る。足りないときは、その項目を `skipped` で出す
  - classic のトークン: `repo` の scope
  - fine-grained のトークン: Secrets と Variables の read
  - どちらも、リポの collaborator であること
- App にインストールで与えた権限は、手元のトークンでは読めない。GitHub の App の設定画面の Permissions で確かめる

## 設定ファイル

| ファイル | 内容 |
|---------|------|
| `.pecot/config/hosts.json` | ホスト設定（トークン環境変数名、スコープ） |
| `.pecot/config/projects/*.json` | プロジェクト設定（自動生成、手動編集不要） |
