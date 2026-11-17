# Contract: 自動レビューのワークフローの雛形

`plugins/pecot-workflow/cli/templates/workflow/pecot-review.yml` に置く雛形の契約だ。
`pecot workflow install review` が、導入先のリポの `.github/workflows/pecot-review.yml` に書き出す。

## 契機

| 契機 | 型 |
|---|---|
| `pull_request` | `opened`・`ready_for_review` |
| `issue_comment` | `created`。合言葉での起動し直し |

ほかの契機は持たない。`pull_request_target`・`synchronize`・`edited` を書かない（FR-003、FR-021）。
`issue_comment` は、既定のブランチの雛形で動く。PR のブランチで変えた雛形は、コメントの run では使われない。

## 利用者が変える値

利用者が変える値は、リポの変数（`vars`）に置く。変数が無ければ、雛形に書いた既定値で動く。

| 変数 | 既定値 | 意味 |
|---|---|---|
| `PECOT_REVIEW_TRIGGER_PHRASE` | `@pecotbot review` | 起動し直しの合言葉。コメントの本文がこれで始まると起動する |
| `PECOT_REVIEW_ALLOWED_BOTS` | 空 | 起動を許す bot の名前。JSON の配列で書く（例: `["my-app[bot]"]`） |
| `PECOT_REVIEW_MAX_TURNS` | `60` | main のターンの上限。サブエージェントの中のやり取りは数えない |
| `PECOT_REVIEW_TIMEOUT_MINUTES` | `30` | 時間の上限。分 |

先頭の `env` に置かないのは、job の `if` が `env` を読めないためだ。公式の表では、`jobs.<job_id>.if` で使える context は `github`・`needs`・`vars`・`inputs` だけだ。
`jobs.<job_id>.timeout-minutes` と `jobs.<job_id>.concurrency` も、`vars` を読める。

- 既定値は、式の `||` で書く。例は `vars.PECOT_REVIEW_TRIGGER_PHRASE || '@pecotbot review'` だ
- `timeout-minutes` は、`${{ fromJSON(vars.PECOT_REVIEW_TIMEOUT_MINUTES || '30') }}` と書く。変数の値は文字列で、`timeout-minutes` は数を求める。`fromJSON` が無いと、変数を置いたときに run が job を作らずに失敗する（research の R2）
- 許す bot の判定は、`contains(fromJSON(...), <PR の作者>)` で書く。カンマ区切りの文字列にしないのは、名前の一部が一致して通るのを避けるためだ
- action の `allowed_bots` には、同じ一覧をカンマ区切りに直して渡す

## job `review`

| 項目 | 決め |
|---|---|
| 時間の上限 | `timeout-minutes` に、変数と既定値の式を書く |
| 同時実行 | job に書く。`group: pecot-review-<PR番号>`、`cancel-in-progress: false`。PR の番号は `github.event.pull_request.number \|\| github.event.issue.number` |
| `permissions` | `contents: read`・`pull-requests: write`・`id-token: write`。`pull-requests: write` は、`GITHUB_TOKEN` で PR に書くためだ。`id-token: write` は、Claude の App のトークンの引き換えと、Workload Identity Federation のためだ |

### 動く条件

job の `if` に書く。すべて満たすときだけ動く。対象外の PR は、runner を使わずに飛ばされる。

| 条件 | 式が見るもの |
|---|---|
| `pull_request` のとき | fork でない（`github.event.pull_request.head.repo.full_name == github.repository`）。draft でない。PR の作者が bot でないか、許す bot の一覧に名前がある |
| `issue_comment` のとき | コメントが PR に付いた（`github.event.issue.pull_request`）。書いたのが bot でない。書いた人の `github.event.comment.author_association` が `OWNER`・`MEMBER`・`COLLABORATOR` のどれか。本文が合言葉と同じか、合言葉の直後が空白か改行（下の式） |

`issue_comment` のイベントは、PR の head のリポと draft を持たない。fork・draft・閉じた PR は、job の中の「PR の確かめ」の step で弾く。
書いた人の権限は、`if` と action の両方で確かめる。`if` で止めないと、action が step を失敗にし、後始末が「止まった」と PR に書く。`prompt` を渡す形では、action は合言葉を確かめないので、合言葉の判定は `if` だけが持つ（research の R15）。

