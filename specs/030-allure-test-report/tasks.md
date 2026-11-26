---

description: "Task list for 030-allure-test-report"
---

# Tasks: 公開サイトのテストレポートを Allure Report に替える

**Input**: Design documents from `/specs/030-allure-test-report/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/test-report.md, quickstart.md

**Tests**: 憲法 III（テストファースト）により、各フェーズでテストを先に書き、落ちることを確かめてから実装する。テストの通過とは別に、quickstart.md の手順を実物で動かす。

**Organization**: フェーズ 1 つが PR 1 つに当たる。Phase 1・2・4・5・6 が US1、Phase 3 が US2、Phase 6 が US3 も、Phase 2・7 が US4。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- vitest の共通の部品: `libs/interface-spec/src/vitest/`
- サイト: `libs/interface-spec/docs/`
- workflow: `.github/workflows/`
- リポ全体のスクリプトとテスト: `.githooks/scripts/`・`.githooks/tests/`
- 作業ファイル: `.pecot/work/<Issue 番号>/`

---

## Phase 1: Setup（レポートのレーンを定め、Allure の結果を残す）

**Purpose**: vitest と pytest の 12 本のレーンが、JUnit XML に加えて Allure の結果を残す。レーンの定めを 1 か所に置く（FR-001〜FR-004・FR-007、research R2・R3・R8）

- [x] T001 [P] `.githooks/tests/test_report_lanes.py` に、レーンの定めのテストを先に書く。
  確かめること（data-model.md の ReportLane）: nx の `test-*` の target（各 `project.json`）が `report-lanes.json` に全部ある、`results` と `excluded` はどちらか一方だけ、
  `results` はその target の nx の `outputs` にある、`results` の最後のディレクトリの名前は `allure-results`、`lanes.py` が matrix（`lane`・`slug`・`results`）の JSON を 1 行で出す
- [x] T002 [P] `libs/interface-spec/tests/allure-reporter.test.ts` に、reporter の設定を作る関数のテストを先に書く。
  確かめること: `resultsDir` が `test-results/<target>/allure-results` になる、`globalLabels` が `project`・`lane` を持つ（値は `NX_TASK_TARGET_PROJECT`・`NX_TASK_TARGET_TARGET`）、
  `links.tms.urlTemplate` が `<PECOT_REPORT_SITE_URL>permalink.html?id=%s` で、渡さなければ `http://localhost:8000/` を使う
- [x] T003 依存を、範囲でなく固定の版で足し、`pnpm-lock.yaml` を作り直す。
  `allure` 3.33.0（CLI）はルートの `package.json`。
  `allure-vitest` 3.15.0 と `allure-js-commons` 3.15.0 は、配布しない `libs/interface-spec/package.json` だけ（research R2。プラグインと text-rules の devDependencies は配布物の `runtime-lock.yaml` に写る）。
  knip が、足した依存を未使用と報告しないことを確かめる。
  `.gitignore` に `allure-results` を足す
- [x] T004 `.githooks/scripts/test_report/report-lanes.json` を作る。入れる 12 本と入れないレーンは research R8 の表のとおり。
  `plugin` は、配布するプラグインのレーンだけが持つ
- [x] T005 `.githooks/scripts/test_report/lanes.py` と `pyrightconfig.json` を作る（T004 の後）。
  `.githooks/scripts/run-lint.sh` と `.pre-commit-config.yaml` の `githooks-lint` の `files` に `test_report/` を足し、pyright strict にかける
- [x] T006 `libs/interface-spec/src/vitest/allure-reporter.ts` を作る（T002・T003 の後）。reporter の設定（`resultsDir`・`globalLabels`・`links`）を返す
- [x] T007 vitest の 8 つの設定の `reporters` に、T006 の設定で `allure-vitest/reporter` を足す（T006 の後）。今の `junit` の reporter は残す。
  対象: `plugins/pecot-workflow/cli/vitest.config.ts`、`plugins/pecot-visual/cli/vitest.config.ts`・`vitest.e2e.config.ts`、`plugins/pecot-tools/cli/vitest.config.ts`・`vitest.e2e.config.ts`、`libs/interface-spec/vitest.config.ts`・`vitest.site.config.ts`、`libs/text-rules/vitest.config.ts`。
  `pecot-workflow:test-hooks` の 2 回目（`plugins/pecot-workflow/scripts/ci/run-tests.sh` の `env -i` の実行）は、Allure の結果を残さない（research R2）
