# Contract: ワークフローの雛形

`plugins/pecot-workflow/cli/templates/workflow/pecot-auto.yml` に置く雛形の契約だ。
`pecot workflow install auto` が、導入先のリポの `.github/workflows/pecot-auto.yml` に書き出す。
書き方の共通の決まり（認証の名前・版の目印・囲みの印・起動者の確かめ・許可と拒否のツール・上限）は、spec 027 の [contracts/workflow-template.md](../../027-auto-revise-on-pr/contracts/workflow-template.md) と、w-help の `review-workflow.md` の「自動処理に共通の決まり」に従う。

## 契機

| 契機 | 条件 |
|---|---|
| `issues` の `labeled` | 付いたラベルの名前が、起動ラベルと同じ。判定は `gate` の job の `if` に書く |
| `workflow_run` の `completed` | 利用者の CI のワークフロー。自動処理が作った PR かは、`gate` が結果のコメントの目印で見分ける |

ほかの契機は持たない。コメント・本文の編集・起票では起動しない（FR-022）。

`on` は式を受け付けない。`workflow_run.workflows` の行は、利用者が書く。行は、次の印のコメントで囲む。`workflow install` は雛形を写すだけで、名前を埋めない。

```text
# pecot-auto:ci-workflows:begin
workflows: ["CI"]
# pecot-auto:ci-workflows:end
```

囲みの初めの値は仮の名前で、その名前の CI が無ければ何も起きない。名前が実在するかは、`pecot workflow doctor auto` が確かめる。
`workflow_run` は、ワークフローのファイルが既定のブランチにあるときだけ起動する。

## 利用者が変える値

利用者が変える値は、リポの変数（`vars`）に置く。変数が無ければ、雛形に書いた既定値で動く。

| 変数 | 既定値 | 意味 |
|---|---|---|
| `PECOT_AUTO_LABEL` | `pecot-auto` | 起動ラベルの名前 |
| `PECOT_AUTO_MAX_TURNS` | `80` | main のターンの上限 |
| `PECOT_AUTO_TIMEOUT_MINUTES` | `30` | `run` の時間の上限。分 |
| `PECOT_AUTO_MAX_CI_ATTEMPTS` | `3` | CI を直す回数の上限。`gate` に渡す |
| `PECOT_AUTO_PROJECT` | 空 | 使うプロジェクトの設定の名前。複数のボードに入ったリポで指定する |

先頭の `env` に置かないのは、job の `if` が `env` を読めないためだ。公式の表では、`jobs.<job_id>.if` で使える context は `github`・`needs`・`vars`・`inputs` だけだ。

- 既定値は、式の `||` で書く。例は `vars.PECOT_AUTO_LABEL || 'pecot-auto'` だ
- `timeout-minutes` は、`${{ fromJSON(vars.PECOT_AUTO_TIMEOUT_MINUTES || '30') }}` と書く。変数の値は文字列で、`timeout-minutes` は数を求める（spec 027 の R2）
- 複数のボードに入ったリポでの指定は、#640（#660）の形に合わせ、変数 `PECOT_AUTO_PROJECT` で読む。`gate` と後始末の step には `--project` で、スキルには `prompt` の `project=<名前>` で渡す。空なら渡さない

## 認証の名前

認証は、w-help の「エージェント用の認証」の共通の名前を使う。雛形ごとの名前は作らない。

| 名前 | 種類 | この雛形での扱い |
|---|---|---|
| `PECOT_AGENT_APP_CLIENT_ID` | 変数 | 必須。空の間は、`gate` を飛ばし、`setup` が Issue に足りない設定を書く。自前の App を、Projects の権限を持つトークンのために使う |
| `PECOT_AGENT_APP_PRIVATE_KEY` | secret | 必須。App の秘密鍵 |
| `CLAUDE_CODE_OAUTH_TOKEN` | secret | モデルの認証。既定 |
| `PECOT_AGENT_ANTHROPIC_*`（4 つ） | 変数 | secret のトークンが無いときだけ、Workload Identity Federation として渡す |

## job

### `gate`

