# @pecot/workflow-mcp

pecot-workflow プラグインの MCP サーバを、npm のパッケージとして単体で配布したものです。プラグインを導入していない環境でも、
MCP クライアントに 1 エントリ登録するだけで、Issue・PR・ボード・リリース・worktree のツールが使えます。

## 前提

- Node.js 24 系は 24.22.1 以上、26 系は 26.12.1 以上。下限に満たない Node でも npm は警告だけで起動しますが、脆弱性の修正を含まない版では使わないでください
- `git` が PATH にあること。ツールは `git` をそのまま起動する
- GitHub の公式の MCP サーバが、書き込みのできる形でつながっていること
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

プラグインの hooks は働きません。公式の MCP の書き込みのツール（`merge_pull_request` など）の確認は、MCP クライアント自身の確認だけになります。
これらのツールは自動で許可しないでください。また、`--help` を打つと、プラグインで出る補足の節は出ません。

## ツール

ツール名は `<対象>_<動詞>` の形です。

GitHub には読み書きしません。読み書きは、GitHub の公式の MCP サーバ（[github-mcp-server](https://github.com/github/github-mcp-server)）のツールで行います。
書く前に、`*_check` のツールに通します。公式の MCP サーバは、features の `issue_dependencies` を有効にしてつなぎます。
公式の MCP に書く手が無い操作（ブランチの作成・ボードの欄の作成・リリースの作成など）は、`workflow_install` で置く `pecot-github-ops.yml` が行います。
Issue・コメント・PR のテンプレートは、MCP の resource で読めます。URI は `pecot-template://<種類>/<名前>`（例: `pecot-template://comment/plan`）です。

| ツール | 内容 |
|---|---|
| `project_list` | 使えるプロジェクトを一覧する |
| `project_check` | 公式の MCP の `create_project` と、github-ops の `project-fields` に渡す値を確かめる。ボードに足りない欄と選択肢を返す。書かない |
| `project_activate` | 公式の MCP で読んだボードから設定ファイルを作り、有効にする |
| `project_link` | プロジェクトの設定にリポジトリを足す・更新する。GitHub の上のつなぎは github-ops の `project-link` が行う |
| `project_get` | プロジェクトの設定の値を表示する（`key` は今は `aggregation_repo` だけ）。`key` を省くと、プロジェクトと登録したリポジトリの要約を出す |
| `project_set` | プロジェクトの設定の値を設定する（`key` は今は `aggregation_repo` だけ） |
| `project_unset` | プロジェクトの設定の値を解除する（`key` は今は `aggregation_repo` だけ） |
| `board_show` | 公式の MCP で読んだボードから、着手できる Issue と列の状態をまとめる |
| `board_check` | 公式の MCP の `update_project_item` で動かす列が、前提と決まりに合うかを確かめる。書かない |
| `issue_check` | 公式の MCP の `issue_write` に渡す値が、pecot の決まり（テンプレート・題の番号・前提・ボードの欄）に合うかを確かめる。書かない |
| `issue_dependency_check` | 公式の MCP の `issue_dependency_write` に渡す値を確かめ、本文の `## Waits for merge` の節と置く列を返す。書かない |
| `issue_comment_check` | 公式の MCP の `add_issue_comment`・`update_issue_comment` に渡す本文を確かめる。書かない |
| `branch_check` | github-ops の `link-branch` に渡すブランチ名と base を確かめる。書かない |
| `session_start` | github-ops の `link-branch` で作ったブランチで、作業の始まり（base・作業ディレクトリ・セッション名）を記録する |
| `session_show` | セッションのフラグ、ブランチ、推定した Issue を表示する |
| `session_finish` | マージした PR の手元を片付ける（開発ブランチへの切り替え、手元のブランチと記録の削除） |
| `pr_check` | 公式の MCP の `create_pull_request`・`update_pull_request`・`merge_pull_request` に渡す値を確かめる。書かない |
| `pr_restack` | スタックしたブランチを、base にしたブランチの新しい位置へスタックし直す |
| `release_check` | github-ops の `release-create` に渡す値と、open の alert を確かめる。書かない |
| `worktree_add` | worktree を作る |
| `worktree_remove` | worktree を削除する |
| `worktree_init` | メイン worktree に worktree の設定ファイルを作る |
| `worktree_link` | 既存の worktree にシンボリックリンクを適用・更新する |
| `workflow_install` | 同梱の GitHub Actions のワークフローの雛形をリポに書き出す（`check` で置いた雛形の版を確かめ、`force` で上書きする） |
| `workflow_doctor` | 雛形と、雛形が要る Actions の secret・変数の名前がそろっているかを確かめる（値は読まない） |

## 失敗したとき

- 初回の起動は依存の取得に時間がかかる。Claude Code で起動が 30 秒を超えて失敗したら、環境変数 `MCP_TIMEOUT` を延ばす
- ツールの結果は JSON で返る。失敗すると `isError` が真になり、原因の名前が `kind`、失敗の文が `detail` に入る。子プロセスの出力は `log` に入る
- `EBADDEVENGINES` で止まるときは、登録の `args` に `--prefix=/` が付いているか確認する

## 版

npm の版は pecot-workflow プラグインの版と一致します。