- [x] T008 pytest のレーンに `allure-pytest` 2.16.2 を足す。
  `libs/interface-spec/docs/pyproject.toml` の dev の依存と `uv.lock`、`.githooks/tests/run.sh` の `uvx --with`。どちらも `--alluredir <report-lanes.json の results>` を付ける。
  `libs/interface-spec/docs/tests/conftest.py`（新規）と `.githooks/tests/conftest.py` に、`project`・`lane` のラベルを付ける hook を足す
- [x] T009 12 本のレーンの nx の `outputs` に、結果のディレクトリを足す（T007・T008 の後）。
  対象: `plugins/pecot-workflow/project.json`・`plugins/pecot-visual/project.json`・`plugins/pecot-tools/project.json`・`libs/text-rules/project.json`・`libs/interface-spec/project.json`・`.githooks/project.json`。
  レーンは、最初に 1 回だけ自分の結果のディレクトリを空にする。レーンの中の 2 つ目からの実行（`test-cli` の e2e、`interface-spec:test-unit` の pytest）は書き足す。
  `PECOT_REPORT_SITE_URL` を nx の入力に宣言する（`.claude/rules/nx-inputs.md`。`.githooks/tests/test_nx_env_inputs.py` が通ること）
- [x] T010 実物で確かめる（research R3・R7 の「実物で確かめる点」）。
  `pnpm exec nx run githooks:test-nx-cache` を動かし、pytest-xdist の `-n auto` でも結果がテストの数だけ残ることを確かめる。残らなければ、原因を調べて利用者に伝える（`-n 0` に変えて済ませない）。
  `pnpm exec nx run pecot-tools:test-cli` を動かし、JUnit XML が変更の前と同じ中身であること、カバレッジの判定が変わらないこと、vitest と e2e の両方の結果が同じディレクトリに残ることを確かめる。
  `pnpm exec nx run pecot-workflow:test-hooks` を動かし、結果がテストの数だけ（2 倍でなく）残ること、JUnit の比べ（`compare-junit.ts`）が通ることを確かめる

**Checkpoint**: quickstart.md の 1 の前半（結果のディレクトリに `*-result.json` がある）。`test_report_lanes.py` が通る。`bash .githooks/scripts/run-lint.sh` が通る。
`plugins/*/cli` のファイルを直すので、version plan が要るかを pre-push の確かめで見る（配布物の中身は変わらない）

---

## Phase 2: User Story 1 + 4 - 手元で 1 つのレポートを作る (Priority: P1・P4)

**Goal**: 手元で動かしたレーンの結果から、公開と同じ形のレポートを 1 つ作って開ける

**Independent Test**: quickstart.md の 1。2 つ以上のレーンを動かしてレポートを作り、vitest と pytest のテストが同じレポートに、書いた題で並ぶことを確かめる

### Tests for User Story 1（先に書く）

- [x] T011 [P] [US1] `.githooks/tests/test_report_generate.py` に、ResultsCheck（data-model.md）のテストを先に書く。
  確かめること: `results` のディレクトリが無いレーン・`*-result.json` が 1 つも無いレーンがあると、そのレーンの名前を出して失敗する、`--local` では欠けたレーンの名前を出して続ける、`allure generate` に渡す引数（結果のディレクトリ・設定・出力・履歴）が決まりどおり、
  履歴のファイルが無いときと、JSON として読めない行があるときは、空の履歴で作って知らせを出す（FR-021）、
  `--sources` を渡したとき、結果の `source.json` が無いか、コミットが材料と違うレーンがあると失敗する（FR-012）。モックは `allure` の起動の境界だけ

### Implementation for User Story 1

