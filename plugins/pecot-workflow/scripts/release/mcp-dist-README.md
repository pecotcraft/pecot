# @pecot/workflow-mcp

pecot-workflow プラグインの MCP サーバを、npm のパッケージとして単体で配布したものです。プラグインを導入していない環境でも、
MCP クライアントに 1 エントリ登録するだけで、Issue・PR・ボード・リリース・worktree のツールが使えます。

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
      "args": ["-y", "--prefix=/", "@pecot/workflow-mcp"]
    }
  }
}
```

`--prefix=/` は、pnpm の `devEngines` を宣言したリポジトリの中で起動しても止まらないようにするための指定です。
`--prefix` を付けないと、そのリポジトリを cwd にした npx が `EBADDEVENGINES` で止まります。
npm には devEngines の判定だけを外す公式の手段が無く、要望（npm/rfcs#830）は not_planned で閉じています。

パッケージは `--package=` ではなく、位置引数で渡してください。
`--package=` で渡すと、npm が `npm_config_package` をサーバの子プロセスに残します。
すると、`worktree_add` の `setup_command` などが打つ npx が、これを読んで別のパッケージを実行します。

`--prefix=/` には次の副作用があります。

- 利用者のリポジトリの `.npmrc` を読まず、globalconfig も `/etc/npmrc` になる。registry・proxy・cafile は `~/.npmrc` に置く
- `npm_config_prefix=/` などの環境変数がサーバに引き継がれる。`worktree_add` の `setup_command` で `npm i -g` を打つと `/lib/node_modules` を向く

この副作用を避けたいときは、先に `npm i -g @pecot/workflow-mcp` で入れて、コマンドを直接登録します。

```json
{
  "mcpServers": {
    "pecot-workflow": {
      "command": "pecot-workflow-mcp"
    }
  }
}
```

Windows の MCP クライアントから使う場合は WSL2 経由で起動します。

```json
{
  "mcpServers": {
    "pecot-workflow": {
      "command": "wsl",
      "args": ["npx", "-y", "--prefix=/", "@pecot/workflow-mcp"]
    }
  }
}
```

WSL 内の npx が非ログインシェルの PATH に無い場合は、`args` を次に差し替えます。

```json
["-e", "bash", "-lc", "npx -y --prefix=/ @pecot/workflow-mcp"]
```

版を固定するときは、`@pecot/workflow-mcp@1.2.3` のように版を付けます。
依存は `npm-shrinkwrap.json` で固定されているため、同じ版なら同じ依存が入ります。

ツールが対象にするリポジトリは、サーバを起動したディレクトリを含むリポジトリです。
Claude Code では、Claude Code がサーバを起動するディレクトリ（通常はプロジェクトの root）になります。

プラグインの hooks は働きません。`issue_create`・`issue_quick`・`pr_create` の確認は、MCP クライアント自身の確認だけになります。
これらのツールは自動で許可しないでください。また、`--help` を打つと、プラグインで出る補足の節は出ません。

## ツール

ツール名は `<対象>_<動詞>` の形です。

| ツール | 内容 |
|---|---|
| `project_list` | 使えるプロジェクトを一覧する |
| `project_search` | GitHub API でプロジェクトを検索する |
| `project_init` | 既存のプロジェクトに pecot-workflow のフィールドを足す |
| `project_create` | プロジェクトを新規に作る |
| `project_info` | プロジェクトの情報をまとめて表示する |
| `project_activate` | 初期化済みのプロジェクトを有効にする |
| `repo_set` | プロジェクトの設定にリポジトリを足す・更新する |
| `aggregation_set` | Epic の集約先リポジトリを設定する |
| `aggregation_unset` | Epic の集約先リポジトリを解除する |
| `aggregation_show` | Epic の集約先リポジトリを表示する |
| `issue_create` | frontmatter 付きの Markdown から Issue を作る |
| `issue_quick` | 自由形式のメッセージから Issue をすぐ作る |
| `issue_read` | Issue の詳細を必要な項目だけ取得する |
| `issue_comment` | Issue にコメントを投稿する |
| `issue_block` | Issue に前提（blocked by）を付ける。付いている前提の種類と理由を変えるのにも使う |
| `issue_unblock` | Issue から前提（blocked by）を外す |
| `issue_reopen` | 閉じた Issue を開き直す（ボードのステータスも戻す） |
| `board_add` | プロジェクトボードに Issue を足す（pecot の外で作った Issue 用） |
| `board_move` | Issue 番号でボードのステータスを更新する |
| `board_sync` | ボードの Ready・Blocked・Active・In Review の Issue を、判定に合う列と札へ直す（`dry_run`・`project` を取る） |
| `branch_create` | Issue に紐づくブランチを作る |
| `branch_delete` | リモートブランチを削除する（保護ブランチは消さない） |
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

## 古いツール名からの移行

次の 8 個は、名前が変わりました。古い名前は登録していないので、呼ぶと `Tool <名前> not found` で失敗します。

- `add_to_project` → `board_add`
- `update_issue_status` → `board_move`
- `create_branch` → `branch_create`
- `delete_branch` → `branch_delete`
- `project_set_repo` → `repo_set`
- `project_set_aggregation_repo` → `aggregation_set`
- `project_unset_aggregation_repo` → `aggregation_unset`
- `project_show_aggregation_repo` → `aggregation_show`

許可の設定に古い名前を書いているときは、`mcp__pecot-workflow__<ツール名>` の `<ツール名>` を新しい名前に書き換えてください。
書き換えるまでは、確認のダイアログが出るだけで、失敗はしません。
入力の `delete_branch`（`pr_cleanup`・`release_merge`）は変わりません。

## 失敗したとき

- 初回の起動は依存の取得に時間がかかる。Claude Code で起動が 30 秒を超えて失敗したら、環境変数 `MCP_TIMEOUT` を延ばす
- ツールが失敗すると、結果の末尾に `exit code: <n>` の行が付く。標準出力が空のときは、結果は標準エラーだけになる
- `EBADDEVENGINES` で止まるときは、登録の `args` に `--prefix=/` が付いているか確認する

## 版

npm の版は pecot-workflow プラグインの版と一致します。
