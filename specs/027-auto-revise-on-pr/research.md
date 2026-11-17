# Research: PR を作ると、GitHub Actions の上で w-revise のレビューが始まる

spec の Clarifications（2026-11-16）の 6 点を前提にする。

外部の仕様は、2026-11-16 に公式のリポと文書を読んで確かめた。
読んだ版は、claude-code-action の `v1.0.276`（`f3b070c8`。同梱の Claude Code は 2.1.325）と、github/docs の `ba073ff7` だ。
写しは `.pecot/work/489/tech-advisor/` にある。
spec 023 の research（2026-11-11、`v1.0.271`）で確かめた事実は繰り返さない。PR を契機にする場合の違いだけを書く。

## 調べた現状

| 対象 | 現状 |
|---|---|
| pecot-workflow の CLI | TypeScript（`cli/src/`）。`bin/pecot` が Node で起動する。spec 023 の plan は Python の CLI を前提にしていて、今の形と合わない |
| MCP サーバ | プラグインの `.mcp.json` が `bin/pecot mcp` を起動する。スキルは MCP ツール（`pr_show`・`issue_comment` など）を使う |
| 配布済みのワークフローの雛形 | `cli/templates/workflow/pecot-board-sync.yml` が 1 つある。利用者が写して置く。説明は `w-help/references/board-sync-workflow.md`、テストは `cli/tests/board-sync-workflow-template.test.ts` |
| 雛形から CLI を打つ形 | `npx -y --prefix=/ @pecot/workflow-mcp@latest <コマンド>`。`@latest` は最新の正式版、`@next` は main に入った後の開発版だ（#499） |
| 雛形の action の指定 | SHA で固定し、版をコメントに書く |
| 雛形のトークン | 変数 `PECOT_BOARD_SYNC_APP_CLIENT_ID` と secret で、`actions/create-github-app-token` が発行する。発行のときに `permission-*` で権限を絞る |
| CLI のトークン | `PECOT_GITHUB_COM_TOKEN` を読む。GHES はホストの名前から作る |
| 雛形を書き出す仕組み | 無い。導入に要る設定を確かめる仕組みも無い |
| w-revise | Step 1〜3 がレビューと投稿、Step 4 が採否の質問、Step 5〜6 が修正と報告。Step 3 は、投稿の手段として `gh api` の手順を書いている |
| w-reviewer | プラグインの `agents/` にあるサブエージェント。編集のツールと AskUserQuestion を持たない |
| w-onboarding | ワークフローの雛形に触れていない |
| プラグインの hooks | `hooks.json` に 6 種類ある。Epic #387 で減らしている途中だ |

## R1. 実行の基盤と契機

- Decision: 契機は `pull_request` の `opened`・`ready_for_review` と、`issue_comment` の `created`（合言葉での起動し直し、R15）にする。claude-code-action の v1 を、`prompt` を渡す形（agent モード）で動かす
- Rationale: どの契機も、`prompt` があれば agent モードになる。agent モードは、追跡コメントを付けず、checkout もしない。ブランチも作らない。`track_progress` は指定しない。指定すると、追跡コメントの付く別のモードに切り替わる

決まったこと:

| 項目 | 値 |
|---|---|
| 契機 | `pull_request` と `issue_comment`。`pull_request_target` は使わない |
| `prompt` | `/pecot-w:w-revise --unattended <owner>/<repo>/<PR番号>`。PR の本文とタイトルを式で埋め込まない |
| プラグイン | `plugin_marketplaces` に `https://github.com/pecotcraft/pecot.git`、`plugins` に `pecot-w@pecot`。spec 023 の R1 と同じ |
| checkout | `actions/checkout` を `fetch-depth: 1`・`persist-credentials: false` で使う。`pull_request` では `ref` を書かず、merge commit が入る。`issue_comment` では既定のブランチが入るので、PR の確かめの step が読んだ head の SHA を `ref` に渡す |
| 前準備 | `actions/setup-node`。`bin/pecot` が Node と pnpm で実行用の写しを作るため |

- action は、PR の run で、作業ツリーの `.claude/`・`.mcp.json`・`CLAUDE.md` などを base ブランチの版に置き換える。PR の作者が、設定の差し替えでエージェントを操れない
- `pull_request` の run は、ワークフローのファイルを PR の merge commit から読む。雛形を足す PR そのもので、最初の実行を確かめられる
- `issue_comment` の run は、既定のブランチのワークフローのファイルで動く。合言葉の起動は、雛形が既定のブランチに入ってから確かめられる

- Alternatives considered:

| 候補 | 採らない理由 |
|---|---|
| `pull_request_target` | base の secret と書き込みのトークンで動く。公式は、PR の中身を扱う処理に使わないよう書いている。公開リポでは、既定の policy が 2026-12-02 から止める |
| `pull_request` の `labeled`（起動ラベル） | claude-code-action の公式の例に無い。作成と同時に付けると 2 度レビューする。R15 で、合言葉のコメントに替えた |
| `pull_request_review` など、ほかの契機 | spec が、PR の作成と合言葉のコメントだけと決めている |

## R2. 起動の条件と、起動者の確かめ