合言葉の判定の式は、次の形にする。`P` は `vars.PECOT_REVIEW_TRIGGER_PHRASE || '@pecotbot review'` だ。GitHub Actions の式に正規表現が無いので、区切りを 4 つの比べ方で表す。式の文字列に改行の書き方が無いので、改行は `fromJSON` で作る。

```text
github.event.comment.body == P ||
startsWith(github.event.comment.body, format('{0} ', P)) ||
startsWith(github.event.comment.body, format('{0}{1}', P, fromJSON('"\n"'))) ||
startsWith(github.event.comment.body, format('{0}{1}', P, fromJSON('"\r\n"')))
```

- `@pecotbot reviewer` と `@pecotbot review-later` は通らない
- 改行は `\n` と `\r\n` の両方を受ける。GitHub の画面から書いたコメントは `\r\n` になることがある。どちらの形でも起動することを、検証用で確かめた（research の R15）

### step

| step | 中身 |
|---|---|
| トークン | 変数 `PECOT_AGENT_APP_CLIENT_ID` があるときだけ。`actions/create-github-app-token` で、`permission-pull-requests: write` と `permission-contents: read` だけを渡す。無いときは飛ばし、Claude の App を使う |
| PR の確かめ | `issue_comment` の run だけ。PR を読み、fork・draft・閉じた PR なら、後の step を飛ばす。読んだ PR の `head.sha` を出力する |
| 受け付けの印 | `issue_comment` の run で、PR の確かめを通ったときだけ。合言葉のコメントに 👀 のリアクションを付ける（FR-035）。付けられなくても、レビューは続ける |
| checkout | `actions/checkout`。`fetch-depth: 1`、`persist-credentials: false`。`issue_comment` の run は既定のブランチを取るので、`ref` に、PR の確かめの step が出力した `head.sha` を渡す。`refs/pull/<PR番号>/head` を渡すと、確かめの後の push で先頭が動き、確かめた版と違う版を読むことがある |
| Node | `actions/setup-node` |
| 利用者の準備 | 印の付いた空の step。初期は空 |
| 自動レビュー | claude-code-action。入力は下の表 |
| 後始末 | `if: always()` で `pecot review finish --ensure` を打つ。渡すものは下の表 |

開始時刻は、最初の step で `date -u +%Y-%m-%dT%H:%M:%SZ` を出力に置いて作る。

後始末の step に渡すもの:

| 渡すもの | 値 |
|---|---|
| `--job-status` | `${{ job.status }}` |
| `--execution-file` | 自動レビューの step の出力 `execution_file` |
| `--since` | 最初の step が出力した開始時刻 |
| `--app-token-missing` | 自前の App が無く、自動レビューの step の `outcome` が `failure` で、出力 `github_token` が空のときだけ付ける。action は、App のトークンを受け取れなかったときも、空の `github_token` を出力する |
| 環境変数 `PECOT_REVIEW_TRIGGER_PHRASE` | `${{ vars.PECOT_REVIEW_TRIGGER_PHRASE }}`。リポの変数は、step の環境変数に自動では入らない |

- `--app-token-missing` は、run の step より前の composite の step で落ちたときも付く。そのときも、設定を見直す案内で足りる
- 環境変数 `GITHUB_RUN_ID`・`GITHUB_RUN_ATTEMPT`・`GITHUB_ACTOR` は、GitHub Actions が入れる

action はすべて SHA で固定し、版をコメントに書く。
後始末の step は、`npx -y --prefix=/ @pecot/workflow-mcp@latest` で CLI を打つ。dist-tag の決め方は、board sync の雛形と同じだ。このリポと検証用に置くファイルは、`@next` にする。

## claude-code-action の入力

