# Research: Issue にラベルを付けると、GitHub Actions が pecot の手順で直して PR まで作る

spec の Clarifications（2026-11-11）の 5 点を前提にする。
新しいスキルを 1 つ足すこと、PR の CI が通るまで直すこと、起動し直しは起動ラベルの付け直しだけにすること。
残りは、待ちを既定の Status の値で示すことと、CI を直す上限で止まったときも待ちの値を書くことだ。

外部の仕様は、2026-11-11 に公式のリポと文書を読んで確かめた。
読んだ版は、claude-code-action の `v1.0.271`（同梱の Claude Code は 2.1.322）だ。
写しは `.pecot/work/315/tech-advisor/` にある。

2026-11-18 に、spec 027（自動レビュー）が作った共通の部分に合わせて、この文書を直した。
読んだのは、spec 027 の research（claude-code-action `v1.0.278`、Claude Code 2.1.326 で確かめた R2・R3・R5・R9・R10・R11・R14）と、その実装だ。
実装は、`cli/src/domain/workflow-template.ts`・`cli/src/commands/workflow.ts`・`cli/templates/workflow/pecot-review.yml` と、w-help の `review-workflow.md` の「自動処理に共通の決まり」だ。
spec 023 が決めた仕組み（起動ラベル・`gate` と `run` の 2 つの job・`workflow_run` での CI の修正・待ちの値）は変えない。

## 調べた現状

| 対象 | 現状 |
|---|---|
| プラグインの名前 | plugin 名は `pecot-w`、marketplace 名は `pecot`（`.claude-plugin/marketplace.json`）。スキルは `/pecot-w:<skill>` で起動する |
| `pecot` の起動 | CLI は TypeScript（`cli/src/`）で、`bin/pecot` が Node で起動する。プラグインの `.mcp.json` が `bin/pecot mcp` を起動し、スキルは MCP ツールを使う |
| Actions での前例 | `pecot-review.yml`（自動レビュー）と、`pecot-board-sync.yml`。ステップは checkout、`actions/setup-node`、`actions/create-github-app-token` の順で、CLI は `npx -y --prefix=/ @pecot/workflow-mcp@latest <コマンド>` で打つ |
| CLI のトークン | `PECOT_GITHUB_COM_TOKEN` を読む。`GH_TOKEN` と `GITHUB_TOKEN` は直接読まない |
| プロジェクトの設定 | 利用者のリポでは `.pecot/config/projects/*.json` を追跡する。`.active` が無い checkout では、ツールが対象のリポからプロジェクトの設定を決める（#579）。複数のボードに入ったリポでの指定は、#640（#660）の形で、変数 `PECOT_AUTO_PROJECT` に設定の名前を置く |
| 進行の欄の書き込み | MCP ツール `session_start` が Active に、`pr_create` が In Review にする。どちらも対話が無い |
| 進行の欄 | `project init` が、`Blocked` を足す（`cli/src/commands/project.ts`） |
| 既定の Status | 実装済み（#376・#404）。`project init` が `Needs Attention` を足す。設定の `project.fields.status`（`id` と `options`）がある。札と設定のキーの対応 `LABEL_CONFIG_KEYS`（`cli/src/domain/board-move.ts`）は `needs_attention` と `todo` の 2 つだ。入力 `labelWrittenByAutomation`（今の札を自動処理が書いたか）があり、呼ぶ側 3 か所（`board-judgment.ts`・`issue-create.ts`・`issue-dependency.ts`）が `false` 固定だ |
| ビュー | CLI は作らない。`board_url` を組み立てるだけだ |
| ワークフローを書き出す仕組み | `workflow install <名前>`・`workflow doctor <名前>` がある。雛形の一覧は `cli/src/domain/workflow-template.ts` の `WORKFLOW_TEMPLATES` で、`auto` の行は無い |
| 雛形の版の目印 | 1 行目の `# pecot-workflow-template: <名前> <版>`。比べるのは `workflow install --check` と `workflow doctor` だ |
| 手で回すスキルの順 | `cli/tests/skills/skill-flow-structure.test.ts` が w-active・w-quick の Step の順を固定している |
| コマンドの名前 | 今の名前は、ブランチの作成が `session start`、ボードへの追加が `board add`、PR の確認が `pr check` だ。古い名前との対応は `cli/src/commands/renamed-commands.ts` にある |
| ボードの説明 | 済み。`board-status.md` に In Review・Blocked・Needs Attention があり、`spec-driven-workflow.md` の表に In Review・Blocked がある |
| w-onboarding | 済み。ボードの URL は、`scripts/board-url.cjs` で取る形に直っている。自動処理の導入の Step は無い |