- [x] T012 [US1] `.githooks/scripts/test_report/allurerc.mjs` を、`defineConfig` で作る。
  トップレベルの `name: "pecot テストレポート"`、awesome の plugin を 1 つ（`groupBy: ["project", "lane", "parentSuite", "suite", "subSuite"]`、`reportLanguage: "ja"`）、
  `historyLimit: 20`（#698 で 3 に下げた。research R5）、`flakyDetection: { includePassedTests: true }`。`historyBaseUrl` は設定しない（research R5・R7）
- [x] T013 [US1] `.githooks/scripts/test_report/generate.py` を作る（T011・T012 の後）。
  判定（どのレーンがそろったか）は純粋な処理に、`allure` の起動は I/O に分ける。入力は `--local`・`--output`・`--history`（省ける）・`--sources`（ReportSources の JSON。`--local` のときだけ省ける）
- [x] T014 [US1] 実物で確かめる（T013 の後）。
  2 つ以上のレーン（vitest と pytest を 1 つずつ）を動かし、`generate.py --local --output .pecot/work/<Issue 番号>/report` でレポートを作って開く。
  `groupBy` のラベルを持たないテストの出方を見て、読みにくければ `groupBy` を `["project", "lane"]` に縮める（research R7）。
  わざと落としたテストに、理由とスタックが出ることを確かめる

**Checkpoint**: quickstart.md の 1 が通る。レポートのテストが、書いた題で、`project`・`lane` の木に並ぶ

---

## Phase 3: User Story 2 - 要件の ID をテストの結果に渡す (Priority: P2)

**Goal**: `verifies` を書いたテストが、Allure の結果に要件の ID をリンクと tag で持つ。レポートを `?tags=<ID>` で開くと、その ID のテストだけが出る

**Independent Test**: quickstart.md の 2 のうち、`verifies` のテストと `report-links.test.ts`

### Tests for User Story 2（先に書く）

- [x] T015 [P] [US2] `libs/interface-spec/tests/verifies.test.ts` に、`verifies` のテストを先に書く。
  確かめること（contracts の `verifies`）: `context.annotate(id, 'verifies')` を呼ぶ、型 `tms`・名前が `id` のリンクを残す、`id` の tag を残す、2 つの ID を書くとリンクと tag を 2 つずつ持つ
- [x] T016 [P] [US2] `libs/interface-spec/tests/site/report-links.test.ts` に、絞り込みの URL のテストを先に書く。
  2 つの ID の tag を持つ結果のディレクトリを一時ディレクトリに作り、`generate.py` の `main()` を Python から `--local` で呼んでレポートを作る。Chromium で `index.html?tags=<ID>` を開き、その ID のテストだけが一覧に出ることを確かめる（research R6。Allure の版を上げて URL の形が変わると、ここで落ちる）。
  `libs/interface-spec/project.json` の `test-site` の inputs に、テストが読む `.githooks/scripts/test_report/` の `generate.py`・`lanes.py`・`allurerc.mjs` を足す（`.claude/rules/nx-inputs.md`）

### Implementation for User Story 2

- [x] T017 [US2] `libs/interface-spec/src/vitest/verifies.ts` を作る（T015 の後）。`allure-js-commons` の `tms`・`tag` を直接呼ぶ。reporter を足さない nx の外では、`annotate` だけを残す
- [x] T018 [US2] 3 つの `tests/_helpers/verifies.ts`（`plugins/pecot-workflow/cli/`・`plugins/pecot-visual/cli/`・`plugins/pecot-tools/cli/`）を、T017 の re-export にする。
  `plugins/pecot-workflow/cli/tests/_helpers/behavior-ids.ts` の `collectVerifiedIds()` と、`interface-spec:lint-defs` が今のまま通ることを確かめる
- [x] T019 [US2] sphinx-needs の permalink を確かめる。9.2.0 は `needs_permalink_file`・`needs_permalink_data` の既定で `permalink.html` を出し、`needs_build_json` は `conf.py` にもうあるので、`conf.py` は直さない。
  `libs/interface-spec/docs/tests/test_iface_defs.py` に、`permalink.html` ができ、定義書の項目の ID で引けることのテストを足す
- [x] T020 [US2] 実物で確かめる。`verifies` を書いたレーン（`pecot-tools:test-cli`）を動かしてレポートを作り、テストに要件の ID のリンクがあり、押すと手元のサイトの `permalink.html?id=<ID>` からその項目へ飛ぶことを確かめる。
  JUnit XML の `<property name="verifies">` が、変更の前と同じであることを確かめる（FR-007）

