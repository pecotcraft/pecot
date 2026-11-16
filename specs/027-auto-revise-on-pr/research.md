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

- Decision: 契機は `pull_request` の `opened`・`ready_for_review`・`labeled` にする。claude-code-action の v1 を、`prompt` を渡す形（agent モード）で動かす
- Rationale: 3 つの型とも、`prompt` があれば agent モードになる。agent モードは、追跡コメントを付けず、checkout もしない。ブランチも作らない。`track_progress` は指定しない。指定すると、追跡コメントの付く別のモードに切り替わる

決まったこと:

| 項目 | 値 |
|---|---|
| 契機 | `pull_request` だけ。`pull_request_target` は使わない |
| `prompt` | `/pecot-w:w-revise --unattended <owner>/<repo>/<PR番号>`。PR の本文とタイトルを式で埋め込まない |
| プラグイン | `plugin_marketplaces` に `https://github.com/pecotcraft/pecot.git`、`plugins` に `pecot-w@pecot`。spec 023 の R1 と同じ |
| checkout | `actions/checkout` を `fetch-depth: 1`・`persist-credentials: false` で使う。`ref` は書かない。`pull_request` では merge commit が入る |
| 前準備 | `actions/setup-node`。`bin/pecot` が Node と pnpm で実行用の写しを作るため |

- action は、PR の run で、作業ツリーの `.claude/`・`.mcp.json`・`CLAUDE.md` などを base ブランチの版に置き換える。PR の作者が、設定の差し替えでエージェントを操れない
- `pull_request` の run は、ワークフローのファイルを PR の merge commit から読む。雛形を足す PR そのもので、最初の実行を確かめられる

- Alternatives considered:

| 候補 | 採らない理由 |
|---|---|
| `pull_request_target` | base の secret と書き込みのトークンで動く。公式は、PR の中身を扱う処理に使わないよう書いている。公開リポでは、既定の policy が 2026-12-02 から止める |
| `issue_comment` でのメンション | コメントを書ける人が広く、起動者の制限が弱くなる。spec の対象にしていない |
| `pull_request_review` など、ほかの契機 | spec が、PR の作成と起動ラベルだけと決めている |

## R2. 起動の条件と、起動者の確かめ

- Decision: fork・draft・ラベルの名前・bot の判定は、job の `if` に書く。書き込み権限の確かめは、action に任せる。`allowed_non_write_users` は設定しない
- Rationale: action は、`github.actor` の権限を確かめ、admin と write だけを通す。確かめは Claude の起動の前に済む。`if` で先に落とせば、対象外の PR では runner の時間もモデルの費用もかからない

job の `if` は `env` を読めない。公式の表では、`jobs.<job_id>.if` で使える context は `github`・`needs`・`vars`・`inputs` だけだ。
起動ラベルの名前と、許す bot の一覧は、リポの変数（`vars`）から読み、式の `||` で既定値を持つ。board sync の雛形も、`if` の判定に `vars` を使っている。
`timeout-minutes` も `vars` を読めるので、時間の上限も変数で変えられる。spec 023 の contracts は「式を受け付けない」と書いているが、公式の表と合わない。

| 起動の試み | 止める仕組み |
|---|---|
| fork からの PR | `if` が、PR の head のリポと導入先のリポを比べる。公式の書き方は `github.event.pull_request.head.repo.full_name == github.repository`。fork の run には secret も渡らない |
| draft の PR | `if` が `github.event.pull_request.draft` を見る |
| 起動ラベルでないラベル | `if` が `github.event.label.name` を比べる。`prompt` を渡した action は、どのラベルでも動くからだ |
| 書き込み権限の無い人が、コメント・本文の編集をする | 契機に無いので、起動しない |
| 書き込み権限の無い人が、ラベルを付ける | triage の人は GitHub の上でラベルを付けられる。action が actor の権限を見て止める |
| bot が作った PR | `if` が、PR の作者の名前を、許した bot の一覧と比べる。action の `allowed_bots` にも同じ一覧を渡す |

- 起動ラベルを書き込み権限のある人が付けたとき、action は PR の作者を確かめない。リポの中のブランチから PR を作れるのは、リポに push できる人と bot だけなので、fork の判定で足りる
- `allowed_bots` は、名前を小文字にし、`[bot]` を除いて比べる。`<slug>` と `<slug>[bot]` のどちらで書いても通る。spec 023 で残した問いは、これで決まる
- `allowed_bots` を設定すると、action の権限のモードの既定が変わる。雛形は R5 のとおり、モードを明示する
- Dependabot の PR の run には、Actions の secret が渡らない。Dependabot の secret が渡る。Dependabot を許す利用者は、API キーと App の鍵を Dependabot の secret にも置く。導入の説明に書く

実装で確かめること:

- action の `restrict_untrusted_prs`（初期値は有効）は、bot が作者の PR を、`allowed_bots` にあっても信頼しない扱いにする。npm・bash などが拒否リストに入る。許した bot の PR で、プラグインの MCP サーバが起動するかを確かめる。許していない bot の PR に、人が起動ラベルを付けた場合も確かめる
- `labeled` の run で、`github.actor` がラベルを付けた人になること。公式の定義の文からの読みで、payload では確かめていない
- 自前の GitHub App が作った PR の作者の名前の形

## R3. GitHub のトークン

