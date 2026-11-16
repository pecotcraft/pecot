# Research: main に入れる前の変更を確かめる試験環境

**Date**: 2026-11-16

調べ方は 3 つある。公式の文書、このリポのコードと設定の読み取り、GitHub の API での読み取りだ。
書き込まないと確かめられない点と、実機でしか分からない点は、R11 にまとめた。tasks で確かめる。

## R1. 検証用の場所（FR-009、FR-001〜003）

- Decision: 今ある `pecotcraft/pecot-sandbox` と、ボード `pecot sandbox`（Projects の 3 番）を引き継ぐ。作り直さない
- Decision: 検証用のリポは、`.pecot/work/<Issue番号>/pecot-sandbox/` に clone して使う
- Rationale:
  - pecot の書き込む先は、作業ディレクトリのリポの `.pecot/config/projects/*.json` で決まる。検証用の clone を作業ディレクトリにすれば、Issue・PR・ボードの書き込みは検証用に届く。書き込む先を切り替える仕組みを足さずに済む
  - #374（specs/024 の quickstart）が、同じ置き場で検証用を使っている
  - 2026-11-16 の時点で、マージ方式・ruleset の必須チェック・merge queue・PR の規則・ボードの項目と値は、このリポと同じだった
  - merge queue は、org が持つ公開のリポで使える。`pecot-sandbox` は公開で、条件を満たす
- Alternatives considered:
  - 確かめのたびにリポを作って消す（gh CLI の `isolated`）。ruleset・merge queue・ボードを毎回作る手間が大きい。退ける
  - 別の org に分ける。ユーザーが、同じ org のままと決めた
- 残る点:
  - `pecot-sandbox` の `ci.yml` が、このリポの必須チェック（`ci-result`・`version-plan`）と同じ名前のチェックを出しているかは読んでいない（R11-3）
  - `pecot-sandbox-b` は空で、ruleset が無い。複数のリポをまたぐ確かめを tasks で扱うときだけ整える

## R2. 直した pecot-workflow の読み込み（FR-014、FR-015、FR-019）

- Decision: Claude Code は `claude --plugin-dir <作業ツリー>/plugins/pecot-workflow` で始める。作業ディレクトリは検証用の clone にする
- Decision: 読み込み元は `claude --plugin-dir <同じパス> plugin list --json` で見る。`pecot-w@inline` の行の `installPath` が作業ツリーを指す
- Decision: GitHub Copilot CLI は `copilot --plugin-dir <作業ツリー>/plugins/pecot-workflow` で始める。読み込み元は `/env` で見る
- Rationale:
  - 公式の文書が、開発中のプラグインの読み込み方を `--plugin-dir` と決めている。同じ名前の入れてある版は、置き換えられる
  - このリポの開発のセッションが、すでに `claude --plugin-dir ./plugins/pecot-workflow/ …` で動いている。足すのは、パスを作業ツリーの絶対パスにすることと、作業ディレクトリを検証用にすることだけ
  - MCP サーバは `bin/pecot` が起こす。ソースと依存のハッシュごとの写しを `~/.claude/plugins/data/pecot-w-inline/runtime/<ハッシュ>/` に build する。ソースを直すと、次の起動で build し直される。MCP サーバを起こし直せば、直した中身で動く
  - w-e2e-planner の手順は、すでに `claude --plugin-dir <ディレクトリ> -p …` を使っている
- Alternatives considered:
  - 手元のパスをマーケットプレイスとして足す。入れる・外す操作が要り、ふだんのセッションに残る。退ける
  - `copilot plugin install ./path`。写しを使うので、直すたびに入れ直しが要る。退ける
- 残る点:
  - #454 で、`/reload-plugins` の後に古い版が動いた訳は分かっていない。このリポに入れてある版は無いので、写しが動いたのではない（R11-1）
  - GitHub Copilot CLI の `--plugin-dir` が、スキルとフックを読むかは文書に無い。エージェントと MCP サーバは明記がある（R11-2）

## R3. そろえる設定の比べ方（FR-017、FR-001〜008）

- Decision: 比べるスクリプトを `.githooks/scripts/` に 1 本置く。このリポと検証用の設定を API で読み、ずれた項目と両方の値を出す。直さない
- Decision: 比べる項目と、比べない項目とその訳を、スクリプトの隣の 1 つのファイルに書く。spec の FR-001〜008 の表と同じ中身にする
- Decision: 比べは、検証用で確かめを流す手順の最初に行う。PR ごとの CI には入れない
- Rationale:
  - ruleset とボードの設定は、GitHub の画面か API で変わる。リポの中のファイルではないので、PR の差分からは変化が分からない。流す直前に比べるのが、ずれを踏まない確かな時機だ
  - #374 の手順は、確かめの途中で検証用の merge queue の規則を外して戻している。ずれは、こういう操作の戻し忘れで生まれる
  - 配布しないスクリプトなので、置き場は `.claude/rules/repo-root-layout.md` の表のとおり `.githooks/scripts/` になる
