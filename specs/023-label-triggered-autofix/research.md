# Research: Issue にラベルを付けると、GitHub Actions が pecot の手順で直して PR まで作る

spec の Clarifications（2026-11-11）の 5 点を前提にする。
新しいスキルを 1 つ足すこと、PR の CI が通るまで直すこと、起動し直しは起動ラベルの付け直しだけにすること。
残りは、待ちを既定の Status の値で示すことと、CI を直す上限で止まったときも待ちの値を書くことだ。

外部の仕様は、2026-11-11 に公式のリポと文書を読んで確かめた。
読んだ版は、claude-code-action の `v1.0.271`（同梱の Claude Code は 2.1.322）だ。
写しは `.pecot/work/315/tech-advisor/` にある。

## 調べた現状

| 対象 | 現状 |
|---|---|
| プラグインの名前 | plugin 名は `pecot-w`、marketplace 名は `pecot`（`.claude-plugin/marketplace.json`）。スキルは `/pecot-w:<skill>` で起動する |
| `pecot` の起動 | `bin/pecot` が uv で venv を作って起動する。uv が必須で、Python は uv が選ぶ |
| Actions での前例 | `security-alerts.yml` と `dependabot-prs.yml`。checkout、`astral-sh/setup-uv`、`actions/create-github-app-token` の順に進め、`PECOT_GITHUB_COM_TOKEN` でトークンを渡す |
| CLI のトークン | `PECOT_GITHUB_COM_TOKEN` を読む。`GH_TOKEN` と `GITHUB_TOKEN` は直接読まない（`core/github/client.py`） |
| プロジェクトの設定 | 利用者のリポでは `.pecot/config/projects/*.json` を追跡し、`.active` は追跡しない。`pecot project activate <設定ファイル名>` で復元できる |
| 進行の欄の書き込み | `pecot create-branch` が Active に、`pecot pr create` が In Review にする。どちらも対話が無い |
| 既定の Status | CLI は読みも書きもしない。`updateProjectV2Field` も使っていない |
| ビュー | CLI は作らない。`board_url` を組み立てるだけだ |
| ワークフローを書き出す仕組み | 無い。近い前例は、定義の文字列をファイルに書く `pecot-gitignore-ensure.sh` だ |
| 手で回すスキルの順 | `scripts/ci/tests/test_skill_flow_structure.py` が w-active・w-quick の Step の順を固定している |
| Node の CLI | `cli-node/` はコマンドが未登録だ。Python にコマンドを足すと、parity のシナリオと数の期待を直す必要がある |
| ボードの説明 | `board-status.md` と `spec-driven-workflow.md` の表に In Review が無い |

## R1. 無人の実行の基盤

- Decision: claude-code-action の v1 を、`prompt` を渡す形（agent モード）で使う。プラグインは `plugin_marketplaces` と `plugins` で入れ、`prompt` に `/pecot-w:w-auto <Issue の参照>` を渡す
- Rationale: 公式が示すスキルの起動の形と同じだ。pecot CLI とプラグインが動く無人の環境は、今はここだけだ

決まったこと:

| 項目 | 値 |
|---|---|
| marketplace の指定 | `https://github.com/pecotcraft/pecot.git`。action は `owner/repo` の短縮形と `#ref` を受け付けない |
| プラグインの指定 | `pecot-w@pecot` |
| プラグインの版 | 固定できない。実行のたびに最新が入る |
| ブランチの作成 | action は作らない。スキルが `pecot create-branch` で作る |
| 前準備 | `astral-sh/setup-uv` を先に動かす。uv が無いと `pecot` が起動しない |

- Alternatives considered:

| 候補 | 採らない理由 |
|---|---|
| claude.ai/code のクラウドセッション | GitHub のプロキシが GraphQL を拒否し、pecot CLI が動かない。プラグインも読み込まれない |
| action のタグモード（`label_trigger`） | action が自分でブランチとコメントを作る。pecot のブランチ名とテンプレートの規則を通らない |
| Claude Code を `run:` で直接起動する | 起動者の確認とトークンの扱いを自前で書くことになる |