## R1. 無人の実行の基盤

- Decision: claude-code-action の v1 を、`prompt` を渡す形（agent モード）で使う。プラグインは `plugin_marketplaces` と `plugins` で入れ、`prompt` に `/pecot-w:w-auto <種類> <Issue の参照>` を渡す
- Rationale: 公式が示すスキルの起動の形と同じだ。pecot の MCP サーバとプラグインが動く無人の環境は、今はここだけだ

決まったこと:

| 項目 | 値 |
|---|---|
| marketplace の指定 | `https://github.com/pecotcraft/pecot.git`。action は `owner/repo` の短縮形と `#ref` を受け付けない |
| プラグインの指定 | `pecot-w@pecot` |
| プラグインの版 | 固定できない。実行のたびに最新が入る |
| ブランチの作成 | action は作らない。スキルが `session_start` で作る |
| 前準備 | `actions/setup-node` を先に動かす。`bin/pecot` が Node で実行用の写しを作るためだ |
| action の版 | SHA で固定し、版をコメントに書く（spec 027 の R11） |

- Alternatives considered:

| 候補 | 採らない理由 |
|---|---|
| claude.ai/code のクラウドセッション | GitHub のプロキシが GraphQL を拒否し、pecot の CLI が動かない。プラグインも読み込まれない |
| action のタグモード（`label_trigger`） | action が自分でブランチとコメントを作る。pecot のブランチ名とテンプレートの規則を通らない |
| Claude Code を `run:` で直接起動する | 起動者の確認とトークンの扱いを自前で書くことになる |

## R2. GitHub のトークン

- Decision: 利用者が自前の GitHub App を作り、`actions/create-github-app-token` で出したトークン 1 本を使う。名前は共通の `PECOT_AGENT_APP_CLIENT_ID`（変数）と `PECOT_AGENT_APP_PRIVATE_KEY`（secret）だ。発行のときに `permission-*` で、job に要る権限だけに絞る
- Rationale: 自動レビューでは自前の App は任意だが、この自動処理では必須のままだ。Claude の App にも `GITHUB_TOKEN` にも Projects の権限が無く、ボードの進行の欄と待ちの値を書けないためだ

| トークン | ボードの更新 | PR の CI の起動 | 寿命 |
|---|---|---|---|
| 自前の GitHub App | できる | 自動で動く | 1 時間 |
| Claude GitHub App（action の既定） | できない。App の権限に Projects が無い | 自動で動く | 1 時間 |
| `GITHUB_TOKEN` | できない。`permissions` に project が無い | 承認待ちになる | job の間 |
| fine-grained PAT | organization のボードだけできる | 自動で動く | 利用者が決める |
| PAT (classic) | できる | 自動で動く | 利用者が決める |

発行するトークンの権限は、job ごとに分ける。

| job | 権限 | 使い道 |
|---|---|---|
| `gate` | Issues: write | 対象外の理由と、上限のコメントの投稿。ラベルの付け外し |
| `gate` | Actions: read | CI の run の読み取り |
| `gate` | Organization の Projects: write | 進行の欄の読み取りと、CI を直す上限での札 `Needs Attention` の書き込み |
| `gate` | Contents: read | ブランチの有無の読み取り |
| `gate` | Pull requests: read | PR の有無の読み取り |
| `run` | Contents: write | ブランチの作成と push |
| `run` | Issues: write | 計画と結果のコメント、ラベルの付け外し |
| `run` | Pull requests: write | PR の作成 |
| `run` | Actions: read | 落ちた CI のログの取得 |
| `run` | Organization の Projects: write | 進行の欄と既定の Status の書き込み。入力は `permission-organization-projects`（`actions/create-github-app-token` v3.3.0） |