- Decision: fork・draft・合言葉・書いた人の関係・bot の判定は、job の `if` に書く。`issue_comment` の fork・draft は、PR を読む step で判定する。書き込み権限の確かめは、action でも重ねて行う。`allowed_non_write_users` は設定しない
- Rationale: action は、`github.actor` の権限を確かめ、admin と write だけを通す。確かめは Claude の起動の前に済む。`if` で先に落とせば、対象外の PR では runner の時間もモデルの費用もかからない

job の `if` は `env` を読めない。公式の表では、`jobs.<job_id>.if` で使える context は `github`・`needs`・`vars`・`inputs` だけだ。
合言葉と、許す bot の一覧は、リポの変数（`vars`）から読み、式の `||` で既定値を持つ。board sync の雛形も、`if` の判定に `vars` を使っている。
`timeout-minutes` も `vars` を読めるので、時間の上限も変数で変えられる。spec 023 の contracts は「式を受け付けない」と書いているが、公式の表と合わない。
ただし、変数の値は文字列で、`timeout-minutes` は数を求める。

- `${{ vars.X || 30 }}` は、変数が無いときだけ動き、変数を置くと run が job を作らずに失敗した（run 44039932798、2026-11-17）。actionlint も型の誤りで止める
- `${{ fromJSON(vars.X || '30') }}` にすると、変数の有無のどちらでも動き、actionlint も通る（run 44040020565・44040534751）

| 起動の試み | 止める仕組み |
|---|---|
| fork からの PR | `if` が、PR の head のリポと導入先のリポを比べる。公式の書き方は `github.event.pull_request.head.repo.full_name == github.repository`。fork の run には secret も渡らない |
| draft の PR | `if` が `github.event.pull_request.draft` を見る |
| 合言葉で始まらないコメント、Issue へのコメント | `if` が、コメントが PR に付いたことと、本文が合言葉で始まり、直後が空白か改行か本文の終わりであることを見る。`prompt` を渡した action は、合言葉を確かめないからだ（R15） |
| 書き込み権限の無い人が、本文を編集する | 契機に無いので、起動しない |
| 書き込み権限の無い人が、合言葉のコメントを書く | `if` が `github.event.comment.author_association` を `OWNER`・`MEMBER`・`COLLABORATOR` と比べ、runner を使わずに飛ばす。action も actor の権限を見て止める。`if` で止めないと、action の失敗を後始末が「止まった」と PR に書く |
| bot が作った PR | `if` が、PR の作者の名前を、許した bot の一覧と比べる。action の `allowed_bots` にも同じ一覧を渡す |

- 書き込み権限のある人が合言葉を書いたとき、action は PR の作者を確かめない。リポの中のブランチから PR を作れるのは、リポに push できる人と bot だけなので、fork の判定で足りる
- `allowed_bots` は、名前を小文字にし、`[bot]` を除いて比べる。`<slug>` と `<slug>[bot]` のどちらで書いても通る。spec 023 で残した問いは、これで決まる
- `allowed_bots` を設定すると、action の権限のモードの既定が変わる。雛形は R5 のとおり、モードを明示する
- Dependabot の PR の run には、Actions の secret が渡らない。Dependabot の secret が渡る。Dependabot を許す利用者は、モデルの認証の secret と App の鍵を、Dependabot の secret にも置く。導入の説明に書く

実装で確かめること:

| 確かめること | 結果 | 版 | 確かめた日 |
|---|---|---|---|
| bot が作者の PR で、プラグインの MCP サーバが起動するか（許した bot の `opened`、許していない bot に人が起動ラベル） | 2 つとも起動し、`pr_show` も動く。どちらの run にも `restrict_untrusted_prs` の警告が出る。制限が止めるのは checkout のコードを動かすコマンドで、MCP サーバの起動は止めない | action v1.0.278・Claude Code 2.1.326・pecot-w 8.0.0 | 2026-11-17 |
| `labeled` の run で、`github.actor` がラベルを付けた人になること | なる。bot の PR に人が付けた run でも、ラベルを付けた人だった | 同上 | 2026-11-17 |
| 自前の GitHub App が作った PR の作者の名前の形 | `pecot-agent-sandbox[bot]`。`user.type` は `Bot`。App の `opened` の run の `github.actor` も同じ名前になる | 同上 | 2026-11-17 |

結果:

- 契約の判定 `contains(fromJSON(vars.PECOT_REVIEW_ALLOWED_BOTS || '[]'), <作者>)` は意図どおり動いた。一覧に無い bot の `opened` は `skipped`、一覧に入れると動いた（run 44040986344・44041242231）
- 警告は `The author of pull request #N is not confirmed to have write access` で始まる（run 44041014404）
- 確かめの head のブランチは、`cuj/567-<4 文字>` の下に置けない。`cuj/567-3w7k` があると `cuj/567-3w7k/bot` は作れないので、別の乱数の名前にした

## R3. GitHub のトークン

