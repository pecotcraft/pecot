# コマンド一覧

## プロジェクト管理 (`project`)

| サブコマンド | 説明 |
|-------------|------|
| `project info` | プロジェクト情報ダッシュボードを表示 |
| `project list` | 利用可能なプロジェクト一覧を表示 |
| `project search` | GitHub APIでプロジェクトを検索 |
| `project activate` | init済みプロジェクトをアクティベート |
| `project set-repo` | リポジトリをプロジェクト設定に追加/更新 |
| `project init` | 既存プロジェクトにpecot-workflow関連フィールドを追加 |
| `project create` | 新規プロジェクトを作成（既存プロジェクトへのフィールド追加は `project init`） |
| `project set-aggregation-repo` | Epic の既定の作成先リポジトリ（`aggregation_repo`）を設定する |
| `project show-aggregation-repo` | Epic の既定の作成先リポジトリ（`aggregation_repo`）を表示する |
| `project unset-aggregation-repo` | Epic の既定の作成先リポジトリを解除する（解除後の Epic 起票は `--repo` の明示が必須） |

## Issue操作 (`issue`)

| サブコマンド | 説明 |
|-------------|------|
| `issue create` | フロントマター付きMarkdownファイルからIssueを作成 |
| `issue quick` | フリーフォーマットメッセージからIssueを即座に作成 |
| `issue read` | Issue詳細を取得 |
| `issue comment` | Issueにコメントを投稿 |
| `issue reopen` | クローズされたIssueを再オープンし、ボード status を同時設定する |

**`issue quick` の暗黙の動作:**

- type: `--type` で `task` / `bug` / `epic` を指定（既定 `task`）
- status: `task` / `bug` は `active`、`epic` は `backlog`（理由は [issue-flow-rules.md §4](issue-flow-rules.md#起票時の既定-status) 参照）
- priority: `medium`
- size: `s`（`epic` は設定なし）
- ブランチ自動作成: `feat/{YYYYMMDD-HHMMSS}/{issue_number}`（`--no-branch` で省略）

## PR操作 (`pr`)

| サブコマンド | 説明 |
|-------------|------|
| `pr create` | PR（プルリクエスト）を作成 |
| `pr read` | PR詳細を取得 |
| `pr merge` | PRをマージし、関連Issueを自動クローズ |
| `pr preflight` | PR作成前の事前確認情報を一括出力 |

**`pr create` のワークフロー補足:**

- `--template release`: リリースPR用。`release_branch`へのPR作成を許可、Issue参照チェックをスキップ
- `--no-issue-ref`: Issue起点でないPR用。Issue番号の自動抽出・追加をスキップ

## その他

| コマンド | 説明 |
|---------|------|
| `create-branch` | Issueに紐づいたブランチを作成（Development自動リンク） |
| `delete-branch` | リモートブランチを削除（保護ブランチチェック付き） |
| `add-to-project` | Issueをプロジェクトボードに追加（pecot 外で作った Issue 用） |
| `update-issue-status` | プロジェクトボードのステータスを更新（通常フローでは CLI が自動設定） |
| `session status` | セッションのフラグ状態・ブランチ情報・Issue推定結果を表示 |
| `session restore` | 消失したセッションフラグ（`.pecot-active` 等）をブランチ情報から復元 |
| `worktree init` | ワークツリー設定ファイルをメインWTに作成 |
| `worktree add` | 新しいワークツリーを作成 |
| `worktree link` | 既存ワークツリーにシンボリックリンクを適用/更新 |
| `worktree remove` | ワークツリーを削除 |
| `release preflight` | リリース前チェック（open の Dependabot alert・CHANGELOG・バージョン・タグ不存在の確認。nx のリポは alert のみ） |
| `release create` | GitHubリリースとタグを作成（リリースノートは CHANGELOG から取得） |
| `release merge` | リリースPRをregular mergeでマージ |
