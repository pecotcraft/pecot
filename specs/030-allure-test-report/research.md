# Research: 公開サイトのテストレポートを Allure Report に替える

2026-11-23 に、公式の文書（allurereport.org/docs。ページに版と日付の表示は無い）と、公式リポのリリースのタグのソースで確かめた。文書に無く、ソースだけで確かめた事実には「（ソース）」と書く。ソースだけの事実は、文書の約束ではないので、版を上げると変わりうる。

読んだ版:

| もの | 版 | 出た日 |
|---|---|---|
| Allure 3（npm の `allure`） | 3.33.0 | 2026-11-05 |
| Allure 2 | 2.46.2 | 2026-11-10 |
| allure-js（`allure-vitest`・`allure-js-commons`） | 3.15.0 | 2026-11-17 |
| allure-python（`allure-pytest`） | 2.16.2 | 2026-09-29 |
| このリポの vitest・pytest・Node | 5.1.0・9.2.0・24.22.1 | — |
| sphinx-needs（このリポの docs） | 9.2.0 | — |

## R1. Allure の版

- **Decision**: Allure 3（npm の `allure` 3.33.0）を使う。版は固定し、ルートの `package.json` の devDependencies に入れる
- **Rationale**:
  - Allure 3 は Node だけで動く（`engines.node >= 22.18.0`）。このリポの dev container は Node 24.22.1 で、Java を足さずに済む。Allure 2 は Java 8 以上が要る
  - 履歴が 1 つの JSONL ファイルで、置き場所（`historyPath`）と上限（`historyLimit`）を設定で決められる（R5）。Allure 2 は、前のレポートの `history/` を結果のディレクトリへ写す形で、上限を設定できることは確かめられなかった
  - vitest と pytest の導入のページは、CLI の入れ方として Allure 3 の文書を指す
  - 画面の言葉に日本語がある（`reportLanguage: "ja"`。ロケールの一覧は README とソース）
- **公式の勧め**: 文書は、どちらを新しく入れるべきかを書いていない。Allure 3 を "the newer version rebuilt from the ground up"、Allure 2 を "the stable, mature version ... with the largest range of integrations" と書く。Allure 2 も出続けている
- **Alternatives considered**:
  - Allure 2: Java が要る。履歴の上限を決められない
  - 公式の GitHub Action（`allure-framework/allure-action`）: レポートを作らず、公開もしない。PR へのコメントと Quality Gate のためのもので、PR にレポートを置かないこの spec では使わない

## R2. vitest の結果を残す

- **Decision**: vitest の設定のすべてに、reporter `allure-vitest/reporter` を足す。`resultsDir` は、レーンごとに分けた `<project>/test-results/<target>/allure-results` にする。既存の `junit` の reporter は残す
  - 対象の設定: `plugins/pecot-workflow/cli/vitest.config.ts`、`plugins/pecot-visual/cli/vitest.config.ts`・`vitest.e2e.config.ts`、`plugins/pecot-tools/cli/vitest.config.ts`・`vitest.e2e.config.ts`、`libs/interface-spec/vitest.config.ts`・`vitest.site.config.ts`、`libs/text-rules/vitest.config.ts`
  - プロジェクトとレーンは、reporter の `globalLabels` で `project`・`lane` のラベルとして渡す。値は、nx が task に渡す環境変数（`NX_TASK_TARGET_PROJECT`・`NX_TASK_TARGET_TARGET`）から決める
  - `allure-vitest`・`allure-js-commons` は 3.15.0 に固定し、配布しない `libs/interface-spec` の `package.json` にだけ足す。`allure` の CLI は、ルートの `package.json` に足す
    - reporter は `libs/interface-spec/src/vitest/allure-reporter.ts` の 1 か所で、`allure-vitest/reporter` の instance として作る。名前やパスの文字列で渡すと、knip がプラグインの設定から `allure-vitest` を未宣言の依存と読む
    - プラグインの cli と `libs/text-rules` の devDependencies は、配布物の `runtime-lock.yaml` に写り、利用者の実行用ミラーにも入る。そこへ足すと、テストのためだけに配布物が変わる（#693）
  - nx の外で動いたとき（`NX_TASK_TARGET_TARGET` が無いとき）は、reporter を足さず、結果を残さない（#693）
    - `pecot-workflow` の設定は 1 つで 3 レーンを受け持ち、reporter は root にしか置けないので、nx の外では結果の置き場所を決められない
    - reporter が無い実行では、`allure.*` の呼び出しは `allure-js-commons` の `NoopTestRuntime` に当たり、何も書かずに警告を出す（ソース）。`verifies` が `allure.*` を呼ぶフェーズで、この警告の扱いを決める
  - 1 つのレーンがテストを何回かに分けて動かすときは、同じ結果のディレクトリへ書き足す。空にするのは、レーンの最初の 1 回だけにする
    - `pecot-visual:test-cli`・`pecot-tools:test-cli`: vitest の後に e2e
    - `interface-spec:test-unit`: vitest の後に pytest
  - `pecot-workflow:test-hooks` の 2 回目（`env -i` で、1 回目と JUnit を比べるための実行）は、Allure の結果を残さない。同じテストが 2 回出るのを避ける。`env -i` では nx の環境変数も消えるので、上の決まりで reporter が付かない
