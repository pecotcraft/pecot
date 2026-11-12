# @pecot/workflow-mcp

pecot-workflow プラグインの MCP サーバを、npm のパッケージとして単体で配布したものです。プラグインを導入していない環境でも、
MCP クライアントに 1 エントリ登録するだけで、Issue・PR・ボード・リリース・worktree の 34 個のツールが使えます。

## 前提

- Node.js 24 系は 24.22.1 以上、26 系は 26.12.1 以上。下限に満たない Node でも npm は警告だけで起動しますが、脆弱性の修正を含まない版では使わないでください
- `git` と `gh` が PATH にあり、`gh auth status` が通ること。ツールは両方をそのまま起動する
- Windows ネイティブ環境は対象外です（Linux / macOS / WSL2 で使用してください）

## 登録

使用する MCP クライアントの設定に次の 1 エントリを追加します。

```json
{
  "mcpServers": {
    "pecot-workflow": {
      "command": "npx",
      "args": ["-y", "--prefix=/", "--package=@pecot/workflow-mcp", "pecot-workflow-mcp"]
    }
  }
}
```

`--prefix=/` は、pnpm の `devEngines` を宣言したリポジトリの中で起動しても止まらないようにするための指定です。
`--prefix` を付けないと、そのリポジトリを cwd にした npx が `EBADDEVENGINES` で止まります。

Windows の MCP クライアントから使う場合は WSL2 経由で起動します。

```json
{
  "mcpServers": {
    "pecot-workflow": {
      "command": "wsl",
      "args": ["npx", "-y", "--prefix=/", "--package=@pecot/workflow-mcp", "pecot-workflow-mcp"]
    }
  }
}
```

WSL 内の npx が非ログインシェルの PATH に無い場合は、`args` を次に差し替えます。

```json
["-e", "bash", "-lc", "npx -y --prefix=/ --package=@pecot/workflow-mcp pecot-workflow-mcp"]
```

版を固定するときは、`--package=@pecot/workflow-mcp@1.2.3` のように版を付けます。
依存は `npm-shrinkwrap.json` で固定されているため、同じ版なら同じ依存が入ります。

初回の起動は依存の取得に時間がかかります。Claude Code で起動が 30 秒を超えて失敗したら、環境変数 `MCP_TIMEOUT` を延ばしてください。

## 対象のリポジトリ

ツールが対象にするリポジトリは、クライアントによって決まります。

- Claude Code: プロジェクトの root（`CLAUDE_PROJECT_DIR`）
- ほかのクライアント: サーバを起動したディレクトリを含むリポジトリ

## 注意

- プラグインの hooks は働かない。`issue_create`・`issue_quick`・`pr_create` の確認は、MCP クライアント自身の確認だけになる。これらのツールは自動で許可しない
- `--help` を打つと、プラグインで出る補足の節は出ません

## 結果の読み方

ツールが失敗すると、結果の末尾に `exit code: <n>` の行が付きます。標準出力が空のときは、結果は標準エラーだけになります。

## ツール

| ツール | 内容 |
|---|---|
| `add_to_project` | プロジェクトボードに Issue を足す（pecot の外で作った Issue 用） |
| `update_issue_status` | Issue 番号でボードのステータスを更新する |
| `create_branch` | Issue に紐づくブランチを作る |
| `delete_branch` | リモートブランチを削除する（保護ブランチは消さない） |
| `project_list` | 使えるプロジェクトを一覧する |
| `project_search` | GitHub API でプロジェクトを検索する |
| `project_init` | 既存のプロジェクトに pecot-workflow のフィールドを足す |
| `project_create` | プロジェクトを新規に作る |
| `project_info` | プロジェクトの情報をまとめて表示する |
| `project_activate` | 初期化済みのプロジェクトを有効にする |
| `project_set_repo` | プロジェクトの設定にリポジトリを足す・更新する |
| `project_set_aggregation_repo` | Epic の集約先リポジトリを設定する |
| `project_unset_aggregation_repo` | Epic の集約先リポジトリを解除する |
| `project_show_aggregation_repo` | Epic の集約先リポジトリを表示する |
| `issue_create` | frontmatter 付きの Markdown から Issue を作る |
| `issue_quick` | 自由形式のメッセージから Issue をすぐ作る |
| `issue_read` | Issue の詳細を必要な項目だけ取得する |
| `issue_comment` | Issue にコメントを投稿する |
| `issue_reopen` | 閉じた Issue を開き直す（ボードのステータスも戻す） |
| `pr_cleanup` | マージ後の後処理をする（Issue のクローズ、ブランチ削除、ローカルの整理） |
| `pr_create` | PR を作る |
| `pr_preflight` | PR を作る前に確かめる情報をまとめて表示する |
| `pr_read` | PR の詳細を必要な項目だけ取得する |
| `session_status` | セッションのフラグ、ブランチ、推定した Issue を表示する |
| `session_restore` | 失われたセッションのフラグをブランチから復元する |
| `release_preflight` | リリース前の確認をする |
| `release_create` | GitHub のリリースとタグを作る（ノートは CHANGELOG から取る） |
| `release_merge` | リリースの PR を通常のマージで取り込む |
| `security_sync` | 開いている Tracker のセキュリティアラートの一覧を書き直す |
| `dependabot_sync` | 開いている Tracker の Dependabot PR の一覧を書き直す |
| `worktree_add` | worktree を作る |
| `worktree_remove` | worktree を削除する |
| `worktree_init` | メイン worktree に worktree の設定ファイルを作る |
| `worktree_link` | 既存の worktree にシンボリックリンクを適用・更新する |

## 版

npm の版は pecot-workflow プラグインの版と一致します。