| 項目 | 決め |
|---|---|
| 動く条件 | 変数 `PECOT_AGENT_APP_CLIENT_ID` が空でなく、`issues` のときはラベルの名前が起動ラベルと同じ。空の間は、何もせずに飛ばす（知らせは `setup` が書く） |
| 時間の上限 | 5 分 |
| `permissions` | `contents: read` だけ |
| step | checkout、Node、トークンの発行、`gate` |
| 発行する権限 | `permission-issues: write`・`permission-actions: read`・`permission-organization-projects: write`・`permission-contents: read`・`permission-pull-requests: read`（[research.md](../research.md) の R2 の表）。`gate` は進行の欄を読み、CI の上限では札を `Needs Attention` に書き、ブランチと PR の有無を読む |
| `env` | 下の表 |
| 出力 | `proceed`・`kind`・`issue`・`number`・`branch`。`auto gate` が `GITHUB_OUTPUT` に書いた値を出す |

`gate` の step は、`npx -y --prefix=/ @pecot/workflow-mcp@latest auto gate` の形で CLI を打つ。dist-tag の決め方は、自動レビューの雛形と同じだ。このリポと検証用に置くファイルは、`@next` にする。

`gate` の step が渡す値:

| `env` | 式 | 引数 |
|---|---|---|
| `PECOT_GITHUB_COM_TOKEN` | 発行した App のトークン | 引数にしない。CLI が環境変数から読む |
| `PECOT_AUTO_LABEL` | `${{ vars.PECOT_AUTO_LABEL \|\| 'pecot-auto' }}` | 引数にしない。`gate` が外すラベルの名前を読む |
| `MAX_CI_ATTEMPTS` | `${{ vars.PECOT_AUTO_MAX_CI_ATTEMPTS \|\| '3' }}` | `--max-ci-attempts "$MAX_CI_ATTEMPTS"` |
| `PECOT_AUTO_PROJECT` | `${{ vars.PECOT_AUTO_PROJECT }}` | 空でないときだけ `--project "$PECOT_AUTO_PROJECT"` |

イベントは、GitHub Actions が入れる環境変数から `--event-name "$GITHUB_EVENT_NAME"` と `--event-path "$GITHUB_EVENT_PATH"` で渡す。

### `run`

| 項目 | 決め |
|---|---|
| 動く条件 | `gate` の `proceed` が真 |
| 時間の上限 | `fromJSON(vars.PECOT_AUTO_TIMEOUT_MINUTES \|\| '30')` |
| 同時実行 | `group: pecot-auto-<gate の number>`、`cancel-in-progress: false` |
| `permissions` | `contents: read` と `id-token: write`。書き込みは App のトークンで行う。`id-token: write` は、Workload Identity Federation のためだ |
| 発行する権限 | `permission-contents: write`・`permission-issues: write`・`permission-pull-requests: write`・`permission-actions: read`・`permission-organization-projects: write`（[research.md](../research.md) の R2 の表） |
| step | 下の表 |

| step | 中身 |
|---|---|
| checkout | `start`・`resume` は既定のブランチ。`ci-fix` は `gate` の `branch`。`persist-credentials: false` |
| Node | `actions/setup-node`。`package-manager-cache: false` を渡す。job が secret を持つためだ |
| トークン | `actions/create-github-app-token`。`permission-*` で、上の権限だけを渡す |
| 利用者の準備 | `# pecot-auto:prepare:begin` と `# pecot-auto:prepare:end` の印のコメントだけ。依存の install などを利用者が足す |
| 自動処理 | claude-code-action。入力は下の表 |
| 後始末 | `if: always()` で `auto finish "$GITHUB_REPOSITORY/$ISSUE" --ensure` を、`npx -y --prefix=/ @pecot/workflow-mcp@latest` で打つ。値は `env` で受けて、引用符付きの引数で渡す（下の表） |

後始末の step が渡す値:

| `env` | 式 | 引数 |
|---|---|---|
| `ISSUE` | `${{ needs.gate.outputs.number }}` | コマンドの引数の一部 |
| `JOB_STATUS` | `${{ job.status }}` | `--job-status "$JOB_STATUS"` |
| `EXECUTION_FILE` | `${{ steps.claude.outputs.execution_file }}` | `--execution-file "$EXECUTION_FILE"` |
| `PECOT_AUTO_LABEL` | `${{ vars.PECOT_AUTO_LABEL \|\| 'pecot-auto' }}` | 引数にしない。CLI が環境変数から読む |
| `PECOT_GITHUB_COM_TOKEN` | 発行した App のトークン | 引数にしない |
| `PECOT_AUTO_PROJECT` | `${{ vars.PECOT_AUTO_PROJECT }}` | 空でないときだけ `--project "$PECOT_AUTO_PROJECT"` |

- `run:` に式を直接埋め込まない。値は中間の環境変数で渡す
- `--execution-file` は空でもよい。空なら、その行を飛ばして判定する
- 環境変数 `GITHUB_RUN_ID`・`GITHUB_RUN_ATTEMPT` は、GitHub Actions が入れる。結果のコメントの目印に使う

### `setup`

変数 `PECOT_AGENT_APP_CLIENT_ID` が空のまま起動ラベルが付いたときに、足りない設定を Issue に書く（[research.md](../research.md) の R4、FR-021）。App が無いので、run のトークン（`GITHUB_TOKEN`）で書く。

| 項目 | 決め |
|---|---|
| 動く条件 | 変数 `PECOT_AGENT_APP_CLIENT_ID` が空で、ラベルの名前が起動ラベルと同じ。`gate` の動く条件と、変数の比べだけが逆になる |
| 時間の上限 | 5 分 |
| `permissions` | `contents: read` と `issues: write`。結果のコメントの投稿と、ラベルを外すためだ |
| step | checkout、Node、`Report` |

`Report` の step は、次の順に動く。値はすべて `env` で受け、`run:` に式を埋め込まない。

1. ラベルを付けた人（`sender`）の名前が `[bot]` で終われば、何も書かずに終わる
2. その人の権限を `collaborators/<login>/permission` の `permission` で読む。`admin`・`write` でなければ（読めないときも）、何も書かずに終わる。`gate` の判定と同じだ
3. `env` の本文を `$RUNNER_TEMP` のファイルに書き、`auto finish "$GITHUB_REPOSITORY/$ISSUE" --result setup-missing --body-file "$BODY_FILE"` を打つ
   - CLI は、`npx -y --prefix=/ @pecot/workflow-mcp@latest` で取る。`PECOT_AUTO_PROJECT` が空でないときだけ `--project` を足す

| `env` | 式 |
|---|---|
| `GH_TOKEN`・`PECOT_GITHUB_COM_TOKEN` | `${{ github.token }}` |
| `PECOT_AUTO_LABEL` | `${{ vars.PECOT_AUTO_LABEL \|\| 'pecot-auto' }}` |
| `PECOT_AUTO_PROJECT` | `${{ vars.PECOT_AUTO_PROJECT }}` |
| `ISSUE` | `${{ github.event.issue.number }}` |
| `SENDER` | `${{ github.event.sender.login }}` |
| `BODY` | 本文。式を持たない |

本文には、空の変数の名前、自前の App に要る変数 `PECOT_AGENT_APP_CLIENT_ID` と secret `PECOT_AGENT_APP_PRIVATE_KEY` の置き場所、`pecot workflow doctor auto` で確かめることを書く。結果のコメントの書き方（段落の中で改行しない、プレースホルダを残さない）に従う。

プロジェクトの設定を復元する step は置かない。ツールが、対象のリポから設定を決める（#579）。
action はすべて SHA で固定し、版をコメントに書く。

## claude-code-action の入力

| 入力 | 値 |
|---|---|
| `claude_code_oauth_token` | secret `CLAUDE_CODE_OAUTH_TOKEN` |
| `anthropic_federation_rule_id`・`anthropic_organization_id`・`anthropic_service_account_id`・`anthropic_workspace_id` | secret のトークンが無いときだけ、変数 `PECOT_AGENT_ANTHROPIC_*` を渡す。あるときは空を渡す（spec 027 の R14） |
| `github_token` | 発行した App のトークン |
| `plugin_marketplaces` | `https://github.com/pecotcraft/pecot.git` |
| `plugins` | `pecot-w@pecot` |
| `prompt` | `/pecot-w:w-auto <gate の kind> <gate の issue>`。変数 `PECOT_AUTO_PROJECT` があるときだけ `project=<名前>` を足す。`pecot-review.yml` と同じ書き方だ |
| `allowed_bots` | 発行の step の出力 `app-slug`。`<slug>` と `<slug>[bot]` のどちらでも通る。`*` は使わない |
| `claude_args` | `--permission-mode default`・`--max-turns`・`--allowedTools`・`--disallowedTools` |