- **Rationale**:
  - 文書の形は `reporters: [..., ["allure-vitest/reporter", { resultsDir }]]`。peerDependencies は `vitest >= 1.3.0` で、5.1.0 を含む
  - `globalLabels` は reporter の文書にある設定で、すべての結果に付く。`ALLURE_LABEL_<名前>` の環境変数は vitest の文書に無く（ソース）、pytest では使えないので、採らない
  - Allure には「プロジェクト」「レーン」に当たる決まった項目が無い。文書（test result file）は、任意の名前のラベルを認めている。`parentSuite`・`suite` は、アダプタがファイルと describe から付けるので、上書きしない
  - レーンごとにディレクトリを分けると、レーンが結果を残したかどうかを、ディレクトリの有無で確かめられる（FR-015）
- **Alternatives considered**:
  - `allure run -- <テストのコマンド>` で包む: nx のレーンの中のコマンドを書き換えることになり、カバレッジの判定の終了コードの扱いを確かめ直す必要がある
  - JUnit XML を Allure に読ませる: 失敗のスタックと添付、`verifies` のリンクを渡せない
    - #809 で、Node の `--test-reporter=junit` の JUnit XML も確かめた。Allure 3.33.0 は 0 件と読み、ラベルも載らない。そこで `node --test` の 2 本は vitest に移す（R8）

## R3. pytest の結果を残す

- **Decision**: pytest のレーン（`interface-spec:test-unit` の docs のテストと、`.githooks` の 4 レーン）に `allure-pytest` 2.16.2 を足し、`--alluredir <結果のディレクトリ>` を付ける。`project`・`lane` のラベルは、`conftest.py` の hook で付ける
  - `libs/interface-spec/docs/pyproject.toml` の dev の依存に足す
  - `.githooks/tests/run.sh` の `uvx --with` に足す。`run.sh` は、nx のレーンから動いたときだけ、結果のディレクトリを消してから `--alluredir` を付ける（#693）
  - `--clean-alluredir` は使わない。xdist の worker もそれぞれ `pytest_configure` でディレクトリを消すので、落ちた worker の代わりが起きると、途中の結果が消える（ソース）
  - ラベルの値は、conftest の `addini`（`pecot_report_project`・`pecot_report_lane`）に `-o` で渡す。xdist の worker も同じ引数で起動する
  - `allure` は hook の中で読む。allure-pytest を入れない pytest（pre-push の `check-nx-env-inputs.sh`）でも、conftest が読める
- **Rationale**: 文書の形は `python -m pytest --alluredir allure-results`。`requires` は `pytest>=4.5.0` で、9.2.0 を含む。環境変数でラベルを付ける仕組みは pytest には無い（ソース）
- **実物で確かめる点**: `.githooks` のテストは pytest-xdist の `-n auto` で動く。`allure-pytest` と xdist を同時に使えることは、文書で確かめられなかった。最初のフェーズで実物で確かめ、結果がそろわなければ、このレーンだけ `-n 0` にせず、原因を調べて利用者に伝える
- **pytest の `verifies`**: pytest のテストは、今 `verifies` を 1 つも書いていない。pytest 用の `verifies` は作らない

## R4. 要件の ID を渡す

- **Decision**: vitest の `verifies(ctx, id)` を 1 か所（`libs/interface-spec/src/vitest/verifies.ts`）にまとめる。
  今の `ctx.annotate(id, 'verifies')` に加えて、次の 2 つを呼ぶ。各プラグインの `tests/_helpers/verifies.ts` は、これを re-export する
  - `tms(id, id)`: テストから定義書の項目へのリンク。URL は reporter の `links.tms.urlTemplate` が作る。名前は `nameTemplate` に頼らず `id` を渡す
  - `tag(id)`: 定義書の項目からテストを絞り込むための目印（R6）
  - reporter を足さない nx の外では、この 2 つを呼ばない。`allure-js-commons` は、test runtime が無いと、呼ぶたびに警告を出す
- **Rationale**:
  - 文書に「要件」の専用の項目は無い。外の管理の項目へのつながりには、リンクの型 `tms`（test management system）と `issue` がある。定義書の項目は、テストが確かめる対象なので `tms` を使う。独自のラベルは作らない（FR-005）
  - `links: { tms: { urlTemplate: "<定義書の URL>%s", nameTemplate: "%s" } }` は reporter の文書にある設定
  - 定義書の項目の URL は、ID だけからは決まらない（項目はコマンドごとのページにある）。
    sphinx-needs の permalink（`permalink.html?id=<ID>`。9.2.0 の設定 `needs_permalink_file`・`needs_permalink_data`）を使い、`urlTemplate` を `<側の URL>permalink.html?id=%s` にする。
    permalink は、2 つの設定の既定のまま出る。`needs_build_json` は `conf.py` にもうある
  - 側の URL はテストを動かすときに決まるので、環境変数 `PECOT_REPORT_SITE_URL` で渡す。渡さなければ、手元の `http://localhost:8000/` にする
  - `verifies` の呼び方は変わらないので、約 1,470 か所の呼び出しを書き直さない（FR-006）。`annotate` を残すので、JUnit XML は変わらない（FR-007）