- App にインストールで与える権限は、`run` の表と、自動レビューの権限（Pull requests: write、Contents: read）との合計にする。自動レビューも自前の App を使うときのためだ
- 制約: user 所有のボードは、初版の対象にしない。GitHub App の権限の表に user の Projects の項目が無い。導入手順に書く
- 制約: App の作成と organization へのインストールは、利用者が画面で行う。CLI は手順を示すだけだ
- 制約: 複数のボードに入ったリポでの指定は、#640（#660）の形に合わせる。変数 `PECOT_AUTO_PROJECT` を、CLI には `--project`、スキルには `project=<名前>` で渡す

実装で確かめること: リポに絞って発行したトークンが、`permission-organization-projects: write` で organization のボードを書けるか。検証用（`pecotcraft/pecot-sandbox`）で確かめる。

結果（2026-11-25、`actions/create-github-app-token` v3.4.0、検証用の App `pecot-agent-sandbox`）: 書ける。表の権限の組で、権限の表を直す点は無い。

- 発行は既定のとおり、ワークフローのリポだけに絞った
- `gate` の組で、進行の欄・ブランチ・PR・CI の run・書いた人の権限を読み、結果のコメント・ラベルを外すこと・organization のボードの `Needs Attention` を書けた
- `run` の組で、結果のコメント・ラベルを外すこと・organization のボードの `Needs Attention` と `Todo` を書けた。push と PR の作成は、スキルを動かす Phase 4 で確かめる
- App のトークンで読むと、組織の非公開のメンバーの `author_association` が `CONTRIBUTOR` で返る。そのため、`auto start` の答えは `author_association` で絞らず、書いた人の `permission` だけで決める（R5）

## R3. CI の失敗を直す仕組み

- Decision: CI の結果を `workflow_run`（completed）で受け、別の run で直す。同じ job の中で CI を待たない
- Rationale: installation token が 1 時間で切れる。同じ job で待つと、CI の 1 周と直す回数の積がこの期限に当たる。run を分ければ、トークン・ターン・時間の上限が run ごとに新しくなる

| 比べる点 | 同じ job で待つ | `workflow_run` で別の run |
|---|---|---|
| トークンの期限 | 1 時間に当たる | run ごとに新しい |
| 待ち時間 | runner の時間を使う | 使わない |
| 回数の数え方 | セッションの中で数える | run の外に持つ |
| 公式の例 | 無い | `examples/ci-failure-auto-fix.yml` |

決まったこと:

- ブランチ名は、手で回すときと同じ `feat/<説明>/<Issue番号>` にする。別の法則を足さない（FR-004）
- 自動処理が作った PR かは、`gate` が結果のコメントの目印で見分ける。ブランチの末尾の Issue 番号から Issue を引き、PR を作ったという目印に同じブランチの名前があるかを確かめる
- 目印が無ければ、人が作った PR だ。`gate` は何も書かずに止める（FR-037）
- 名前では絞れないので、PR の CI が終わるたびに `gate` の job が動く。エージェントは起こさず、判定だけで終わる
- 直した回数は、Issue に残す結果のコメントの目印で数える。数えるのは CLI で、エージェントは数えない
- 数え方は、利用者が決めた（2026-11-24、#712）。同じブランチの `ci-fix-pushed` の目印を、最後の `limit` の目印の後から数える。`head_sha` がブランチの先頭と違う CI は、何も書かない。最後の結果が `ci-passed` でも、`head_sha` が先頭と同じ CI は判定する。1 回の push で複数の CI が届いたときは、それぞれ別に扱う
- CI が通ったときも `workflow_run` が届く。このときはエージェントを起こさず、CLI が結果のコメントを書いて終わる
- `workflow_run` は、ワークフローのファイルが既定のブランチにあるときだけ起動する
- `workflow_run` の `on` は式を受け付けない。CI のワークフローの名前は、利用者が `workflow_run.workflows` の行に書く。行は印のコメントで囲み、囲みの初めの値は仮の名前にする。その名前の CI が無ければ、何も起きない。名前が実在するかは `workflow doctor auto` が確かめる
- App のトークンで push すると、起動者が bot になる。action は、何も設定しなければ bot を拒否する。そのため、`allowed_bots` に、発行の step の出力 `app-slug` を渡す。`*` は使わない
- `allowed_bots` は、名前を小文字にし、`[bot]` を除いて比べる。`<slug>` と `<slug>[bot]` のどちらでも通る（spec 027 の R2）。`app-slug` は `actions/create-github-app-token` v3.3.0 の出力だ
- `allowed_bots` を置くと、action の権限のモードの既定が auto にならない。雛形は R6 のとおり、モードを明示する
- claude-code-action の v1.0.278 は `workflow_run` に対応する

