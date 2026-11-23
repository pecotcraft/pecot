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
`@pecot/workflow-mcp@next` は、次の正式版より前の開発版を取ります。
依存は `npm-shrinkwrap.json` で固定されているため、同じ版なら同じ依存が入ります。

ツールが対象にするリポジトリは、サーバを起動したディレクトリを含むリポジトリです。
Claude Code では、Claude Code がサーバを起動するディレクトリ（通常はプロジェクトの root）になります。

プラグインの hooks は働きません。`issue_create`・`pr_create`・`pr_merge` の確認は、MCP クライアント自身の確認だけになります。
これらのツールは自動で許可しないでください。また、`--help` を打つと、プラグインで出る補足の節は出ません。

## ツール

ツール名は `<対象>_<動詞>` の形です。
Issue・コメント・PR のテンプレートは、MCP の resource で読めます。URI は `pecot-template://<種類>/<名前>`（例: `pecot-template://comment/plan`）です。

| ツール | 内容 |
|---|---|
| `project_list` | 使えるプロジェクトを一覧する |
| `project_search` | GitHub API でプロジェクトを検索する（初期化済みか・有効かも出す） |
| `project_init` | 既存のプロジェクトに pecot-workflow のフィールドを足す |
| `project_create` | プロジェクトを新規に作る |
| `project_activate` | 初期化済みのプロジェクトを有効にする |
| `project_link` | プロジェクトの設定にリポジトリを足す・更新する |
| `project_get` | プロジェクトの設定の値を表示する（`key` は今は `aggregation_repo` だけ。Epic の集約先リポジトリ） |
| `project_set` | プロジェクトの設定の値を設定する（`key` は今は `aggregation_repo` だけ） |
| `project_unset` | プロジェクトの設定の値を解除する（`key` は今は `aggregation_repo` だけ） |
| `board_show` | ボードの状態をまとめて表示する |
| `board_add` | プロジェクトボードに Issue を足す（pecot の外で作った Issue 用） |
| `board_move` | Issue 番号でボードのステータスを更新する |
| `board_sync` | ボードの Ready・Blocked・Active・In Review の Issue を、判定に合う列と札へ直す（`project` を取る） |
| `issue_create` | frontmatter 付きの Markdown から Issue を作る（`freeform: true` と `repo`・`message` で、自由形式のメッセージから作る） |
| `issue_check` | `issue_create` に渡すファイルを確かめ、作らずに番号・前提・進め方の表を出す |
| `issue_show` | Issue の詳細を必要な項目だけ取得する |
| `issue_comment` | Issue にコメントを投稿する |
| `issue_block` | Issue に前提（blocked by）を付ける。付いている前提の種類と理由を変えるのにも使う |
| `issue_unblock` | Issue から前提（blocked by）を外す |
| `issue_reopen` | 閉じた Issue を開き直す（ボードのステータスも戻す） |
| `session_start` | Issue の作業を始める（ブランチを作り、ボードを Active にし、作業対象を記録する） |
| `session_show` | セッションのフラグ、ブランチ、推定した Issue を表示する |
| `session_finish` | 作業を終える（マージ後の後処理として、Issue のクローズ、ブランチ削除、ローカルの整理をする） |
| `pr_create` | PR を作る |
| `pr_show` | PR の詳細を必要な項目だけ取得する |
| `pr_check` | PR を作る前に確かめる情報をまとめて表示する |
| `pr_merge` | PR をマージする（スタックの中の PR は最下段だけ） |
| `pr_restack` | 積んだブランチを、base にしたブランチの新しい位置へ載せ直す |
| `review_finish` | 自動レビューを終える（止まったときだけ、止まったことを知らせるコメントを PR に書く） |
| `release_check` | リリース前の確認をする |
| `release_create` | GitHub のリリースとタグを作る（ノートは CHANGELOG から取る） |
| `release_merge` | リリースの PR を通常のマージで取り込む |
| `tracker_sync` | 開いている Tracker の一覧を書き直す（`source` が `dependabot` なら Dependabot PR、`security` ならセキュリティアラート） |
| `worktree_add` | worktree を作る |
| `worktree_remove` | worktree を削除する |
| `worktree_init` | メイン worktree に worktree の設定ファイルを作る |
| `worktree_link` | 既存の worktree にシンボリックリンクを適用・更新する |
| `branch_delete` | リモートブランチを削除する（保護ブランチは消さない） |
| `workflow_install` | 同梱の GitHub Actions のワークフローの雛形をリポに書き出す（`check` で置いた雛形の版を確かめ、`force` で上書きする） |
| `workflow_doctor` | 雛形と、雛形が要る Actions の secret・変数の名前がそろっているかを確かめる（値は読まない） |

## 失敗したとき

- 初回の起動は依存の取得に時間がかかる。Claude Code で起動が 30 秒を超えて失敗したら、環境変数 `MCP_TIMEOUT` を延ばす
- ツールの結果は JSON で返る。失敗すると `isError` が真になり、原因の名前が `kind`、失敗の文が `detail` に入る。子プロセスの出力は `log` に入る
- `EBADDEVENGINES` で止まるときは、登録の `args` に `--prefix=/` が付いているか確認する

## 版

npm の版は pecot-workflow プラグインの版と一致します。