- **Alternatives considered**:
  - 独自のラベル `requirement`: レポートの検索の対象にならない（R6）。独自の項目になる
  - 3 つの `verifies.ts` をそれぞれ直す: 同じ処理が 3 か所に残る（憲法 VIII）

## R5. 履歴

- **Decision**（2026-11-26 に改めた）: 履歴はリリース版だけが持つ。1 つのファイル `history.jsonl` として、S3 のバケットに置く。開発版は履歴を持たず、`historyPath` を渡さない
  - レポートを作る run が、S3 のファイルを読んで `historyPath` に渡し、足された後のファイルを S3 に戻す。バケット・ロール・書く run は #822 で決める
  - `historyLimit` は 10 にする。Allure のグラフの既定（`DEFAULT_CHART_HISTORY_LIMIT = 10`）と同じ回数
  - Allure のアダプタが付ける自動のラベル（`host`・`thread` など）は落とさない。タイムラインがこの 2 つを使う
  - `historyBaseUrl` は設定しない
  - 不安定なテストの判定は、`flakyDetection: { includePassedTests: true }` にする。ほかの値（`historyDepth: 10`・`stabilizationPeriod: 5`）は既定のまま。既定では、最新の実行で落ちたテストにしか印が付かない
    - `historyDepth` の 10 は、残す回数と同じになる
- **Rationale**:
  - Allure 3 の履歴は、1 回の実行が 1 行の JSONL で、`historyPath` のファイルを読み、足す（文書の history-and-retries・how-it-works-history-files）。置き場所は自分で持ち越す。公式の GitHub Pages の手引きの Allure 3 の例は、履歴を持ち越していない
  - 開発版のレポートは、マージキューの結果を寄せ集めたもので（R9）、PR の CI と見るものがほぼ同じになる。履歴の価値は、リリースをまたいだ推移と不安定なテストにあるので、リリース版にだけ持つ
  - 大きさ（2026-11-26 に、1 つの側の 17,975 件で測った）
    - 履歴 10 回で、レポートは約 440 MB、`history.jsonl` は約 225 MB。git の 1 ファイル 100 MB を超えるので、`pages-store` に置けない
    - 自動のラベルを落とすと、レポートは約 353 MB になる。落とさずに、履歴を S3 に置いて収める
    - 開発版は、履歴なしで約 134 MB。2 つの側のレポートを合わせても、Pages の 1 GB に収まる
    - S3 の費用は、225 MB を置いて月 1 セント未満
  - `historyBaseUrl` は、過去のレポートへのリンクを作るための設定。このサイトは、レポートを側ごとに上書きし、過去のレポートを残さないので、設定しない
  - 前回との違い（New・Fixed・Regressed・Malfunctioned）と Flaky の印は、履歴があれば Allure が出す（文書の test-stability）
  - 履歴は、添付とステップを持たない。添付は、今の実行のレポートにだけある
- **経緯**: `historyLimit` の既定は無制限。初めは Allure 2 が持つ数（20）に合わせ、#698 で、大きさが公開の上限を超えるので 3 に下げた。2026-11-26 に、置き場所を S3 に替えて 10 にした
  - #698 のとき、main の結果（17,635 テスト）で測ると、履歴 1 件で `history.jsonl` が約 25 MB、レポートが約 30 MB 増えた
  - 20 件では 1 つの側が約 1.2 GB になり、GitHub の 1 ファイル 100 MB と Pages の 1 GB を超えた
  - 3 件では `history.jsonl` が約 67 MB、2 つの側のレポートと履歴で約 550 MB に収まったが、不安定の判定とグラフが見る前の回は 3 件に限られた
- **Alternatives considered**:
  - `pages-store` に置く（#698 から 2026-11-26 までの形）: 10 回の履歴が、git の 1 ファイル 100 MB を超える
  - Release の添付に置く: 採らなかった。2026-11-26 に、利用者が S3 を選んだ
  - 自動のラベルを落として小さくする: タイムラインが使う `host`・`thread` が無くなる
  - Allure Report Storage（OSS）を自前で動かす: Allure の運営する置き場所は無く、Docker か Cloudflare Workers で動かし続けることになる
  - Actions の cache か artifact に置く: 期限で消える。028 が保管ブランチを足した理由と同じ
  - 履歴を保管の job で足す: 保管の job に Node と Allure が要る。保管の job は、中身を写すだけにしておく

## R6. 定義書の項目から、テストへ飛ぶ