実装で確かめること: fork の PR で `pull_requests` が空になること。

## R4. 起動と、判定の置き場

- Decision: ワークフローは 2 つの job に分ける。先の job `gate` は、エージェントを起こさずに CLI だけで判定する。後の job `run` が claude-code-action を動かす
- Rationale: 対象外の Issue と上限の判定を、LLM に任せない。判定が毎回同じになり、対象外のときに費用がかからない

| job | 中身 |
|---|---|
| `gate` | `auto gate` が、イベントから Issue 番号・種類（始める、続ける、CI を直す）・進めるかを出す |
| `run` | `gate` が進めると出したときだけ動く。同時実行のグループに、`gate` の出した Issue 番号を使う |

- 起動ラベルの判定は、`gate` の job の `if` に書く。`prompt` を渡した action は、どのラベルでも動くからだ
- 利用者が変える値は、ファイルの先頭の `env` ではなく、リポの変数（`vars`）に置く。job の `if` が `env` を読めないためだ。公式の表では、`jobs.<job_id>.if` で使える context は `github`・`needs`・`vars`・`inputs` だけだ（spec 027 の R2）
- 名前は、`PECOT_AUTO_LABEL`（既定 `pecot-auto`）・`PECOT_AUTO_MAX_TURNS`・`PECOT_AUTO_TIMEOUT_MINUTES`・`PECOT_AUTO_MAX_CI_ATTEMPTS` だ。既定値は、式の `||` で書く（FR-017）
- 同時実行は `concurrency.group: pecot-auto-<Issue番号>` と `cancel-in-progress: false` で止める（FR-026）。何も設定しなければ、待つ run は 1 つで、後から来た run が置き換える
- 起動ラベルは、w-onboarding の導入の Step で作る。あるかは `workflow doctor auto` が確かめる。`workflow install` は、雛形を写すだけにする
- 変数が空のとき（`gate` を飛ばす）と、App に権限が無いときは、足りない設定を Issue に書く経路が要る（FR-021）。この経路が届くかは、実装で確かめる
  - 変数が空のときは、job `setup` が run のトークン（`GITHUB_TOKEN`、`issues: write`）で `setup-missing` を書く。App が無いので、App のトークンでは書けないためだ。ラベルを付けた人の権限は、`gate` と同じ判定で先に読む
  - App に権限が無いときは、`gate` のトークンの発行が失敗する。発行の step を `continue-on-error: true` にし、失敗を出力 `token-failed` で `setup` に渡す。`setup` が、同じ `GITHUB_TOKEN` で、トークンを作れなかったことを書く

結果（2026-11-26、検証用）:

- 変数が空のときは、`setup` の job が `setup-missing` の結果のコメントを書き、起動ラベルを外した。`gate` と `run` は飛ばされた
- App の持たない権限（Commit statuses）を `gate` のトークンに求めると、発行が `The permissions requested are not granted to this installation.` で失敗した。足す前の雛形では、知らせは届かない。足した後は、`gate` の Decide と `run` が飛ばされ、`setup` が結果のコメントを書き、起動ラベルを外した
- 足した後も、変数があって発行できるときは `setup` が飛ばされ、`gate` が判定を書いた

## R5. 起動者の制限と、信頼できない入力

- Decision: 起動者の確認は、`gate` が行い、action の確かめも重ねて残す。`allowed_non_write_users` は設定しない
- Rationale: `gate` が、ラベルを付けた人（`sender`）の権限を `collaborators/<login>/permission` の `permission` で読む。`admin`・`write` でなければ（`maintain` は `write` で返る）、何も書かずに `proceed=false` を出す
  - action も `issues: labeled` で同じ権限を確かめるが、action が止めると step が失敗し、後始末が「止まった」と書く
  - 先に `gate` で止めれば、この誤った知らせが出ない（spec 027 の R2・R15）

