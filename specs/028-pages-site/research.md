# Research: pecot の文書サイトを GitHub Pages で公開する

公式の仕様は、公式リポ（actions/deploy-pages v5・actions/upload-pages-artifact v5・actions/configure-pages・actions/download-artifact v8・actions/starter-workflows）と docs.github.com で確かめた。

2026-11-17 の 2 回目の決め直し（#616）で、R1〜R6 を書き直し、R12・R13 を足した。
1 回目の形（Actions だけで公開し、側を artifact に置く）の欠陥は、#588 の作業中に見つかった。
根拠の文書の写しは `.pecot/work/588/tech-advisor/docs/` にある。

2026-11-18 の 3 回目の決め直し（#590）で、PR 版を ci の結果から作る形に改め、R3・R5・R6 を直して R14 を足した。

## R1. 公開元と公開の形

- **Decision**: 保管はブランチ、公開は Actions とする
  - 各側は、専用の保管ブランチ `pages-store` の中のディレクトリに置く
  - 公開元は「GitHub Actions」で、`pages-store` の中身を `configure-pages` → `upload-pages-artifact` → `deploy-pages` の公式の 3 段で公開する
  - environment は `github-pages` とし、デプロイ先を既定のブランチだけに絞る
  - 公開の job の concurrency は `group: pages`・`cancel-in-progress: false`（starter workflow の値）
- **Rationale**: 3 つの案を、弱みを並べて比べた。1 GB の上限（docs「GitHub Pages limits」の "Published GitHub Pages sites may be no larger than 1 GB."）は 3 案すべてに当たる

  | 案 | 弱み |
  |---|---|
  | ブランチから公開（Deploy from a branch） | ビルドに 1 時間 10 回の soft limit があり、PR の push が続くと超える。Jekyll を外す `.nojekyll` が要る。environment の保護を使えない |
  | Actions だけ（1 回目の案） | artifact は最長 90 日で消え、開発版・PR 版も push が止まれば消える。毎回すべての側を集め直す。別の run の artifact を選ぶので、出どころを偽られる |
  | 保管はブランチ、公開は Actions（採る案） | 保管ブランチと、それを守る仕組み（専用の GitHub App・ruleset・environment）が要る。この組み合わせには公式の参照実装が無い |

  - 採る案では、側は消えない。書き換えるのは、その側のディレクトリだけで済む（FR-020）
  - 公開は公式の action の形なので、10 回の soft limit を受けない。docs「GitHub Pages limits」の次の文が根拠
    - `This limit does not apply if you build and publish your site with a custom GitHub Actions workflow.`
  - environment `github-pages` の保護が残る。Actions の公開には Jekyll が掛からない
  - docs「Configuring a publishing source」は、2 つの条件で Actions を勧める。「Jekyll 以外でビルドする」と「専用ブランチを持ちたくない」で、この spec は前者に当たる
  - 保管ブランチの名前は `gh-pages` にしない。公開元をブランチと取り違えないため
  - ブランチの履歴は、毎回 1 つの orphan のコミットに置き換えて増やさない
- **Alternatives considered**:
  - ブランチから公開: 上の表の弱みがある
  - Actions だけ: 上の表の弱みがある。1 回目はこの案を採り、artifact の期限切れを自前の作り直しで補っていた
  - Release の asset に置く: リリースはプラグインごとに出るので、どのリリースに付けるかが決まらない
  - `deploy-pages` の `preview` 入力: action.yml に "only in alpha currently and is not available to the public" とあり、前提にできない
- **決め手にしなかった事実**:
  - docs「Configuring a publishing source」には、`GITHUB_TOKEN` で push したコミットでは Pages のビルドが起きない、とある
  - 一方で、rossjrw/pr-preview-action と peaceiris/actions-gh-pages の README は、`GITHUB_TOKEN` で公開できると書いている
  - どの案でも保管ブランチを守る資格情報が要るので、案の差にならない
- **参照実装との関係**: mike（MkDocs の多版）と rossjrw/pr-preview-action は、多版・PR ごとのサイトをブランチに置き、そのブランチから公開する。採る案は置き場所の形だけが同じで、公開の形は違う。pr-preview-action の README は、公開元を「GitHub Actions」にすると動かないと書いている

## R2. 3 つの側を 1 つのサイトに並べる方法

