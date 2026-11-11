# Contract: ワークフローの雛形

`plugins/pecot-workflow/cli/templates/workflow/pecot-auto.yml` に置く雛形の契約だ。
`pecot auto install` が、導入先のリポの `.github/workflows/pecot-auto.yml` に書き出す。

## 契機

| 契機 | 条件 |
|---|---|
| `issues` の `labeled` | 付いたラベルの名前が、起動ラベルと同じ |
| `workflow_run` の `completed` | 利用者の CI のワークフロー。自動処理が作った PR かは、`gate` が結果のコメントの目印で見分ける |

ほかの契機は持たない。コメント・本文の編集・起票では起動しない（FR-022）。

## 先頭に置く値

利用者が変える値は、ファイルの先頭の `env` にまとめる。

| 名前 | 既定値 |
|---|---|
| `PECOT_AUTO_LABEL` | `pecot-auto` |
| `PECOT_AUTO_MAX_TURNS` | `80` |
| `PECOT_AUTO_MAX_CI_ATTEMPTS` | `3` |
| `PECOT_AUTO_PROJECT_CONFIG` | 書き出しのときの、有効な設定の名前 |

時間の上限は、job の `timeout-minutes` に直接書く。式を受け付けないためだ。

## job

### `gate`

| 項目 | 決め |
|---|---|
| 動く条件 | 変数 `PECOT_AUTO_APP_CLIENT_ID` が空でない。空の間は、何もせずに飛ばす |
| 時間の上限 | 5 分 |
| `permissions` | `contents: read` だけ |
| step | checkout、uv、トークンの発行、設定の復元、`pecot auto gate` |
| 出力 | `proceed`・`kind`・`issue`・`number`・`branch` |

### `run`

| 項目 | 決め |
|---|---|
| 動く条件 | `gate` の `proceed` が真 |
| 時間の上限 | 30 分 |
| 同時実行 | `group: pecot-auto-<gate の number>`、`cancel-in-progress: false` |
| `permissions` | `contents: read` と `id-token: write`。書き込みは App のトークンで行う |
| step | 下の表 |

| step | 中身 |
|---|---|
| checkout | `start`・`resume` は既定のブランチ。`ci-fix` は `gate` の `branch` |
| uv | `astral-sh/setup-uv` |
| トークン | `actions/create-github-app-token`。権限は [research.md](../research.md) の R2 の表 |
| 設定の復元 | `pecot project activate <PECOT_AUTO_PROJECT_CONFIG>` |
| 利用者の準備 | 印の付いた空の step。依存の install などを利用者が足す |
| 自動処理 | claude-code-action。入力は下の表 |
| 後始末 | `if: always()` で `pecot auto finish --ensure --job-status <job の終わり方>` |

## claude-code-action の入力

| 入力 | 値 |
|---|---|
| `anthropic_api_key` | secret `ANTHROPIC_API_KEY` |
| `github_token` | 発行した App のトークン |
| `plugin_marketplaces` | `https://github.com/pecotcraft/pecot.git` |
| `plugins` | `pecot-w@pecot` |
| `prompt` | `/pecot-w:w-auto <gate の kind> <gate の issue>` |
| `allowed_bots` | 自前の App の名前。`*` は使わない |
| `claude_args` | `--max-turns` と `--allowedTools` |

設定しない入力:

- `allowed_non_write_users` は設定しない。書き込み権限の無い人を通す入力だ
- `prompt` に Issue の本文・タイトル・コメントを式で埋め込まない

環境変数 `PECOT_GITHUB_COM_TOKEN` に、同じ App のトークンを渡す。

## 許可するツール

| ツール | 使い道 |
|---|---|
| `Read`・`Glob`・`Grep` | コードを読む |
| `Edit`・`Write` | 修正する |
| `Bash(pecot *)` | pecot の手順 |
| `Bash(git status *)`・`Bash(git diff *)`・`Bash(git log *)`・`Bash(git fetch *)`・`Bash(git checkout *)`・`Bash(git add *)`・`Bash(git commit *)`・`Bash(git push *)` | ブランチの操作とコミット |
| `Bash(gh pr checks *)`・`Bash(gh run view *)` | 落ちた CI を読む |
| 印の付いた行 | 利用者のテストのコマンド。初期は空 |

許可しないもの:

- `gh api`・`gh pr merge`・`gh issue close`・`gh release`
- `curl`・`wget` などの、外への送信
- `WebFetch`・`WebSearch`

許可リストは境界ではない。main への push を止めるのは、保護されたブランチの ruleset と App の権限だ。導入の手順に、ruleset があることを前提として書く。

## 版の目印

- ファイルの 1 行目に `# pecot-auto-template: <版>` を置く
- 版は整数で、雛形の中身を変えるたびに 1 つ上げる
- 利用者が足す行（準備の step、テストのコマンドの許可）は、開始と終了の印のコメントで囲む。`pecot auto install --force` は、囲みの中を消す前に出す

## テストで確かめること

| 確かめること | 方法 |
|---|---|
| YAML として読める | 雛形を書き出して読み込む |
| 契機が `issues: labeled` と `workflow_run: completed` だけ | 読み込んだ `on` を比べる |
| `allowed_non_write_users` が無い | キーの有無を見る |
| `prompt` に `github.event.issue.body`・`title`・`comment.body` の式が無い | 文字列を探す |
| `run` の job に `timeout-minutes`・`concurrency` がある | キーの有無を見る |
| `claude_args` に `--max-turns` と `--allowedTools` がある | 文字列を探す |
| 後始末の step が `if: always()` を持つ | キーの値を見る |
| このリポ固有の名前（`pecotcraft/pecot` の設定の名前、CI の名前）が、置き換えの後に残らない | 書き出した結果を探す |