- 読み方:

| 項目 | 読む先 | 比べないもの |
|---|---|---|
| マージ方式 | `GET /repos/{owner}/{repo}` の `allow_squash_merge`・`allow_merge_commit`・`allow_rebase_merge`・`allow_auto_merge`・`delete_branch_on_merge` | `id`・名前・URL・日時・件数 |
| ruleset | `GET /repos/{owner}/{repo}/rulesets/{id}` の `rules`・`conditions`・`enforcement` | `id`・`node_id`・`source`・`_links`・日時・`bypass_actors[].actor_id`・`integration_id` |
| ボードの項目と値 | Projects の項目の名前・型・選択肢の名前と並び | 項目と選択肢の `id`・色・説明・日時 |
| 置いてある自動化 | `.github/workflows/` の `ci.yml` の有無と、`pecot-board-sync.yml` の有無と中身 | `ci.yml` の中身 |

- Alternatives considered:
  - org の ruleset を 1 つ作って両方のリポに当てる。ずれが起きなくなるが、Team 以上のプランが要る。`pecotcraft` のプランは確かめていない。退ける
  - safe-settings。App を動かし続ける必要がある。2 つのリポのために足すには重い。退ける
  - 自動で直す。spec が、検出までと決めている

## R4. 確かめで作ったものの名前と片付け（FR-010、FR-011）

- Decision: 確かめが検証用に作るブランチは `cuj/<Issue番号>-<乱数>` の形にする。Issue と PR の題は `[cuj <Issue番号>-<乱数>]` で始める
- Decision: 片付けるスクリプトを `.githooks/scripts/` に 1 本置く。この形の名前を持つ、開いた PR・ブランチ・Issue を閉じて消し、ボードからアーカイブする
- Rationale:
  - terraform の GitHub provider は、作るものに目印の接頭辞を付け、残りをまとめて消す。gh CLI は、名前に乱数を入れて重なりを避ける
  - 接頭辞を持たないもの（検証用の `ci.yml`、設定の JSON、main の履歴）は、片付けの対象にならない
- 残る点: マージまで進んだ確かめの commit は、検証用の main に残る。検証用のコードは比べない（FR-007）ので、残してよい

## R5. 計画の「流す先」（FR-022〜025）

- Decision: plan テンプレ（`cli/templates/comment/plan.md`）の CUJ に、「流す先」の項目を 1 つ足す。「誰が・起点」の次に置く
- Decision: 外へ書き込む CUJ は、検証用の場所を書く。外へ書き込まない CUJ は「手元」と書く
- Decision: 検証用の場所は、プロジェクトの指示（`CLAUDE.md` など）に書く。設定のキーは足さない
- Decision: w-e2e-planner は、流す先が検証用の CUJ を、実投稿まで自分で行う。今の「実投稿はしない。main に委ねる」は、流す先が検証用でない CUJ にだけ残す
- Decision: w-reviewer は、流す先の欠けを挙げる。プロジェクトの指示に検証用の場所があるのに、作業中のリポを流す先にした CUJ も挙げる
- Rationale:
  - CUJ の定義は、plan テンプレ・w-e2e-planner・w-reviewer の 3 か所に同じ文で書いてある。項目を足すときは、3 か所を同じ変更で直す
  - 配布物は、検証用を持たない利用者にも配られる。検証用の場所を配布物に書き込むと、利用者のリポで意味を持たない。プロジェクトの指示に置けば、指示に無いリポでは「流す先」は利用者が決めた先か「手元」になり、スキルは止まらない
- Alternatives considered:
  - pecot の設定に「検証用のリポ」のキーを足す。CLI・定義書・テストの変更が要る。計画に 1 行書くだけの用には重い。退ける

## R6. 利用者へ配る自動化の確かめ（FR-020、FR-021、FR-003）

- Decision: 直した `cli/templates/workflow/pecot-board-sync.yml` を、検証用のリポの `.github/workflows/` に入れてから起こす。入れるときは、検証用の PR と merge queue を通す
- Rationale:
  - 公式の文書のとおり、`workflow_dispatch` と `pull_request_target` は、既定のブランチの定義で動く。検証用の既定のブランチに置かないと、直した定義では動かない
  - テンプレートと、このリポの `.github/workflows/pecot-board-sync.yml` は、npx の dist-tag だけが違う。検証用にも同じファイルがある
  - dist-tag は、テンプレートが `@latest`、このリポが `@next` だ
  - 検証用の workflow は、定期の起動（`schedule`）を持たない。このリポの定期の起動は、Lambda の Scheduler が起こしていて、検証用を向いていない。確かめていない間に検証用を書き換え続けるものは、今は無い
