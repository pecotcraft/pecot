# packages monorepo のリリース

1 リポ内に複数 package があり、package ごとに CHANGELOG とバージョンを持つ構成を扱う。
設定は pecot-workflow の MCP ツール `project_link` の `package: ["NAME:PATH", ...]` で行う。タグ形式は `<package>-v<ver>`。

## バージョン決定基準

- **patch** (`X.Y.Z → X.Y.Z+1`): 該当 package のバグ修正のみ
- **minor** (`X.Y.Z → X.Y+1.0`): 後方互換の機能追加
- **major** (`X.Y.Z → X+1.0.0`): 破壊的変更

## 手順

### 1. 対象確認

pecot-workflow の MCP ツール `project_get` を `key` を省いて呼び、`repositories` から対象リポの要素を読む。

対象リポの package の一覧から、対象の package 名を選ぶ。1 PR = 1 package（複数同時リリース不可）。
リリース package を `<package>`、バージョンを `<ver>` と表記。

### 2. bump 種別のユーザー確認

`<ver>` を確定する前に、ユーザーへ以下を提示して明示的承認を得る。
承認を得るまで、Step 3 以降（CHANGELOG 編集・docs PR・リリースの確認と作成）には進まない。

提示項目:

- 対象 package: `<package>`
- 現バージョン（直近タグ `<package>-v<前バージョン>`）→ 新バージョン `<ver>`
- 想定 bump 種別（`patch` / `minor` / `major`）
- 判断根拠: 上記「バージョン決定基準」のどれに該当するか。
  当該 package の主要変更を要約する。
  変更は `git log <package>-v<前バージョン>..origin/<develop> --oneline` で拾う

確認観点:

- 「未使用機能の削除」「内部のみの変更」「ドキュメント追加のみ」など、外部影響が無い変更を `major` として扱っていないか
- 後方互換のある追加が `major` になっていないか
- バグ修正のみのはずが `minor` 以上になっていないか

参考事例（#205）は次のとおり。

- 機能削除を `major` で扱ったまま流し、`1.0.0 → 2.0.0` に過剰 bump した例がある。
  「削除」だからといって自動的に破壊的変更ではない（未使用・内部限定なら patch が妥当）

違和感があれば `<ver>` を選び直して本ステップをやり直す。
ユーザーから「OK」「進めて」等の明示承認を得て初めて Step 3 へ進む。

### 3. CHANGELOG 準備

#### 3-1. docs ブランチ作成

```bash
git fetch origin
git checkout -b docs/changelog-<package>-v<ver> origin/<develop>
```

#### 3-2. 対象 CHANGELOG 編集

Step 1 で選んだ要素の `packages` のうち、`name` が `<package>` の要素の `changelog` のファイルを編集する。
前回タグ `<package>-v<前バージョン>` からの差分をまとめる。

```bash
git log <package>-v<前バージョン>..origin/<develop> --oneline
```

該当 CHANGELOG の `[Unreleased]` の下に以下を追加:

```markdown
## [<ver>] - YYYY-MM-DD

### 追加
- ...

### 変更
- ...

### 修正
- ...
```

ファイル末尾の `[Unreleased]` / `[<ver>]` リンク定義も更新。

#### 3-3. リポ固有の version file 更新

package に対応する `plugin.json` / `pyproject.toml` 等があれば同期更新
（リポ側 pre-commit フックが強制）。

#### 3-4. docs PR 作成・merge

```bash
git add <編集したファイル>
git commit -m "docs(changelog): <package> <ver> リリースノートを追加"
git push -u origin docs/changelog-<package>-v<ver>
```

push したら、pecot-workflow の MCP ツール `pr_check` を、次の入力で使う。

```text
pr_check
  method: "create"
  owner: "<owner>"
  repo: "<repo>"
  title: "docs(changelog): <package> <ver> リリースノートを追加"
  head: "docs/changelog-<package>-v<ver>"
  base: "<develop>"
  template: "pecot-template://pr/create"
  screenshot: "CHANGELOG の追記だけで、画面・生成する Markdown・CLI の出力は変わらない"
  body: |
    ## Summary

    <package> の CHANGELOG.md に <ver> のリリースノートを追加した。

    ## Changes

    なし

    ## Verified

    - <package> の CHANGELOG.md に <ver> の節があることを確かめた

    ## Risks

    なし
```

`problems` が空なら、`template` と `screenshot` を除いた同じ値で、公式の MCP の `create_pull_request` で PR を作る。