- **Decision**: 定義書の項目のリンクは、`<側>/test-report/index.html?tags=<ID>` にする。サイトを作るときに、定義書の ID だけから作る
- **Rationale**:
  - テスト 1 件の URL は `index.html#<testResultId>` で、`testResultId` は実行ごとに変わる uuid から作る（ソース）。結果を読まずに作れず、実行をまたいで変わる
  - 絞り込みの状態は、URL の `#` の前の query に載る（`tags`・`query`・`status`・`transition` など。ソース）。`?tags=<ID>` は、結果を読まずに作れる
  - 検索の対象になるラベルは、決まった名前（`tag`・`suite`・`epic` など）だけで、独自のラベルは対象にならない（ソース）。そこで、ID を tag としても持たせる（R4）
- **文書に無い挙動への依存**: URL の形は文書に無い。Allure の版を固定し、`interface-spec:test-site` に、作ったレポートを `?tags=<ID>` で開いて、その ID のテストだけが出ることを確かめるテストを置く。版を上げて形が変わると、このテストが落ちる
- **Alternatives considered**:
  - レポートの `test-results.json` を読んで、テスト 1 件の URL を作る: サイトを作るときにテストの結果が要る（FR-011・FR-017 に反する）。形は文書で確かめられなかった
  - `?query=<ID>`: リンクの名前や URL にも当たり、ID が前方一致するほかの項目も出る

## R7. 1 つのレポートにまとめる

- **Decision**: `allure generate <結果のディレクトリ>...` に、レポートのレーンの結果のディレクトリを全部渡す。設定は `.githooks/scripts/test_report/allurerc.mjs` に置く
  - plugin は awesome を 1 つ。`groupBy: ["project", "lane", "parentSuite", "suite", "subSuite"]`、`reportLanguage: "ja"`
  - #811 で、`groupBy` を `["epic", "feature", "story"]` に替えた。値の決まりは [data-model.md](data-model.md) のラベルの表にある
  - レポートの名前は、トップレベルの `name: "pecot テストレポート"` に置く。awesome の `reportName` は、3.33.0 では画面の題を変えない（ソース。awesome は options の後に、トップレベルの `name` から来る `context.reportName` を渡す）
- **Rationale**: 複数のディレクトリを渡す形は、CLI のヘルプの例と、設定の `resultsDir` の配列にある。結果には「どのディレクトリから来たか」の項目が無く、出どころはラベルでだけ分かる。`groupBy` は任意のラベルで木を組む（plugin-awesome の README）
- **実物で確かめた点**（Phase 2。`text-rules:test-unit` と `githooks:test-nx-cache`）: `groupBy` は縮めない
  - vitest は `parentSuite` がファイル、`suite` が `describe`、`subSuite` が入れ子の `describe`。pytest は `parentSuite` がパッケージ、`suite` がモジュール、`subSuite` がクラス
  - どちらも `lane` の下が `parentSuite`・`suite` の順に並び、同じ深さになる。テストは、書いた題で葉に出る
  - ラベルを持たない段は飛ばされ、テストは 1 つ上の段に並ぶ（`describe` の無い `it`・クラスの無い pytest の関数）。読みにくくはならない

## R8. レポートのレーンの定め

- **Decision**: `.githooks/scripts/test_report/report-lanes.json` を、レーンの 1 か所の定めにする。nx の `test-*` の target を全部並べ、レポートに入れるレーンには結果のディレクトリを、入れないレーンには理由を書く

  | 入れるレーン（22） | 道具 |
  |---|---|
  | `pecot-workflow:test-cli`・`test-hooks`・`test-skills` | vitest |
  | `pecot-visual:test-cli`（e2e を含む） | vitest |
  | `pecot-tools:test-cli`（e2e を含む） | vitest |
  | `text-rules:test-unit` | vitest |
  | `workflow-core:test-unit`（#791 で足した） | vitest |
  | `interface-spec:test-unit` | vitest と pytest |
  | `interface-spec:test-site` | vitest |
  | `githooks:test-nx-cache`・`test-nx-affected`・`test-ci`・`test-checks` | pytest |
  | `pecot-visual:test-slidev`・`nx-release:test-unit` | vitest（`node --test` から移した。#809） |
  | pecot-workflow の `test-bootstrap`、各プラグインの `test-release`、pecot-visual の `test-hooks`・`test-compare`・`test-skills` | bash（`bash-test.sh` が結果を書く。#810） |

  入れないレーンは、今は無い。

- **2026-11-26 に改めた**: 上の「入れないレーン」も入れ、nx の `test-*` のレーンすべてをレポートに入れる（spec の FR-002）。上の 2 つの表は、改める前の記録として残す
  - `node --test` の 2 本は、vitest に移し、`allure-vitest` で結果を残す（#809。R2 の Alternatives）
  - bash の 9 本の結果の残し方は、#810 で決める