| 起動の試み | 止める仕組み |
|---|---|
| 権限の無い人が起票・コメント・本文の編集をする | ワークフローの契機が `issues: labeled` と `workflow_run` だけなので、起動しない |
| 権限の無い人がラベルを付ける | GitHub がラベルの操作を許さない。triage の人は `gate` が止める。action も止める |
| fork の PR の CI が落ちる | `gate` が `head_branch` と PR の有無を見て止める |
| bot が起動する | `allowed_bots` に渡した自前の App だけが通る |

Issue の本文は、action のサニタイズを通らない。そこで次の 3 つを置く（FR-028）。

- `prompt` には種類と Issue の参照だけを渡す。本文を式で埋め込まない
- `auto_start` が渡すコメントは、書き込み権限のある人のものに限る。書いた人の `permission` が `admin`・`write` のものだ。`author_association` では絞らない。App のトークンでは、組織の非公開のメンバーが `CONTRIBUTOR` で返る（2026-11-25 に検証用で確かめた）
- スキルは、本文とコメントを「直す対象の説明」として読むと書く。許可の外の操作を求める文には従わない

これは指示の文で、境界ではない。境界は、App の権限と、許可リストと、保護されたブランチの ruleset だ。

## R6. ツールの許可リストと上限

- Decision: 許可リストは、雛形の `claude_args` の `--allowedTools` に書く。権限のモードは `--permission-mode default` と明示する。ターンは `--max-turns`、時間は job の `timeout-minutes` で止める
- Rationale: action の今の既定は auto モードで、公式は「レビューであって境界ではない」と書いている。`allowed_bots` を置くと既定が auto にならないので、明示して同じ形に揃える（spec 027 の R5）

雛形の既定値:

| 項目 | 初期値 | 決め方 |
|---|---|---|
| ツール | `Read`・`Glob`・`Grep`・`Edit`・`Write`、pecot の MCP ツール（`session_start`・`issue_comment`・`pr_check`・`pr_create`・`auto_start`・`auto_finish`）、`git` と `gh run view`・`gh pr checks` | 手順に出るものから |
| 許可しないもの | `Agent`・`AskUserQuestion`・`WebFetch`・`WebSearch`・`Bash(git clone:*)`・`Read(//proc/**)` | 人に聞かず、外へ送らず、トークンを読ませないため |
| 利用者のテストのコマンド | 空。囲みの中の `env` `PECOT_AUTO_EXTRA_ALLOWED_TOOLS` に利用者が足す | リポごとに違うため。自動レビューと同じ形だ |
| ターン | 80 | このリポの試行で直す |
| 時間 | 30 分。`fromJSON(vars.PECOT_AUTO_TIMEOUT_MINUTES \|\| '30')` | このリポの試行で直す |
| CI を直す回数 | 3 | このリポの試行で直す |

- プラグインの MCP ツールは、許可リストに書かないと使えない。名前は `mcp__plugin_pecot-w_pecot-workflow__<ツール名>` の形だ
- 確認の要らないコマンドは、許可リストに無くても動く。使わせないツールは `--disallowedTools` に書く。deny の規則は、プラグインの hook の allow より優先される（spec 027 の R5）
- 自動レビューは書き換えのツールを拒否に書く。この自動処理は直すのが仕事なので、`Edit`・`Write` を許す
- Bash の規則は、書かれたコマンドの文字列に合わせるもので、公式も境界ではないと書いている。`git push` を main に向けさせないのは、ruleset と App の権限だ（FR-029）
- 行末のコメントは `claude_args` に書かない。action が捨てるのは `#` で始まる行だけだ

実装で確かめること: `Bash` を許した実行で、プラグインの `PreToolUse` の hook が止めないか。spec 027 では、`Bash` を拒んだので、この hook が動かなかった。

結果（2026-11-26、検証用、claude-code-action v1.0.278、`--include-hook-events`）: 止めない。