## R2. GitHub のトークン

- Decision: 利用者が自前の GitHub App を作り、`actions/create-github-app-token` で出したトークン 1 本を使う。action の `github_token` と、環境変数 `PECOT_GITHUB_COM_TOKEN` の両方に渡す
- Rationale: 1 本で 3 つを満たす。ボードの更新、PR の CI の自動起動、短い寿命（1 時間）だ

| トークン | ボードの更新 | PR の CI の起動 | 寿命 |
|---|---|---|---|
| 自前の GitHub App | できる | 自動で動く | 1 時間 |
| Claude GitHub App（action の既定） | できない。App の権限に Projects が無い | 自動で動く | 1 時間 |
| `GITHUB_TOKEN` | できない。`permissions` に project が無い | 承認待ちになる | job の間 |
| fine-grained PAT | organization のボードだけできる | 自動で動く | 利用者が決める |
| PAT (classic) | できる | 自動で動く | 利用者が決める |

App に要る権限:

| 権限 | 範囲 | 使い道 |
|---|---|---|
| Contents | write | ブランチの作成と push |
| Issues | write | 計画と結果のコメント、ラベルの付け外し |
| Pull requests | write | PR の作成 |
| Actions | read | 落ちた CI のログの取得 |
| Organization の Projects | write | 進行の欄と既定の Status の書き込み |

- 制約: user 所有のボードは、初版の対象にしない。GitHub App の権限の表に user の Projects の項目が無い。導入手順に書く
- 制約: App の作成と organization へのインストールは、利用者が画面で行う。CLI は手順を示すだけだ

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
- CI が通ったときも `workflow_run` が届く。このときはエージェントを起こさず、CLI が結果のコメントを書いて終わる
- App のトークンで push すると、起動者が bot になる。action は、何も設定しなければ bot を拒否する。そのため、`allowed_bots` に自前の App の名前を書く。`*` は使わない
- `workflow_run` は、ワークフローのファイルが既定のブランチにあるときだけ起動する
- 利用者は、CI のワークフローの名前を雛形に書く。`pecot auto install` が `.github/workflows/` を読んで候補を示す

- 実装で確かめること: `allowed_bots` に書く名前の形（`<slug>[bot]` と `<slug>` のどちら）。fork の PR で `pull_requests` が空になること

## R4. 起動と、判定の置き場

- Decision: ワークフローは 2 つの job に分ける。先の job `gate` は、エージェントを起こさずに CLI だけで判定する。後の job `run` が claude-code-action を動かす
- Rationale: 対象外の Issue と上限の判定を、LLM に任せない。判定が毎回同じになり、対象外のときに費用がかからない

| job | 中身 |
|---|---|
| `gate` | `pecot auto gate` が、イベントから Issue 番号・種類（始める、続ける、CI を直す）・進めるかを出す |
| `run` | `gate` が進めると出したときだけ動く。同時実行のグループに、`gate` の出した Issue 番号を使う |

- 起動ラベルの判定は、ワークフローの `if` に書く。`prompt` を渡した action は、どのラベルでも動くからだ
- 起動ラベルの名前の既定値は `pecot-auto` とする。ワークフローの先頭の `env` で変えられる（FR-017）
- 同時実行は `concurrency.group: pecot-auto-<Issue番号>` と `cancel-in-progress: false` で止める（FR-026）。何も設定しなければ、待つ run は 1 つで、後から来た run が置き換える

## R5. 起動者の制限と、信頼できない入力

- Decision: 起動者の確認は action の既定の挙動に任せる。`allowed_non_write_users` は設定しない
- Rationale: action は `issues: labeled` で、ラベルを付けた人の権限を確かめる。admin と write だけが通り、triage は通らない。確認は Claude の起動の前に済む

