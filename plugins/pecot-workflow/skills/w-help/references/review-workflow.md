# 自動レビューのワークフロー

PR を作ると、GitHub Actions の上で w-review のレビューを回し、インラインコメントと指摘の一覧を PR に載せる雛形です。置くかどうかは任意です。w-review は、この雛形からだけ起こします。

自動レビューは指摘の投稿で終わります。コードを直さず、push・マージ・クローズもしません。採否と直しは、PR を作った人が端末の w-pr の Step 5 で続けます。

## 前提

- pecot-workflow の MCP ツール `workflow_install` と `workflow_doctor` があること。呼んで、ツールが見つからないと言われなければよい
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
- App のトークンは Contents・Issues・Pull requests の write を持ち、絞れない。エージェントには、書き換えのツールを渡さず、`Bash` は PR を読む `gh pr diff`・`gh pr view` だけを許すことで、リポを書き換えさせない
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

## コンフリクトしていた PR

GitHub は、base とコンフリクトしている PR では、PR を作ったときと ready にしたときのワークフローを動かしません。雛形は、PR への push でも起動し、まだ自動レビューの付いていない PR だけをレビューします。

- 開いた時点でコンフリクトしていた PR は、コンフリクトを解いた push で最初のレビューが始まる
- 自動レビューの跡は、bot が付けた指摘の一覧と、止まったことを知らせるコメントで見る。跡のある PR への push では、job は動くがレビューを飛ばす
- base の側の変更でコンフリクトが消えたときは、PR のイベントが起きない。合言葉で起動する
- 雛形を入れる前からある PR のうち、自動レビューの付いていないものは、入れた後の最初の push でレビューが始まる
- 雛形を変えた PR はレビューが飛ばされて跡が残らないので、push のたびに job が動く。かかるのは runner の時間だけで、モデルは呼ばない

## 合言葉

PR に合言葉のコメントを書くと、もう一度レビューが始まります。既定の合言葉は `@pecotbot review` です。

- コメントの本文が合言葉と同じか、合言葉の直後が空白か改行のときだけ起動する。`@pecotbot reviewer` や、文の途中の合言葉では起動しない
- 起動できるのは、リポに書き込み権限のある人だけ。書き込み権限の無い人のコメントでは、レビューは動かず、PR には何も付かない。実行の記録には、成功の run が残る
- 合言葉のコメントより後に PR へ push されたコミットは、レビューしない。push した後に、もう一度合言葉を書く
- 受け付けると、コメントに 👀 のリアクションが付く
- 2 巡目以降は、前の指摘が直ったかを先に見て、指摘の一覧に「直った」か「対応」を書く。新しい指摘には、PR の中の通し番号の続きを振る
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
- 雛形を変えた PR は、人がレビューする。自前の App を使う構成なら、自動レビューが動く

自前の App を使う構成では、この確かめはありません。

## 運用

### 変えられる値

リポの変数に置くと、雛形の既定値より優先します。変数が無ければ、既定値で動きます。

| 変数 | 既定値 | 意味 |
|---|---|---|
| `PECOT_REVIEW_TRIGGER_PHRASE` | `@pecotbot review` | 起動し直しの合言葉 |
| `PECOT_REVIEW_ALLOWED_BOTS` | `[]` | PR をレビューする bot の名前。JSON の配列で書く（例: `["my-app[bot]"]`） |
| `PECOT_REVIEW_MODEL` | `opus` | レビューに使うモデル。別名（`opus`・`sonnet` など）か、完全な名前で書く |
| `PECOT_REVIEW_EFFORT` | `high` | effort の段階。`low`・`medium`・`high`・`xhigh`・`max` のどれか |
| `PECOT_REVIEW_MAX_TURNS` | `60` | main のターンの上限 |
| `PECOT_REVIEW_TIMEOUT_MINUTES` | `30` | job の時間の上限。分 |
| `PECOT_REVIEW_PROJECT` | 空 | レビューで使うプロジェクトの設定の名前。`.pecot/config/projects/` のファイル名から `.json` を除いて書く |
| `PECOT_REVIEW_WEB_ACCESS` | `true` | `false` にすると、外の文書を引かない |

`PECOT_REVIEW_PROJECT` は、リポが 2 つ以上のプロジェクトの設定に入っているときに置きます。置かないと、pecot の MCP ツールが設定を選べず、レビューが止まります。設定が 1 つのリポでは要りません。

雛形を上書きしても、変数は消えません。

### 外の文書を引く

自動レビューは、指摘の根拠に、外の公式の文書を引きます。

| 手段 | 読めるもの |
|---|---|
| Context7 | ライブラリ・フレームワークの文書 |
| `WebSearch` | 検索の結果の題と URL。ページの中身は読まない |
| `WebFetch` | `docs.github.com` と、Claude Code が承認なしで読ませる組み込みの文書のドメインのページだけ |

`WebFetch` で読むドメインは、雛形の `pecot-review:allowed-tools` の行で足します。`PECOT_REVIEW_EXTRA_ALLOWED_TOOLS` に `WebFetch(domain:example.com)` の形で書きます。PR に仕込まれた指示で読まされても困らない、信頼できるドメインだけを足します。

