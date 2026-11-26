# Contract: 自動レビューのワークフローの雛形

`plugins/pecot-workflow/cli/templates/workflow/pecot-review.yml` に置く雛形の契約だ。
`pecot workflow install review` が、導入先のリポの `.github/workflows/pecot-review.yml` に書き出す。

## 契機

| 契機 | 型 |
|---|---|
| `pull_request` | `opened`・`ready_for_review`・`synchronize` |
| `issue_comment` | `created`。合言葉での起動し直し |

ほかの契機は持たない。`pull_request_target`・`edited` を書かない（FR-003、FR-021）。

`synchronize` は、まだ自動レビューの付いていない PR の最初のレビューのためだけに置く（FR-003）。
GitHub は、コンフリクトのある PR では `pull_request` のワークフローを動かさない。開いた時点か ready にした時点でコンフリクトしていた PR は、解いた push の `synchronize` だけが届く。
前の自動レビューの跡がある PR では、`synchronize` の run は「前のレビューの確かめ」の step の後の step と後始末を飛ばす。
base の側の変更でコンフリクトが消えたときは PR のイベントが起きず、合言葉で起こす。
`issue_comment` は、既定のブランチの雛形で動く。PR のブランチで変えた雛形は、コメントの run では使われない。

## 利用者が変える値

利用者が変える値は、リポの変数（`vars`）に置く。変数が無ければ、雛形に書いた既定値で動く。

| 変数 | 既定値 | 意味 |
|---|---|---|
| `PECOT_REVIEW_TRIGGER_PHRASE` | `@pecotbot review` | 起動し直しの合言葉。コメントの本文がこれで始まると起動する |
| `PECOT_REVIEW_ALLOWED_BOTS` | 空 | 起動を許す bot の名前。JSON の配列で書く（例: `["my-app[bot]"]`） |
| `PECOT_REVIEW_MODEL` | `opus` | モデル。`claude_args` の `--model` に渡す。別名か完全な名前 |
| `PECOT_REVIEW_EFFORT` | `high` | effort の段階。`claude_args` の `--effort` に渡す。`low`・`medium`・`high`・`xhigh`・`max` |
| `PECOT_REVIEW_MAX_TURNS` | `60` | main のターンの上限。サブエージェントの中のやり取りは数えない |
| `PECOT_REVIEW_TIMEOUT_MINUTES` | `30` | 時間の上限。分 |
| `PECOT_REVIEW_PROJECT` | 空 | プロジェクトの設定の名前。リポが 2 つ以上の設定に入っているときに置く。`.pecot/config/projects/` のファイル名から `.json` を除いたもの |
| `PECOT_REVIEW_WEB_ACCESS` | `true` | `false` にすると、Context7 を足さず、`WebFetch`・`WebSearch` を拒む |

任意の secret `CONTEXT7_API_KEY` があれば、Context7 にキーを渡す。無ければ、キー無しでつなぐ（回数の上限が低い）。

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
| 同時実行 | job に書く。`group: pecot-review-<PR番号>`、`cancel-in-progress: false`、`queue: max`。PR の番号は `github.event.pull_request.number \|\| github.event.issue.number`。既定の `queue: single` は待ちを 1 つしか持たず、後から並んだ push の run が、待っている合言葉の run を取り消す（FR-024）。actionlint 1.7.12 は `queue` を知らないので、このリポの `.github/actionlint.yaml` で外す |
| `permissions` | `contents: read`・`pull-requests: write`・`id-token: write`。`pull-requests: write` は、`GITHUB_TOKEN` で PR に書くためだ。`id-token: write` は、Claude の App のトークンの引き換えと、Workload Identity Federation のためだ |

### 動く条件

job の `if` に、`github.event_name` で始まる `pull_request` と `issue_comment` の 2 つの枝に分けて書く。枝の条件をすべて満たすときだけ動く。対象外の PR は、runner を使わずに飛ばされる。