- **Decision**: 側を作る run と、保管して公開する run を分ける
  - 作る run（`pages-build.yml`）: 1 つの側のサイトを作り、artifact に上げる。書き込みはしない
  - 保管して公開する run（`pages-deploy.yml`）: 既定のブランチの文脈で `workflow_run` から動く。受けた run の出どころを確かめ（R3）、`pages-store` のその側のディレクトリだけを差し替え、`pages-store` の全体を公開する
  - 保管の job は、`concurrency: {group: pages-store, cancel-in-progress: false, queue: max}` で順に動かす
  - 保管の push は `--force-with-lease=<取ったときの SHA>` で行う。断られたら取り直してやり直す
- **Rationale**:
  - REST の Create a GitHub Pages deployment は artifact を 1 つ受け取り、配置先の path を持たない。1 回の deploy はサイト全体を差し替える。全体の正を `pages-store` に置けば、ほかの側を消さずに 1 つの側だけ書き換えられる（FR-020）
  - concurrency の既定の queue では、待っている run が新しい run に置き換えられて消える（docs「workflow-syntax」の concurrency）。開発版の更新が PR 版の更新に押し出されるので、保管には `queue: max` を使う
  - 公開の job は starter と同じ `group: pages` で足りる。待っている公開が置き換えられても、最後の公開が `pages-store` の最新を出す
  - actionlint 1.7.12 は `queue` を知らない。`.github/actionlint.yaml` の除外は path ごとなので、`pages-deploy.yml` の path を足して publish-npm.yml と同じ除外を付け、#529 の対象にも加える
- **Alternatives considered**:
  - 毎回すべての側を作り直す: 側の数だけ合否のレーンを動かすことになり、PR が増えると 30 分（SC-001・SC-007）に収まらない
  - 公開中のサイトを URL から取り込んで差分だけ足す: 公開物を正にすることになり、壊れた公開が次へ引き継がれる

## R3. 出どころの確かめと、権限の分け方

- **Decision**:
  - PR 版は、ci.yml の `pull_request`（同じリポのブランチだけ）の run の `pages-preview` の job で作り、artifact に上げるだけにする（R14）
  - 開発版とリリース版は pages-build.yml の run からだけ受け、PR 版は ci.yml の `pull_request` の run からだけ受ける。PR の作者は自分のブランチの ci.yml も pages-build.yml も書き換えられるが、run の `path` と `event` は偽れない
  - 保管して公開する run は、`workflow_run` で受けた run を `GET /repos/{owner}/{repo}/actions/runs/{run_id}` で読み直す。PR 版か、main の祖先の定義で動いた run かは API の項目から決め、artifact の名前や中身からは決めない。項目は data-model.md の RunProvenance
  - run の API には起動の入力（`side`）が無いので、手での起動の開発版とリリース版は API の項目では分けられない。main の祖先の定義（レビュー済み）が上げた artifact の名前で分ける
  - job を 4 つに分け、各 job に要る権限だけを持たせる（contracts の `pages-deploy.yml`）。信頼できない tar を扱う job（verify）は書き込みの権限を持たない
  - `pages-store` に書けるのは、pages-store 専用の GitHub App だけにする。秘密鍵は environment `pages-store` の secret に置く。GitHub は、deploy key より GitHub App を勧める（docs「Managing deploy keys」）。deploy key は期限が無く、org の設定で止められている
- **Rationale**:
  - PR の作者は、PR のブランチの workflow の定義を書き換えられる。artifact の名前を偽れば、1 回目の形ではリリース版・開発版をすり替えられた
  - fork の PR の run は、初回の承認の後、2 回目からは承認なしで動く
  - run の `path`・`event`・`head_repository`・`head_sha`・`pull_requests` は GitHub が決めるので、PR の定義からは偽れない。偽れるのは自分の PR 版だけになる
  - `head_branch` ではブランチを判定しない。タグで動いた run では、`head_branch` にタグ名が入る。`main` という名前のタグで `workflow_dispatch` を起こすと `head_branch=main` になる。main の祖先であることを compare の API で確かめて、これを止める
  - `pull_requests` には、ほかのリポの PR（fork が上流の main から開いた PR）も入る。開発版・リリース版では見ない。PR 版では `base.repo` と `head.sha` で絞る
  - GitHub Security Lab の「Preventing pwn requests」と「New patterns and mitigations」は、`workflow_run` で受けた artifact を untrusted なデータとして扱い、書き込む job から分けるよう求める
  - CodeQL の `actions/artifact-poisoning/critical` は、別の run の artifact を確かめずに使う形を止める
  - `pull_request_target` は使わない。docs は「PR のコードをビルド・実行するなら避けよ」とする