設定しない入力:

- `anthropic_api_key`。`CLAUDE_CODE_OAUTH_TOKEN` か Workload Identity Federation を使う
- `allowed_non_write_users`。書き込み権限の無い人を通す入力だ
- `track_progress`。追跡コメントの付く別のモードに切り替わる

`prompt` に Issue の本文・タイトル・コメントを式で埋め込まない。渡すのは、種類・リポの名前・Issue の番号だけだ。
`allowed_bots` を置くと、action の権限のモードの既定が auto にならない。雛形は `--permission-mode default` を明示する。

環境変数 `PECOT_GITHUB_COM_TOKEN` に、同じ App のトークンを渡す。環境変数 `PECOT_AUTO_LABEL` も、`gate` の step・後始末の step・action の step の `env` に渡す。スキルが呼ぶ `auto_finish` が、外すラベルの名前を読むためだ。

## 許可するツール

| ツール | 使い道 |
|---|---|
| `Read`・`Glob`・`Grep` | コードを読む |
| `Edit`・`Write` | 修正する。自動レビューと違い、この自動処理は直すのが仕事なので許す |
| `mcp__plugin_pecot-w_pecot-workflow__<ツール名>` | pecot の手順。ツールは `session_start`・`issue_comment`・`pr_check`・`pr_create`・`auto_start`・`auto_finish` |
| `Bash(git status:*)`・`Bash(git diff:*)`・`Bash(git log:*)`・`Bash(git fetch:*)`・`Bash(git checkout:*)`・`Bash(git add:*)`・`Bash(git commit:*)`・`Bash(git push:*)` | ブランチの操作とコミット |
| `Bash(gh pr checks:*)`・`Bash(gh run view:*)` | 落ちた CI を読む |
| `PECOT_AUTO_EXTRA_ALLOWED_TOOLS` | 利用者のテストのコマンド。job の `env` に `# pecot-auto:allowed-tools:begin` と `:end` の印のコメントで囲んで置き、`--allowedTools` の末尾に、空でないときだけ足す。初期は空 |

`Bash(pecot *)` は許さない。pecot の手順は、MCP ツールで呼ぶ。

`--allowedTools` は、確認なしに使えるツールの一覧として働く。使わせないツールは `--disallowedTools` に書く。

- `Agent`・`AskUserQuestion`
- `WebFetch`・`WebSearch`
- `Bash(git clone:*)`。pecot-w の hook が allow を返すので、deny の規則で塞ぐ
- `Read(//proc/**)`。`/proc/self/environ` から環境変数のトークンを読ませない
- `gh api`・`gh pr merge`・`gh issue close`・`gh release`・`curl`・`wget` は許可に書かない。規則の無いコマンドは、`default` のモードで拒まれる

許可リストは境界ではない。main への push を止めるのは、保護されたブランチの ruleset と App の権限だ。導入の手順に、ruleset があることを前提として書く。

## 版の目印

- ファイルの 1 行目に `# pecot-workflow-template: auto <版>` を置く
- 版は整数で、雛形の中身を変えるたびに 1 つ上げる
- 利用者が足す行（CI の名前、準備の step、許可の変数）は、`# pecot-auto:<囲み>:begin` と `:end` の印のコメントで囲む。`pecot workflow install auto --force` は、囲みの中を消す前に出す
- 許可を `claude_args` の中に書かない。`claude_args: >-` の中の `#` の行はコメントにならず、引数として渡る
- 利用者が変える値は変数にあるので、雛形を上書きしても消えない。消えるのは、囲みの中の行だけだ

## テストで確かめること