作れたら、[PR をマージする](../../w-help/references/github-write.md#pr-をマージする) の手順で、`merge_method: "squash"` でマージする。
`merge_pull_request` が断られたら、利用者に GitHub の画面でのマージを頼み、マージされるのを `pull_request_read`（`get`）で待つ。

マージしたら、手元を片付ける。リモートのブランチは、リポの「head ブランチを自動で消す」の設定が消す。

```bash
git checkout <develop>
git branch -D docs/changelog-<package>-v<ver>
```

#### 3-5. develop 最新化

`release_check` は、セッションを始めたディレクトリを読む。`<develop>` が checkout されている worktree で始めたセッションで実行する。違うときは、そこで止めて、その worktree でセッションを始め直すよう利用者に伝える。

次の `git pull` は、その worktree で打つ。

```bash
git pull --ff-only origin <develop>
```

### 4. プリフライト

ここではリリースの値を渡さず、alert だけを確かめる。

1. open の alert を、公式の MCP の 3 つのツールで全ページ読む。読めなかったときは、誤りの文を控える
   - ツールは `list_dependabot_alerts`・`list_code_scanning_alerts`・`list_secret_scanning_alerts` を使う
2. `release_check` の `reads` に、読んだ一覧（`pages`）か誤りの文（`error`）を渡す。`params` は渡さない

Dependabot の open の alert と、その一覧の取得の失敗は、警告を出すだけで止めない。
止めるのは、code scanning・secret scanning の open の alert があるときと、その一覧を取得できないときの 2 つ。
alert は、解消（fixed）か理由付きの dismiss で 0 件にしてから再実行する。取得できないときは、トークンと権限を直して再実行する。
`problems` に `params` の `required` だけが残るのは、値を渡していないためなので、この Step では止めない。

### 5. リリース PR 作成

単一ブランチモード（`<develop>` と `<release>` が同じ）では、リリース PR を作らない。Step 5・6 を飛ばし、Step 7 へ進む。

pecot-workflow の MCP サーバの resource `pecot-template://pr/release` を読み、`.pecot/tmp/output/` に写す。

写したファイルを編集:

- frontmatter の `owner`・`repo`
- `head: <develop>`・`base: <release>`
- `title: "release: <package> v<ver>"`
- 本文: release 雛形の 4 節（Summary / Changes / Migration / Verified）を
  すべて埋める（1 つでも欠けると `pr_check` が止める）。Changes には該当 CHANGELOG の
  `## [<ver>]` セクションを転記

編集したら、`pr_check` に `method: "create"` で、frontmatter の値と本文（`body`）を渡す。`problems` が空なら、`template` を除いた同じ値で `create_pull_request` を使う。

### 6. リリース PR マージ

[PR をマージする](../../w-help/references/github-write.md#pr-をマージする) の手順で、Step 5 で作った PR を `merge_method: "merge"` でマージする。
merge queue のリポなどで `merge_pull_request` が断られたら、利用者に GitHub の画面でマージしてもらう。
マージされるまで、`pull_request_read`（`get`）で読んで待つ。

マージしたら、`list_branches` で `<develop>` が残っているかを確かめる。PR の head が `<develop>` 自体だからだ。
リポの「head ブランチを自動で消す」が有効で、`<develop>` をブランチの保護か ruleset で守っていないと、GitHub が消す。
消えていたら、`create_branch`（`branch: "<develop>"`・`from_branch: "<release>"`）で作り直し、`<develop>` を保護するよう利用者に伝える。

### 7. タグ + GitHub Release

1. マージした後の `<release>` の先頭のコミットを、`list_commits`（`sha: "<release>"`）で読む。手元にも `git fetch origin <release>` で取り込む
2. 同じタグのリリースを `get_release_by_tag`（`tag: "<package>-v<ver>"`）で読む。無いときの 404 の誤りの文も、そのまま渡す
3. `release_check` に `params` と `reads` を渡す。`reads` には、Step 4 の alert の一覧と、読んだリリースを入れる
   - `params` は次の形にする

     ```text
     {"tag": "<package>-v<ver>", "sha": "<sha>", "body": "<節の本文>", "name": "<package> v<ver>"}
     ```

   - `body` は package の CHANGELOG の `## [<ver>]` の節の本文にする。違うときは、`problems` の `candidates` の本文に直す。候補の本文は、節が使わないリンクと脚注の定義を除き、節の外にある使う定義を加えたものになる
4. `problems` が空なら、同じ `params` で github-ops の `release-create` を起動する。手順は [github-ops で書く](../../w-help/references/github-ops.md)

### 8. 完了報告

次の 3 つを報告して終了。

- タグ名 `<package>-v<ver>`
- GitHub Release URL
- リリース PR URL（Step 5 で作った PR）