- Decision: 利用者が作る GitHub App を 1 つ使う。変数と secret の名前は、自動処理に共通の `PECOT_AGENT_APP_CLIENT_ID` と `PECOT_AGENT_APP_PRIVATE_KEY` にする。ワークフローは、`actions/create-github-app-token` の `permission-*` で、自分に要る権限だけに絞って発行する
- Rationale: Clarifications で、共通の部分をこの spec が先に作ると決めた。App にインストールで与える権限は、使う自動処理の合計にする。発行のときに絞れば、自動レビューのトークンはリポの内容を書き換えられない（FR-011）。後から別の自動処理を足すとき、利用者は App の権限を足すだけで、鍵を作り直さない（SC-009）

自動レビューが発行するトークンの権限:

| 権限 | 範囲 | 使い道 |
|---|---|---|
| Pull requests | write | インラインコメントの投稿、PR へのコメント |
| Contents | read | PR と diff の読み取り |

- 公式の表では、PR へのコメントの投稿は、Issues か Pull requests のどちらかの write で足りる。Issues の write は付けない
- 発行したトークンは、action の `github_token` と、環境変数 `PECOT_GITHUB_COM_TOKEN` の両方に渡す。`github_token` を渡すので、GitHub の API のために `id-token: write` は要らない
- job の `permissions` は `contents: read` と `id-token: write` にする。`id-token: write` は、モデルの認証の Workload Identity Federation のためだ（R14）。書き込みは App のトークンで行う
- App のトークンで書いたコメントは、`issue_comment` のワークフローを起こす。`GITHUB_TOKEN` は起こさない。書いたのが bot なので、`if` の bot の判定で飛ばされ、輪にならない。指摘の本文が合言葉で始まっても同じだ

- Alternatives considered:

| 候補 | 採らない理由 |
|---|---|
| `GITHUB_TOKEN`（`pull-requests: write`） | 公式の PR レビューの例と同じで、利用者の設定は API キーだけで済む。採らないのは、後に続く自動処理が App を要るためだ。認証の形が 2 つに分かれる。Clarifications の答えにも合わない |
| Claude GitHub App（action の既定） | 利用者が権限を選べない。pecot CLI に渡すトークンを別に用意することになる |
| PAT | 寿命を利用者が決め、人のアカウントに結び付く。board sync の雛形は、App を使えないボードのために PAT の道を持つ。自動レビューはボードに書かないので、要らない |

実装で確かめること:

| 確かめること | 結果 | 版 | 確かめた日 |
|---|---|---|---|
| w-revise が使う MCP ツール（`pr_show`・`issue_show`・`pr_restack` の確かめ・`issue_comment`）が、Projects の権限の無いトークンで動くか | 権限では止まらない。4 つとも、Pull requests の write と Contents の read で動く。ただし `.active` の無い checkout では、4 つとも `no-active-project` で止まる（#579） | action v1.0.278・Claude Code 2.1.326・pecot-w 8.0.0 | 2026-11-17 |
| GraphQL の `reviewThreads` の読み取りに要る権限 | 同じトークンで読める。`pr_show` の `reviews` が、スレッドの path・line・未解決か・本文を返す。スレッドの ID は返さない | 同上 | 2026-11-17 |

検証用の PR #280 の run で分かったことは、次のとおりだ。

- `.active` が無いと止まる訳は、PR と Issue を扱うツールが、対象のリポを見ずに `.active` の設定を要求するためだ。`.active` は配る `.pecot/.gitignore` で追跡しない。このリポは最初のコミットから追跡が残っているので、ここでは起きない。直しは #579 で行う
- 権限の確かめは、run の中で `.active` を書く step を置き、設定の問題を外して行った（run 44037912331・44038253745・44038480578）
- `issue_show` は、着手できるかの判定（`startable`）まで出た。ボードの読み取りに Projects の権限は要らなかった
- `pr_restack` の確かめは、checkout の切り離された HEAD で `{"branch":"HEAD","base":"main","outcome":"up-to-date"}` を返した
- `issue_comment` は、`message` に複数行の本文を渡せば、テンプレートの検証を通って投稿できる。`Write` を許さなくても、指摘の一覧を投稿できる
- R8 の引き継ぎは、F-NN とスレッド ID の対応を要る。`pr_show` は ID を返さないので、R8 の読み取りの手段は後のフェーズで決める

## R4. 指摘の投稿の手段

- Decision: w-revise の文は、何をどの形で投稿するかだけを決める。投稿の手段は決めない。人のいない実行では、雛形の許可リストに、公式の PR レビューの例と同じ MCP ツール `mcp__github_inline_comment__create_inline_comment` を入れる。`gh api` は許可しない
- Rationale: ユーザーの判断だ（2026-11-16）。スキルが手段を書かなければ、端末と自動レビューが同じ文を読める（FR-005）。実行の場所ごとに、そこにある手段で投稿する。雛形は公式の例と同じ形になり、広い `Bash(gh api *)` の許可が要らない

スキルが決めるのは、次のことだ（FR-007）。

- 指摘の採番と、コメントの本文の先頭の形（`**F-NN** [視点の印]`）
- 投稿先の振り分け。行を指せる指摘はインライン、それ以外は指摘の一覧の General 節
- 指摘の一覧（`review-findings`）の形。これは pecot の MCP ツール `issue_comment` で投稿する