- **脅威の前提**:
  - main の ruleset は、承認 0 件でマージできる（`required_approving_review_count: 0`）
  - 守れるのは「マージ前の PR のコードが、リリース版・開発版を書き換えない」まで。書き込み権限のある人がマージすること自体は防げない
  - 必須のチェックも PR の定義で動くので、マージ前の PR が満たせる（R12）。書き込み権限のある人は信頼する側に置くので、これは守らない
- **Alternatives considered**:
  - PR の run から直接公開する: environment の保護に `refs/pull/*/merge` を足すことになり、docs の推奨（既定のブランチだけ）から外れる
  - artifact の名前（`pages-side-*`）で側を選ぶ: 1 回目の形。PR から偽れる

## R4. 各側の保管と、消えたときの見え方

- **Decision**:
  - 各側は `pages-store` に置き、消えない。作る run の artifact は受け渡しのためだけで、`retention-days: 7` にする
  - リリース版か開発版がまだ無いときは、保管の job が、その位置に「まだありません」の案内のページを置く。案内のページは、ある方の側へのリンクを持つ
  - PR 版は、PR が閉じた後の保管で消える
  - `pages-store` の大きさが 900 MB を超えたら、run の summary に警告を書く
- **Rationale**:
  - 1 回目の形は、artifact を 90 日で消える置き場所にし、リリース版だけを自動で作り直していた。開発版と PR 版も push が 90 日無ければ消えるのに、そこを補っていなかった。保管が消えなければ、作り直しの仕組みは要らない
  - 案内のページを置けば、知らせの「最新のリリース版を見る」（`/pecot/`）が切れない（SC-006）
- **artifact が消えたとき**:
  - 保管の job が 7 日より長く落ち続けると、その間の側は失われる
  - 開発版・リリース版は、`pages-build.yml` の手での起動で作り直せる
  - PR 版を作り直す手段は、その PR への push だけになる
- **Alternatives considered**:
  - artifact を 90 日残し、リリース版だけ作り直す: 1 回目の形。上の欠陥がある

## R5. どの run が何を起こすか

- **Decision**:

  | 契機 | 作る run（`pages-build.yml`） | 保管して公開する run（`pages-deploy.yml`） |
  |---|---|---|
  | main への push | 開発版を作る | 作る run の完了の `workflow_run` で起きる |
  | `release.yml` の本番の land が成功した後 | release.yml が App のトークンで `side=release` の `workflow_dispatch` を起こす | 同上 |
  | 同じリポの PR の opened・synchronize・reopened | 動かない。PR 版は ci.yml の `pages-preview` が作る（R14） | ci の run の完了の `workflow_run` で起きる。PR 版を公開し、`pages / preview` を付ける |
  | 同じリポの PR の closed | 作らずに終わる | 作る run の完了の `workflow_run` で起きる。保管中の閉じた PR の側を消す |
  | merge queue の ci | — | 動かない（verify の `if` で止める） |
  | 手での起動 | `workflow_dispatch`。入力は `side`（`release`・`dev`）だけ | 公開だけのやり直しは `pages-deploy.yml` の `workflow_dispatch` |

- **Rationale**:
  - `workflow_dispatch` は任意の SHA を受けない。起動できるのは main からだけで、開発版は起動した run のコミット（`github.sha`）、リリース版はタグ（R13）から決める。任意の SHA を受けると、既定のブランチの文脈で、レビューを経ていないコードが動く。キャッシュを使う段を足したときに、既定のブランチのキャッシュへ書ける（CodeQL の `actions/cache-poisoning/poisonable-step`）
  - release.yml の App のトークンは、本番では既に `permission-actions: write` を持つ。release の job に新しい権限を足さない
  - land の後に起こすのは、main が進んでいると land が `--no-ff` で merge し、タグのコミットが main の祖先になるのが land の後だから（`.githooks/scripts/release-land.sh`）
  - `GITHUB_TOKEN` で起こした `workflow_dispatch` も run を作る（docs「GITHUB_TOKEN」）。App のトークンを使うのは、既に権限を持つからで、`GITHUB_TOKEN` では起きないからではない
- **Alternatives considered**:
  - `pages-build.yml` が release.yml の `workflow_run` を受ける: 本番か dry-run かと SHA を run の入力から読み直すことになり、手での起動と入口がそろわない
  - release.yml の job に `actions: write` を足す: App のトークンで足りる

## R6. 合否のレーンを動かす方法