**Checkpoint**: `verifies.test.ts` と `report-links.test.ts` が通る。呼び出しの約 1,470 か所は書き直していない（FR-006）。
`plugins/*/cli` のファイルを直すので、version plan が要るかを pre-push の確かめで見る

---

## Phase 4: User Story 1 - 画面と成果物を添付する (Priority: P1)

**Goal**: 画面を開くテストと成果物を作るテストが、成功でも失敗でも、判定に使った画面の画像か成果物を添付する（FR-007a・FR-007b・SC-011、research R11）

**Independent Test**: quickstart.md の 3。成功したテストをレポートで開き、添付があることを確かめる

- [x] T021 [US1] pecot-visual の e2e（`plugins/pecot-visual/cli/tests/e2e/*.test.ts`。29 ファイル）を 1 つずつ読み、添付の対象と、添付するものを表にする。置き場所は `specs/030-allure-test-report/research.md` の R11 の下。
  対象にするのは、ブラウザで画面を開くテストと、PNG・PDF・PPTX・xlsx を作って判定するテスト。対象にしないテストには理由を書く。同じレーン（`test-cli`）の integration で、実ブラウザで PNG を作るテストも表に入れる
- [x] T022 [P] [US1] `libs/interface-spec/tests/site/layout.test.ts` で、測ったページの `page.screenshot()` を、測ったのと同じ `page` から撮って添付する。ケースごとに 1 枚（全ページを回すケースは、違反したページか `index.html`）
- [x] T023 [P] [US1] `libs/interface-spec/src/vitest/attach.ts` に、成果物のファイルと中身を添付する関数を足し、`plugins/pecot-visual/cli/tests/_helpers/attach.ts` から re-export する。
  中身を読んで `attachment` に渡し、型は拡張子から決める（contracts の「添付」）
- [x] T024 [US1] T021 の表の対象のテストに、判定したファイルの添付を足す（T021・T023 の後）。
  判定の後で作り直した画像を添付しない。xlsx を PDF・PNG にして判定するテストは、判定に使った PNG を添付する
- [x] T025 [US1] 実物で確かめる。`pnpm exec nx run interface-spec:test-site` と、pecot-visual の e2e を 1 ファイル動かしてレポートを作り、成功したテストに添付があること、添付が判定したものと同じであることを目で確かめる。
  レポートのディレクトリの大きさを測り、research R11 の「大きさ」に書く

**Checkpoint**: quickstart.md の 3 が通る。T021 の表の対象のテストの全部に添付がある。
`plugins/pecot-visual/cli` のファイルを直すので、version plan が要るかを pre-push の確かめで見る

---

## Phase 5: User Story 1 - テストを動かしてレポートを作る run (Priority: P1)

**Goal**: `test-report.yml` が、開発版とリリース版の材料を決め、全レーンを動かし、レポートと履歴を artifact に上げる（FR-009a〜FR-009d・FR-012・FR-015、contracts の `test-report.yml`）

**Independent Test**: quickstart.md の 4 のうち、`test_report_workflow.py` と ReportSources のテスト。PR の上では、workflow の形とスクリプトのテストまでを確かめる

### Tests for User Story 1（先に書く）

- [x] T026 [P] [US1] `.githooks/tests/test_report_workflow.py` に、`test-report.yml` の形のテストを先に書く。
  確かめること: 契機は `push`（main）と `workflow_dispatch`（入力 `side`: `release`・`dev`）で、`pull_request` が無い、どの job も `contents: read` だけ、
  concurrency は `test-report-<side>` で `cancel-in-progress: false`、
  artifact は `test-report-<side>`・`retention-days: 7`・`overwrite: true`、`tests` の job の matrix が `lanes.py` から決まる、action は SHA で固定、`run:` に式と日本語が無い
