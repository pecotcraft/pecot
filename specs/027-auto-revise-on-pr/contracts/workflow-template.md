# Contract: 自動レビューのワークフローの雛形

`plugins/pecot-workflow/cli/templates/workflow/pecot-review.yml` に置く雛形の契約だ。
`pecot workflow install review` が、導入先のリポの `.github/workflows/pecot-review.yml` に書き出す。

## 契機

| 契機 | 型 |
|---|---|
| `pull_request` | `opened`・`ready_for_review`・`labeled` |

ほかの契機は持たない。`pull_request_target`・`issue_comment`・`synchronize`・`edited` を書かない（FR-003、FR-021）。

## 利用者が変える値

利用者が変える値は、リポの変数（`vars`）に置く。変数が無ければ、雛形に書いた既定値で動く。

| 変数 | 既定値 | 意味 |
|---|---|---|
| `PECOT_REVIEW_LABEL` | `pecot-review` | 起動ラベルの名前 |
| `PECOT_REVIEW_ALLOWED_BOTS` | 空 | 起動を許す bot の名前。JSON の配列で書く（例: `["my-app[bot]"]`） |
| `PECOT_REVIEW_MAX_TURNS` | `60` | ターンの上限 |
| `PECOT_REVIEW_TIMEOUT_MINUTES` | `30` | 時間の上限。分 |

先頭の `env` に置かないのは、job の `if` が `env` を読めないためだ。公式の表では、`jobs.<job_id>.if` で使える context は `github`・`needs`・`vars`・`inputs` だけだ。
`jobs.<job_id>.timeout-minutes` と `jobs.<job_id>.concurrency` も、`vars` を読める。

- 既定値は、式の `||` で書く。例は `vars.PECOT_REVIEW_LABEL || 'pecot-review'` だ
- 許す bot の判定は、`contains(fromJSON(...), <PR の作者>)` で書く。カンマ区切りの文字列にしないのは、名前の一部が一致して通るのを避けるためだ
- action の `allowed_bots` には、同じ一覧をカンマ区切りに直して渡す

## job `review`

| 項目 | 決め |
|---|---|
| 時間の上限 | `timeout-minutes` に、変数と既定値の式を書く |
| 同時実行 | job に書く。`group: pecot-review-<PR番号>`、`cancel-in-progress: false` |
| `permissions` | `contents: read` だけ。書き込みは App のトークンで行う |

### 動く条件

job の `if` に書く。すべて満たすときだけ動く。対象外の PR は、runner を使わずに飛ばされる。

| 条件 | 式が見るもの |
|---|---|
| 導入が済んでいる | `vars.PECOT_AGENT_APP_CLIENT_ID` が空でない。空の間は、失敗せずに飛ばす |
| fork でない | `github.event.pull_request.head.repo.full_name == github.repository` |
| draft でない | `github.event.pull_request.draft` が偽 |
| `labeled` のとき | `github.event.label.name` が、起動ラベルの名前と同じ |
| `opened`・`ready_for_review` のとき | PR の作者が bot でない。bot なら、許す bot の一覧に名前がある |

### step

| step | 中身 |
|---|---|
| checkout | `actions/checkout`。`fetch-depth: 1`、`persist-credentials: false`。`ref` は書かない |
| Node | `actions/setup-node` |
| トークン | `actions/create-github-app-token`。`permission-pull-requests: write` と `permission-contents: read` だけを渡す |
| 利用者の準備 | 印の付いた空の step。初期は空 |
| 自動レビュー | claude-code-action。入力は下の表 |
| 後始末 | `if: always()` で `pecot pr review-finish --ensure` を打つ |

action はすべて SHA で固定し、版をコメントに書く。
後始末の step は、`npx -y --prefix=/ @pecot/workflow-mcp@latest` で CLI を打つ。dist-tag の決め方は、board sync の雛形と同じだ。このリポと検証用に置くファイルは、`@next` にする。

## claude-code-action の入力