今の w-revise の Step 3 にある `gh api` の手順は、手で回すときの手順として分けて残す。人のいない実行は、その手順を読まない。

| 比べる点 | 端末 | 人のいない実行 |
|---|---|---|
| インラインコメントの手段 | 今の `gh api` の手順 | action に同梱の MCP ツール |
| 投稿のまとまり | 1 つの review | action の決まりに従う |
| ファイル単位の指摘 | ファイルコメント | 手段が無ければ、General 節へ回す |
| スレッドの読み取り | 今のクエリ | pecot の MCP ツール `pr_show` |

- action に同梱の MCP サーバは、GitHub 公式の MCP サーバ（`github/github-mcp-server`）とは別だ。action が自前で持ち、許可リストに名前を書いたときだけ入る（`src/mcp/install-mcp-server.ts`）
- この MCP ツールは、`confirmed: true` を付けるとすぐ投稿する。付けないと、セッションの後に分類してから投稿する。指摘の一覧に URL を並べるには、すぐ投稿された結果が要る
- 分類の step は `ANTHROPIC_API_KEY` を使う。トークンと Workload Identity Federation だけの構成（R14）では分類が飛ばされ、`confirmed` の無いコメントも全部投稿される（action の `docs/setup.md`）。雛形は `classify_inline_comments: "false"` を明示し、どの投稿もすぐ出す形に揃える

実装で確かめること:

| 確かめること | 結果 | 版 | 確かめた日 |
|---|---|---|---|
| この MCP ツールで投稿したコメントの URL を、指摘の一覧の Disposition に並べられるか | 並べられる。`confirmed: true` の結果が `comment_id` と `html_url` を返す。本文の先頭の `**F-NN** [tech]` は、そのまま PR に出る | action v1.0.278・Claude Code 2.1.326 | 2026-11-17 |
| 2 巡目で、前の巡の未解決のスレッドへ返信する手段があるか | 無い。ツールは返信の引数を持たない（action の `src/mcp/github-inline-comment-server.ts`）。人のいない実行の 2 巡目は、新しい指摘として投稿する | 同上 | 2026-11-17 |
| 自動レビューの許可リストに、スレッドを resolve できる手段が入っていないこと | 入っていない。run の中のツールに、名前に resolve・reply を含むものは無かった | 同上 | 2026-11-17 |

結果:

- 行を指さない投稿（ファイル単位）は、`line` を求めるエラーで止まる（run 44031535860）
- ファイル単位の指摘は、指摘の一覧の General へ回す

## R5. ツールの許可リストと上限

- Decision: 許可リストは `claude_args` の `--allowedTools` に書く。権限のモードは `--permission-mode default` と明示する。ターンは `--max-turns`、時間は job の `timeout-minutes` で止める
- Rationale: action の今の既定は auto モードで、公式は「レビューであって境界ではない」と書いている。厳密にするときは `default` を明示するよう勧めている

雛形の既定値:

| 項目 | 初期値 | 決め方 |
|---|---|---|
| ツール | `Read`・`Glob`・`Grep`、w-revise が使う pecot の MCP ツール、`mcp__github_inline_comment__create_inline_comment`。Bash は許可しない | w-revise の Step 1〜3 と w-reviewer の調べ方に出るものから |
| 許可しないもの | `Edit`・`Write`・`AskUserQuestion`・`WebFetch`・`WebSearch`、`git push`・`git commit` | コードを直さず、人に聞かず、外へ送らないため |
| ターン | 60 | このリポの試行で直す |
| 時間 | 30 分 | このリポの試行で直す |

- Agent ツール（サブエージェントの起動）は、許可リストに書かなくても使える。プラグインのサブエージェントの名前は `pecot-w:w-reviewer` になる
- プラグインの MCP ツールは、許可リストに書かないと使えない。名前は `mcp__plugin_pecot-w_pecot-workflow__<ツール名>` の形だ
- `-p` の実行でも、サブエージェントは動き、`prompt` の `/スキル名` は展開される。公式の文書で確かめた
- w-reviewer は Context7 と `git clone` で公式の文書を調べる。人のいない実行でこれを許すかは、試行で決める。初期値では許さない。根拠を調べきれない指摘は、その旨を付けて返させる

実装で確かめること:

| 確かめること | 結果 | 版 | 確かめた日 |
|---|---|---|---|
| 人のいない実行で、w-reviewer が起き、指摘が main に返ること | 起き、指摘を返す。サブエージェントは、MCP ツールを使う前に ToolSearch で読み込む | action v1.0.278・Claude Code 2.1.326・pecot-w 8.0.0 | 2026-11-17 |
| サブエージェントが、main の許可リストを引き継ぐこと | 確認が要るツールは、許可リストに無ければ拒まれる。確認の要らないツール（`Skill`、読み取りだけの `Bash` のコマンド）は、許可リストに無くても使える。`--disallowedTools` に書いたツールは、main でもサブエージェントでも使えない | 同上 | 2026-11-17 |
| プラグインの hooks が、人のいない実行で止まらないこと | 止めない。`SessionStart`・`UserPromptSubmit`（2 本）・`PreToolUse:Skill` が動き、出力はどれも空だった。`Stop` の hook は今の `hooks.json` に無い。`PreToolUse` の `Bash` の hook は、`Bash` を禁止するので動かない | 同上 | 2026-11-17 |