- 残る点: workflow の中の pecot は、npx が npm から取る（#499）。`@latest` は最新の正式版、`@next` は main に入った後の開発版で、どちらもマージ前の直した中身ではない。直した中身で動かす手段は R11-4 で確かめる

## R7. 検証用の権限（FR-016、FR-027）

- Decision: 手元のセッションは、今の人の認証（`gh` と `.pecot/config/.env`）のまま使う。絞らない
- Decision: 人のいないセッションには、検証用のリポにだけ入れた GitHub App の installation token を渡す
- Decision: 権限が無いとき、pecot は今のとおり認証の失敗で止まる。別の権限を探して切り替える処理は足さない
- Rationale:
  - 手元では、人がもともとこのリポに書ける。絞っても、守られるものが無い
  - GitHub の公式の文書は、長く使う連携に GitHub App を勧めている。入れる先のリポを選べ、token は 1 時間で切れる
- 残る点:
  - Projects の権限は、org の権限だ。検証用のリポにだけ入れた App の token が、同じ org のボード `pecot-project` に書けるかは、文書に明記が無い（R11-5）。書けると分かったら、受け入れる危険として計画に書き、ユーザーの承認を得る

## R8. クラウドのセッション（FR-026）

公式の文書（code.claude.com の cloud-environments・claude-code-on-the-web・plugins/loading）に、次のことが書いてある。

| 事実 | 影響 |
|---|---|
| GitHub への要求は、専用の proxy を通る。GraphQL は、渡した認証によらず 403 で拒まれる | pecot は、ボード・前提・merge queue の読み書きに GraphQL を使う。Anthropic が動かすクラウドでは、これらが動かない |
| proxy は、セッションに付けたリポへの要求だけを通す。ほかのリポは 403 になる | 検証用のリポを、セッションに付ける必要がある |
| リポの `enabledPlugins` と `extraKnownMarketplaces` のプラグインは、入らない | 作業ツリーの pecot-workflow を読み込む別の手段が要る |
| `CLAUDE_CODE_PLUGIN_DIRS` は、絶対パスのプラグインを `--plugin-dir` と同じに読む。プロジェクトの設定からは渡せない。クラウドの環境変数で渡せるかは書かれていない | 実機で確かめる（R11-6） |
| 自前の環境（self-hosted）は、置いた側の認証で git を動かす | proxy の制約を受けない見込み。文書の記述は短い |
| claude-code-action は、`plugins` と `plugin_marketplaces` でプラグインを入れる。作業ツリーから読む手順は書かれていない | 実機で確かめる（R11-6） |

- Decision: 最初に、R11-6 の点を実機で確かめる。結果で、次の 3 つから動かし方を選ぶ。選ぶのはユーザーだ

| 案 | 中身 | 見込み |
|---|---|---|
| A | Anthropic が動かすクラウドのセッション | GraphQL の拒否が文書に明記されている。pecot の今の作りでは、ボードを使う確かめが動かない |
| B | 自前の環境のクラウドのセッション | proxy を通らない見込み。環境を動かし続ける手間がある |
| C | GitHub Actions の中で動くセッション | App の token を渡せ、GraphQL も通る。#315 の向きと同じ |

- Rationale: spec は、人のいないセッションが検証用で確かめを流せることを、完了の条件にしている。案 A は、文書の上では条件を満たせない。実機で確かめずに 1 つへ決めると、作った後で動かないと分かる
- 記録: specs/025 の research の R9 に、同じ制約が残っている

## R9. フェーズの前後の決まり（FR-028）

「マージを待つ」の例は、4 か所に書いてある。

| 置き場 | 今の例 |
|---|---|
| `skills/w-breakdown/SKILL.md` の Step 7 の引数 | 既定のブランチから配られるものを使う（プラグイン・action・公開したパッケージ）。リリースの後の実物で確かめる。開発ブランチの CI やリリースのワークフローが、前提の変更を使う |
| `skills/w-help/references/issue-flow-rules.md` | 既定のブランチから配られるもの（プラグイン・action・公開したパッケージ）を使うとき。リリースの後の実物で確かめるとき |
| `skills/w-help/references/spec-driven-workflow.md` | action は、既定のブランチのプラグインを入れる |
| `skills/w-issueize/SKILL.md` | action は、既定のブランチのプラグインを入れる。main に入るまで、確認ができない |

