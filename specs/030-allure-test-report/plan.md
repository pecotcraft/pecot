# Implementation Plan: 公開サイトのテストレポートを Allure Report に替える

**Branch**: `feat/breakdown-allure-report/670` | **Date**: 2026-11-23 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/030-allure-test-report/spec.md`

## Summary

vitest と pytest の全レーン（12 本）に、Allure の公式のアダプタ（`allure-vitest`・`allure-pytest`）を足し、テストのたびに Allure が読む結果を残す。`verifies` は、要件の ID を Allure の `tms` のリンクと tag としても渡す。
2026-11-26 に、レポートのレーンを nx の `test-*` のすべてに広げた。`node --test` の 2 本は vitest に移し（#809）、bash の 9 本は #810 で入れる。

テストを動かしてレポートを作る workflow `test-report.yml` を足す。リリース版は、本番のリリースのたびに全レーンを動かして、Allure 3 のレポートを 1 つ作る。
開発版は、2026-11-26 に改めた形で作る。main では流し直さず、マージキューで流したレーンの最新の結果を寄せ集めて作り、結果の無いレーンだけ main で流す（#821）。
公開は、028 の `pages-deploy.yml` が受け、保管ブランチ `pages-store` の `<側>/test-report/` に置く。PR 版にはレポートを置かない。
履歴はリリース版だけが 10 回分を持ち、S3 に置く。開発版は履歴を持たない（#822）。

定義書の項目は、`test-report/index.html?tags=<ID>` へのリンクを持つ。リンクは定義書だけから作るので、定義書の公開はテストを待たない。

画面を開くテストと成果物を作るテストは、判定に使った画面の画像か成果物を、成功でも失敗でも毎回添付する。

最後に、sphinx-test-reports を使った自前のテストレポートと、合否を描く作り・`junit-lanes.json`・`PECOT_SITE_RESULTS` を消す。

調べた結果と判断の理由は [research.md](research.md) にある。

## Technical Context

**Language/Version**: TypeScript（vitest の設定と `verifies`、テストの添付）、Python 3（pytest の `conftest.py`、Sphinx の拡張、`.githooks/scripts/` のスクリプト。pyright strict）、GitHub Actions の YAML、JavaScript（`allurerc.mjs`）

**Primary Dependencies**: `allure` 3.33.0・`allure-vitest` 3.15.0・`allure-js-commons` 3.15.0（npm）、`allure-pytest` 2.16.2（PyPI）。版は固定する。
今ある vitest 5.1.0・pytest 9.2.0・Sphinx・sphinx-needs 9.2.0 はそのまま。`sphinx-test-reports` は消す

**Storage**: レポートは、保管ブランチ `pages-store` の `<側>/test-report/`。リリース版の履歴は S3 のバケット（#822）。開発版のレーンの最新の結果の置き場所は #821 で決める。結果とレポートの受け渡しは artifact（`retention-days: 7`）

**Testing**: vitest（`verifies` の単体テスト、`interface-spec:test-site` でレポートの絞り込みの URL を実物で確かめる）、pytest（`.githooks/tests` の workflow の形・出どころの確かめ・保管・レーンの定め、`libs/interface-spec/docs/tests` の拡張）

**Target Platform**: GitHub Actions の ubuntu-latest と、ci.yml と同じ dev container（Node 24.22.1）。公開先は GitHub Pages

**Project Type**: リポの運用の仕組み（workflow とスクリプト）、テストの設定、配布しないライブラリ（`libs/interface-spec`）の文書サイト

**Performance Goals**: テストの結果がそろってから 30 分以内にレポートが変わる（SC-008）。定義書の公開の時間は延びない（SC-007）

**Constraints**: 公開サイト全体で 1 GB 以内。PR の run は、レポートと履歴を書き換えない。`pull_request_target` を使わない。手での起動は任意の SHA を受けない。テストの成否・JUnit XML・カバレッジの判定を変えない

**Scale/Scope**: レポートは 2 つ（開発版・リリース版）。レポートのレーンは 12 本で、#809・#810・#795 の後は 22 本。`verifies` の呼び出しは約 1,470 か所（書き直さない）。
履歴はリリース版だけが持ち、10 回まで（2026-11-26 に改めた。research R5）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判断 | 理由 |
|---|---|---|
| I. ライブラリ優先 | 合格 | `verifies` は `libs/interface-spec/src/vitest/` の 1 か所に置き、各プラグインは re-export する。レポートを作る処理は `.githooks/scripts/test_report/` に置き、workflow の `run:` には処理を書かない |
| II. CLI インタフェース | 合格 | レポートを作る処理は、手元でも workflow でも同じコマンド（`generate.py`）で動く。入力はレーンの定めと結果のディレクトリ、出力はレポートのディレクトリ |
| III. テストファースト | 合格 | `verifies` が tms と tag を残すこと、レーンの定めの漏れ、出どころの確かめ、保管の置き場所は、テストを先に書く。Red を確かめてから実装する |
| IV. 標準準拠 | 合格（文書に無い挙動への依存が 1 つ） | アダプタの設定・結果の残し方・複数のディレクトリからの作成・履歴は、公式の文書の形に従う。要件の ID は、Allure が用意しているリンクの型 `tms` と tag に入れ、独自の項目を作らない。定義書からの絞り込みの URL（`?tags=`）は文書に無く、ソースで確かめた挙動に頼る（research R6）。標準との不適合ではないが、版を上げると変わりうるので、版を固定し、実物で確かめるテストを置く。利用者に伝える |
| V. 品質の自動チェック | 合格 | TS は tsc strict、Python は pyright strict と ruff、workflow は actionlint・yamllint。`.githooks/scripts/test_report/` を `githooks-lint` の範囲に足す。消すコードは残さず削除する |
| VI. 層の分離 | 合格 | レーンの定めの読み込みと判定（どのレーンがそろったか）は純粋な処理、`allure` の起動と artifact の扱いは I/O に分ける |
| VII. シンプルさ | 合格 | 新しい nx project は作らない。PR 版のレポート・過去のレポートの保存・`historyBaseUrl`・pytest 用の `verifies` は作らない |
| VIII. 抽象化しない | 合格 | Allure のアダプタと CLI を直接使う。結果の形を自前で作らない。`verifies` の 3 つの写しを 1 つにする |
| IX. 統合を先にするテスト | 合格 | レポートの絞り込みは、実物の結果から作ったレポートを Chromium で開いて確かめる。出どころの確かめは、GitHub の API の応答の実物の形を入力にする。quickstart の手順を実物で動かす |

Phase 1 の後の再確認（2026-11-23）: 合格。
`test-report.yml` の job は、リリース版の履歴を S3 で読み書きする job が OIDC のために `id-token: write` を持つほかは、`contents: read` だけにする（2026-11-26 に改めた）。
公開サイト（`pages-store`）に書くのは `pages-deploy.yml` の store の job だけ。S3 に書く run と、ロールの信頼の条件は #822 で決める。
レポートの置き場所は、028 の側のディレクトリの中に足す形で、ほかの側と定義書を消さない。

## Project Structure

### Documentation (this feature)

```text
specs/030-allure-test-report/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── test-report.md
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks が作る
```

### Source Code (repository root)

```text
package.json                          # 変更: allure（CLI）を devDependencies に
libs/interface-spec/package.json      # 変更: allure-vitest と allure-js-commons を。プラグインには足さない（research R2）
.gitignore                            # 変更: allure-results と、手元のレポートの出力

