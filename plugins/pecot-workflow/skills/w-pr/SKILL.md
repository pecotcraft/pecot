---
name: w-pr
description: |
  PRを作成しタイトル・説明を自動生成します。
  Use when the user wants to create a pull request for the current branch — auto-generates title/description from commits and diff. Triggers: "create PR", "submit for review".
  Does not merge PRs (use w-merge).
allowed-tools: mcp__plugin_pecot-w_pecot-workflow__pr_check, mcp__plugin_pecot-w_pecot-workflow__pr_create, Bash(git push:*), Bash(git checkout:*), Bash(git branch:*), Bash(git worktree list:*), Bash(git fetch:*), Bash(git pull:*), Bash(mkdir:*), Bash(touch:*), Bash(gh api markdown:*), Bash(gh pr view:*), Bash(gh pr edit:*)
when_to_use: "PR を作りたい、レビューに出したい、プルリクエストの説明文を作ってほしい"
---

# プルリクエスト作成

現在のブランチの変更内容を分析し、変更内容に合ったタイトルと説明でプルリクエストを作成します。

## 手順

### Step 1: 事前確認スクリプトを実行

`pr_check` を `directory: "."` で呼ぶ。

結果に `exit code: 1` か `exit code: 2` の行が出たら、結果を見て解決し、呼び直してから次へ進む。

### Step 2: 変更内容の確認とコミット

1. コミットが必要な場合は自動的にコミットする
   - ステージング済みだがコミットされていない場合、プロジェクトのコミット規約に沿ってコミット（既存履歴 `git log` を参照）
   - コミットメッセージは git diff から生成
   - **不要な確認はしない**（即座にコミット実行）

2. 変更内容を確認する
   - 扱いに困る変更（意図不明、関係なさそう等）があればユーザーに確認
   - 明確な問題がない場合は確認不要

### Step 3: PR作成

1. テンプレートを準備する。`pr_create` を `prepare: true` で呼ぶ
2. 出力されたファイルを編集する
   - 冒頭の <!-- 読者: / 書き方: / フィールド: --> ガイドコメントに従って YAML フロントマターと本文を記述する
3. 投稿する。`pr_create` を `file: "<ファイルパス>"` で呼ぶ

feature PR の `base` は `prepare: true` の呼び出しが config 由来で自動設定する。2ブランチモードのリポは
開発ブランチ（`develop-aist` 等）、単一ブランチモード（`develop` == `release` / trunk-based）の
リポは `main`。自動設定された `base` を書き換えない。

`pr_create` の結果に `exit code: 3` の行が出て止まったら、出た指摘を直して呼び直す。

#### スクリーンショット

次のどれかが変わる変更は、結果のスクリーンショットを撮って Summary に置く。

- 画面
- ツールが生成して利用者が GitHub で見る Markdown（Issue・PR の本文、コメント、Tracker の表）
- 利用者が読む CLI の出力の文

CHANGELOG・README・SKILL.md の文の変更は含めない。
撮らないときは、フロントマターの `screenshot` に理由を書く（`message` の形では入力 `screenshot`）。
Summary に画像があれば `screenshot` は空のままにする。画像と理由のどちらも無い本文は、`pr_create` が止める。

撮り方は次のとおり。

1. Markdown は `gh api markdown -f mode=gfm -f context=<owner>/<repo> -F text=@<md>` で HTML にする。
   `<article class="markdown-body">` で包み、github-markdown-css を CDN（cdnjs や jsdelivr の版固定 URL）から読ませる
2. CLI の出力は、打ったコマンドと出力を ```` ```console ```` のフェンスに入れ、同じ手順で描画する
3. 下の配信のスクリプトで、`.pecot/work/<Issue番号>` を起点に静的配信を立てる。`cd` と組み合わせない。
   Playwright MCP は初期設定で `file://` を開けないので、http で配信する。
   background で立てる（Claude Code は Bash の background 実行、GitHub Copilot CLI は非同期の実行）。撮り終えたら止める
4. スクリプトが `Serving http://127.0.0.1:<port>/` と出してから、次の URL を Playwright MCP で開く。
   `http://127.0.0.1:<port>/<file>.html`
   `配信を立てられません:` と出て終了したら、port や起点を直して立て直す。
   Playwright MCP の screenshot のツールで撮る。ツール名は Claude Code と GitHub Copilot CLI で違う
5. screenshot のツールの `filename` に相対名を渡すと、workspace root（セッションの作業ディレクトリ）を起点に解かれる。
   `.playwright-mcp/<名前>.png` と書く。名前だけを渡すと、作業ディレクトリの直下に保存される。`git add` に混ぜない

手順 3. で使う配信のスクリプトは、次のとおり。

```bash
node --input-type=commonjs - .pecot/work/<Issue番号> <port> <<'EOF'
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const fail = (message) => { console.error(`配信を立てられません: ${message}`); process.exit(1) }
const root = path.resolve(process.argv[2])
const port = Number(process.argv[3])
if (!Number.isInteger(port)) fail(`port が整数ではありません（${process.argv[3]}）`)
if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) fail(`起点がディレクトリではありません（${root}）`)
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' }
http.createServer((req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    if (pathname.includes('\0')) return res.writeHead(400).end()
    const file = path.resolve(root, '.' + pathname)
    if (file !== root && !file.startsWith(root + path.sep)) return res.writeHead(403).end()
    fs.readFile(file, (error, body) => {
      if (error) return res.writeHead(404).end()
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' }).end(body)
    })
  } catch {
    res.writeHead(400).end()
  }
}).on('error', (error) => fail(error.message))
  .listen(port, '127.0.0.1', () => console.log(`Serving http://127.0.0.1:${port}/`))
EOF
```

画像は、本文から `![説明](./画像のファイル名)` で参照し、PR を作った後に gh で載せる。
gh v2.99.0 以上が要る。GHES のリポでは `--attach` が使えない。`screenshot` に理由を書くか、Web の画面で画像を貼る。

```bash
gh pr view <PR番号> --json body -q .body > .playwright-mcp/body.md
gh pr edit <PR番号> --body-file .playwright-mcp/body.md --attach .playwright-mcp/<名前>.png
```

`--attach` は画像ごとに繰り返す。パスには、screenshot のツールの結果に出たパスを使う。本文の画像のパスは、アップロード後の URL に書き換わる。
body.md は画像と同じ `.playwright-mcp/` に置く。gh は本文の `./<名前>.png` を body.md のディレクトリを起点に解く。
置き場所が違うと参照が書き換わらず、画像は本文の末尾に足される。

### Closing Issue キーワードと Epic

- `pr_create`（`prepare: true`）の実行時、テンプレの `Closes #` には active タスク番号が自動で埋め込まれる
- 自動埋め込みの番号を書き換えない。特に Epic 番号 (sub-issue を持つ親 Issue) を書かない
- ブランチ名末尾の `<num>` も sub-issue 番号にする
- `session_finish` は Issue Type=Epic / `sub-issues > 0` の Issue を自動でクローズ対象から除外する（保険）
- 既知制約: Issue Type 未設定かつ sub-issue 0 件の Epic は判定不能

PR作成後、レビュー対応は `/pecot-w:w-revise`、マージは `/pecot-w:w-merge` を使用する。