- **Rationale**: `.githooks/tests` に、nx の `test-*` の target がこのファイルに全部あることを確かめるテストを置く。レーンが増えたとき、入れるか入れないかを書かないと CI が落ちる（FR-002）
- **`junit-lanes.json` の扱い**: 消す。今の読み手は、合否を描く作り・CI の JUnit の artifact・リリース版の材料の 3 つで、どれもこの機能で無くなる。サイトに載せるプラグインの一覧は、定義書（`plugins/*/interface/`）を持つプラグインから決める

## R9. テストを動かす run と、公開の流れ

- **Decision**: レポートを作る workflow `test-report.yml` を足す。公開は、今の `pages-deploy.yml` が受ける。開発版の材料は、2026-11-26 に、マージキューの結果の寄せ集めに改めた

  | job | すること | 権限 |
  |---|---|---|
  | `side` | 側と材料を決める。リリース版は、タグから材料（プラグインごとのコミットと、結果を出せるか）を決める。開発版は、レーンの最新の結果があるかを見て、結果の無いレーンを決める | `contents: read` |
  | `tests`（matrix） | レーンを 1 つずつ dev container で動かす。リリース版は全レーン、開発版は結果の無いレーンだけ。テストが落ちても、結果のディレクトリを artifact に上げる | `contents: read` |
  | `report` | 全レーンの結果がそろったことを確かめ、`allure generate` でレポートを作り、artifact `test-report-<側>` に上げる。リリース版だけ、S3 から履歴を取って渡す | `contents: read`。S3 の履歴を扱う job は、OIDC のために `id-token: write` も持つ（#822） |

  - 契機: main への push（開発版）、`workflow_dispatch` の `side`（main からだけ）、`release.yml` の本番の land の後（リリース版）。`pull_request` は契機にしない
  - `workflow_dispatch` の `side=dev` も、push と同じく、結果の無いレーンだけを流して寄せ集める
  - `pages-deploy.yml` は、`workflow_run` の対象に `test-report.yml` を足す。出どころの確かめ（`provenance.py`）に、この workflow のパスと、PR の run を受けない決まりを足す
  - 保管（`store.py`）は、レポートを `<側>/test-report/` に置く。定義書の側を差し替えるときは `test-report/` を残し、レポートを差し替えるときは定義書を残す
- **開発版の材料**（2026-11-26 に改めた）: main では流し直さない
  - マージキューの `ci.yml` の run が、流したレーンの結果を artifact に上げる
  - 使うのは、main に入ったコミットを試した run の結果だけ。マージされなかった run の結果は使わない
  - レーンごとに最新の 1 回分を保管し、新しい結果で置き換える。マージの変更が届かないレーンは、前の結果のまま使う。入力が変わっていないので、前の結果が今のコミットの結果でもある
  - マージキューが流さないレーンには、変更が届いたのに省いたレーンもある。`list-test-lanes.sh` の積のモードは、PR の変更のレーン（`queue_base..head`）と main の変更のレーン（`pr_main..queue_base`）の積だけを流し、PR の CI で試し済みのレーンを省く。このレーンは、その変更を試した run（PR の CI など）の結果に替える
  - マージキューを通らずに main に入るコミットもある。リリースの land は、バンプのコミット（と、main が進んでいたときのマージのコミット）を main へ直接 push する（`release-land.sh`）。このコミットで入力が変わったレーンは、main で流す
  - 結果がまだ無いレーン（足したばかりのレーン・保管の初回）だけを、`tests` の job が main で流す
  - #821 の計画で決める事柄
    - 保管の置き場所（`pages-store` か S3）と、そこへ書く run。028 の信頼の境界（FR-007・FR-026〜FR-028）に合わせる
    - マージキューが試したコミットと、main に入ったコミットが同じ SHA になるか。コミットの確かめ方
    - マージキューの結果の tms のリンクを、開発版のサイトに向ける渡し方。`PECOT_REPORT_SITE_URL` はテストを動かす時点で結果に書き込まれ、nx の入力でもある。マージキューは PR の run の nx キャッシュを取り込むので、渡し方とキャッシュの一致を合わせて決める
    - nx のキャッシュから戻った結果を、そのレーンのその run の結果として数えるか
    - 積のモードで省いたレーンの結果の取り方（PR の CI の run の結果を上げて使うかなど）
    - マージキューを通らないコミット（リリースの land）の見分け方と、そのコミットで入力が変わったレーンの決め方
    - レーンごとに、どのコミットの結果かをレポートで読める形（環境の情報など。#817 と合わせる）
- **Rationale**:
  - 定義書の公開（`pages-build.yml`）と分けるので、定義書はテストを待たない（FR-011）
  - 信頼の境界は 028 のまま使う。公開サイト（`pages-store`）に書くのは、`pages-deploy.yml` の store の job だけ（FR-014）。S3 の履歴を書く run は #822 で決める
  - 開発版は、古いコミットのレポートで新しいレポートを上書きしない（028 の `dev_is_newer` と同じ決まりを、レポートにも当てる）
  - マージキューは、マージした後の状態をもう試している。main で同じものを流し直しても得るものが無い。#492 で ci の main での実行を消したのと同じ理由