- [x] T027 [P] [US1] `.githooks/tests/test_pages_release.py` に、ReportSources（data-model.md）のテストを先に書く。
  確かめること: タグのコミットに `report-lanes.json` があるプラグインだけが `runs` に入り、無いプラグインは `missing` に入る、`runs` が空ならレポートを作らないと決まる、骨組みのコミットが結果を出せないときは、プラグインに属さないレーンを入れない、開発版は 1 項目で全レーン。実物の git のタグで確かめる

### Implementation for User Story 1

- [x] T028 [US1] `.githooks/scripts/pages_site/release_sources.py` に、ReportSources を決める処理を足す（T027 の後）。タグと骨組みの決め方は、今の ReleaseSources をそのまま使う
- [x] T029 [US1] `.github/workflows/test-report.yml` を作る（T026・T028 の後）。job は `side`・`tests`・`report`（contracts の表）。
  `tests` は、テストが落ちても、結果のディレクトリと `source.json`（レーンと取り出したコミット）を artifact `allure-results-<slug>` に上げる。`report` は、公開中の `history.jsonl` を取り（無ければ空）、`generate.py` で作り、レポート・履歴・`report-sources.json` を上げる。
  `PECOT_REPORT_SITE_URL` を、側の URL で渡す
- [x] T030 [US1] `.github/workflows/release.yml` の本番の land の後に、`test-report.yml` を `side=release` で起こす step を足す（今の `pages-build.yml` の起こし方と同じ形）。
  `.githooks/tests/test_report_workflow.py` に、この step のテストを足す
- [x] T031 [US1] `.claude/rules/github-workflows.md` の workflow の一覧に、`test-report.yml` の行を足す

**Checkpoint**: `test_report_workflow.py` と `test_pages_release.py` が通る。actionlint が通る

---

## Phase 6: User Story 1 + 3 - 保管して公開し、サイトからつなぐ (Priority: P1・P3)

**Goal**: `pages-deploy.yml` が `test-report.yml` の run を受け、レポートと履歴を `<側>/test-report/` に置いて公開する。サイトのフッターと振る舞いの項目から、レポートへ飛べる（FR-009〜FR-021、research R9・R10）

**Independent Test**: quickstart.md の 4 の残りと、マージの後の 5

### Tests（先に書く）

- [x] T032 [P] [US1] `.githooks/tests/test_pages_provenance.py` に、`test-report.yml` の run の決まりのテストを先に書く（contracts の verify の表）。
  確かめること: workflow のパスが `test-report.yml` の run を受ける、event が `pull_request` の run は捨てる、head が main の祖先でなければ捨てる、
  開発版は保管中のレポートのコミットより古ければ捨てる、`workflow_dispatch` は artifact が 1 つだけのときその側。入力は、GitHub の API の応答の実物の形
- [x] T033 [P] [US3] `.githooks/tests/test_pages_store.py` に、レポートの置き場所のテストを先に書く（data-model.md の StoreLayout に足すもの）。
  確かめること: レポートを置いても定義書とほかの側が変わらない、定義書の側を差し替えても `test-report/` と `history.jsonl` が残る、
  `test-report/` の無いリリース版・開発版に案内のページが置かれる、`pr/<番号>/` に `test-report/` を置かない、
  `.pecot-store.json` の `reports` に run の ID とコミットが書かれる、SideCheck が定義書の側の中の `test-report/` へのリンクをリンク切れにしない、`history.jsonl` に JSON として読めない行があると捨てる
- [x] T034 [P] [US1] `libs/interface-spec/docs/tests/test_iface_defs.py` に、サイトのリンクのテストを先に書く（data-model.md の SiteStamp に足すもの、contracts の「サイト」の表）。
  確かめること: 開発版はフッターのリンクと項目のリンク（`test-report/index.html?tags=<ID>`）を出す、
  リリース版は `PECOT_SITE_REPORT_PLUGINS` にあるプラグインの項目だけリンクを出し、無いプラグインの名前をフッターのリンクのそばに書く、`PECOT_SITE_REPORT_PLUGINS` が空ならリリース版はリンクを出さない、PR 版と手元はどちらのリンクも出さない

### Implementation

