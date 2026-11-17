# 自動レビューのワークフロー

PR を作ると、GitHub Actions の上で w-revise のレビューを回し、インラインコメントと指摘の一覧を PR に載せる雛形です。置くかどうかは任意で、置かなくても端末で `/pecot-w:w-revise` を回せば同じレビューができます。

自動レビューは指摘の投稿で終わります。コードを直さず、push・マージ・クローズもしません。採否と直しは、人が端末の w-revise で続けます。

## 前提

- pecot-workflow の MCP ツール `workflow_install` と `workflow_doctor` を使える版であること
- リポが github.com にあること。GHES では確かめていない（「GHES」の節）
- モデルの利用の認証を、次のどちらかで用意できること
  - Claude のサブスクリプション（既定）
  - Claude Platform の Workload Identity Federation

## 導入

### 1. 雛形を置く

pecot-workflow の MCP ツール `workflow_install`（`name: "review"`）で、雛形をリポに書き出します。

- 雛形: `${CLAUDE_PLUGIN_ROOT}/cli/templates/workflow/pecot-review.yml`
- 置き先: 利用者のリポの `.github/workflows/pecot-review.yml`
- 既にファイルがあると、上書きせずに止まる。更新は「雛形を更新する」の節

### 2. Claude の GitHub App を入れる