検索の語と URL には、diff の文の入ることがあります。private のリポでコードを外へ出したくないときは、変数 `PECOT_REVIEW_WEB_ACCESS` を `false` にします。

Context7 は、API キーが無くても使えます。キーを使うと、回数の上限が上がります。Context7 でキーを作り、secret `CONTEXT7_API_KEY` に置きます。

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
| `limit` | ターンか時間の上限で止まった | `PECOT_REVIEW_MAX_TURNS`・`PECOT_REVIEW_TIMEOUT_MINUTES` を上げ、合言葉で起動し直す |
| `setup-missing` | 要る権限か設定が足りない | コメントにある足りないものを整える。Claude の App が入っていないときもこれになる。整えてから合言葉で起動し直す |
| `failed` | それ以外の失敗。モデルの API の失敗（認証・クレジット）を含む | 実行の記録を読み、原因を除いてから合言葉で起動し直す |

コメントの「止まった場所」が「インラインコメントを投稿した後」なら、インラインコメントは付いていて、指摘の一覧がまだありません。起動し直すと、前の指摘と同じ趣旨のものは新しく投稿せず、指摘の一覧で前のスレッドを指します。

PR のチェックの行から、実行の記録へ行けます。時間の上限の `cancelled` は、人が実行を手で取り消したときと区別できません。

### 実行の記録

run の Summary に、レビューの実行の記録が出ます。PR のチェックの行から run を開き、Summary を見ます。

| 表 | 中身 |
|---|---|
| `Review run` | 使われたモデルと effort、ターンの数、結果 |
| `Tool calls` | 呼んだツールを順に。ツールの名前と、読んだパス・打ったコマンド・URL などの対象 |
| `Denied calls` | 許可が無くて拒まれた呼び出しの、ツールの名前と対象 |

effort は、Claude Code が実際に使った値です。準備の step が環境変数 `CLAUDE_CODE_EFFORT_LEVEL` を置くと、変数 `PECOT_REVIEW_EFFORT` より強く、その値が出ます。

ツールの出力と、Claude の考えた文は出しません。issue_comment の本文のように、入力の中の本文の項目も出しません。パス・コマンド・パターン・URL・検索の語は 200 文字まで出ます。拒まれた呼び出しも含め、これらは Claude が書いた文を含むことがあります。対象はコードスパンに入れて出すので、リンクや画像にはなりません。記録を作れなかったときも、レビューの結果は変わりません。

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

版 6 で、上の step の `if` が変わりました。版 5 から更新するときは、`pecot-review:prepare` に足した step の `if` も、上の step と同じ式に直します。直さないと、レビューを飛ばす push の run でも、足した step が動きます。

雛形は、job の `concurrency` に `queue: max` を書きます。actionlint 1.7.12 はこの項目を知らず、`unexpected key "queue"` を出します。GitHub は受け付けるので、actionlint の設定でこのファイルの指摘を外します。

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
- 雛形の Review と Finish の 2 つの step の `env` にある `PECOT_GITHUB_COM_TOKEN` を、その名前に替える
- 次の 2 つも前提になる
  - 雛形が SHA で固定した版の action（`anthropics/claude-code-action` など）を使える
  - Actions の実行環境から npm の registry に届く
  - Actions の実行環境から、github.com の pecot のマーケットプレイス（`pecotcraft/pecot`）に届く。雛形は、そこからプラグインを取る

## 自動処理に共通の決まり

自動レビューと、後に続く pecot の自動処理の雛形が、同じ形で持つ決まりです。

| 決まり | 形 |
|---|---|
| 認証の名前 | エージェント用の変数と secret は、[認証・設定ファイル](auth-config.md) の「エージェント用の認証」の名前を使う。雛形ごとに名前を作らない |
| 版の目印 | 1 行目のコメントに、雛形の名前と整数の版を書く。版は、雛形の中身を変えるたびに 1 つ上げる。`workflow_install` の `check` と `workflow_doctor` が、この版を比べる |
| 利用者が足す行の印 | `# pecot-<名前>:<囲み>:begin` と `# pecot-<名前>:<囲み>:end` のコメントで囲む。`workflow_install` の `force` は、囲みの中の行を消す前に出す |
| 起動する人の確かめ | fork・draft・許していない bot の PR では動かない。コメントでの起動は、`author_association` と、書いた人の権限（admin・maintain・write）の両方を見る |
| 許可するツール | `--allowedTools` に、使うツールだけを並べる。これは確認なしで使えるツールの一覧で、境界にはならない |
| 拒否するツール | 書き換えのツール・`Agent` を `--disallowedTools` に書く。権限のモードは `default` にし、規則の無いコマンドを拒ませる。プラグインの hook が allow を返すコマンド（`git clone`）と、環境変数を読める `/proc` は、拒否の規則で塞ぐ |
| 上限 | ターンと時間の上限を、変数で変えられる既定値として持つ |
| 止まったとき | 後始末の step が `if: always()` で動き、止まったことを PR に 1 つだけ書く |