- **Decision**: 開発版を作る run は、合否のレーンとサイトの作成を 1 つの job で行う（PR 版は R14）
  - dev container を 1 回だけ立て、`junit-lanes.json` のレーンを順に `nx run <project>:<target>` で動かす
  - テストが落ちても次のレーンへ進み、続けてサイトを作る
  - JUnit が無いレーンが 1 つでもあれば、その job は失敗する
  - JUnit は、調べ直し用に側の artifact に入れる。レーンごとの artifact は作らない
- **Rationale**:
  - PR の CI と同じ dev container（`.githooks/ci/dev-container.sh`）で動かせば、手元・CI・公開で合否がずれない
  - matrix にすると、レーンの数だけランナーを使い、コンテナの起動もその数だけ繰り返す
  - 2026-11-17 の run の値（job ごと、コンテナの起動を含む）は、レーンが 1.2〜4.8 分、サイトが 1.9 分。開発版は 1 つの job で順に動かしても 12 分前後で、30 分に収まる
  - リリース版は、タグのコミットと `skeleton` のコミットを替えるたびに依存を入れ直す（contracts の「リリース版の build」）。その分だけ 12 分より延びる。値は #589 の run で測る
- **Alternatives considered**:
  - レーンごとに matrix の job を立てる: #588 で入れた形。job は side・レーン 4 本・site の 6 つで、うちレーンの 4 台がそれぞれコンテナを立てる
  - 開発版で PR の CI の JUnit を流用する: main への push では ci が動かない。PR 版では流用する（R14）

## R7. 合否のレーンの定め

- **Decision**: 合否のレーンと JUnit のパスを `libs/interface-spec/docs/junit-lanes.json` の 1 か所に書く。`conf.py` の `iface_junit` と、作る run が動かすレーンは、どちらもこのファイルから決める
- **Rationale**: FR-009。workflow が別に一覧を持つと、レーンを足したときにずれる。
  レーンの一覧を読む処理と、保管の処理は、`.githooks/scripts/pages_site/` の Python に置く。
  `.githooks/scripts` の JS には型検査も lint も無く、憲章 III（strict の型検査）を満たせないため、JS では書かない
- **Alternatives considered**: `project.json` の `outputs` から JUnit を拾う。pecot-visual の `test-hooks` のように、JUnit を出さないレーンがあり、どれが合否のレーンかを決められない

## R8. 版と実行の表示

- **Decision**: サイトを作るときに、環境変数（`PECOT_SITE_SIDE`・`PECOT_SITE_PR`）を `conf.py` が読み、`html_context` に渡す。
  テンプレートの `header.html` が、リリース版でない側でだけページの上に 1 行の知らせと、最新のリリース版へのリンクを出す。Read the Docs の版の知らせと同じ形にする。コミット・プラグインの版・時刻・実行へのリンクは出さない（2026-11-18、#590 で帯から改めた）。
  手元では、環境変数が無ければ側を「ローカル」と出す
- **Rationale**: FR-012・FR-019・FR-021・FR-025。テーマの既存のテンプレート（`_templates/header.html`）を使えば、全ページに 1 か所で出せる。コミット・版・時刻・実行を並べた帯は、ほかのドキュメントのサイトに無く、読む人の判断にも使わないので外した
- **Alternatives considered**: 版の値をフッターに出す。ほかのドキュメントのサイトでも出しておらず、要る情報が無い

## R9. 状態の 5 つの区別

- **Decision**: `outcome_of` を、通った・落ちた・飛ばした・テストが無い・未実行の 5 つにする。決め方は data-model.md の「振る舞いの状態」
- **Rationale**: FR-014。今は、飛ばしたケースを含む項目と、つながるケースが無い項目を、どちらも「未実行」にしている。spec はこの 2 つを未実行と分ける
- **Alternatives considered**: 飛ばしたものを「通った」に含める。確かめていない項目を通ったと出すことになる

## R10. PR から PR 版へのリンク

- **Decision**: 保管して公開する run の preview-status の job が、PR の head のコミットに commit status（context `pages / preview`、`target_url` に PR 版の URL）を付ける
- **Rationale**: FR-023。PR の checks の欄から 1 クリックで開ける。PR の本文やコメントを増やさない（CLAUDE.md の「GitHub が UI で出す情報を本文に書かない」とそろう）。status は head のコミットに付くので、push のたびに新しいコミットへ付け直される
- **決まり**（R12 の結果による）:
  - `pages / preview` の context は、必須のチェックの名前と重ならない
  - `pages / preview` を付けるのは、main の定義で動く preview-status の job だけ