- **リリース版**: `release_sources.py` が、プラグインごとに最新のタグのコミットを決める。そのコミットに `report-lanes.json` があれば、結果を出せるタグと読む。`tests` の job は、そのコミットを取り出し、そのプラグインのレーンを動かす。libs と `.githooks` のレーンは、最も新しいタグのコミット（骨組み）で動かす
- **同じ側の run の重なり**: concurrency は `test-report-<side>` で、`cancel-in-progress: false` にする。動いている run は取り消さず、後から来た run は待つ。待てるのは 1 つで、さらに来ると、待っていた run が新しい run に置き換わる（concurrency の既定の決まり）
  - リリース版の全レーンの実行は、定義書のビルドより長い。取り消す形にすると、続けて起動したとき、レポートが出ない
  - 待っていた run が置き換わるので、すべての起動のレポートができるわけではない。リリース版の履歴の行は、できたレポートの分だけ増える
  - 前の run が履歴を S3 に戻す前に、次の run が履歴を読むと、履歴の 1 行が抜ける。レポートは最新のものが残るので、受け入れる
- **結果のコミット**: `tests` の job は、結果の artifact に、レーンと取り出したコミットを書いた `source.json` を入れる。`report` の job は、リリース版では、これを材料のコミットと比べる（FR-012）。開発版では、レーンごとのコミットが main の祖先であることを確かめる（形は #821）
- **Alternatives considered**:
  - main への push のたびに、全レーンを流し直す（2026-11-23 から 2026-11-26 までの形）: マージキューと同じ試験を重ねて流す
  - `ci.yml` の結果を使う: 2026-11-23 の clarify では、affected のレーンしか動かないので採らなかった。2026-11-26 に、変更が届かないレーンを前の結果で埋める形で採った（上の開発版の材料）
  - `pages-build.yml` に足す: 定義書の公開がテストを待つ

## R10. サイトからのリンク

- **Decision**: リンクを出すかどうかは、サイトを作るときに、側と定義書だけから決める

  | 側 | 側からレポートへのリンク | 項目からテストへのリンク |
  |---|---|---|
  | 開発版 | 出す | 出す |
  | リリース版 | 結果を出せるタグを持つプラグインが 1 つでもあれば出す。入っていないプラグインの名前を、リンクのそばに書く | そのプラグインが結果を出せるタグなら出す |
  | PR 版・手元 | 出さない | 出さない |

  - 側からのリンクは、フッターのリンクの並び（`_templates/footer.html`）に足す
  - レポートがまだ保管されていない側には、保管の job が `test-report/index.html` に案内のページを置く（028 の FR-029 と同じ形）。リンク切れにならない
- **Rationale**: サイトはテストを待たずに作るので、レポートがあるかどうかを作るときに知れない。案内のページがあれば、最初の 1 回だけの空白でも、リンクが切れない。spec の FR-010 は、この形に改めた
- **Alternatives considered**: サイトを作るときに公開中のレポートの有無を HTTP で確かめる: 作る run の結果が、公開の状態で変わる

## R11. 添付

- **Decision**: 判定に使ったものを、判定の前後で同じ参照から添付する

  | テスト | 添付するもの |
  |---|---|
  | `libs/interface-spec/tests/site/layout.test.ts` | 測ったページの `page.screenshot()`。ケースごとに 1 枚（全ページを回すケースは、違反したページか `index.html`） |
  | pecot-visual の e2e で、PNG・SVG・PDF を作るもの（`drawio-*`・`pptx-preview-soffice` など） | 判定した PNG・SVG・PDF のファイル |
  | pecot-visual の e2e で、xlsx を作るもの（`evidence-*`・`mcp-tools` など） | 作った xlsx と、判定した PDF か、判定した画素をそのまま包んだ PNG |
  | pecot-visual の e2e で、PPTX を作るもの（`golden-path-*`・`slidev-to-pptx-*` など） | 判定した PPTX のファイル |

  - 対象のファイルの一覧は、下の「対象のテスト（T021）」の表に 1 つずつ挙げる
  - contracts の「添付」の `attachFile`・`attachContent` を使う。中身を読んで `attachment` に渡す
- **Rationale**: PPTX と PDF は、テストが画像にせずに判定している。添付のために画像へ変えると、判定したものと別のものを見せることになる（FR-007b）。そこで、成果物そのものを添付する。spec の FR-007a は、この形に改めた
- **大きさ**: 添付は、レポートの `data/attachments/` に 1 回分だけ入る。保管の job の大きさの知らせ（900 MB）が、レポートも数える
  - 手元で `test-site` と、pecot-visual の e2e の 2 ファイル（`drawio-png-chromium`・`drawio-pdf-chromium`）から作ったレポートは 12 MB だった
    - そのうち `data/attachments/` は 3.6 MB（19 ケース・20 個）。大きいのは、`layout.test.ts` の全体の画面の PNG（1 枚 0.8 MB まで）

### 対象のテスト（T021）