- `PreToolUse:Bash` の hook の結果は、どの呼び出しでも `outcome: success`・終了コード 0 だった
- 許した `git` と、囲みに足したテストのコマンドは、そのまま動いた
- 規則の無いコマンド（`cat`・`mkdir` など）は、`permission_denials` に入った。`default` のモードが拒んでいる

## R7. 待ちの値

- Decision: `pecot project init` が、既定の Status に待ちの値を足す。値の名前は `Needs Attention`、色は赤にする。既にあるボードでも、同じコマンドを打ち直すと足される
- Rationale: 新しいコマンドを増やさずに済む。`init` は今も、足りないフィールドだけを作る冪等なコマンドだ

実装済みのこと（#376・#404）:

- 待ちの値の追加と、設定の `project.fields.status` は、実装済みだ。`updateProjectV2Field` は、今の選択肢を `id` つきで全部読んで 1 つ足す形で使われている
- 札と設定のキーの対応 `LABEL_CONFIG_KEYS` は、`needs_attention` と `todo` の 2 つだ
- ビューの表示項目は変えない。既定のビューは、既定の Status の札を初めから出している

残る差は 2 つだ。

- 設定のキー `status.options.in_progress` が無い。`auto start` が PR のある Issue を In Progress に戻すのに要る。`LABEL_CONFIG_KEYS` にも `In Progress` を足す
- `labelWrittenByAutomation` が、呼ぶ側 3 か所で `false` 固定だ。結果のコメントの目印から、今の札を自動処理が書いたかを決め、この入力につなぐ。pecot の判定（`board_sync` など）が置いた `Needs Attention` は、`auto start` が戻さない

役割は次のとおりだ。待ちの値を書くのは `auto finish`、戻すのは `auto start` で、エージェントは既定の Status に触れない。

- Alternatives considered:

| 候補 | 採らない理由 |
|---|---|
| ラベルの札 | 画面で比べた結果、緑の札の隣に 1 つ増えるだけで、探さないと見えない。ビューの設定も要る |
| 進行の欄を Pending にする | 後回しの Epic と同じ列に並び、区別できない |
| 進行の欄に新しい値を足す | 列が増え、進行の欄の必須の値の検証と既存のボードの移行に広がる |

## R8. CLI のコマンド

- Decision: `pecot auto` の下に 3 つのコマンドを足す。入出力は [contracts/cli-commands.md](contracts/cli-commands.md) に書く。3 つとも、既存のコマンドと同じ仕組みで MCP ツール（`auto_gate`・`auto_start`・`auto_finish`）としても出る

| コマンド | 呼ぶもの | 役割 |
|---|---|---|
| `auto gate` | ワークフロー | イベントを読み、進めるかと種類を出す |
| `auto start` | スキル | 待ちの値を戻し、前回の計画・質問・答え・ブランチを出す |
| `auto finish` | スキルとワークフロー | 結果のコメントを書き、待ちの値を書き、起動ラベルを外す |

- 導入と確かめは、`auto` 専用のコマンドを作らず、雛形の一覧に `auto` の行を足して `pecot workflow install auto`・`pecot workflow doctor auto` で行う（spec 027 の R10）
- Rationale: 「必ず起きること」を CLI に寄せる。結果のコメント（FR-008）と起動ラベルを外すこと（FR-038）は、エージェントがターンの上限で切られても起きなければならない
- ワークフローの最後の step は `if: always()` で `auto finish --ensure` を呼ぶ。結果のコメントがまだ無ければ、上限か失敗として書く
- 上限と失敗の見分けは、spec 027 の `review finish --ensure` と同じ形だ（spec 027 の R9）。job が `cancelled` なら `limit`、`execution_file` の最後の `result` が `subtype: error_max_turns` なら `limit`、それ以外の失敗は `failed` にする
- 外すラベルの名前は、環境変数 `PECOT_AUTO_LABEL` から読み、無ければ `pecot-auto` とする。run の目印は、環境変数 `GITHUB_RUN_ID` と `GITHUB_RUN_ATTEMPT` から作る

## R9. 新しいスキル