| 確かめること | 方法 |
|---|---|
| YAML として読める | 雛形を読み込む |
| 1 行目が `# pecot-workflow-template: auto <版>` | 1 行目を読む |
| 契機が `issues: labeled` と `workflow_run: completed` だけ | 読み込んだ `on` を比べる |
| `pull_request_target` が無い | キーの有無を見る |
| `gate` の `if` が、変数 `PECOT_AGENT_APP_CLIENT_ID` と起動ラベルを `vars` で読み、`env.` を読んでいない | 式の文字列を探す |
| `allowed_non_write_users`・`track_progress`・`anthropic_api_key` が無い | キーの有無を見る |
| `prompt` に `github.event.issue.body`・`title`・`comment.body` の式が無い | 文字列を探す |
| `run` の job に `timeout-minutes`・`concurrency` があり、`timeout-minutes` が `fromJSON` で数に直している | 式の文字列を探す |
| 4 つの変数に、既定値の式がある | 式の文字列を探す |
| `claude_code_oauth_token` があり、Workload Identity Federation の 4 つの入力が、secret のあるときに空になる式を持つ | 式の文字列を探す |
| `allowed_bots` が、発行の step の出力 `app-slug` を読む | 式の文字列を探す |
| `claude_args` に `--permission-mode default`・`--max-turns`・`--allowedTools`・`--disallowedTools` があり、`#` が無い | 文字列を探す |
| 許可リストに `Edit`・`Write` と 6 つの MCP ツールがあり、`Bash(pecot` が無い | 文字列を探す |
| `--disallowedTools` に `Agent`・`AskUserQuestion`・`WebFetch`・`WebSearch`・`Bash(git clone:*)`・`Read(//proc/**)` があり、`Edit`・`Write` が無い | 文字列を探す |
| 許可リストに、マージ・クローズ・リリースのツール（`pr_merge`・`release_create` など）が無い | 文字列を探す |
| トークンの発行の step の `permission-*` が、job ごとの表と一致する | `with` のキーを比べる |
| `gate`・`run`・`setup` の `permissions` が、表のとおり | 読み込んだ値を比べる |
| `gate` が `proceed`・`kind`・`issue`・`number`・`branch` を job の出力にする | 読み込んだ `outputs` を比べる |
| `gate` の step の `env` に `PECOT_GITHUB_COM_TOKEN`・`PECOT_AUTO_LABEL`・`MAX_CI_ATTEMPTS`・`PECOT_AUTO_PROJECT` があり、`--project` を空でないときだけ足す | `env` のキーを見て、偽の `npx` で `run` を動かす |
| 後始末の step が `if: always()` を持ち、`JOB_STATUS`・`EXECUTION_FILE` を `env` で受けて、`run` に `${{` が無い | `env` のキーと `run` の文字列を見る |
| `setup` の `if` が、変数 `PECOT_AGENT_APP_CLIENT_ID` が空であることと起動ラベルを `vars` で読み、`env.` を読んでいない | 式の文字列を探す |
| `setup` が App のトークンを発行しない | `uses` の有無を見る |
| `setup` の `Report` が、`[bot]` の名前と `admin`・`write` でない人（権限を読めないときも）では何も書かずに終わる | 偽の `gh`・`npx` で `run` を動かす |
| `setup` の `Report` が、`auto finish "$GITHUB_REPOSITORY/$ISSUE" --result setup-missing --body-file "$BODY_FILE"` を打ち、本文が書き方に従い、`run` に `${{` が無い | 偽の `gh`・`npx` で `run` を動かし、本文を確かめる |
| `PECOT_AUTO_LABEL` が、`gate`・後始末・action の step の `env` にある | `env` のキーを見る |
| 利用者が足す許可と CI の名前が、印の囲みの中にある | 印のコメントを探す |
| action がすべて SHA で固定されている | `uses` の形を見る |
| このリポ固有の名前（`pecotcraft/pecot` の設定の名前、CI の名前）が、書き出した結果に残らない | 書き出した結果を探す |
| 導入の説明に書いた変数・secret の名前が、雛形と同じ | 文書と雛形を比べる |

actionlint は pre-commit が掛ける。