| 条件 | 式が見るもの |
|---|---|
| `pull_request` のとき | fork でない（`github.event.pull_request.head.repo.full_name == github.repository`）。draft でない。PR の作者が bot でないか、許す bot の一覧に名前がある |
| `issue_comment` のとき | コメントが PR に付いた（`github.event.issue.pull_request`）。書いたのが bot でない。書いた人の `github.event.comment.author_association` が `OWNER`・`MEMBER`・`COLLABORATOR` のどれか。本文が合言葉と同じか、合言葉の直後が空白か改行（下の式） |

`issue_comment` のイベントは、PR の head のリポと draft を持たない。fork・draft・閉じた PR は、job の中の「PR の確かめ」の step で弾く。
書いた人の権限は、`if`・PR の確かめの step・action の 3 か所で確かめる。
`author_association` の `COLLABORATOR` は read・triage の招待も含み、`MEMBER` はリポへの権限を問わない。
このため `if` は runner を使わない前段の絞りにとどめ、PR の確かめの step が `collaborators/<login>/permission` の `permission` を読み、`admin`・`write`（maintain は write で返る）でなければ後の step を飛ばす。
ここで止めないと、action が step を失敗にし、後始末が「止まった」と PR に書く。

PR の確かめの step は、head のコミットの時刻が合言葉のコメントの時刻より後なら、後の step を飛ばす。
コメントを書いた人が見ていないコミットを、その依頼でレビューしないためだ。
CodeQL の `actions/untrusted-checkout/high` と `actions/untrusted-checkout-toctou/high` は、`issue_comment` の checkout に、権限の確かめとこの時刻の確かめの両方を求める。
時刻は、`date -d` で `*_at` を読む 2 行で比べる（CodeQL が確かめと認める形）。

`prompt` を渡す形では、action は合言葉を確かめないので、合言葉の判定は `if` だけが持つ（research の R15）。

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
| 前のレビューの確かめ | `synchronize` の run だけ（`id: first`）。PR の Issue コメントのうち、Bot が書いたもので、本文が先頭の空白を除いて `## Findings` で始まるか、`<!-- pecot-review-stopped` を含むものを探す。無ければ `ok=true`、あれば `ok=false` を出力する。`gh api --paginate` の結果を変数に代入して読み、パイプとプロセス置換を使わない。API の失敗は step の失敗にする |
| PR の確かめ | `issue_comment` の run だけ。PR と書いた人の権限を読み、fork・draft・閉じた PR か、書いた人の `permission` が `admin`・`write`（maintain は write で返る）でなければ、後の step を飛ばす。読んだ PR の `head.sha` を出力する。API の失敗は step の失敗にする |
| 受け付けの印 | `issue_comment` の run で、PR の確かめを通ったときだけ。合言葉のコメントに 👀 のリアクションを付ける（FR-035）。付けられなくても、レビューは続ける |
| checkout | `actions/checkout`。`fetch-depth: 1`、`persist-credentials: false`。`ref` に、`pull_request` の run は `github.event.pull_request.head.sha`、`issue_comment` の run は PR の確かめの step が出力した `head.sha` を渡す。既定の merge の ref では、base の変更で指摘の行が head の diff とずれる。`refs/pull/<PR番号>/head` を渡すと、確かめの後の push で先頭が動き、確かめた版と違う版を読むことがある |
| Node | `actions/setup-node`。`package-manager-cache: false` を渡す。job が secret を持つので、PR の `package.json` が npm を指しても、npm のキャッシュを戻さず保存もしない。キャッシュが要る利用者は、利用者の準備の囲みで `actions/cache` を使う。setup-node は囲みの外にあり、`cache` を足しても雛形の上書きで消える |
| 利用者の準備 | 開始と終了の印のコメント 2 行だけ。step は `uses` か `run` を要するので、空の step は置かない |
| 自動レビュー | claude-code-action。入力は下の表 |
| 実行の記録 | 自動レビューの直後。`if: always() && steps.claude.outputs.execution_file != ''`、`continue-on-error: true`。`env` の `EXECUTION_FILE` で execution file を受け、`jq` で 3 つの表を `$GITHUB_STEP_SUMMARY` に足す（下の節）。失敗を job の失敗にすると、後始末が成功したレビューに「止まった」と書くので、失敗させない |
| 後始末 | `if: always() && steps.first.outputs.ok != 'false'` で `pecot review finish "$GITHUB_REPOSITORY/$PR" --ensure` を打つ。PR の番号も `env` の `PR` で受ける。自動レビューの step の値を、`env` で受けて引用符付きの引数で渡す（下の表） |