libs/interface-spec/
├── src/vitest/verifies.ts            # 新規: annotate に加えて、tms のリンクと tag を残す
├── src/vitest/allure-reporter.ts     # 新規: reporter の設定（resultsDir・globalLabels・links）を 1 か所で作る
├── vitest.config.ts                  # 変更: reporter を足す
├── vitest.site.config.ts             # 変更: reporter を足す
├── tests/site/layout.test.ts         # 変更: 測ったページの画像を添付する
├── tests/site/report-links.test.ts   # 新規: レポートを ?tags=<ID> で開き、絞り込みを確かめる
├── docs/
│   ├── conf.py                       # 変更: sphinx_test_reports・tr_*・PECOT_SITE_RESULTS などを消す（permalink は sphinx-needs 9.2.0 の既定のまま出る）
│   ├── _ext/iface_defs.py            # 変更: JUnit と合否の部分を消す。項目にレポートへのリンクを出す
│   ├── _ext/site_stamp.py            # 変更: レポートの URL と、入っていないプラグインの一覧
│   ├── _templates/footer.html        # 変更: テストレポートへのリンク
│   ├── development/                  # 削除
│   ├── junit-lanes.json              # 削除
│   ├── pyproject.toml                # 変更: sphinx-test-reports を消し、allure-pytest を足す
│   ├── tests/conftest.py             # 新規: project・lane のラベル
│   └── tests/test_iface_defs.py      # 変更: 合否のテストを消し、リンクのテストを足す
├── project.json                      # 変更: outputs に結果のディレクトリ。docs の説明
└── README.md                         # 変更: 合否の節を消す

libs/text-rules/vitest.config.ts      # 変更: reporter を足す

plugins/pecot-workflow/cli/
├── vitest.config.ts                  # 変更: reporter を足す
└── tests/_helpers/verifies.ts        # 変更: re-export にする
plugins/pecot-tools/cli/
├── vitest.config.ts・vitest.e2e.config.ts   # 変更: reporter を足す
└── tests/_helpers/verifies.ts        # 変更: re-export にする
plugins/pecot-visual/cli/
├── vitest.config.ts・vitest.e2e.config.ts   # 変更: reporter を足す
├── tests/_helpers/verifies.ts        # 変更: re-export にする
└── tests/e2e/*.test.ts               # 変更: 判定した成果物を添付する（対象は research R11）
plugins/*/project.json                # 変更: レーンの outputs に結果のディレクトリ