結果:

- `--allowedTools` は、確認なしに使えるツールの一覧として働く
- 一覧に無い pecot の MCP ツールは拒まれる。`board_show` と `session_show` は、`Claude requested permissions to use ...` で止まった（run 44041509504）
- 確認の要らないツールは、一覧に無くても使える。w-reviewer は `Bash` で `echo probe` を打てた（run 44031535860）。main は `Skill` を呼べた（run 44038480578）
- 使わせないツールは `--disallowedTools` に書く。`Bash` を書くと、`Bash is disabled for this session, in subagents as well as here` で拒まれる（run 44037912331）
- `prompt` の `/pecot-w:w-help` は展開され、スキルの手順で動いた。スラッシュでの展開は `Skill` のツールを通らない（run 44038253745）
- hook の動きは、`claude_args` に `--include-hook-events` を足して読んだ
- Context7 の MCP サーバは `needs-auth` で、人のいない実行では使えない。初期値で許さない判断と合う

## R6. 同時実行

- Decision: `concurrency` は job に書く。`group` は `pecot-review-<PR番号>`、`cancel-in-progress` は `false` にする
- Rationale: 進行中のレビューを途中で取り消すと、インラインコメントだけが残り、指摘の一覧が無い状態になる

- 公式の PR 向けの例は `cancel-in-progress: true` だ。push のたびに古い run を捨てる CI のための形で、自動レビューは push で起動しない
- `concurrency` をワークフローに書くと、起動でない run（合言葉で始まらないコメントなど）も、同じ group に入る。job に書けば、`if` で飛ばされた run は group に入らない

| 確かめること | 結果 | 版 | 確かめた日 |
|---|---|---|---|
| job の `concurrency` で、`if` で飛ばされた run が group に入らないこと | 入らない。起動の run A の間に、起動の run B を待たせ、起動でないラベルの run C を起こした。C は待たずに `skipped` で終わり、B は取り消されずに A の直後に動いた | GitHub Actions（github.com） | 2026-11-17 |
| 作成とラベル付けを続けて行ったときの扱い | 同じ PR を 2 度レビューする。`opened` と `labeled` の両方が条件を満たし、`concurrency` は 2 本を順に並べるだけで重複を防がない | 同上 | 2026-11-17 |

- 場面 1 の run は 44038712373（A）・44038740962（B）・44038762984（C）だ
- 場面 2 は、PR を開いた 1 秒後に起動ラベルを付けた。`gh pr create --label` と同じ形だ（run 44039121603・44039125330）
- 起動し直しを合言葉のコメントに変えたので、この重なりは起きなくなった（R15）。PR の作成で合言葉は書けない

## R7. 人のいない実行の w-revise

- Decision: w-revise に、引数 `--unattended` の分岐を足す。Step 1〜3 は同じ文を読む。Step 3 の後、採否を聞かずに終わる。新しいスキルは足さない
- Rationale: Clarifications の答えだ。レビューと投稿の決まりが 1 か所に残る

人のいない実行で変わる点:

| Step | 手で回すとき | `--unattended` |
|---|---|---|
| 1 PR の情報 | 載せ直しが要れば、載せ直す | 載せ直さない。要ることを、指摘の一覧の General に書く |
| 2 レビューの依頼 | 控えた w-reviewer に送る。無ければ新しく起こす | 新しく起こす |
| 3 投稿 | インライン・ファイル・指摘の一覧 | 同じ |
| 4 以降 | 採否を聞き、直し、報告する | 行わない。`pr_review_finish` を呼んで終わる |

- 引数で分ける。環境から推し量らない
- 端末から `--unattended` で試すこともできる。端末には action のツールが無いので、インラインコメントは「端末での投稿の手順」で投稿する。ワークフローの中と同じ手段での確かめは、検証用で行う
- スキルの文には、Claude Code 固有のツールの名前を足さない

## R8. 手で回す w-revise への引き継ぎ

- Decision: w-revise の Step 1 に、PR の未解決のスレッドを読む分岐を足す。自動レビューの指摘があれば、Step 2・3 を飛ばして Step 4 へ進む
- Rationale: FR-014 だ。同じレビューを 2 度待たせない

決まったこと:

- 見分けるのは、未解決で、先頭が `**F-NN**` か `**R<巡>/F-NN**` のスレッドだ。今の Step 6 が resolve の対象を選ぶ正規表現と同じにする
- F-NN とスレッド ID の対応表は、Step 3 の今のクエリで作れる。指摘の一覧のコメントから、General の指摘を読む
- スレッドの指すコミットが PR の先頭と違えば、開発者に示す。そのうえで、採否へ進むか、2 巡目のレビューをするかを選ばせる
- 開発者は、引き継がずに、端末でレビューからやり直すことも選べる。そのときは 2 巡目として採番する

## R9. 終わり方と、止まったときのコメント