| 入力 | 値 |
|---|---|
| `claude_code_oauth_token` | secret `CLAUDE_CODE_OAUTH_TOKEN`。既定の認証（spec の「費用と認証の方針」） |
| `anthropic_federation_rule_id`・`anthropic_organization_id`・`anthropic_service_account_id`・`anthropic_workspace_id` | secret のトークンが無いときだけ、変数 `PECOT_AGENT_ANTHROPIC_*` を渡す。あるときは空を渡す（下の式） |
| `classify_inline_comments` | `"false"`。分類の step は `ANTHROPIC_API_KEY` が無いと飛ばされ、`confirmed` の無いコメントも全部投稿される。明示して、どの投稿もすぐ出す形に揃える（research の R4） |
| `github_token` | 自前の App のトークン。トークンの step を飛ばしたときは空になり、action が Claude の App のトークンを受け取る |
| `plugin_marketplaces` | `https://github.com/pecotcraft/pecot.git` |
| `plugins` | `pecot-w@pecot` |
| `prompt` | `/pecot-w:w-revise --unattended <github.repository>/<PR番号>` |
| `allowed_bots` | 許す bot の一覧。`*` は使わない |
| `claude_args` | `--permission-mode default`・`--max-turns`・`--allowedTools`・`--disallowedTools` |

action の公式の文書は、トークンと Workload Identity Federation の入力を同時に渡さないよう書いている（`docs/setup.md`）。4 つの ID は、次の形で片方だけを渡す。

```text
anthropic_federation_rule_id: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN == '' && vars.PECOT_AGENT_ANTHROPIC_FEDERATION_RULE_ID || '' }}
```

残りの 3 つも同じ形にする。secret を消すと、雛形を書き換えずに Workload Identity Federation で動く。

設定しない入力:

- `anthropic_api_key`。従量で動かすときは Workload Identity Federation を使い、静的な secret を置かない
- `allowed_non_write_users`。書き込み権限の無い人を通す入力だ
- `track_progress`。追跡コメントの付く別のモードに切り替わる
- `restrict_untrusted_prs`。初期値の有効のままにする

`prompt` に、PR の本文・タイトル・ブランチ名・コメントを式で埋め込まない。渡すのは、リポの名前と PR の番号だけだ。

action の外の step と、環境変数 `PECOT_GITHUB_COM_TOKEN` には、次のトークンを渡す。

```text
${{ steps.token.outputs.token || github.token }}
```

- 自前の App を置いたときは、そのトークンだ。置かないときは、ワークフローの `GITHUB_TOKEN` だ
- pecot の MCP ツールは `PECOT_GITHUB_COM_TOKEN` だけを読み、action が Claude の App のトークンを置く `GITHUB_TOKEN` を読まない。このため、既定では、インラインコメントが `claude[bot]`、指摘の一覧が `github-actions[bot]` の名前で付く（research の R3）

### Claude の App のワークフローの確かめ

Claude の App のトークンは、ワークフローのファイルが既定のブランチと同じ中身のときだけ受け取れる。
PR のブランチで雛形を変えた PR では、action がレビューを飛ばし、step は成功で終わる。
action の中の step の出力 `skipped_due_to_workflow_validation_mismatch` が `true` になるが、action の外からは読めない。step も job も成功で終わるので、後始末は何もしない（`contracts/cli-commands.md`）。
自前の App のときは、この確かめは無い。

## 許可するツール

| ツール | 使い道 |
|---|---|
| `Read`・`Glob`・`Grep` | コードを読む |
| `mcp__plugin_pecot-w_pecot-workflow__pr_show`・`issue_show`・`pr_restack`・`issue_comment`・`review_finish` | w-revise の Step 1〜3 と終わり方 |
| `mcp__github_inline_comment__create_inline_comment` | インラインコメントの投稿。action に同梱のツールで、公式の PR レビューの例と同じだ |
| 印の付いた行 | 利用者が足す許可。初期は空 |

diff は `pr_show` で読む。checkout は履歴を 1 つしか取らないので、手元の `git diff` と `git log` では base との差を出せない。

`--allowedTools` は、確認なしに使えるツールの一覧として働く。一覧に無い MCP ツールは拒まれるが、確認の要らないツール（`Skill`、読み取りだけの `Bash` のコマンド）は、一覧に無くても使える（research の R5）。
このため、使わせないツールは `--disallowedTools` に書く。ここに書いたツールは、サブエージェントでも使えない。