後始末の step が渡す値:

| `env` | 式 | 引数 |
|---|---|---|
| `JOB_STATUS` | `${{ job.status }}` | `--job-status "$JOB_STATUS"` |
| `REVIEW_OUTCOME` | `${{ steps.claude.outcome }}` | `--review-outcome "$REVIEW_OUTCOME"` |
| `REVIEW_CONCLUSION` | `${{ steps.claude.outputs.conclusion }}` | `--review-conclusion "$REVIEW_CONCLUSION"` |
| `REVIEW_HAS_TOKEN` | `${{ steps.claude.outputs.github_token != '' }}` | `--review-has-token "$REVIEW_HAS_TOKEN"` |
| `EXECUTION_FILE` | `${{ steps.claude.outputs.execution_file }}` | `--execution-file "$EXECUTION_FILE"` |
| `REVIEW_STARTED_AT` | `${{ steps.start.outputs.time }}` | `--since "$REVIEW_STARTED_AT"` |
| `PECOT_REVIEW_TRIGGER_PHRASE` | `${{ vars.PECOT_REVIEW_TRIGGER_PHRASE }}` | 引数にしない。CLI が環境変数から読む |

- `run:` に式を直接埋め込まない。GitHub の公式の安全ガイドは、値を中間の環境変数で渡す形を勧めている
- `conclusion` はふつう空なので、引用符が無いと引数が消え、次のオプションが値として読まれる
- `github_token` は、値を渡さず、有無だけを `true` か `false` で渡す
- 開始時刻は、job の最初の step（`id: start`）が `date -u +%Y-%m-%dT%H:%M:%SZ` を出力に置いて作る。`--execution-file`・`--since` は空でもよく、空なら上限の見分けと止まった場所を「分からない」に倒す
- リポの変数は、step の環境変数に自動では入らないので、合言葉も `env` で渡す
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
| `prompt` | `/pecot-w:w-review <github.repository>/<PR番号>`。変数 `PECOT_REVIEW_PROJECT` があるときだけ、末尾に `project=<名前>` を足す（下の式） |
| `allowed_bots` | 許す bot の一覧。`*` は使わない |
| `settings` | PreToolUse のフック 1 つ。`$CLAUDE_EFFORT` を `$RUNNER_TEMP/pecot-review-effort` に書くだけで、何も返さない。実行の記録が、使われた effort を読む |
| `claude_args` | `--permission-mode default`・`--model`・`--effort`・`--max-turns`・`--allowedTools`・`--disallowedTools` |

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

`prompt` に、PR の本文・タイトル・ブランチ名・コメントを式で埋め込まない。渡すのは、リポの名前と PR の番号と、変数 `PECOT_REVIEW_PROJECT` の値だけだ。
変数を置けるのは、リポの設定を変えられる人だけなので、合言葉の変数と同じ信頼の範囲に入る。

プロジェクトの設定の名前は、`prompt` の末尾に次の式で足す。変数が無いと式は空の文字列になり、`prompt` は変数を足す前と同じになる。

```text
${{ vars.PECOT_REVIEW_PROJECT != '' && format(' project={0}', vars.PECOT_REVIEW_PROJECT) || '' }}
```

w-review は、引数の `project=<名前>` を、`pr_show`・`issue_show`・`issue_comment` の `project` に渡す（`contracts/skill-flow.md`）。

action の外の step と、環境変数 `PECOT_GITHUB_COM_TOKEN` には、次のトークンを渡す。

```text
${{ steps.token.outputs.token || github.token }}
```