- Decision: CLI に `pecot pr review-finish` を足す。ワークフローの最後の step が、`if: always()` で呼ぶ。スキルは、最後に同じ処理を MCP ツールから呼ぶ
- Rationale: 失敗と上限を PR に残すこと（FR-012）は、エージェントがターンの上限で切られても起きなければならない。スキルの文だけで書くと、切られたときに何も残らない

| 終わり方 | PR に残るもの |
|---|---|
| レビューを終えた | 指摘の一覧。別のコメントは足さない |
| 失敗・上限・設定の不足 | 止まったことを知らせるコメントを 1 つ |

- レビューを終えたときに別のコメントを足さないのは、GitHub が PR にチェックの行を出し、そこから実行の記録へ行けるためだ。同じことをコメントに書かない
- 止まったことを知らせるコメントは、CLI がテンプレートから書く。エージェントは書かない
- 同じ実行で 2 度書かないために、実行の ID を入れた目印の行を使う
- 失敗と上限の見分けは、job の終わり方と、action の出力から決める

| 終わり方 | job・step | action の `conclusion` | `execution_file` の最後の `result` |
|---|---|---|---|
| ターンの上限 | Review が `failure` | `failure` | `subtype: error_max_turns`・`terminal_reason: max_turns`・`is_error: true` |
| 時間の上限 | job が `cancelled`。Review が `cancelled` | 空 | ファイルが残らない |
| API の失敗（認証・クレジット） | Review が `failure` | `failure` | `subtype: success`・`terminal_reason: api_error`・`is_error: true`。`result` に API の文が入る |
| 終えた | Review が `success` | `success` | `subtype: success`・`is_error: false` |

確かめた版は action v1.0.278・Claude Code 2.1.326、日付は 2026-11-17 だ。分かったことは、次のとおりだ。

- `if: always()` の step は、時間の上限で切られた後も動いた（run 44040534751）。後始末の step を最後に置く形は成り立つ
- 時間の上限の `cancelled` は、人が run を手で取り消したときと同じ値だ。job の中からは、2 つを見分けられない
- `subtype` だけでは、API の失敗と終えた場合を見分けられない。`is_error` と `terminal_reason` も見る
- `--max-turns` は main のターンだけを数える。サブエージェントの中のやり取りは数えない。w-reviewer が長いレビューを返した run も、2 ターンで終わった（run 44039505483）
- ターンの上限の run は 44039760791、API の失敗の run は 44029781882（認証）・44030238020（クレジット）だ

- Alternatives considered:

| 候補 | 採らない理由 |
|---|---|
| ワークフローの step に `gh pr comment` を直接書く | コメントの形が雛形に埋まり、CLI の検証を通らない。雛形を置いた後に形を直せない |
| 何も書かず、チェックの赤い行だけにする | 必須でないチェックの失敗は、開発者が気づきにくい。インラインコメントだけが残って止まったことが、PR から分からない |

## R10. 導入と、共通の部分

- Decision: CLI に `pecot workflow install <名前>` と `pecot workflow doctor <名前>` を足す。名前は、雛形の一覧から選ぶ。初版の一覧は `review` の 1 つだ
- Rationale: FR-028〜FR-031 が、置くこと・確かめること・古さを知ることを求めている。FR-019 が、後に続く自動処理が作り直さずに使える形を求めている。雛形ごとの違い（ファイル・変数・secret・ラベル）を表に持てば、後の自動処理は行を足すだけで済む

共通にするもの:

| 共通の部分 | 置き場 |
|---|---|
| 認証の名前（`PECOT_AGENT_APP_CLIENT_ID` など）と、発行のときに権限を絞る形 | 雛形と、w-help の認証の説明 |
| 雛形を書き出す・古さを確かめる・設定を確かめる | `pecot workflow install`・`doctor` |
| 版の目印と、利用者が足す行の印 | 雛形の書き方の決まり |
| 起動者の確かめ・許可リスト・上限の書き方 | 雛形と、w-help の説明の「自動処理に共通の決まり」の節 |

- board sync の雛形は、今のまま、利用者が写して置く。雛形の一覧には足さない。足すと、変数の名前と導入の手順が変わるためだ
- 雛形の版は、1 行目の目印の整数で持つ。`pecot workflow install --check` と `doctor` が比べる。古さを知らせる手段は、この 2 つだけにする。実行のたびの警告は足さない
- w-onboarding に、自動レビューを入れるかを選ぶ Step を足す。選ばなければ、何も置かない
- w-help に、導入の説明 `references/review-workflow.md` を足す

- Alternatives considered:

| 候補 | 採らない理由 |
|---|---|
| board sync と同じく、写して置くだけにする | 設定を確かめる手段（FR-030）と、古さを知る手段（FR-031）が無い |
| `pecot review install` のように、自動レビュー専用にする | 後に続く自動処理が、同じものをもう一度作ることになる |

## R11. 雛形の action の版

- Decision: action は SHA で固定し、版をコメントに書く。board sync の雛形と同じだ
- Rationale: GitHub の公式は、full-length の commit SHA で固定するよう書いている。claude-code-action の文書に、固定の勧めは無い。`@v1` は、何もしなくても新しい挙動が入ると書いている

- 固定した版は、利用者のリポの Dependabot が上げられる。雛形の版の目印とは別に動く