| 入力 | 値 |
|---|---|
| `anthropic_api_key` | secret `ANTHROPIC_API_KEY` |
| `github_token` | 発行した App のトークン |
| `plugin_marketplaces` | `https://github.com/pecotcraft/pecot.git` |
| `plugins` | `pecot-w@pecot` |
| `prompt` | `/pecot-w:w-revise --unattended <github.repository>/<PR番号>` |
| `allowed_bots` | 許す bot の一覧。`*` は使わない |
| `claude_args` | `--permission-mode default`・`--max-turns`・`--allowedTools`・`--disallowedTools` |

設定しない入力:

- `allowed_non_write_users`。書き込み権限の無い人を通す入力だ
- `track_progress`。追跡コメントの付く別のモードに切り替わる
- `restrict_untrusted_prs`。初期値の有効のままにする

`prompt` に、PR の本文・タイトル・ブランチ名・コメントを式で埋め込まない。渡すのは、リポの名前と PR の番号だけだ。

環境変数 `PECOT_GITHUB_COM_TOKEN` に、同じ App のトークンを渡す。

## 許可するツール

| ツール | 使い道 |
|---|---|
| `Read`・`Glob`・`Grep` | コードを読む |
| `mcp__plugin_pecot-w_pecot-workflow__pr_show`・`issue_show`・`pr_restack`・`issue_comment`・`pr_review_finish` | w-revise の Step 1〜3 と終わり方 |
| `mcp__github_inline_comment__create_inline_comment` | インラインコメントの投稿。action に同梱のツールで、公式の PR レビューの例と同じだ |
| 印の付いた行 | 利用者が足す許可。初期は空 |

Bash は許可しない。diff は `pr_show` で読む。checkout は履歴を 1 つしか取らないので、手元の `git diff` と `git log` では base との差を出せない。

次のツールは、`--disallowedTools` で止める。

- `Edit`・`Write`・`NotebookEdit`
- `AskUserQuestion`
- `WebFetch`・`WebSearch`

許可リストは境界ではない。リポの内容を書き換えさせないのは、App のトークンの権限だ（FR-011）。

## 版の目印

- ファイルの 1 行目に `# pecot-workflow-template: review <版>` を置く
- 版は整数で、雛形の中身を変えるたびに 1 つ上げる
- 利用者が足す行（準備の step、許可）は、開始と終了の印のコメントで囲む。`pecot workflow install review --force` は、囲みの中を消す前に出す
- 利用者が変える値は変数にあるので、雛形を上書きしても消えない

## テストで確かめること

| 確かめること | 方法 |
|---|---|
| YAML として読める | 雛形を読み込む |
| 契機が `pull_request` の 3 つの型だけ | 読み込んだ `on` を比べる |
| `pull_request_target` が無い | キーの有無を見る |
| job の `if` に、fork・draft・ラベルの名前・bot の判定がある | 式の文字列を探す |
| job の `if`・`timeout-minutes`・`concurrency` が、`env.` を読んでいない | 式の文字列を探す |
| 4 つの変数に、既定値の式がある | 式の文字列を探す |
| `allowed_non_write_users`・`track_progress` が無い | キーの有無を見る |
| `prompt` に `github.event.pull_request.body`・`title`・`head.ref` の式が無い | 文字列を探す |
| job の `permissions` が `contents: read` だけ | 読み込んだ値を比べる |
| トークンの発行に渡す権限が、Pull requests の write と Contents の read だけ | `with` のキーを比べる |
| job に `timeout-minutes` と `concurrency` がある | キーの有無を見る |
| `claude_args` に `--permission-mode default`・`--max-turns`・`--allowedTools`・`--disallowedTools` がある | 文字列を探す |
| 許可リストに `Bash`・`Edit`・`Write` が無い | 文字列を探す |
| 許可リストに、マージ・クローズ・リリースのツール（`pr_merge`・`release_create` など）が無い | 文字列を探す |
| 後始末の step が `if: always()` を持つ | キーの値を見る |
| action がすべて SHA で固定されている | `uses` の形を見る |
| 後始末の step の dist-tag が `@latest` | `run` の文字列を見る |
| 導入の説明に書いた変数・secret・ラベルの名前が、雛形と同じ | 文書と雛形を比べる |

actionlint は pre-commit が掛ける。