| 起動の試み | 止める仕組み |
|---|---|
| 権限の無い人が起票・コメント・本文の編集をする | ワークフローの契機が `issues: labeled` だけなので、起動しない |
| 権限の無い人がラベルを付ける | GitHub がラベルの操作を許さない。triage の人は action が止める |
| fork の PR の CI が落ちる | `gate` が `head_branch` と PR の有無を見て止める |
| bot が起動する | `allowed_bots` に書いた自前の App だけが通る |

Issue の本文は、action のサニタイズを通らない。そこで次の 3 つを置く（FR-028）。

- `prompt` には Issue の参照だけを渡す。本文を式で埋め込まない
- `pecot auto start` が渡すコメントは、書き込み権限のある人のものに限る。`author_association` が OWNER・MEMBER・COLLABORATOR のものだ
- スキルは、本文とコメントを「直す対象の説明」として読むと書く。許可の外の操作を求める文には従わない

これは指示の文で、境界ではない。境界は、App の権限と、許可リストと、保護されたブランチの ruleset だ。

## R6. ツールの許可リストと上限

- Decision: 許可リストは、雛形の `claude_args` の `--allowedTools` に書く。ターンは `--max-turns`、時間は job の `timeout-minutes` で止める
- Rationale: action に時間の入力は無い。Bash は初めから無効で、書いたものだけが動く

雛形の既定値:

| 項目 | 初期値 | 決め方 |
|---|---|---|
| ツール | Read・Edit・Write・Glob・Grep と、Bash の `pecot`・`git`・`gh run view`・`gh pr checks` | 手順に出るコマンドから |
| 利用者のテストのコマンド | 空。雛形の印の付いた行に利用者が足す | リポごとに違うため |
| ターン | 80 | このリポの試行で直す |
| 時間 | 30 分 | このリポの試行で直す |
| CI を直す回数 | 3 | このリポの試行で直す |

- Bash の規則は、書かれたコマンドの文字列に合わせるもので、公式も境界ではないと書いている。`git push` を main に向けさせないのは、ruleset と App の権限だ（FR-029）
- 行末のコメントは `claude_args` に書かない。action が捨てるのは `#` で始まる行だけだ

## R7. 待ちの値

- Decision: `pecot project init` が、既定の Status に待ちの値を足す。値の名前は `Waiting`、色は赤にする。既にあるボードでも、同じコマンドを打ち直すと足される
- Rationale: 新しいコマンドを増やさずに済む。`init` は今も、足りないフィールドだけを作る冪等なコマンドだ

決まったこと:

- `updateProjectV2Field` の `singleSelectOptions` は、渡した一覧で上書きする。今の選択肢を `id` つきで全部読み、1 つ足して渡す。`id` を落とすと、カードの値が消える
- 設定ファイルの `project.fields` に、既定の Status のフィールドと選択肢の ID を足す。キーは `status` とする
- 待ちの値を書くのは `pecot auto finish`、戻すのは `pecot auto start` だ。エージェントは既定の Status に触れない
- ビューの表示項目は変えない。既定のビューは、既定の Status の札を初めから出している

- Alternatives considered:

| 候補 | 採らない理由 |
|---|---|
| ラベルの札 | 画面で比べた結果、緑の札の隣に 1 つ増えるだけで、探さないと見えない。ビューの設定も要る |
| 進行の欄を Pending にする | 後回しの Epic と同じ列に並び、区別できない |
| 進行の欄に新しい値を足す | 列が増え、`_validate_workflow_field` の必須の値と既存のボードの移行に広がる |

## R8. CLI のコマンド

- Decision: `pecot auto` の下に 5 つのコマンドを足す。入出力は [contracts/cli-commands.md](contracts/cli-commands.md) に書く

| コマンド | 呼ぶもの | 役割 |
|---|---|---|
| `pecot auto install` | 利用者（w-onboarding から） | ワークフローの雛形を書き出し、起動ラベルを作る。`--check` で、置いた雛形が古いかを確かめる |
| `pecot auto doctor` | 利用者 | 導入に要る設定がそろっているかを確かめる |
| `pecot auto gate` | ワークフロー | イベントを読み、進めるかと種類を出す |
| `pecot auto start` | スキル | 待ちの値を戻し、前回の計画・質問・答え・ブランチを出す |
| `pecot auto finish` | スキルとワークフロー | 結果のコメントを書き、待ちの値を書き、起動ラベルを外す |