- [x] T035 [US1] `.githooks/scripts/pages_site/provenance.py` と `verify.py` に、`test-report.yml` の run の決まりと、レポートの artifact の確かめ（`report-sources.json` の決め直しと、T036 の SideCheck の呼び出し）を足す（T032・T036 の後）
- [x] T036 [US3] `.githooks/scripts/pages_site/store.py` に、レポートの置き場所・残す決まり・案内のページ・`reports` の記録と、SideCheck の `history.jsonl` の行の確かめを足す（T033 の後）。大きさの知らせは、レポートも数える
- [x] T037 [US1] `.github/workflows/pages-deploy.yml` の `workflow_run` の対象に `test-report.yml` を足す（T035・T036 の後）。
  `.githooks/tests/test_pages_workflows.py` の契機と、「`pages / preview` を書くのは pages-deploy だけ」のテストを直す
- [x] T038 [US1] `libs/interface-spec/docs/_ext/site_stamp.py` に `report_url`・`report_plugins` を足し、`_templates/footer.html` にテストレポートのリンクを、`_ext/iface_defs.py` の振る舞いの項目にテストへのリンクを足す（T034 の後）。
  `.githooks/scripts/pages_site/release_build.py` が、ReportSources から `PECOT_SITE_REPORT_PLUGINS` を渡す。`libs/interface-spec/tests/site/layout.test.ts` が、足したリンクで崩れないことを確かめる
- [x] T039 [US3] 手元で、保管を実物に通す（T036 の後）。
  一時の git リポを `pages-store` に見立て、`store.py publish` に、手元で作ったレポートの tar を 2 回続けて渡す。2 回目の `history.jsonl` が 2 行になること、定義書の側を差し替えても残ることを確かめる

**Checkpoint**: quickstart.md の 4 が通る。マージの後に、quickstart.md の 5（開発版のレポートが出て、2 回目の push で履歴が 2 件になる）を確かめる

---

## Phase 7: User Story 4 - 自前のテストレポートを片付ける (Priority: P4)

**Goal**: sphinx-test-reports を使った自前のテストレポートと、合否を描く作り・`junit-lanes.json`・使わなくなったスクリプトとテストが無い（FR-022・FR-023・FR-025、research R12）

**Independent Test**: quickstart.md の 7。grep が何も出さず、`interface-spec:docs` が定義書だけのサイトを作る

- [x] T040 [US4] `libs/interface-spec/docs/tests/test_iface_defs.py` を先に直す。合否・JUnit・STRICT・`junit-lanes` のテスト（調査の一覧は `specs/030-allure-test-report/research.md` の R12）を消し、サイトに載せるプラグインの一覧が、定義書（`plugins/*/interface/`）を持つプラグインから決まることのテストを足す
- [x] T041 [US4] `libs/interface-spec/docs/_ext/iface_defs.py` から、JUnit を読む部分・合否を描く部分・`IfaceTests`・`IfaceOverview`・`check_strict`・`junit_lanes_table`・`iface-<状態>` の role を消す（T040 の後）。
  `write_pages` のプラグインの一覧を、定義書を持つプラグインから決める。`index.rst` の `.. iface-overview::` を消す
- [x] T042 [US4] `libs/interface-spec/docs/conf.py` から、`sphinx_test_reports`・`tr_*`・`PECOT_SITE_RESULTS`・`PECOT_SITE_STRICT`・`PECOT_SITE_LANES` を消す。
  `libs/interface-spec/docs/pyproject.toml` から `sphinx-test-reports` を消して `uv.lock` を作り直す。`libs/interface-spec/docs/development/`・`junit-lanes.json`・`docs/tests/fixtures/junit/` を消す
- [x] T043 [P] [US4] `.githooks/scripts/pages_site/lanes.py`・`collect.py`・`dev_side.py` と、`.githooks/tests/test_pages_lanes.py`・`test_pages_collect.py` を消す。
  `release_sources.py` が `junit-lanes.json` を読む部分と、`release_build.py` が `PECOT_SITE_LANES` を渡す部分を消し、`test_pages_release.py`・`test_pages_verify.py` を合わせて直す。
  `.githooks/project.json` の `test-ci` の入力と一覧、`test_nx_env_inputs.py` の `_EXEMPT` から、消したものを外す