## R12. 確かめる場所

- Decision: CUJ は、spec 026 の検証用（`pecotcraft/pecot-sandbox`）で流す。このリポへの導入は、検証用で通った後に行う
- Rationale: spec 026 の決まりだ

- プラグインは、既定のブランチから入る。`plugin_marketplaces` は `#ref` を受け付けない。直した w-revise を、マージの前に action の中で動かす手段は、spec 026 の R11-6 が確かめる
- R11-6 の結果が出るまで、スキルを通した確かめは、main へのマージの後になる。tasks の前提の表に書く
- 雛形の `pull_request` の契機は、雛形を足す PR の run で確かめられる（R1）。`issue_comment` の契機は既定のブランチの定義で動くので、検証用の main に入れて確かめる。spec 026 の「配る自動化を確かめる」の手順に従う

## R13. GitHub Enterprise Server

- spec 023 の R13 と同じだ。`github_token` を渡す形なので、Claude GitHub App のトークンの交換に依らない
- 導入の説明には、github.com で確かめたことと、GHES では確かめていないことを書く。トークンの環境変数の名前が変わることは、board sync の説明と同じ文を使う

## R14. モデルの認証

- Decision: 雛形は、secret `CLAUDE_CODE_OAUTH_TOKEN` を action の `claude_code_oauth_token` に渡す。Workload Identity Federation の 4 つの ID は、secret が無いときだけ変数から渡す。`anthropic_api_key` は渡さない
- Rationale: 既定をサブスクリプションにするのは、ユーザーの判断だ（spec の「費用と認証の方針」）。action は、静的なトークンがあればそれを使い、Workload Identity Federation を使わない。secret の有無だけで、払い方を切り替えられる

| 項目 | 値 |
|---|---|
| トークン | secret `CLAUDE_CODE_OAUTH_TOKEN`。`claude setup-token` で作る |
| Workload Identity Federation | 変数 `PECOT_AGENT_ANTHROPIC_FEDERATION_RULE_ID`・`PECOT_AGENT_ANTHROPIC_ORGANIZATION_ID`・`PECOT_AGENT_ANTHROPIC_SERVICE_ACCOUNT_ID`・`PECOT_AGENT_ANTHROPIC_WORKSPACE_ID` |
| job の `permissions` | `contents: read` と `id-token: write`。Workload Identity Federation が GitHub の OIDC トークンを取るためだ。`id-token: write` は、リポの何も書き換えない |

確かめた版は action v1.0.278・Claude Code 2.1.326、日付は 2026-11-17 だ。分かったことは、次のとおりだ。

- トークンと Workload Identity Federation の入力を両方渡すと、action は警告を出してトークンを使う（run 44031119294）。公式の文書も同時に渡さないよう書いているので、雛形は式で片方だけを渡す
- 貼り付けのときに改行が入ったトークンは、`401 OAuth access token is invalid` で止まる。導入の説明に、1 行で貼ることを書く
- 2026-07-15 より後に作ったリポでは、OIDC トークンの subject が ID を含む形になる（GitHub の immutable subject claims）
  - 例は `repo:pecotcraft@351183614/pecot-sandbox@1455471836:*` だ
  - Anthropic の文書とウィザードの例は古い形で、そのままでは `match_subject_prefix` で拒まれる（run 44029781882）
- 導入の説明では、ルールの subject の prefix を、GitHub の API が返す `sub_claim_prefix` から作る
  - 読む先は `repos/<owner>/<repo>/actions/oidc/customization/sub` だ
- `pull_request` の fork の run には、GitHub が `id-token: write` を渡さない。`issue_comment` の run は base のリポの文脈で動くので、fork の PR へのコメントでも渡る。PR の確かめの step が、action より前に fork を弾く
- Workload Identity Federation で動かすと、組織にクレジットが無ければ `Credit balance is too low` で止まる（run 44030238020）

## R15. 起動し直しの契機

- Decision: 起動し直しは、PR へのコメントの合言葉で行う。既定は `@pecotbot review` で、変数 `PECOT_REVIEW_TRIGGER_PHRASE` で変えられる。契機は `issue_comment` の `created` だ
- Rationale: claude-code-action の `label_trigger` は Issue だけが対象だ。PR のレビューの公式の例は、`synchronize` で自動に動かすか、`@claude` のメンションで起こす形だけだ。ラベルの形は公式の例に無いので、メンションの形に合わせた（2026-11-17、ユーザーの判断）
- Alternatives considered:
  - 起動ラベル（`pull_request` の `labeled`）。公式の例に無い。作成と同時に付けると 2 度レビューする（R6）。終わりにラベルを外す処理も要る
  - `synchronize`。push のたびに動き、費用が読めない
  - `workflow_dispatch`。PR の画面から起こせない

合言葉の形は、レビューの bot の前例に合わせた。2026-11-17 に、公式の文書と GitHub のアカウントで調べた。

| サービス | 頼み方 | 名前のアカウント |
|---|---|---|
| claude-code-action | `@claude` | Anthropic が持つ User |
| Codex | `@codex review` | OpenAI が持つ User |
| CodeRabbit | `@coderabbitai review` | Organization |
| Sourcery | `@sourcery-ai review` | Organization |
| Dependabot | `@dependabot rebase` など | Organization |
| Gemini Code Assist | `/gemini review` | — |
| Cursor Bugbot | `cursor review`・`bugbot run` | — |