- `Bash`
- `Edit`・`Write`・`NotebookEdit`
- `AskUserQuestion`
- `Agent`。人のいない実行では、サブエージェントを起こさない（`contracts/skill-flow.md`）
- `WebFetch`・`WebSearch`

許可リストは境界ではない。Claude の App のトークンは、Contents・Issues・Pull requests の write を持つ。リポの内容を書き換えさせないのは、`--disallowedTools` で、書き換えのツールと `Bash` を渡さないことだ（FR-011）。自前の App のときは、トークンの権限も境界になる。

pecot の MCP ツールは、`.active` の無い checkout でも、対象のリポからプロジェクトの設定を決める（#579）。リポが複数のボードに入っている利用者は、変数でプロジェクトを指定する。指定の渡し方は #579 で決める。

## 版の目印

- ファイルの 1 行目に `# pecot-workflow-template: review <版>` を置く
- 版は整数で、雛形の中身を変えるたびに 1 つ上げる
- 利用者が足す行（準備の step、許可）は、開始と終了の印のコメントで囲む。`pecot workflow install review --force` は、囲みの中を消す前に出す
- 利用者が変える値は変数にあるので、雛形を上書きしても消えない

## テストで確かめること

| 確かめること | 方法 |
|---|---|
| YAML として読める | 雛形を読み込む |
| `pull_request_target` が無い | キーの有無を見る |
| 契機が `pull_request` の 2 つの型と、`issue_comment` の `created` だけ | 読み込んだ `on` を比べる |
| job の `if` に、fork・draft・合言葉と区切りの 4 つの比べ方・`author_association`・bot の判定がある | 式の文字列を探す |
| `issue_comment` の run に、PR の確かめの step があり、checkout の `ref` がその step の `head.sha` の出力を読む | step の `if` と `with` を見る |
| job の `if`・`timeout-minutes`・`concurrency` が、`env.` を読んでいない | 式の文字列を探す |
| 4 つの変数に、既定値の式がある | 式の文字列を探す |
| `timeout-minutes` が `fromJSON` で数に直している | 式の文字列を探す |
| `allowed_non_write_users`・`track_progress`・`anthropic_api_key` が無い | キーの有無を見る |
| `claude_code_oauth_token` があり、Workload Identity Federation の 4 つの入力が、secret のあるときに空になる式を持つ | 式の文字列を探す |
| `classify_inline_comments` が `"false"` | キーの値を見る |
| `issue_comment` の run に、PR の確かめの後で 👀 のリアクションを付ける step がある | step の `if` と `run` を見る |
| `prompt` に `github.event.pull_request.body`・`title`・`head.ref` の式が無い | 文字列を探す |
| job の `permissions` が `contents: read`・`pull-requests: write`・`id-token: write` だけ | 読み込んだ値を比べる |
| トークンの発行の step が、変数 `PECOT_AGENT_APP_CLIENT_ID` のあるときだけ動き、渡す権限が Pull requests の write と Contents の read だけ | step の `if` と `with` のキーを比べる |
| `github_token` と `PECOT_GITHUB_COM_TOKEN` が、発行したトークンが無いときに Claude の App と `GITHUB_TOKEN` に落ちる式を持つ | 式の文字列を探す |
| job に `timeout-minutes` と `concurrency` がある | キーの有無を見る |
| `claude_args` に `--permission-mode default`・`--max-turns`・`--allowedTools`・`--disallowedTools` がある | 文字列を探す |
| 許可リストに `Bash`・`Edit`・`Write` が無く、`--disallowedTools` にある | 文字列を探す |
| 許可リストに、マージ・クローズ・リリースのツール（`pr_merge`・`release_create` など）が無い | 文字列を探す |
| 後始末の step が `if: always()` を持つ | キーの値を見る |
| action がすべて SHA で固定されている | `uses` の形を見る |
| 後始末の step の dist-tag が `@latest` | `run` の文字列を見る |
| 導入の説明に書いた変数・secret の名前と合言葉の既定値が、雛形と同じ | 文書と雛形を比べる |

actionlint は pre-commit が掛ける。