- Decision: 「マージを待つ」の問いを、次の形に直す。前提の変更を、手元のブランチか試験環境で動かして確かめられるなら「積める」。どちらでも動かせないなら「マージを待つ」
- Decision: 例から「プラグイン」を外す。直したプラグインは、ブランチの中身を読み込んで確かめられる
- Decision: 次の例は残す。試験環境でも動かせないからだ

| 残す例 | 残す訳 |
|---|---|
| 既定のブランチから配られる action と、公開したパッケージを使う | action は既定のブランチの中身を入れる。パッケージは公開の後にしか取れない |
| リリースの後の実物で確かめる | リリースを確かめる場所は、この Epic で作らない（spec の「しないもの」） |
| 開発ブランチの CI やリリースのワークフローが、前提の変更を使う | このリポだけの運用を確かめる場所は、要るときが来たら作る |

- spec との関係: 上の 3 つは、場所を作らないと決めたものなので残る。spec の SC-010 は、試験環境で確かめられるものに限って 0 件、と書いてある

## R10. 文書の置き場（FR-029、FR-030）

- Decision: 試験環境の一覧と手順は、`plugins/pecot-workflow/CONTRIBUTING.md` に節を 1 つ足して書く。`CLAUDE.md` には、検証用の場所と、その節への案内だけを書く
- Rationale: `CONTRIBUTING.md` は、開発者とエージェントが開発の手順を読む場所で、配布物の利用者向けの README とは分かれている。`CLAUDE.md` は、エージェントが毎回読む。R5 の「検証用の場所は、プロジェクトの指示に書く」の置き場になる

## R11. 実機で確かめる点

R11-5 と R11-6 は、人のいないセッションのフェーズで確かめる。ほかは、tasks の最初のフェーズで確かめる。結果は、この表に足す。

| 番号 | 確かめること | 訳 | 使う先 |
|---|---|---|---|
| R11-1 | #454 で、`/reload-plugins` の後に古い版が動いた訳 | 同じ誤りを避ける 1 行を、手順に書くため | R2 |
| R11-2 | GitHub Copilot CLI の `--plugin-dir` が、スキル・フック・エージェント・MCP サーバを読むか。同じ名前の入れてある版より先に使われるか | 文書に明記が無い。読まれないものは、できない範囲として文書に残す | R2 |
| R11-3 | `pecot-sandbox` の `ci.yml` が、`ci-result`・`version-plan` の名前のチェックを出すか。merge queue の契機（`merge_group`）で動くか | 必須のチェックが出ないと、検証用の PR はマージできない | R1 |
| R11-4 | `pecot-board-sync.yml` の中で動く pecot を、どこから取るか。直した中身にできるか | 配る自動化を、直した中身で確かめるため | R6 |
| R11-5 | 検証用のリポにだけ入れた App の token で、ボード `pecot-project` に書けるか | 権限で絞れるかどうかで、受け入れる危険が変わる | R7 |
| R11-7 | サブエージェントが、作業中のリポで始めたセッションの中から、検証用へ書き込む手段。MCP ツールの引数、Bash での `pecot`、検証用の clone で起こす `claude -p` を比べる | w-e2e-planner が、流す先が検証用の CUJ を実投稿まで行うため | R5 |
| R11-6 | クラウドのセッションの 5 点。`claude` をセッションの中から起こせるか。`CLAUDE_CODE_PLUGIN_DIRS` を環境変数で渡すと読まれるか。自前の token で、付けていないリポへ REST で書けるか。Projects の REST が proxy を通るか。自前の環境で GraphQL が通るか | 動かし方（R8 の案 A・B・C）を選ぶため | R8 |

## 出典

2026-11-16 に読んだ。

| 項目 | 読んだもの |
|---|---|
| プラグインの読み込み（Claude Code） | code.claude.com/docs/en/plugins の create・loading・cli-reference、env-vars |
| プラグインの読み込み（GitHub Copilot CLI） | docs.github.com の copilot-cli の plugins-creating・cli-command-reference・cli-plugin-reference |
| クラウドのセッション | code.claude.com/docs/en の cloud-environments・claude-code-on-the-web・github-actions |
| workflow の契機 | docs.github.com の actions の events-that-trigger-workflows |
| ruleset・リポの設定・Projects の API | docs.github.com の rest の repos/rules・repos/repos・projects/fields |
| GitHub App と権限 | docs.github.com の apps の choosing-permissions-for-a-github-app・installing-your-own-github-app |
| 実物の GitHub で試す実例 | cli/cli の `acceptance/README.md`、integrations/terraform-provider-github の `CONTRIBUTING.md` |