- 自前の App を置いたときは、そのトークンだ。置かないときは、ワークフローの `GITHUB_TOKEN` だ
- pecot の MCP ツールは `PECOT_GITHUB_COM_TOKEN` だけを読み、action が Claude の App のトークンを置く `GITHUB_TOKEN` を読まない。このため、既定では、インラインコメントが `claude[bot]`、指摘の一覧が `github-actions[bot]` の名前で付く（research の R3）

### Claude の App のワークフローの確かめ

Claude の App のトークンは、ワークフローのファイルが既定のブランチと同じ中身のときだけ受け取れる。
PR のブランチで雛形を変えた PR では、action がレビューを飛ばし、step は成功で終わる。
このとき、自動レビューの step の `outcome` は `success` で、action の出力 `conclusion` は空になる。後始末は、これを止まったこととして扱わない（`contracts/cli-commands.md`、research の R9）。
この PR には自動レビューの跡が残らないので、push のたびに `synchronize` の run が checkout から後始末まで動く。モデルは呼ばれず、かかるのは runner の時間だけだ。
action の中の出力 `skipped_due_to_workflow_validation_mismatch` は、action の `outputs` に無く、呼ぶ側から読めない。
自前の App のときは、この確かめは無い。

## 実行の記録

実行の記録の step は、execution file（SDK のメッセージの配列）を `jq -r` で読み、次の 3 つの表を job summary に足す。

| 表 | 中身 |
|---|---|
| `Review run` | init の `model`、使われた effort、result の `num_turns`・`subtype` |
| `Tool calls` | assistant のメッセージの `tool_use` を順に、番号・ツール名・対象 |
| `Denied calls` | result の `permission_denials` の、ツール名・対象。無ければ `None.` |

- 使われた effort は、`settings` のフックが書いたファイルから読む。init のメッセージは effort を持たない。ファイルが無ければ `unknown` を出す
- 対象は、入力の `file_path`・`path`・`file`・`pattern`・`command`・`url`・`query`・`pr_ref`・`issue_ref`・`libraryId`・`libraryName` のうち最初にあるもの。どれも無ければ、入力のキーの名前だけを並べる。コメントの本文の入る項目は出さない
- ツールの出力と、Claude の文は出さない。対象は Claude の書いた文字列なので、拒まれた呼び出しを含め、diff から写した文が 200 文字まで出ることがある
- セルは、改行を空白に替え、バッククォートを外して 200 文字で切り、`|` を `\|` に替えてコードスパンで囲む。空のセルは囲まない（空のコードスパンは文字のまま出る）。対象は Claude が diff を読んで書いた文字列を含むので、リンク・画像・HTML にしない
- action の `display_report` は使わない。Claude の書いた内容を Summary に出すので、action の文書が、信頼できる入力のときだけ使うよう警告している

## 許可するツール

| ツール | 使い道 |
|---|---|
| `Read`・`Glob`・`Grep` | コードを読む |
| `mcp__plugin_pecot-w_pecot-workflow__pr_show`・`issue_show`・`issue_comment` | w-review の Step 1〜3 |
| `mcp__github_inline_comment__create_inline_comment` | インラインコメントの投稿。action に同梱のツールで、公式の PR レビューの例と同じだ |
| `Bash(gh pr diff:*)`・`Bash(gh pr view:*)` | PR の diff と情報を読む。公式の PR レビューの例と同じだ（#633） |
| `WebSearch`・`WebFetch(domain:docs.github.com)`・`mcp__context7__resolve-library-id`・`mcp__context7__query-docs` | 外の公式の文書を引く。`PECOT_REVIEW_WEB_ACCESS` が `false` でないときだけ足す（#657） |
| `PECOT_REVIEW_EXTRA_ALLOWED_TOOLS` | 利用者が足す許可。job の `env` に印のコメントで囲んで置き、`--allowedTools` の末尾に、空でないときだけ足す。初期は空 |

Context7 は、`--mcp-config` で `https://mcp.context7.com/mcp`（OAuth でない URL）につなぐ。
設定の JSON は job の `env` に 2 つ置き、secret `CONTEXT7_API_KEY` の有無で式が選ぶ。
キーは Review の step の `env` から、Claude Code が `${CONTEXT7_API_KEY}` を展開して渡す。