- Rationale: 「必ず起きること」を CLI に寄せる。結果のコメント（FR-008）と起動ラベルを外すこと（FR-038）は、エージェントがターンの上限で切られても起きなければならない
- ワークフローの最後の step は `if: always()` で `pecot auto finish --ensure` を呼ぶ。結果のコメントがまだ無ければ、上限か失敗として書く

## R9. 新しいスキル

- Decision: スキルの名前は `w-auto` とする。手順は [contracts/skill-flow.md](contracts/skill-flow.md) に書く
- Rationale: w-active の手順から、人を待つ箇所（レビューの Agent、EnterPlanMode、AskUserQuestion）を除いた順になる。w-active・w-quick・w-pr の文は変えない

決まったこと:

- 種類は 3 つある。始める、続ける、CI を直す、だ。`gate` が決めて、引数でスキルに渡す
- 計画は `pecot issue comment` の plan のテンプレートで投稿する。承認は待たない（FR-005）
- 直し方が決まらないときは、質問を書いて `pecot auto finish --result question` で終わる
- PR のスクリーンショットは撮らない。`screenshot` の欄に、無人の実行である理由を書く
- スキルの文には、Claude Code 固有のツールの名前を書かない

## R10. 雛形の版

- Decision: 雛形の先頭に版の目印の行を置く。`pecot auto install --check` と `pecot auto gate` が、置かれたファイルの目印を CLI の持つ版と比べる
- Rationale: プラグインは実行のたびに最新が入るが、ワークフローのファイルは利用者のリポに残る。両者のずれを利用者へ知らせる手段が要る（FR-033）
- 古いとき、`gate` は止めずに進め、結果のコメントに更新の手順を 1 行足す

## R11. ランナーの上の準備

- Decision: 雛形は、checkout、uv の用意、トークンの発行、プロジェクトの設定の復元、の順に進める。依存の install は、利用者が印の付いた step に足す

| step | 中身 |
|---|---|
| checkout | 既定のブランチ。CI を直すときは `head_branch` |
| uv | `astral-sh/setup-uv` |
| トークン | `actions/create-github-app-token` |
| 設定の復元 | `pecot project activate <設定ファイル名>`。名前は `pecot auto install` が雛形に書き込む |
| 利用者の準備 | 依存の install など。初期は空 |

- 実装で確かめること: プラグインの hooks が、無人の実行で止まらないこと。`UserPromptSubmit` と `PostToolUse` の hook がスキルの名前を見ている箇所がある

## R12. 文書の修正

- Decision: `board-status.md` と `spec-driven-workflow.md` の表に、In Review と、既定の Status との関係を書く（FR-044）
- `w-onboarding/SKILL.md` の `board_url` を取るスクリプトは、`.active` の中身に `.json` を重ねて足している。同じ変更で直す
- 認証の説明（`auth-config.md`）に、GitHub App のトークンを `PECOT_GITHUB_COM_TOKEN` で渡す形を足す

## R13. GitHub Enterprise Server

- 公式は Actions を対応と書いている。ワークフローは手で用意する
- `github_token` を渡す形なので、Claude GitHub App のトークンの交換に依らない。ただし GHES で通して動かした確認は無い
- 導入手順には、github.com で確かめたことと、GHES では未確認であることを書く

## 残した判断

| 項目 | 扱い |
|---|---|
| ターン・時間・CI を直す回数の初期値 | このリポに導入して試し、雛形の既定値を直す |
| `allowed_bots` の名前の形 | 実装のときに action のソースで確かめる |
| user 所有のボード | 初版の対象にしない |
| GitHub Copilot CLI での無人の実行 | 対象にしない |