- 主流は `@<名前> <頼みごと>` の形だ。頼みごとの語を後ろに付けるので、後の自動処理（spec 023）も同じ名前で頼める
- 名前は、どの前例も提供元が自分で持つ。pecot は `pecotbot` を Organization として持つ。Organization は、ログインして使うアカウントを持たずに名前を押さえられる
- 他人のアカウントの名前は使わない。`@pecot` は他人の User で、書くたびにその人へ通知が飛ぶ
- `@` の候補にも、GitHub の `/` の一覧にも、自前の名前は出ない（下の表）。補完はどの形でも得られないので、前例の多い形を採った
- 本文の先頭だけを見る。`contains` で探すと、文の途中の言及でも起動するためだ
- `prompt` を渡す形では、action は合言葉を確かめない（`src/entrypoints/prepare.ts` の `containsTrigger` は、tag のモードでだけ `checkContainsTrigger` を呼ぶ）。判定は job の `if` だけが持つ
- 書いた人の書き込み権限と、人であることは、action も確かめる（`checkWritePermissions`・`checkHumanActor`）。ただし action が止めると step が失敗し、後始末が「止まった」と PR に書く。このため、job の `if` で `author_association` を先に見る
- 合言葉の後に区切りを求める。本文が合言葉と同じか、合言葉の直後が空白か改行のときだけ通す。`@pecotbot reviewer` では起動しない

| 確かめること | 結果 | 版 | 確かめた日 |
|---|---|---|---|
| 書き込み権限を持つ人の `/pecot-review` で起動し、PR の head を読めるか | 起動した。checkout の `ref` に `refs/pull/<N>/head` を渡すと、PR のブランチにだけあるファイルを読めた。action のログに `Actor has write access` と `Verified human actor` が出た | action v1.0.278・Claude Code 2.1.326・pecot-w 8.0.0 | 2026-11-17 |
| 文の途中に合言葉を書いたコメント | job が `skipped` になった | 同上 | 2026-11-17 |
| Issue への `/pecot-review` のコメント | job が `skipped` になった | 同上 | 2026-11-17 |
| App の名前を合言葉にしたとき、コメント欄の `@` の候補に出るか | 出ない。App が作った PR（検証用の #283）で、ユーザーが画面で確かめた。`@<App の名前>` にしても補完は効かないので、合言葉の名前の決めに使った | GitHub の画面（github.com） | 2026-11-17 |
| 書き込み権限の無い人のコメント | 確かめていない。書き込み権限の無いアカウントが無い。`if` に `author_association` の判定を入れた雛形で、quickstart のシナリオ 8 で確かめる | — | — |

- 受け付けの印として、合言葉のコメントに 👀 のリアクションを付ける（FR-035）。合言葉の run は PR の Checks の欄に出ず、結果が出るまで無言になるためだ。飛ばされた run は印を付けないので、受け付けられなかったことも分かる
- リアクションは、App のトークンの Pull requests の write で付けられる見込みだ。公式の表では、Issue のコメントへのリアクションは Issues か Pull requests の write で足りる。Phase 2 の検証用の run で確かめる
- 上の表の確かめは、合言葉が `/pecot-review` だった時点の run だ。`@pecotbot review` に変えた後の判定は、同じ式の形なので、Phase 2 の雛形で確かめ直す
- `pecotbot` の Organization の名前を書いたとき、誰にも通知が飛ばないことは、Phase 2 の検証用の run で確かめる
- 確かめのワークフローは、検証用の main に入れて確かめ、後で消した（検証用の PR #287・#288）。`issue_comment` は既定のブランチの定義で動くためだ
- run は 44045334864（起動）・44045337610（文の途中）・44045340626（Issue）だ
- `issue_comment` のイベントは、PR の head のリポと draft を持たない。確かめのワークフローは、App のトークンで PR を読み、fork・draft・閉じた PR を弾く step を置いた

## 調査で見つけた、この spec の外の事実

| 事実 | 扱い |
|---|---|
| 公開リポでは、`pull_request_target` を止める既定の policy が、2026-12-02 から強制される。配布済みの `pecot-board-sync.yml` は `pull_request_target` を使う | この spec では直さない。別の Issue に記録する |
| spec 023 の plan は、Python の CLI と `pecot auto` の 5 つのコマンドを前提にしている。今の CLI は TypeScript だ | FR-033 の作業で、R10 の共通の部分を使う形と合わせて直す |

## 残した判断

| 項目 | 扱い |
|---|---|
| ターン・時間の初期値 | 検証用で試し、雛形の既定値を直す |
| w-reviewer に、公式の文書を調べる手段を許すか | 試行で決める。初期値では許さない |
| 許した bot の PR で、action の制限のもとで動くか | 実装の最初のフェーズで確かめる。動かなければ、ユーザーに伝えて判断を仰ぐ |
| プラグインの hooks が人のいない実行を止めるか | 実装の最初のフェーズで確かめる |