`WebFetch` は `docs.github.com` だけを許可に書く。雛形は GitHub Actions の上で動き、組み込みの文書のドメインに `docs.github.com` が無いためだ。
ほかは、Claude Code に組み込みの文書のドメインだけが承認なしで通り、残りのドメインは `default` のモードで拒まれる。
利用者は `PECOT_REVIEW_EXTRA_ALLOWED_TOOLS` に `WebFetch(domain:...)` を書いてドメインを足す。

diff は `gh pr diff` で読む。`pr_show` は本文とレビューしか返さない。checkout は履歴を 1 つしか取らないので、手元の `git diff` と `git log` では base との差を出せない。

`--allowedTools` は、確認なしに使えるツールの一覧として働く。一覧に無い MCP ツールは拒まれるが、確認の要らないツール（`Skill`、読み取りだけの `Bash` のコマンド）は、一覧に無くても使える（research の R5）。
このため、使わせないツールは `--disallowedTools` に書く。ここに書いたツールは、サブエージェントでも使えない。

- `Edit`・`Write`・`NotebookEdit`
- `AskUserQuestion`
- `Agent`。w-review はサブエージェントを起こさない（`contracts/skill-flow.md`）
- `WebFetch`・`WebSearch`。`PECOT_REVIEW_WEB_ACCESS` が `false` のときだけ
- `Bash(git clone:*)`。pecot-w の hook が、`.pecot/work/<数字>/reviewer/` への clone に allow を返す。deny の規則は hook の allow より優先される
- `Read(//proc/**)`。`/proc/self/environ` から環境変数のトークンを読ませない

許可リストは境界ではない。Claude の App のトークンは、Contents・Issues・Pull requests の write を持つ。リポの内容を書き換えさせないのは、`--disallowedTools` で書き換えのツールを渡さないことと、`default` のモードで規則の無いコマンドが拒まれることだ（FR-011）。
自前の App のときは、トークンの権限も境界になる。

pecot の MCP ツールは、`.active` の無い checkout でも、対象のリポからプロジェクトの設定を決める（#579）。リポが複数のボードに入っている利用者は、変数 `PECOT_REVIEW_PROJECT` でプロジェクトを指定する。雛形が、その名前を `prompt` の引数で w-review に渡す（#640）。
MCP サーバが環境変数から読む形にしないのは、全部のツールが読む入力を CLI に足すことになり、手元のセッションの挙動も変わるためだ。

## 版の目印

- ファイルの 1 行目に `# pecot-workflow-template: review <版>` を置く
- 版は整数で、雛形の中身を変えるたびに 1 つ上げる
- 利用者が足す行（準備の step、許可の変数）は、開始と終了の印のコメントで囲む。`pecot workflow install review --force` は、囲みの中を消す前に出す
- 許可を `claude_args` の中に書かない。`claude_args: >-` の中の `#` の行はコメントにならず、引数として渡る
- 利用者が変える値は変数にあるので、雛形を上書きしても消えない

## テストで確かめること