- [x] T044 [P] [US4] `.github/workflows/ci.yml` の tests の job から、「Stage JUnit」「Upload JUnit」の step を消す。`.githooks/tests/test_pages_workflows.py` の、この 2 つの step と `junit-lanes` のテストを消す
- [x] T045 [P] [US4] 文書を直す。
  `libs/interface-spec/README.md` の合否の節、`libs/interface-spec/project.json` の `docs`・`test-unit` の description、`.claude/rules/pages-site.md` の `junit-lanes.json` と #645 に触れる文、`CLAUDE.md` の `docs` の説明
- [x] T046 [US4] `specs/028-pages-site/spec.md` に、この機能で取り下げた決まりを書く（FR-025）。FR-014〜FR-019 と、`PECOT_SITE_RESULTS` に触れる Clarifications に、030 で取り下げた旨と日付を足す。本文は消さない
- [x] T047 [US4] 実物で確かめる。quickstart.md の 7 の grep が何も出さないこと、`pnpm exec nx run interface-spec:docs` が警告なしで作れること、`pecot-workflow:test-hooks` の JUnit の比べ（`compare-junit.ts`）が今のまま通ることを確かめる

**Checkpoint**: quickstart.md の 7 が通る。`bash .githooks/scripts/run-lint.sh` と knip が通る

---

## Phase 8: Polish（公開した実物の確かめと、保守の手順）

**Purpose**: 公開したレポートを実物で確かめ、起動・やり直しの手順をルールファイルに書く（FR-009c・FR-024）

- [ ] T048 quickstart.md の 5 を、公開サイトの開発版で確かめる。12 本のレーンのテストがあること、定義書の項目のリンクから、その ID のテストだけが出ること、テストの要件の ID のリンクから、開発版の定義書の項目へ戻れること、2 回目の main への push の後に履歴が 2 件になることを見る。
  `test-report.yml` の run の所要時間と、結果がそろってからレポートが変わるまでの時間を測り、30 分以内であることを確かめる（SC-008）。値を `.claude/rules/pages-site.md` に書く
  pages-deploy の deploy の step の所要時間を見て、Pages の 10 分の上限に余裕があることを確かめる（#698 で公開の中身が約 630 MB に増えた）
- [ ] T049 quickstart.md の 6 を確かめる。リリースの前は、リリース版のフッターにリンクが無く、`/pecot/test-report/` に案内のページがあること。
  リリースの時機が来ていなければ、`gh workflow run test-report.yml --ref main -f side=release` で起こし、run が「結果を出せるプラグインが無い」で成功して終わることを確かめる。リリースの後の確かめは、その旨を Issue に残して次のリリースで行う
- [ ] T050 `.claude/rules/pages-site.md` に、テストレポートの節を足す。URL の表、起動とやり直し（`gh workflow run test-report.yml --ref main -f side=dev`・`side=release`）、レポートが出ないときに読む所、手元での作り方（`generate.py --local`）、Allure の版を上げるときに見る所（`report-links.test.ts`）。
  `paths` に `.github/workflows/test-report.yml` と `.githooks/scripts/test_report/**` を足す
- [ ] T051 [P] `specs/030-allure-test-report/quickstart.md` と `contracts/test-report.md` を、実装で変わった所に合わせて直す

---

## Dependencies & Execution Order

### Phase Dependencies