- **Alternatives considered**: PR にコメントを付けて更新する。PR の会話に機械の書き込みが増える

## R11. リンク切れ

- **Decision**: サイトは今の `sphinx-build -W`（警告を失敗にする）で作る。verify の job が、受けた側のツリーの中の内部リンクを確かめる。側の間の行き来のリンクは、store が組んだ `pages-store` の全体で確かめる。先が無い側には案内のページ（R4）を置くので切れない。外部リンクは確かめない
- **Rationale**: FR-019・SC-006。Sphinx の参照切れは `-W` で止まる。側の行き来のリンクは Sphinx の外で決まるので、組み立ての後に確かめる
- **Alternatives considered**: `sphinx-build -b linkcheck` で外部も確かめる。外部のサイトの都合で公開が止まる

## R12. `GITHUB_TOKEN` の commit status と必須のチェック

- **問い**: workflow が `GITHUB_TOKEN` で付けた commit status は、ソースを GitHub Actions（integration_id 15368）に固定した必須のチェックを満たすか
- **調べ方**: pecotcraft/pecot-sandbox の PR（2026-11-17、Issue #361・PR #362。調べた後に閉じた）
  - ruleset 27130266 は、`ci-result` と `version-plan` を integration_id 15368 で必須にし、承認は 0 件、merge queue は有効、bypass は無い。
    このリポの ruleset（26538811）とは、必須のチェック・承認・merge queue の形が同じ。このリポには App の bypass と `code_scanning` の規則があるが、PR の作者が必須のチェックを満たせるかには関わらない
  - sandbox の `version-plan` は `echo ok` で常に通るので、ほかの理由で `BLOCKED` にはならない
  - 飛ばした job は Success と報告され、必須のチェックを満たす（docs「Using conditions to control job execution」）。そのため、`ci-result` の job は `if: false` でなく、job ごと消して止めた

  | 手順 | status | `mergeStateStatus` |
  |---|---|---|
  | 対照: PR の ci.yml から `ci-result` の job を消す | 無し | `BLOCKED` |
  | 負の対照: 人のトークンの `gh api` で `ci-result=success` を付ける | creator は人のアカウント | `BLOCKED` |
  | `pull_request` の workflow（`permissions: statuses: write`）が `GITHUB_TOKEN` で `ci-result=success` を付ける（[run](https://github.com/pecotcraft/pecot-sandbox/actions/runs/44140684507)） | creator は `github-actions[bot]` | `CLEAN` |

- **結論**: `GITHUB_TOKEN` で付けた commit status は、GitHub Actions に固定した必須のチェックを満たす。人のトークンで付けた status は満たさない
- **前提**:
  - 承認 0 件の ruleset では、同じリポの PR の作者は、PR の ci.yml の `ci-result` の job を書き換えるだけで必須のチェックを満たせる。status で偽れるかどうかで、守れる範囲は変わらない
  - merge queue に入れた後は、merge_group の run が改めて要る。PR の head の status だけで queue を通るかは調べていない
- **決まり**: R10 の 2 つの決まりを contracts に書き、`.githooks/tests/test_pages_workflows.py` で固定する（#590）
- **守らない範囲**（#624）: 必須のチェックが PR の定義で動き、承認 0 件でマージできることは、欠陥として扱わない
  - GitHub は、書き込み権限のある人を信頼する側に置く。docs「Available rules for rulesets」に "Any person or integration with write permissions to a repository can set the state of any status check in the repository" とある。必須のチェックは失敗を止める安全網で、書き込める人への防壁ではない
  - PR から CI の定義を変えられなくする標準の手段は、org の ruleset の required workflows だけで、GitHub Team 以上が要る。pecotcraft は Free のプランで、費用に見合わない
  - 承認の必須と CODEOWNERS は、書き込み権限者が 1 人なので使えない。自分の PR を自分で承認できない

## R13. リリース版の定義

- **Decision**:
  - 版の基準はタグにする。各プラグインの最新のタグは、`<plugin>-v<semver>` のうち、プレリリースの接尾辞が無いものの semver の最大値
  - 各プラグインの合否のレーンは、そのプラグインのタグのコミットで動かす。レーンの一覧も、そのタグのコミットの `junit-lanes.json` から取る
  - サイトの骨組み（`libs/interface-spec`）は、最も新しいタグのコミットから取る。各プラグインの `plugins/<name>/` は、そのタグの中身に差し替える
  - 最も新しいタグのコミットは、ほかのタグのコミットをすべて祖先に持つもの。時刻では決めない。そういうコミットが無いときは作らない
  - 骨組みの文書（ガイド・はじめに・`reference/file-formats` など、プラグインの定義書の外のページ）は、最も新しいタグのコミットのものを出す。プラグインの版の対象外とする
  - タグのコミットが main の祖先でないときは作らない
  - 骨組みがタグの定義書を読めず、ビルドが落ちたときは、前のリリース版を残す
  - タグの ruleset で、`*-v*` の作成・更新・削除を止め、bypass を PECOT_BOT の App（`actor_type: Integration`）だけにする。`text-rules-v*` にも当たるが、リリースのタグなので当たるのが正しい
- **Rationale**:
  - nx release は、プロジェクトごとの group（`nx.json` の `projectsRelationship: independent`）で、version plan のあるものだけにタグを付ける
    - 2026-11-17 の本番では 3 つのプラグインに付き、text-rules には付かなかった
    - これまでプラグインは 3 つそろって付いてきたが、version plan の無いプラグインがあれば、そのプラグインには付かない
  - 1 回目の定義（Latest のリリースのタグが指すコミット）では、あるプラグインのリリースのコミットに、ほかのプラグインの未リリースの変更が載る
  - 骨組みからレーンの一覧を取ると、未リリースのプラグインに足したレーンが古いタグに無く、STRICT で止まる
  - 骨組みの文書は今「準備中」で、どのプラグインに属すかを決められない
  - タグの ruleset が無いと、書き込み権限のある人が main に無いコミットにタグを付け、リリース版にできる。main の祖先の条件と ruleset の両方で止める
- **Alternatives considered**:
  - Latest のリリースのコミットで作る: 1 回目の定義。上の欠陥がある
  - プラグインごとに別のサイトを作る: 全体の合否（FR-018）と、プラグインをまたぐ骨組みを 1 か所に出せない

## R14. PR 版の合否は ci の結果を使う

- **Decision**:
  - PR 版は、ci.yml の tests の後の job（`pages-preview`）で作る。テストは動かさない
  - ci が動かしたレーンは、同じ run の tests が残した JUnit を使う。ci が動かさなかったレーンは、保管中の開発版の run の artifact の JUnit で埋める
  - ci が動かしたのに JUnit が無いレーンは、開発版で埋めずに失敗する
  - 開発版で埋めたレーンと開発版のコミットを、job summary に出す
  - 開発版の artifact は 90 日残す。PR 版が、保管中の開発版の JUnit を取れるようにするため
  - pages-build.yml の `pull_request` は、閉じた PR の掃除を起こす `closed` だけにする
- **Rationale**:
  - 2 回目の形では、PR 版の作る run が 4 本のレーンを順に全部動かしていた。#630 では 12 分かかり、うち 9.5 分がレーンだった
  - 同じ PR で ci の tests も変更の届いたレーンを動かしていて、テストを 2 回動かしていた
  - PR 版はレビューの間に画面を見るためにあるので、ci の結果と同じころにできないと役に立たない
  - ci が動かさなかったレーンは、PR の変更が届いていないので、main の結果と同じになる。開発版が PR の base より新しいときは、その分だけ main の結果になる
  - 落ちたレーンを開発版の合格で隠さないよう、ci が動かしたレーンは ci の JUnit だけを使う
  - tests の JUnit は nx の outputs に入っているので、キャッシュに当たったレーンでも作業ツリーに戻る
- **トレードオフ**:
  - ci の `pull_request` の run は、PR を main に merge したコミットでテストを動かす。サイトは head で作るので、main が進んでいると、合否と中身のコミットが少しずれる
  - 開発版で埋めたレーンは、その PR のコミットの結果ではない。ページには出さず、job summary の「出どころ」の列で分かるようにする
- **Alternatives considered**:
  - pages-build のレーンを matrix で並べる: 7〜8 分に縮むが、テストを 2 回動かすことは残る
  - nx のリモートキャッシュで ci の結果を取り込む: pages-build と ci は同時に始まるので、同じ push のキャッシュはまだ無い。今回の push で変わったレーンは 2 回動く
  - PR 版を ci の完了の `workflow_run` で作る: 既定のブランチの文脈で PR のコード（`conf.py`・`_ext`）を動かすことになる（pwn request）
  - 開発版で埋めたことを job summary だけに出す: PR 版を見る人に届かない