対象は、テストが開いた画面か、作った PNG・SVG・PDF・PPTX・xlsx を、判定に使うもの。CLI の中で Chromium が動くだけで、テストが画面と成果物のどちらも判定に使わないものは、対象にしない。レーンは e2e に限らない。

| ファイル | ケース | 添付するもの |
|---|---|---|
| `cache-identity-full-vs-diff` | 1 | 本判定の 2 つの PPTX（全変換・差分変換）。外部 pptx モードは渡された 2 つ |
| `cache-identity-no-cache` | 1 | `--no-cache` の run の PPTX |
| `cache-warning-cleanup-failure` | 1 | 壊した後の run の PPTX |
| `cache-warning-save-failure` | 1 | 保存に失敗した run の PPTX |
| `drawio-embed-handshake-race` | 1 | `exportViaEmbed` が返した SVG |
| `drawio-pdf-chromium` | 4 | 1: SVG と PDF。2・3: 1 と同じ PDF。4: degrade で残る SVG |
| `drawio-png-chromium` | 1 | 書き出した PNG |
| `element-error-observability` | 1 | 2 回の run の PPTX |
| `evidence-create-cli` | 1 | 書き出した xlsx |
| `evidence-xlsx-format-render` | 1 | 作った xlsx と、判定した各ページの PNG |
| `evidence-xlsx-soffice` | 4 | 1〜3: 作った xlsx と、判定した PDF。4: 作った xlsx と、判定した各ページの PNG |
| `golden-path-create-convert` | 1 | 変換した PPTX |
| `golden-path-default-out` | 1 | 既定のパスに出た PPTX |
| `golden-path-hyperlink` | 1 | 変換した PPTX |
| `mcp-tools` | 3 | `drawio_export` の成功: SVG と PDF。degrade: SVG。`evidence_create`: xlsx |
| `mcp-windows-path` | 2 | 書き出した xlsx |
| `pptx-preview-soffice` | 3 | 1・2: preview の PDF。4: 変換した PPTX と、その PDF |
| `slidev-to-pptx-animation-policy` | 2 | 変換した PPTX、セクションの staging の PPTX、キャッシュの run の PPTX |
| `slidev-to-pptx-embedded-fonts` | 2 | 変換した PPTX |
| `slidev-to-pptx-hash-router` | 3 | 1: 変換した PPTX。2・3: 判定したステップの PPTX |
| `slidev-to-pptx-pipeline-smoke` | 3 | 2〜4: 変換した PPTX |
| integration の `drawio-url`（capturePng smoke） | 1 | 書き出した PNG |

FR-007a（画面・成果物の添付）の対象にしないものを次に並べる。出力の文字列・MCP の応答で判定するものは、FR-007c の対象として出力を添付する（下の「出力の添付」）。

| FR-007a の対象にしないもの | 理由 |
|---|---|
| `cache-warning-merge-failure` | 書き出しに失敗する run で、成果物が無い。テストは payload だけを見る |
| `exit-code-contract`・`help`・`version`・`runner-unexpected-exit-log` | 終了コードと出力の文字列だけを見る |
| `golden-path-errors` | 失敗の理由と、子プロセスの execve だけを見る |
| `mcp-stdio` | MCP の応答だけを見る |
| `mcp-tools` の残りの 9 ケース | 一覧・URL・HTML・md・dev サーバの HTTP・エラーの応答を見る |
| `pptx-preview-soffice` の 3 | PDF ができないことを見る |
| `slidev-to-pptx-pipeline-smoke` の 1 | `dist` の JS の中身だけを見る |
| `theme-versions-side-by-side` | `dist` の JS を見る。ブラウザを開かず、画像も作らない |
| integration の `drawio-url`（表示用 HTML の遷移 smoke） | 開く画面はテストが置いた stub で、遷移先の URL だけを見る |

- 添付は、成果物を作った直後、どの判定よりも前に置く。判定で落ちたときも残る

### 出力の添付（#816、FR-007c）