- Decision: 利用者が作る GitHub App を 1 つ使う。変数と secret の名前は、自動処理に共通の `PECOT_AGENT_APP_CLIENT_ID` と `PECOT_AGENT_APP_PRIVATE_KEY` にする。ワークフローは、`actions/create-github-app-token` の `permission-*` で、自分に要る権限だけに絞って発行する
- Rationale: Clarifications で、共通の部分をこの spec が先に作ると決めた。App にインストールで与える権限は、使う自動処理の合計にする。発行のときに絞れば、自動レビューのトークンはリポの内容を書き換えられない（FR-011）。後から別の自動処理を足すとき、利用者は App の権限を足すだけで、鍵を作り直さない（SC-009）

自動レビューが発行するトークンの権限:

| 権限 | 範囲 | 使い道 |
|---|---|---|
| Pull requests | write | インラインコメントの投稿、PR へのコメント、起動ラベルを外す |
| Contents | read | PR と diff の読み取り |

- 公式の表では、Issue のコメントの投稿とラベルを外す操作は、Issues か Pull requests のどちらかの write で足りる。Issues の write は付けない
- 発行したトークンは、action の `github_token` と、環境変数 `PECOT_GITHUB_COM_TOKEN` の両方に渡す。`github_token` を渡すので、job の `permissions` に `id-token: write` は要らない
- job の `permissions` は `contents: read` だけにする。書き込みは App のトークンで行う
- App のトークンで書いたコメントとラベルの操作は、ほかのワークフローを起こす。`GITHUB_TOKEN` は起こさない。起動ラベルを外す操作は `unlabeled` で、雛形の契機に無いので、輪にならない

- Alternatives considered:

| 候補 | 採らない理由 |
|---|---|
| `GITHUB_TOKEN`（`pull-requests: write`） | 公式の PR レビューの例と同じで、利用者の設定は API キーだけで済む。採らないのは、後に続く自動処理が App を要るためだ。認証の形が 2 つに分かれる。Clarifications の答えにも合わない |
| Claude GitHub App（action の既定） | 利用者が権限を選べない。pecot CLI に渡すトークンを別に用意することになる |
| PAT | 寿命を利用者が決め、人のアカウントに結び付く。board sync の雛形は、App を使えないボードのために PAT の道を持つ。自動レビューはボードに書かないので、要らない |

実装で確かめること:

- w-revise が使う MCP ツール（`pr_show`・`issue_show`・`pr_restack` の確かめ・`issue_comment`）が、Projects の権限の無いトークンで動くか。ボードを読むなら、`organization-projects: read` を足すか、読まない道を作る
- GraphQL の `reviewThreads` の読み取りに要る権限。公式の表では読めなかった

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

実装で確かめること:

- この MCP ツールで投稿したコメントの URL を、指摘の一覧の Disposition に並べられるか
- 2 巡目で、前の巡の未解決のスレッドへ返信する手段があるか。無ければ、人のいない実行の 2 巡目は、新しい指摘として投稿する
- 自動レビューの許可リストに、スレッドを resolve できる手段が入っていないこと

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

- 人のいない実行で、w-reviewer が起き、指摘が main に返ること
- サブエージェントが、main の許可リストを引き継ぐこと
- プラグインの hooks が、人のいない実行で止まらないこと。`UserPromptSubmit`・`PreToolUse`・`Stop` の hook がある

## R6. 同時実行

- Decision: `concurrency` は job に書く。`group` は `pecot-review-<PR番号>`、`cancel-in-progress` は `false` にする
- Rationale: 進行中のレビューを途中で取り消すと、インラインコメントだけが残り、指摘の一覧が無い状態になる

- 公式の PR 向けの例は `cancel-in-progress: true` だ。push のたびに古い run を捨てる CI のための形で、自動レビューは push で起動しない
- `concurrency` をワークフローに書くと、起動ラベルでないラベルが付いた run も、同じ group に入る。job に書けば、`if` で飛ばされた run は group に入らない見込みだ。実装で確かめる

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
- Rationale: 起動ラベルを外すこと（FR-034）と、失敗と上限を PR に残すこと（FR-012）は、エージェントがターンの上限で切られても起きなければならない。スキルの文だけで書くと、切られたときに何も残らない

| 終わり方 | PR に残るもの |
|---|---|
| レビューを終えた | 指摘の一覧。別のコメントは足さない |
| 失敗・上限・設定の不足 | 止まったことを知らせるコメントを 1 つ |

- レビューを終えたときに別のコメントを足さないのは、GitHub が PR にチェックの行を出し、そこから実行の記録へ行けるためだ。同じことをコメントに書かない
- 止まったことを知らせるコメントは、CLI がテンプレートから書く。エージェントは書かない
- 同じ実行で 2 度書かないために、実行の ID を入れた目印の行を使う
- 失敗と上限の見分けは、job の終わり方と、action の出力から決める。見分け方は実装で確かめる

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
- 雛形そのものは、雛形を足す PR の run で確かめられる（R1）

## R13. GitHub Enterprise Server

- spec 023 の R13 と同じだ。`github_token` を渡す形なので、Claude GitHub App のトークンの交換に依らない
- 導入の説明には、github.com で確かめたことと、GHES では確かめていないことを書く。トークンの環境変数の名前が変わることは、board sync の説明と同じ文を使う

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