.github/workflows/
├── test-report.yml                   # 新規: レポートを作る。リリース版は全レーンを動かし、開発版はレーンの最新の結果を寄せ集める（#821）
├── pages-deploy.yml                  # 変更: test-report.yml の run も受ける
├── release.yml                       # 変更: 本番の land の後に test-report.yml を起こす
└── ci.yml                            # 変更: JUnit を artifact に上げる step を消す

.githooks/
├── scripts/test_report/
│   ├── report-lanes.json             # 新規: レーンの 1 か所の定め
│   ├── lanes.py                      # 新規: 定めを読み、matrix と結果のディレクトリを出す
│   ├── generate.py                   # 新規: そろいを確かめ、allure generate を起こす
│   ├── allurerc.mjs                  # 新規: Allure 3 の設定
│   └── pyrightconfig.json            # 新規
├── scripts/pages_site/
│   ├── provenance.py                 # 変更: test-report.yml の run の決まり
│   ├── verify.py                     # 変更: レポートの artifact の確かめ
│   ├── store.py                      # 変更: test-report/ の置き場所・案内のページ・残す決まり
│   ├── release_sources.py            # 変更: タグが結果を出せるかを決める。junit-lanes を読まない
│   ├── release_build.py              # 変更: PECOT_SITE_LANES を渡さない
│   └── lanes.py・collect.py・dev_side.py   # 削除
├── tests/
│   ├── conftest.py                   # 変更: project・lane のラベル
│   ├── run.sh                        # 変更: allure-pytest と --alluredir
│   ├── test_report_lanes.py          # 新規: nx の test-* が定めに全部ある
│   ├── test_report_generate.py       # 新規: そろいの判定
│   ├── test_report_workflow.py       # 新規: test-report.yml の形
│   ├── test_pages_*.py               # 変更: レポートの出どころ・保管
│   └── test_pages_lanes.py・test_pages_collect.py   # 削除
└── project.json                      # 変更: レーンの outputs と inputs

.claude/rules/pages-site.md           # 変更: テストレポートの起動・やり直しと、手元での作り方
.claude/rules/github-workflows.md     # 変更: workflow の一覧に test-report.yml
specs/028-pages-site/spec.md          # 変更: この機能で取り下げた決まりを書く（FR-025）
```

**Structure Decision**: 新しい nx project は作らない。
レポートを作る処理は、複数のプロジェクトにまたがり workflow から呼ぶので `.githooks/scripts/test_report/` に置く（`.claude/rules/repo-root-layout.md`）。
`verifies` と reporter の設定は、今も全部の vitest の設定が使っている `libs/interface-spec/src/vitest/` に置く。ルートに新しいディレクトリは作らない。

## 段階

各段は、前の段が無いと確かめられないものを後ろに置く。

1. **結果を残す**（US1 の前半）: アダプタの導入・レーンの定め・`project` と `lane` のラベル。手元で 1 つのレーンを動かし、結果のディレクトリができることを確かめられる。実物で確かめる点（xdist との同時使用・`groupBy` の出方）は、ここで片付ける
2. **手元でレポートを作る**（US1・US4 の一部）: `allurerc.mjs`・`generate.py`。手元で動かした結果から、1 つのレポートを作って開ける
3. **要件の ID をつなぐ**（US2）: `verifies` の集約と tms・tag、定義書の permalink、項目からのリンク、絞り込みの URL を確かめるテスト
4. **添付**（US1 の 6）: 画面のテストと成果物のテストに添付を足す
5. **作る run**（US1）: `test-report.yml`。開発版とリリース版の材料の決め方。PR の上では、workflow の形のテストまで確かめられる
6. **保管と公開**（US1・US3）: `pages-deploy.yml`・`provenance.py`・`store.py` の変更、履歴の持ち越し、サイトのリンクと案内のページ、`release.yml` の追加。`workflow_run` は既定のブランチの定義で動くので、公開の確かめは 5 と 6 がマージされた後になる
7. **片付け**（US4）: 自前のテストレポート・合否を描く作り・`junit-lanes.json`・使わなくなったスクリプトとテスト・CI の JUnit の artifact を消す。028 の spec を改める
8. **実物の確かめと手順**: 公開した開発版のレポートを実物で確かめ、起動・やり直しの手順をルールファイル（`pages-site.md`）に書く。README などの文書の片付けは 7 に入れる
9. **改めた形への移行**（2026-11-26）: 次の 4 つを行う。どれも spec の改め（#820）の後に進める
   - `node --test` の 2 本を vitest に移して入れる（#809）
   - bash の 9 本を入れる（#810）
   - 開発版を、main で流し直さず、マージキューの結果から作る（#821）
   - リリース版の履歴を 10 回にして、S3 に移す（#822）

## Complexity Tracking

憲法の違反は無い。