[Claude の GitHub App](https://github.com/apps/claude) を、雛形を置くリポに入れます。Claude Code の `/install-github-app` からも入れられます。

- インラインコメントは、この App のトークンで投稿する
- App のトークンは Contents・Issues・Pull requests の write を持ち、絞れない。エージェントには、書き換えのツールと `Bash` を渡さないことで、リポを書き換えさせない
- 権限を絞りたいときは、「自前の GitHub App」の節の手順を足す

### 3. モデルの認証の secret を登録する

Settings > Secrets and variables > Actions に、secret `CLAUDE_CODE_OAUTH_TOKEN` を置きます。

- トークンは、手元の端末で `claude setup-token` を打って作る
- 改行を入れず、1 行で貼る。改行が入ると `401 OAuth access token is invalid` で止まる
- サブスクリプションでなく API の利用で払うときは、secret を置かずに「Workload Identity Federation」の節の 4 つの変数を置く

### 4. 確かめる

pecot-workflow の MCP ツール `workflow_doctor`（`name: "review"`）で、雛形と設定がそろっているかを確かめます。

- 雛形の有無と版、secret と変数の名前の有無を見る。値は読まない
- Claude の App が入っているかは読めないので、`skipped` で出る。確かめ方は「Claude の App が入っているか」の節
- secret と変数の一覧を読むのに要る権限は、[認証・設定ファイル](auth-config.md) の「エージェント用の認証」にある

### 5. 既定のブランチへ入れる

雛形をコミットし、既定のブランチへ入れます。`workflow_doctor` は作業ツリーのファイルを読むだけなので、既定のブランチへ入れるまでは通っても動きません。

- Claude の App のトークンは、ワークフローのファイルが既定のブランチと同じ中身のときだけ受け取れる
- 雛形を足す PR そのものでは、レビューは飛ばされる（「雛形を変えた PR」の節）

入れた後に PR を作るか、draft の PR を ready にすると、最初のレビューが始まります。

## 合言葉

PR に合言葉のコメントを書くと、もう一度レビューが始まります。既定の合言葉は `@pecotbot review` です。

- コメントの本文が合言葉と同じか、合言葉の直後が空白か改行のときだけ起動する。`@pecotbot reviewer` や、文の途中の合言葉では起動しない
- 起動できるのは、リポに書き込み権限のある人だけ。read・triage の人のコメントは、job が飛ばされる
- 受け付けると、コメントに 👀 のリアクションが付く
- 2 巡目以降の指摘は、`R2/F-01` のように巡の番号を付けて採番する
- 変えるときは、変数 `PECOT_REVIEW_TRIGGER_PHRASE` を置く

## 自前の GitHub App

インラインコメントのトークンも権限を絞りたい利用者だけが足す手順です。置けば、雛形はこの App のトークンを発行し、Claude の App の代わりに使います。

- App の権限
  - Pull requests: read and write
  - Contents: read
- リポの変数 `PECOT_AGENT_APP_CLIENT_ID` に App の Client ID を置く
- リポの secret `PECOT_AGENT_APP_PRIVATE_KEY` に秘密鍵を置く
- App をリポに入れる

雛形は、トークンを発行するときに、上の 2 つの権限だけに絞ります。同じ App をほかの自動処理にも使うときは、インストールで与える権限を、使う自動処理が要る権限の合計にします。

- インストールで与えた権限は、`workflow_doctor` では読めない。GitHub の App の設定画面の Permissions で確かめる
- 自前の App では、インラインコメントと指摘の一覧が、どちらも App の名前で付く。Claude の App のときは、インラインコメントが `claude[bot]`、指摘の一覧が `github-actions[bot]` で付く

## Workload Identity Federation

Claude Platform の組織で払うときの認証です。secret `CLAUDE_CODE_OAUTH_TOKEN` を置かず、次の 4 つの変数を置きます。

| 変数 | 中身 |
|---|---|
| `PECOT_AGENT_ANTHROPIC_FEDERATION_RULE_ID` | federation のルールの ID |
| `PECOT_AGENT_ANTHROPIC_ORGANIZATION_ID` | 組織の ID |
| `PECOT_AGENT_ANTHROPIC_SERVICE_ACCOUNT_ID` | service account の ID |
| `PECOT_AGENT_ANTHROPIC_WORKSPACE_ID` | workspace の ID |

ルールの subject の prefix は、GitHub の API が返す値から作ります。

1. `gh api repos/<owner>/<repo>/actions/oidc/customization/sub --jq .sub_claim_prefix` を打つ
2. 返った値（例: `repo:pecotcraft@351183614/pecot-sandbox@1455471836`）を、ルールの subject の prefix にする

2026-07-15 より後に作ったリポでは、subject が組織とリポの ID を含む形になります。Anthropic の文書の例は古い形で、そのまま使うとルールに拒まれます。

- 組織にクレジットが無いと、`Credit balance is too low` で止まる
- secret `CLAUDE_CODE_OAUTH_TOKEN` があると、そちらを使い、4 つの変数は使わない

## 雛形を変えた PR

Claude の App を使う構成では、雛形のファイルを足す・変える PR でレビューが動きません。

- action が、ワークフローのファイルが既定のブランチと違うことを見て、レビューを飛ばす
- job は成功で終わり、止まったことを知らせるコメントも付かない。実行の記録に `Workflow validation failed` が出る
- 雛形を変えた PR は、端末の `/pecot-w:w-revise` でレビューする

自前の App を使う構成では、この確かめはありません。

## 運用

### 変えられる値

リポの変数に置くと、雛形の既定値より優先します。変数が無ければ、既定値で動きます。

| 変数 | 既定値 | 意味 |
|---|---|---|
| `PECOT_REVIEW_TRIGGER_PHRASE` | `@pecotbot review` | 起動し直しの合言葉 |
| `PECOT_REVIEW_ALLOWED_BOTS` | `[]` | PR をレビューする bot の名前。JSON の配列で書く（例: `["my-app[bot]"]`） |
| `PECOT_REVIEW_MAX_TURNS` | `60` | main のターンの上限。サブエージェントの中のやり取りは数えない |
| `PECOT_REVIEW_TIMEOUT_MINUTES` | `30` | job の時間の上限。分 |

雛形を上書きしても、変数は消えません。

### bot の PR をレビューする

雛形の既定値のままだと、bot が作った PR はレビューしません。名前を `PECOT_REVIEW_ALLOWED_BOTS` の配列に足すと、その bot の PR もレビューします。

名前の一部だけが合うものは通しません。`[bot]` まで含めて書きます。

### Dependabot の PR

Dependabot が起こした実行は、Actions の secret でなく Dependabot の secret を読みます。

1. `PECOT_REVIEW_ALLOWED_BOTS` に `"dependabot[bot]"` を足す
2. 使うモデルの認証の secret（と、自前の App の秘密鍵）を、Settings > Secrets and variables > Dependabot にも置く

### 止まったときの読み方

レビューを終えたときは、指摘の一覧だけが付きます。止まったときは、`Review stopped` で始まるコメントが 1 つ付きます。

| 結果 | 起きたこと | 次にすること |
|---|---|---|
| `limit` | ターンか時間の上限で止まった | 大きな PR は端末で `/pecot-w:w-revise` を回す。自動で回すなら `PECOT_REVIEW_MAX_TURNS`・`PECOT_REVIEW_TIMEOUT_MINUTES` を上げ、合言葉で起動し直す |
| `setup-missing` | 要る権限か設定が足りない | コメントにある足りないものを整える。Claude の App が入っていないときもこれになる。整えてから合言葉で起動し直す |
| `failed` | それ以外の失敗。モデルの API の失敗（認証・クレジット）を含む | 実行の記録を読み、合言葉で起動し直すか、端末の w-revise を回す |

コメントの「止まった場所」が「インラインコメントを投稿した後」なら、インラインコメントは付いていて、指摘の一覧がまだありません。起動し直すと、前の巡と同じ趣旨の指摘は新しく投稿せず、前のスレッドに返信します。

PR のチェックの行から、実行の記録へ行けます。時間の上限の `cancelled` は、人が実行を手で取り消したときと区別できません。

### トークンを作り直す

`claude setup-token` で作ったトークンが切れると、モデルの API の認証で止まり、`failed` のコメントが付きます。

1. 手元で `claude setup-token` を打ち、新しいトークンを作る
2. secret `CLAUDE_CODE_OAUTH_TOKEN` を、1 行で上書きする

### 払い方を切り替える

| 切り替え | 手順 |
|---|---|
| サブスクリプション → Workload Identity Federation | 4 つの変数を置いてから、secret `CLAUDE_CODE_OAUTH_TOKEN` を消す |
| Workload Identity Federation → サブスクリプション | secret `CLAUDE_CODE_OAUTH_TOKEN` を置く。4 つの変数は残してよい |

secret の有無だけで切り替わります。雛形は書き換えません。

### 雛形を更新する

雛形の 1 行目の版の目印で、置いた雛形が古いかを確かめます。

- `workflow_install` に `check: true` を付けると、書かずに版だけを比べる。`workflow_doctor` も、古いと `outdated` を出す
- 更新は `workflow_install` に `force: true` を付けて上書きする
- 上書きの前に、利用者が足した行のうち消えるものを出す。囲みの中に足した行は、上書きの後に足し直す

利用者が足してよい行は、次の 2 つの囲みの中だけです。

| 囲み | 足すもの |
|---|---|
| `pecot-review:allowed-tools` | レビューの準備に要るツールの許可。job の `env` の `PECOT_REVIEW_EXTRA_ALLOWED_TOOLS` にカンマ区切りで書く |
| `pecot-review:prepare` | 依存のインストールなど、レビューの前に動かす step。上の step と同じ `if` を付ける |

後始末の step は、npm の最新の正式版の `@pecot/workflow-mcp` を取ります。major が上がると、互換の無い変更も次の実行から入ります。`@latest` を `@<major>` か `@<版>` に替えると、取る版を留められます。

### Claude の App が入っているか

`workflow_doctor` では確かめられません。次のどちらかで見ます。

- リポの Settings > GitHub Apps に `Claude` がある
- 組織のリポなら、組織の Settings > GitHub Apps の `Claude` の Configure で、対象のリポが選ばれている

入っていないと、レビューが始まった後で `setup-missing` のコメントが付きます。

### GHES

github.com で確かめた構成です。GHES では確かめていません。

- Claude の GitHub App は github.com の App なので、GHES では自前の App の構成になる
- token を渡す環境変数の名前が変わる。名前は `PECOT_GITHUB_<HOST>_TOKEN` で、`<HOST>` はホスト名を大文字にし、ドットをアンダースコアに替えたもの
- 次の 2 つも前提になる
  - 雛形が SHA で固定した版の action（`anthropics/claude-code-action` など）を使える
  - Actions の実行環境から npm の registry に届く

## 自動処理に共通の決まり

自動レビューと、後に続く pecot の自動処理の雛形が、同じ形で持つ決まりです。

| 決まり | 形 |
|---|---|
| 認証の名前 | エージェント用の変数と secret は、[認証・設定ファイル](auth-config.md) の「エージェント用の認証」の名前を使う。雛形ごとに名前を作らない |
| 版の目印 | 1 行目のコメントに、雛形の名前と整数の版を書く。版は、雛形の中身を変えるたびに 1 つ上げる。`workflow_install` の `check` と `workflow_doctor` が、この版を比べる |
| 利用者が足す行の印 | `# pecot-<名前>:<囲み>:begin` と `# pecot-<名前>:<囲み>:end` のコメントで囲む。`workflow_install` の `force` は、囲みの中の行を消す前に出す |
| 起動する人の確かめ | fork・draft・許していない bot の PR では動かない。コメントでの起動は、`author_association` と、書いた人の権限（admin・maintain・write）の両方を見る |
| 許可するツール | `--allowedTools` に、使うツールだけを並べる。これは確認なしで使えるツールの一覧で、境界にはならない |
| 拒否するツール | 書き換えのツール・`Bash`・`Agent` を `--disallowedTools` に書く。リポを書き換えさせない境界は、こちらが持つ |
| 上限 | ターンと時間の上限を、変数で変えられる既定値として持つ |
| 止まったとき | 後始末の step が `if: always()` で動き、止まったことを PR に 1 つだけ書く |