| Phase | 前提 | 種類 | 理由 |
|---|---|---|---|
| 2 | 1 | スタックできる | レポートを作る処理が、Phase 1 の `report-lanes.json` と、レーンが残す結果のディレクトリを読む。Phase 1 のブランチの上で、手元でレーンを動かして確かめられる |
| 3 | 2 | スタックできる | 絞り込みの URL のテストが、Phase 2 の `generate.py` でレポートを作る。Phase 2 のブランチの上で、手元で確かめられる |
| 4 | 2 | スタックできる | 添付がレポートに出ることを、Phase 2 の `generate.py` で作ったレポートで確かめる。Phase 2 のブランチの上で、手元で確かめられる |
| 5 | 2 | スタックできる | 作る run が、Phase 1 の `lanes.py` と Phase 2 の `generate.py` を呼ぶ。workflow の形とスクリプトは、スタックしたブランチの上のテストで確かめられる |
| 6 | 3 | スタックできる | 振る舞いの項目のリンクが、Phase 3 で `verifies` が残す tag の形と、`permalink.html` を前提にする。Phase 3 のブランチの上で、手元でサイトとレポートを作って確かめられる |
| 6 | 5 | マージを待つ | `pages-deploy.yml` は `workflow_run` で起き、既定のブランチの定義で動く。`test-report.yml` が main への push で動いて artifact を残していないと、確かめと保管と公開を確かめられない |
| 7 | 6 | マージを待つ | 替わりのテストレポートが公開サイトで読めることを確かめてから、自前の作りを消す。公開は、既定のブランチの `workflow_run` でしか動かない |
| 8 | 6 | マージを待つ | 公開サイトのレポートを実物で確かめる。保管と公開が main に入り、main への push で 2 回動いていないと、履歴を確かめられない |

Phase 3・Phase 4・Phase 5 は、どれも Phase 2 だけを前提にするので、並べて進められる。
Phase 7 と Phase 8 は、どちらも Phase 6 だけを前提にするので、並べて進められる。Phase 8 の T050 は、Phase 7 の T045 と同じファイル（`.claude/rules/pages-site.md`）を直すので、後に入る方が合わせる。

### User Story Dependencies

- **US1（Phase 1・2・4・5・6）**: Phase 2 までは手元で完結する。公開は、Phase 5 を main に入れてから Phase 6 で確かめる
- **US2（Phase 3・Phase 6 の T034・T038）**: `verifies` と絞り込みの URL は、Phase 3 で手元で完結する。サイトからのリンクは、保管の決まりと一緒に Phase 6 で入れる（SideCheck が、定義書の側の中の `test-report/` へのリンクを通す必要があるため）
- **US3（Phase 6）**: US1 の保管の上に載る
- **US4（Phase 2・Phase 7）**: 手元での作り方は Phase 2、片付けは Phase 6 の公開を確かめた後

### Within Each User Story

- テストを先に書き、落ちることを確かめてから実装する
- 判定の純粋な処理（ResultsCheck・ReportSources・RunProvenance）を、I/O（`allure` の起動・API・展開・push）より先に作る

### Parallel Opportunities

- Phase 1 の T001・T002
- Phase 3 のテスト T015・T016
- Phase 4 の T022・T023
- Phase 5 のテスト T026・T027
- Phase 6 のテスト T032〜T034
- Phase 7 の T043〜T045
- Phase 3・Phase 4・Phase 5（どれも Phase 2 の上にスタックできる）

---

## Parallel Example: Phase 6

```bash
Task: "test-report.yml の run の決まりのテストを .githooks/tests/test_pages_provenance.py に書く"
Task: "レポートの置き場所のテストを .githooks/tests/test_pages_store.py に書く"
Task: "サイトのリンクのテストを libs/interface-spec/docs/tests/test_iface_defs.py に書く"
```

---

## Implementation Strategy

### MVP First

1. Phase 1 → Phase 2 で、手元でレポートを作って読める
2. Phase 5 → Phase 6 で、開発版のレポートが公開される（US1）
3. **STOP and VALIDATE**: quickstart.md の 5

### Incremental Delivery

1. Phase 1 → Phase 2（手元のレポート）
2. Phase 3（要件の ID）・Phase 4（添付）・Phase 5（作る run）を並べて進める
3. Phase 5 のマージの後に Phase 6（保管と公開、サイトのリンク）→ 開発版のレポートが見える
4. Phase 6 のマージの後に Phase 7（片付け）と Phase 8（実物の確かめと手順）

---

## Notes

- [P] tasks = different files, no dependencies
- workflow の `workflow_dispatch` と `workflow_run` は、既定のブランチの定義で動く。PR のブランチで直しても、その PR の上では動かない
- リリース版のレポートは、この機能が入った後のタグを持つプラグインだけが入る。全部のプラグインがそろうのは、それぞれの次のリリースの後
- 絞り込みの URL（`?tags=<ID>`）は、Allure の公式の文書に無い形に頼る。Allure の版を上げる PR では、`report-links.test.ts` の結果を見る