- **Decision**: テスト対象を CLI・MCP のツール・hook・子プロセスとして動かすテストは、判定に使った出力を添付する。添付は、出力をテストへ返す補助が、返す値そのものから、判定より前に作る

  | 対象 | 添付するもの |
  |---|---|
  | CLI をプロセス内か子プロセスで動かすテスト | 標準出力・標準エラー |
  | MCP のツールをクライアントから呼ぶテスト | `tools/call`・`tools/list` が返した結果の全体（JSON） |
  | hook・スクリプト・サーバを子プロセスで動かすテスト | 標準出力・標準エラー。HTTP で応答を読むものは、その状態と本文 |
  | 上のテストのうち、書き出したファイルを読んで判定するもの | 読んだファイルの中身 |

  - 標準出力・標準エラーは空でないものを添付し、両方空なら空の標準出力を 1 つ添付する。名前は、コマンド（先頭から 200 字）と終了コード
  - 関数を直に呼ぶ単体テストの戻り値は添付しない。判定する値はテストのコードにあり、落ちたときは vitest・pytest が差分を出す
  - 準備で動かすコマンドも、補助を通れば添付する。`beforeAll` で動かしたものは、allure-vitest が describe の中のテストの全部に付ける
  - 対象のレーンは、レポートのレーンのうち `interface-spec:test-site` を除くすべて。#809 で足した `pecot-visual:test-slidev`・`nx-release:test-unit` も入る。`test-site` は画面の添付のまま

  | 補助 | 添付 |
  |---|---|
  | `libs/interface-spec/src/vitest/attach.ts` | `attachText`・`attachJson`・`attachJsonInTest`・`attachOutput`・`readOutput`・`attachReadText`・`attachAtTestEnd` |
  | MCP のクライアント（3 つのプラグインの `tests/_helpers/attaching-client.ts` の `AttachingClient`） | `callTool`・`listTools` が返した結果の全体 |
  | pecot-visual の統合テストの `makeStream(name)` | 名前を付けた stream の、テストの終わりの中身 |
  | `libs/workflow-core/tests/_helpers/captured-io.ts` の `capture()` | テストの終わりの `out`・`err`。`TestRunner.getCurrentTest()` があるときだけ `onTestFinished` で添付する |
  | pecot-workflow の `runCommand`・`runInProcess` | 標準出力・標準エラー（`capture({ attach: false })` で二重を避ける）。`read` は読んだ中身 |
  | pecot-workflow の `callToolOnce` | `toolOutcomeOf` で確かめる前の結果の全体 |
  | pecot-workflow の hook の `run` | 起動の失敗で throw する前の出力 |
  | `.githooks/tests/attach.py` | `run_attached`（`check`・timeout でも添付してから投げる）・`attach_output`・`read_output`・`attach_json` |

- **名前**: コマンドを動かさず、io を注入して `run` を同じプロセスで呼ぶテストは、argv が無い。workflow-core の `capture()` と pecot-visual の `makeStream(name)` は、stream の名前（`capture stdout`・`stdout` など）を名前にする。終了コードは `run` の戻り値で、テストが判定する
- **Rationale**: 成功したテストが実際に何を出したかを、レポートから確かめるため。`subprocess.run` や `child_process` を全体で差し替える案は採らない。テスト対象が中で動かす子プロセスの出力まで添付され、判定に使ったものと見分けられない
- **大きさ**: #809 の 2 本を足す前の 13 レーンを手元で動かして作ったレポートの `data/attachments/` は、13,910 個で 21 MB だった（2026-11-26）
  - nx の graph の JSON（1 個 約 120 KB）と `nx show target inputs` の出力（1 個 約 190 KB）は、テストがその一部だけで判定する。全体を添付すると、2 つの nx のレーンで 47 MB になった
  - そこで、判定に使ったタスク名・依存・target の設定・ファイルだけを `attach_json` で添付する。2 つのレーンで 1.5 MB になる。nx が落ちたときは、出力の全体を添付する
  - `beforeAll` で取った `tools/list` の結果は、describe のテストごとに複製される。そこで、全体は全体を見るテストだけが添付し、1 つのツールを見るテストはその項目だけを添付する
  - リポのファイルの一覧（`git ls-files`）は、テストの入力なので添付しない
  - `pages-store`（2026-11-26 に 535 MB）に開発版とリリース版の増えを足すと、約 565 MB と見込む。保管の job の知らせ（900 MB）に収まる
- `attachmentPath` は使わず、中身を読んで `attachment` に渡す（contracts の「添付」）
  - `allure-vitest` 3.15.0 の reporter は、`attachmentPath` のパスを `onTestRunEnd` で読む。テストが `afterAll` や `finally` で消した成果物は抜ける
- PPM の画素で判定するテストは、その画素をそのまま可逆の PNG に包んで添付する。判定に使った画素そのものから作るので、FR-007b に当たらない
- Allure 3.33.0 は PDF・PPTX・xlsx を中で表示しない。落として開く

## R12. 片付け

- **Decision**: 次を消す
  - `sphinx-test-reports` の依存と、`conf.py` の `sphinx_test_reports`・`tr_*` の設定
  - `iface_defs.py` の JUnit を読む部分・合否を描く部分・`IfaceTests`・`IfaceOverview`・`check_strict`・`junit_lanes_table`
  - `docs/development/`
  - 環境変数 `PECOT_SITE_RESULTS`・`PECOT_SITE_STRICT`・`PECOT_SITE_LANES`
  - `junit-lanes.json`、`.githooks/scripts/pages_site/lanes.py`・`collect.py`・`dev_side.py` と、それぞれのテスト
  - `ci.yml` の「Stage JUnit」「Upload JUnit」の step
- **残すもの**: 各 vitest の設定の `junit` の reporter と JUnit XML。`pecot-workflow:test-hooks` が、2 回の実行の JUnit を比べる（`compare-junit.ts`）
- **028 の spec**: FR-014〜FR-019 と、`PECOT_SITE_RESULTS` に触れる Clarifications に、この機能で取り下げた旨を足す（FR-025）