- Decision: スキルの名前は `w-auto` とする。手順は [contracts/skill-flow.md](contracts/skill-flow.md) に書く
- Rationale: w-active の手順から、人を待つ箇所（レビューの Agent、EnterPlanMode、AskUserQuestion）を除いた順になる。w-active・w-quick・w-pr の文は変えない

決まったこと:

- 種類は 3 つある。始める、続ける、CI を直す、だ。`gate` が決めて、引数でスキルに渡す
- 手順は、MCP ツールの名前で書く。ブランチは `session_start`、PR の確認と作成は `pr_check`・`pr_create` だ
- 計画は、resource `pecot-template://comment/plan` を写したファイルを `issue_comment` で投稿する。テンプレートの取り方は、#651 で `prepare: true` から resource に変わった
- 計画は plan のテンプレートで投稿する。承認は待たない（FR-005）
- 直し方が決まらないときは、質問を書いて `auto_finish`（`result: question`）で終わる
- PR のスクリーンショットは撮らない。`screenshot` の欄に、無人の実行である理由を書く
- スキルの文には、Claude Code 固有のツールの名前を書かない

## R10. 雛形の版

- Decision: 雛形の 1 行目に、版の目印 `# pecot-workflow-template: auto <版>` を置く。比べるのは `workflow install auto --check` と `workflow doctor auto` だけだ
- Rationale: プラグインは実行のたびに最新が入るが、ワークフローのファイルは利用者のリポに残る。両者のずれを利用者へ知らせる手段が要る（FR-033）。共通の形は spec 027 の R10 が決めた
- `gate` は版を比べない。実行のたびの警告は足さない。結果のコメントにも、更新の行を足さない

## R11. ランナーの上の準備

- Decision: 雛形は、checkout、Node の用意、トークンの発行の順に進める。依存の install は、利用者が印の付いた step に足す

| step | 中身 |
|---|---|
| checkout | 既定のブランチ。CI を直すときは `head_branch` |
| Node | `actions/setup-node`。`package-manager-cache: false` を渡す。job が secret を持つためだ |
| トークン | `actions/create-github-app-token` |
| 利用者の準備 | 依存の install など。印のコメントで囲み、初期は空 |

- プロジェクトの設定を復元する step は置かない。ツールが対象のリポから設定を決める（#579）
- プラグインの hook のうち、`SessionStart`・`UserPromptSubmit`・`PreToolUse:Skill` が無人の実行で止まらないことは、spec 027 で確かめ済みだ。残るのは R6 の `Bash` の `PreToolUse` だけだ

## R12. 文書の修正

- Decision: `board-status.md` と `spec-driven-workflow.md` の In Review の記載、`board_url` のスクリプトの修正は済んでいる。残るのは次の 3 つだ
- 既定の Status と進行の欄の関係（FR-044）が、`board-status.md` に足りているかを見て、足りなければ足す
- 導入の説明 `auto-workflow.md`（w-help の `references/`）を新しく書く。`review-workflow.md` の「自動処理に共通の決まり」を参照する
- 認証の説明（`auth-config.md`）には、「エージェント用の認証」の節がある。足すのは、この自動処理が発行のときに絞る権限の組だけだ

## R13. GitHub Enterprise Server

- 公式は Actions を対応と書いている。ワークフローは手で用意する
- `github_token` を渡す形なので、Claude GitHub App のトークンの交換に依らない。ただし GHES で通して動かした確認は無い
- 導入手順には、github.com で確かめたことと、GHES では未確認であることを書く

## 残した判断

| 項目 | 扱い |
|---|---|
| ターン・時間・CI を直す回数の初期値 | このリポに導入して試し、雛形の既定値を直す |
| user 所有のボード | 初版の対象にしない |
| GitHub Copilot CLI での無人の実行 | 対象にしない |

未決の判断が 1 つある。この改訂では決めない。spec の改訂か、ユーザーの判断が要る。

| 項目 | 内容 |
|---|---|
| ruleset の確かめ | main への push を止める ruleset があるかを、`workflow doctor auto` が確かめるか（FR-029） |

実装で確かめることは、R3 の 1 つが残る。R2・R4・R6 は確かめ、結果を各節に書いた。

| 確かめること | 場所 |
|---|---|
| fork の PR で、`pull_requests` が空になるか | R3 |