| 確かめること | 方法 |
|---|---|
| YAML として読める | 雛形を読み込む |
| `pull_request_target` が無い | キーの有無を見る |
| 契機が `pull_request` の 3 つの型と、`issue_comment` の `created` だけ | 読み込んだ `on` を比べる |
| 前のレビューの確かめの step が `synchronize` の run だけで動き、jq が Bot の指摘の一覧と止まったことの目印だけを拾う。checkout から自動レビューまでの `if` と後始末の `if` が、その出力を見る | `run` の jq を試しのコメントにかけ、`if` の文字列を見る |
| job の `if` が `pull_request` と `issue_comment` の 2 つの枝に分かれ、`pull_request` の枝に fork・draft・bot の判定、`issue_comment` の枝に合言葉と区切りの 4 つの比べ方・`author_association`・bot の判定がある | 枝ごとに式の文字列を探す |
| `issue_comment` の run に、PR の確かめの step があり、checkout の `ref` が `pull_request` の `head.sha` かその step の `head.sha` の出力を読む | step の `if` と `with` を見る |
| PR の確かめの step が、書いた人の `permission` を読み、`admin`・`write` のときだけ通す。API の失敗をプロセス置換で握りつぶさない | `env` と `run` の文字列を見る |
| job の `if`・`timeout-minutes`・`concurrency` が、`env.` を読んでいない | 式の文字列を探す |
| 6 つの変数に、既定値の式がある | 式の文字列を探す |
| `timeout-minutes` が `fromJSON` で数に直している | 式の文字列を探す |
| `allowed_non_write_users`・`track_progress`・`anthropic_api_key` が無い | キーの有無を見る |
| `claude_code_oauth_token` があり、Workload Identity Federation の 4 つの入力が、secret のあるときに空になる式を持つ | 式の文字列を探す |
| `classify_inline_comments` が `"false"` | キーの値を見る |
| `issue_comment` の run に、PR の確かめの後で 👀 のリアクションを付ける step がある | step の `if` と `run` を見る |
| `prompt` に `github.event.pull_request.body`・`title`・`head.ref` の式が無い | 文字列を探す |
| `prompt` の末尾が、変数 `PECOT_REVIEW_PROJECT` のあるときだけ `project=<名前>` を足す式になっている | 式の文字列を比べる |
| job の `permissions` が `contents: read`・`pull-requests: write`・`id-token: write` だけ | 読み込んだ値を比べる |
| トークンの発行の step が、変数 `PECOT_AGENT_APP_CLIENT_ID` のあるときだけ動き、渡す権限が Pull requests の write と Contents の read だけ | step の `if` と `with` のキーを比べる |
| `github_token` と `PECOT_GITHUB_COM_TOKEN` が、発行したトークンが無いときに Claude の App と `GITHUB_TOKEN` に落ちる式を持つ | 式の文字列を探す |
| job に `timeout-minutes` と `concurrency` がある | キーの有無を見る |
| `claude_args` に `--permission-mode default`・`--model`・`--effort`・`--max-turns`・`--allowedTools`・`--disallowedTools` がある | 文字列を探す |
| 許可リストに `Edit`・`Write` が無く、`--disallowedTools` にある。`Bash` の許可は `gh pr diff`・`gh pr view` の規則だけ | 文字列を探す |
| `--disallowedTools` に `Bash(git clone:*)`・`Read(//proc/**)` がある | 文字列を探す |
| 許可リストに、マージ・クローズ・リリースのツール（`pr_merge`・`release_create` など）が無い | 文字列を探す |
| 後始末の step が `if: always()` を持つ | キーの値を見る |
| 後始末の step が、`JOB_STATUS`・`REVIEW_OUTCOME`・`REVIEW_CONCLUSION`・`REVIEW_HAS_TOKEN` を `env` で受け、`run` に `${{` が無い | `env` のキーと `run` の文字列を見る |
| 後始末の step が、`steps.claude.outputs.github_token` の値そのものを `env` に置いていない | 式の文字列を探す |
| `claude_args` に `#` が無い | 読み込んだ値を見る |
| `settings` が、`$CLAUDE_EFFORT` をファイルに書く PreToolUse のフックだけを持つ | 読み込んだ値を比べる |
| 実行の記録の step が自動レビューの直後にあり、`if`・`continue-on-error`・`env` を持ち、`run` に `${{` が無い | キーの値と `run` の文字列を見る |
| 実行の記録の `jq` が、3 つの表を出し、ツールの出力と本文を出さない。`\|` と改行で列がずれず、リンク・画像・HTML がコードスパンの中に出る | `run` の jq を試しの execution file にかける |
| 利用者が足す許可が、job の `env` の変数から `--allowedTools` に足される | 式の文字列を探す |
| action がすべて SHA で固定されている | `uses` の形を見る |
| 後始末の step の dist-tag が `@latest` | `run` の文字列を見る |
| 導入の説明に書いた変数・secret の名前と合言葉の既定値が、雛形と同じ | 文書と雛形を比べる |

actionlint は pre-commit が掛ける。
