---

description: "Task list for 028-pages-site"
---

# Tasks: pecot の文書サイトを GitHub Pages で公開し、インタフェース定義書と合否をそこで読める

**Input**: Design documents from `/specs/028-pages-site/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/pages.md, quickstart.md

**Tests**: 憲章 II（TDD）により、各フェーズでテストを先に書く。テストの通過とは別に、quickstart.md の手順を実物で動かす。

**Organization**: フェーズ 1 つが PR 1 つに当たる。Phase 2 が US2 と US4、Phase 3・4 が US1、Phase 5 が US3。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- サイト: `libs/interface-spec/docs/`
- workflow: `.github/workflows/`
- リポ全体のスクリプトとテスト: `.githooks/scripts/`・`.githooks/tests/`

---

## Phase 1: Setup（合否のレーンを 1 か所で定める）

**Purpose**: 合否のレーンと JUnit のパスを `junit-lanes.json` に移し、サイトと workflow の両方がそこから決まるようにする（FR-009、research R7）

- [x] T001 [P] `libs/interface-spec/docs/tests/test_iface_defs.py` に、`junit-lanes.json` の読み込みのテストを先に書く。
  確かめること: 4 本（`pecot-workflow:test-cli`・`pecot-workflow:test-hooks`・`pecot-tools:test-cli`・`pecot-visual:test-cli`）がプラグインごとにまとまる、「同じ `junit` を 2 回書かない」に反すると失敗する、`target` の `outputs` に `junit` が無いと失敗する
- [x] T002 [P] `.githooks/tests/test_pages_lanes.py` に、`.githooks/scripts/pages_site/lanes.py` が `junit-lanes.json` から GitHub Actions の matrix（`lane`・`slug`・`junit`）の JSON を出すテストを先に書く。
  slug は ci.yml の `tests (<lane>)` と同じ作り方
- [x] T003 `libs/interface-spec/docs/junit-lanes.json` を作る。項目は data-model.md の JunitLane（`plugin`・`target`・`junit`）。今の `conf.py` の `iface_junit` の重なり（pecot-workflow の `junit.xml` が 2 回）を解く
- [x] T004 `libs/interface-spec/docs/conf.py` の `iface_junit` を、`junit-lanes.json` から作るように直す（T003 の後）
- [x] T005 `.githooks/scripts/pages_site/lanes.py` を作る（T003 の後）。
  `.githooks/scripts/pages_site/pyrightconfig.json` を置き、`.githooks/scripts/run-lint.sh` と `.pre-commit-config.yaml` の `githooks-lint` の `files` を広げて、`pages_site/` を pyright strict にかける（憲章 III）
- [x] T006 `libs/interface-spec/project.json` の `docs` と `test-unit` の description に、`junit-lanes.json` を足す。`test-unit` の inputs に `plugins/*/project.json` を足す。
  `docs` は `cache: false` で inputs が働かないので、inputs は足さない

**Checkpoint**: `pnpm exec nx run interface-spec:docs` が今と同じ HTML を作る。`python3 .githooks/scripts/pages_site/lanes.py` が 4 本の matrix を出す。`bash .githooks/scripts/run-lint.sh` が通る

---

## Phase 2: User Story 2 + 4 - 合否の出し方と、手元での確認 (Priority: P2・P4)

**Goal**: 状態を 5 つに分け、落ちたケースの要旨・状態ごとの数・全体の合否・版の帯を出す。手元でも同じ出し方で作れる

**Independent Test**: quickstart.md の「1. 手元で、公開と同じ出し方を見る」

### Tests for User Story 2 + 4

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T007 [P] [US2] `libs/interface-spec/docs/tests/test_iface_defs.py` に `outcome_of` の 5 つの状態のテストを書く。
  data-model.md の表を上から順に当てる: 「そのプラグインの合否のレーンのうち、JUnit が無いものがある」→ `not-run`、
  「JUnit はそろっているが、項目につながるケースが 0 件」→ `no-test`、
  「failed か error が 1 つでもある」→ `failed`、
  「passed が 1 つ以上あり、ほかは passed か skipped」→ `passed`、
  「すべて skipped」→ `skipped`。
  入力は実物の vitest の JUnit の形（`tests/fixtures` に置く）
- [x] T008 [P] [US2] 同じファイルに、落ちたケースの要旨のテストを書く。`message` は `<failure>`・`<error>` の `message` 属性、無ければ本文の先頭の 1 行。`detail` は本文
- [x] T009 [P] [US2] 同じファイルに、状態ごとの数のテストを書く。0 件の状態は出さない。一覧表の行（コマンド・ツールごと）と、トップの全体の合否（プラグインごと）。
  spec の Edge Cases「同じテストが複数の結果のファイルに出る: 1 件として数える」も確かめる
- [x] T010 [P] [US4] 同じファイルに、SiteStamp のテストを書く。
  `PECOT_SITE_*` が無いときは `side=local`・手元の HEAD・今の時刻・`run_url` 無し。
  `side=pr` で `PECOT_SITE_PR` が無いと失敗。
  `sha` が取れないと失敗。
  プラグインの版は各 `plugins/<name>/.claude-plugin/plugin.json` の `version`
- [x] T011 [P] [US4] 同じファイルに、`PECOT_SITE_STRICT=1` で JUnit が欠けたレーンがあると、そのレーンの名前を出して build が失敗するテストを書く。STRICT が無ければ失敗しない

### Implementation for User Story 2 + 4

- [x] T012 [US2] `libs/interface-spec/docs/_ext/iface_defs.py` の `outcome_of` を 5 つの状態にし、`OUTCOME_LABELS` に記号（`✓`・`✗`・`−`・`–`・`?`）と文字を持たせる。表示は記号と文字の両方を出す（FR-015）
- [x] T013 [US2] `libs/interface-spec/docs/_ext/iface_defs.py` で、`failed` の項目のページに落ちたケースの名前と要旨を出し、本文（スタック）は折りたたむ。`passed` で一部が skipped の項目は、飛ばしたケースを示す
- [x] T014 [US2] `libs/interface-spec/docs/_ext/iface_defs.py` の `_summary` と `IfaceIndex` を、5 つの状態ごとの数にする
- [x] T015 [US2] `libs/interface-spec/docs/_ext/iface_defs.py` に、プラグインごとの状態ごとの数をまとめる directive を足し、`libs/interface-spec/docs/index.rst` に置く（FR-018）
- [x] T016 [US4] `libs/interface-spec/docs/conf.py` で SiteStamp を決めて `html_context` に渡す。`PECOT_SITE_STRICT` を拡張の設定に渡す
- [x] T017 [US2] `libs/interface-spec/docs/_templates/header.html` に版の帯を出す。中身は contracts/pages.md の「版の帯」の表のとおり。リリース版と開発版への行き来のリンクは、公開サイトの絶対パス（`/pecot/`・`/pecot/dev/`）で張る
- [x] T018 [P] [US2] `libs/interface-spec/docs/_static/pecot.css` に、帯と 5 つの状態の見た目を足す。色は補いにだけ使う
- [x] T019 [US4] `libs/interface-spec/docs/_ext/iface_defs.py` の `IfaceTests` の「JUnit のファイルが見つからないため…」の文言を、欠けたレーンの名前を出す形に直す

**Checkpoint**: quickstart.md の 1 が通る。一部のレーンだけ動かして作っても失敗せず、`PECOT_SITE_STRICT=1` では失敗する

---

## Phase 3: User Story 1 - 側を作る run (Priority: P1)

**Goal**: `pages-build.yml` が、合否のレーンを全部動かし、JUnit がそろったときだけ側の HTML を artifact に上げる。公開はしない

**Independent Test**: この PR の上で、`pull_request` の契機の run が `pages-side-pr-<番号>` の artifact を作ることを、`gh run view` で確かめる（`pull_request` は PR のブランチの定義で動く）

### Tests for User Story 1（作る run）

- [x] T020 [P] [US1] `.githooks/tests/test_pages_workflows.py` に、`pages-build.yml` の形のテストを書く。
  contracts/pages.md の「`pages-build.yml`」の表のとおり: 契機（`push` の `main`・`pull_request` の opened/synchronize/reopened/closed だけ。手での起動とリリース版は #616 で決め直す）、
  PR は `head.repo.full_name == github.repository` のときだけ作る、
  権限は `contents: read` だけ、
  concurrency は `pages-build-<side>-<PR の番号か ref>` で `cancel-in-progress: true`、
  artifact は `retention-days: 90`、
  action は SHA で固定

### Implementation for User Story 1（作る run）

- [x] T021 [US1] `.github/workflows/pages-build.yml` に、側と SHA を決める job を書く。closed の PR では、作らずに成功で終わる
- [x] T022 [US1] 同じファイルに、合否のレーンの matrix の job を書く。
  matrix は `.githooks/scripts/pages_site/lanes.py` の出力。
  ci.yml の `tests` の job と同じく `.githooks/ci/dev-container.sh` で `nx run <target>` を動かす。
  テストが落ちても job は続け、JUnit を `pages-junit-<slug>` に上げる。
  pecot-visual のレーンには `PECOT_CI_BROWSER=1` を渡す
- [x] T023 [US1] 同じファイルに、サイトを作る job を書く。
  JUnit を集め、`PECOT_SITE_STRICT=1` と `PECOT_SITE_*`（side・pr・sha・run の URL・run の開始時刻）を付けて `nx run interface-spec:docs` を動かし、`pages-side-<side>`（PR は `pages-side-pr-<番号>`）に上げる。
  job summary に側・コミット・レーンごとの数を書く

**Checkpoint**: この PR の run で PR 版の artifact ができる。レーンの target を壊したコミットを一時的に push すると、サイトを作る job が失敗する（確かめた後に戻す）

---

## Phase 4: User Story 1 - 確かめて保管し、公開する run (Priority: P1) 🎯 MVP

**Goal**: `pages-deploy.yml` が、受けた run の出どころを API で確かめ、保管ブランチ `pages-store` のその側だけを差し替え、公式の `deploy-pages` で公開する。
`pages-build.yml` に手での起動とリリース版を足し、レーンを 1 つの job で順に動かす。release.yml の本番が、land の後にリリース版を作る run を起こす

**Independent Test**: quickstart.md の「3. 開発版の公開」「4. リリース版の公開」「6. 止まる場合」の 2〜4 行目

2026-11-17 の 2 回目の決め直し（#616）で、このフェーズ以降を書き直した。理由は research.md の R1〜R6・R12・R13。

### Tests for User Story 1（確かめて保管し、公開する run）

- [x] T024 [P] [US1] `.githooks/tests/test_pages_provenance.py` に、`.githooks/scripts/pages_site/provenance.py` の RunProvenance の判定のテストを書く。
  入力は GitHub の REST の応答（workflow run・compare・pull）の実物の形。
  確かめること: data-model.md の RunProvenance の表と決まりのとおり。
  開発版は `push` と `workflow_dispatch` を受け、main の祖先でない `head_sha`（`head_branch` に `main` という名前のタグが入った run を含む）を捨てる。
  保管中の開発版の SHA を祖先に持たない古い run を捨て、同じ SHA の再実行は受ける。
  開発版・リリース版は `pull_requests` にほかのリポの PR があっても落ちない。
  PR 版は、`base.repo` と `head.sha` で絞り、閉じた PR と head の変わった PR を捨てる。
  `path`・`head_repository`・`conclusion` が違う run を捨てる。
  `push` と `pull_request` の run では、artifact の名前（`pages-side-dev` など）を判定に使わない。
  main の祖先の定義で動いた `workflow_dispatch` の run だけ、artifact の名前で `dev` か `release` かを決め、名前が 1 つに決まらなければ捨てる。
  開いている PR の番号の一覧を出す（store の掃除に使う）
- [x] T025 [P] [US1] `.githooks/tests/test_pages_release.py` に、`.githooks/scripts/pages_site/release_sources.py` の ReleaseSources のテストを書く。
  プレリリースの接尾辞のあるタグを除いた semver の最大値を選ぶ。
  `skeleton` はほかのすべてのタグのコミットを祖先に持つもので、無ければ失敗する。
  タグのコミットが main の祖先でなければ失敗する。
  各プラグインのレーンを、そのタグのコミットの `junit-lanes.json` から取る
- [x] T026 [P] [US1] `.githooks/tests/test_pages_store.py` に、`.githooks/scripts/pages_site/store.py` のテストを書く。
  SideCheck: 絶対パス・`..`・シンボリックリンク・通常のファイルとディレクトリ以外を含む側を捨てる。側の中の内部リンクが切れた側を捨てる。
  StoreLayout: 受けた側のディレクトリと `.pecot-store.json` だけを書き換える。リリース版を書き換えても `dev/`・`pr/` が残る。
  リリース版か開発版が無いとき、案内のページを置く。組んだ全体で、側の間の行き来のリンクが切れていない。
  900 MB を超えたら summary に警告を書く
- [x] T027 [P] [US1] `.githooks/tests/test_pages_workflows.py` に、`pages-deploy.yml` と、直した `pages-build.yml` の形のテストを足す。
  `pages-deploy.yml`: 契機は `workflow_run`（`pages-build.yml` の completed）と `workflow_dispatch`。
  verify・store・deploy の 3 つの job の権限と environment が contracts の表のとおり。どの job にも `actions: write` が無い。
  store の concurrency が `group: pages-store`・`cancel-in-progress: false`・`queue: max`、deploy が `group: pages`・`cancel-in-progress: false`。
  action は `configure-pages`・`upload-pages-artifact` v5・`deploy-pages` v5 を SHA で固定。
  `pages-build.yml`: `workflow_dispatch` の入力が `side`（`release`・`dev`）だけ。job が side と build の 2 つ。権限が `contents: read` だけ。側の artifact が `retention-days: 7`。
  side の job が、`workflow_dispatch` で `github.ref` が `refs/heads/main` でないときに失敗する。
  `.github/actionlint.yaml` の `paths` に `pages-deploy.yml` の除外がある
- [x] T028 [P] [US1] `.githooks/tests/test_release_workflow.py` に、本番（`dry-run=false`）で land が成功した後にだけ、App のトークンで `gh workflow run pages-build.yml -f side=release` を打つ段があるテストを足す。
  release の job に `actions: write` が無いことも確かめる

### Implementation for User Story 1（確かめて保管し、公開する run）

- [x] T029 [US1] `.githooks/scripts/pages_site/provenance.py` を作る。API の応答から RunProvenance を判定する純粋な処理だけを置く
- [x] T030 [US1] `.githooks/scripts/pages_site/release_sources.py` を作る。タグと main から ReleaseSources を決める
- [x] T031 [US1] `.githooks/scripts/pages_site/store.py` を作る。
  SideCheck、`pages-store` の差し替え・案内のページ・行き来のリンクの確かめ・大きさの警告、job summary を置く。
  push は `--force-with-lease=<取ったときの SHA>` で、断られたら取り直してやり直す
- [x] T032 [US1] `.github/workflows/pages-build.yml` を直す。
  job を side と build の 2 つにし、build は dev container を 1 回だけ立ててレーンを順に動かし、続けてサイトを作る。
  `workflow_dispatch`（`side` だけ。main からの起動に限り、開発版は `github.sha` で作る）を足す。
  リリース版（T030 の ReleaseSources、`PECOT_SITE_PLUGIN_COMMITS`、`release-sources.json`）を、contracts の「リリース版の build」の順で足す。
  側の artifact に JUnit を入れ、`retention-days: 7` にする。レーンごとの artifact はやめる
- [x] T033 [US1] `libs/interface-spec/docs/_ext/site_stamp.py` と `_templates/header.html` に、リリース版のプラグインごとのタグのコミット（`PECOT_SITE_PLUGIN_COMMITS`）を足す。
  `conf.py` に、STRICT と `iface_junit` が使うレーンの一覧を外から受け取る口を足す（リリース版で、各タグから集めた一覧を渡す）。
  テストは `libs/interface-spec/docs/tests/` に先に書く
- [x] T034 [US1] `.github/workflows/pages-deploy.yml` を書く。verify・store・deploy の 3 つの job を、contracts の表のとおりの権限・environment・concurrency で置く。
  PR 版の run は、verify が「保管は Phase 5 から」と summary に書いて捨てる（T039 で保管に替える）。
  `.github/actionlint.yaml` の `paths` に `.github/workflows/pages-deploy.yml` を足し、publish-npm.yml と同じ `queue` の除外を付ける。#529 の対象にも加える
- [x] T035 [US1] `.github/workflows/release.yml` の本番の land の成功の後に、App のトークンで `pages-build.yml` を `side=release` で起こす段を足す。dry-run では打たない
- [x] T036 [US1] 保管ブランチ・environment・pages-store の App・ruleset と、GitHub Pages の公開元を、contracts の「保管ブランチ・environment・ruleset」の表のとおりに設定する。
  リポの管理者の操作なので、マージの前にユーザーに打ってもらうコマンドを PR に書く。
  `pages-store` の初回の作成も含める

**Checkpoint**: マージの後、main への push で `/pecot/dev/` が公開され、`/pecot/` に案内のページが出る。手でリリース版を作ると `/pecot/` が変わり、`/pecot/dev/` は変わらない

---

## Phase 5: User Story 3 - PR 版 (Priority: P3)

**Goal**: 開いている同じリポの PR の PR 版を `/pr/<番号>/` に保管し、PR の head のコミットに URL の commit status を付ける。PR が閉じたら、次の保管で消す

**Independent Test**: quickstart.md の「5. PR 版」と「6. 止まる場合」の 1〜3 行目

### Tests for User Story 3

- [x] T037 [P] [US3] `.githooks/tests/test_pages_store.py` に、PR 版の保管のテストを足す。
  `/pr/<番号>/` だけを書き換える。保管のたびに、verify が出した開いている PR の番号の一覧に無い `pr/<番号>/` を消す。
  closed の契機の run と、RunProvenance に合わない run でも、掃除はする
- [x] T038 [P] [US3] `.githooks/tests/test_pages_workflows.py` に、preview-status の job のテストを足す。
  job が verify・store・deploy・preview-status の 4 つになる。preview-status の権限は `statuses: write` だけ。context は `pages / preview` で、必須のチェックの名前（`ci-result`・`version-plan`）と重ならない。
  `pages / preview` を付ける job は `pages-deploy.yml` の preview-status だけで、ほかの workflow に無い（research R12）。
  `target_url` は `https://pecotcraft.github.io/pecot/pr/<番号>/`、付け先は verify が決めた PR の head のコミット

### Implementation for User Story 3

- [x] T039 [US3] `.githooks/scripts/pages_site/store.py` に、PR 版の保管と閉じた PR の掃除を足す。T034 で捨てていた PR 版の run を、保管に替える
- [x] T040 [US3] `.github/workflows/pages-deploy.yml` に preview-status の job を足す
- [x] T041 [US3] `libs/interface-spec/docs/_templates/header.html` の PR 版の帯に、PR の番号と PR へのリンクを出す。PR 版どうしのリンクは置かない（FR-025）

2026-11-18 の 3 回目の決め直し（#590）で、PR 版を ci の結果から作る T046〜T048 を足した。理由は research.md の R14。

- [x] T046 [US3] `.github/workflows/ci.yml` の tests の job に、合否のレーンの JUnit を `pages-junit-<slug>` に残す段を足す。
  tests の後に `pages-preview` の job を足し、ci の JUnit と開発版の JUnit で PR 版を作る。`.githooks/scripts/pages_site/collect.py`・`dev_side.py` と帯の「開発版で埋めたレーン」も足す
- [x] T047 [US3] `.githooks/scripts/pages_site/provenance.py` で、PR 版を ci.yml の `pull_request` の run からだけ受ける。
  pages-build.yml の `pull_request` の run は、閉じた PR の掃除だけを起こす
- [x] T048 [US3] `.github/workflows/pages-build.yml` の `pull_request` を `closed` だけにし、開発版の artifact を 90 日残す。
  `pages-deploy.yml` は ci の run も受け、deploy に `queue: max` を足す
- [x] T049 [US3] 版の帯をやめ、リリース版でない側だけの 1 行の知らせ（`_templates/header.html`）にする。コミット・版・時刻・実行は出さず、渡す環境変数も外す。
  GitHub と同じく、ヘッダーを画面の幅いっぱいに広げ、フッターはロゴ・「© 2026 pecotcraft」・リンクを真ん中に寄せる（`_templates/footer.html`）。
  本文の段落と箇条書きの 1 行を 50rem で止める（`_static/pecot.css`、`interface-spec:test-site`）

**Checkpoint**: マージの後、同じリポのブランチから開いた PR に `pages / preview` が付き、`/pecot/pr/<番号>/` が開く。PR を閉じると、次の保管で消える

---

## Phase 6: Polish（文書）

**Purpose**: 公開サイトの案内と、保守者の手順

- [x] T042 [P] `README.md` に、公開サイトへのリンクを足す（FR-011）。README の全面的な書き直しはしない
- [x] T043 [P] `libs/interface-spec/README.md` を書き直す。
  「定義書と合否の HTML」に版の帯と `PECOT_SITE_STRICT` を足し、「CI の artifact に上げない理由」を、公開の流れが全レーンを動かす今の形に直す。
  保管ブランチ・environment・ruleset の設定と、公開の流れの起動・やり直しの方法を書く（FR-010）
- [x] T044 [P] `plugins/pecot-workflow/CONTRIBUTING.md` の「このリポだけの運用」の表に、公開サイト（`pages-build.yml`・`pages-deploy.yml`・`pages-store`）の行を足す。確かめ方は `.githooks/tests/test_pages_*.py` と、マージの後の実物
- [x] T045 quickstart.md の 1〜6 を通して動かし、結果を PR に書く。3 と 5 では、push から公開の終わりまでの時間を run の時刻で測り、30 分以内（SC-001・SC-007）であることを書く

---

## Dependencies & Execution Order

### Phase Dependencies

| Phase | 前提 | 種類 | 理由 |
|---|---|---|---|
| 2 | 1 | 積める | 「未実行」と「テストが無い」の区別と STRICT が、`junit-lanes.json` のプラグインごとのレーンの一覧を読む。Phase 1 のブランチの上で手元で作って確かめられる |
| 3 | 1 | 積める | 作る run が `pages_site/lanes.py` の出力を読む。`pull_request` の run は PR のブランチの定義で動くので、積んだブランチの PR で確かめられる |
| 4 | 2 | 積める | SideCheck の内部リンクの確かめ（T026）と、帯のタグのコミット（T033）が、Phase 2 の帯を読む |
| 4 | 3 | マージを待つ | `pages-deploy.yml` は `workflow_run` で起き、既定のブランチの定義で動く。作る run が main への push で動いて artifact を残していないと、確かめと保管と公開を確かめられない |
| 5 | 4 | マージを待つ | PR 版の保管は `pages-deploy.yml` の中にあり、`workflow_run` は既定のブランチの定義で動く。公開の流れが main に入っていないと、PR 版を公開して確かめられない |
| 6 | 5 | 積める | 文書は、PR 版までの仕組みと URL を書く。Phase 5 のブランチの上で書いて、内容を見比べられる |

Phase 2 と Phase 3 は、どちらも Phase 1 だけを前提にするので並べて進められる。Phase 3 の作る run は、Phase 2 が入っていなくても側を作れる（版の帯が出ないだけ）。
Phase 5 の T041 と Phase 6 の T043 も Phase 2 の帯を使うが、Phase 4 を通して Phase 2 を間接に前提にするので、表には書かない。

### User Story Dependencies

- **US2・US4（Phase 2）**: 手元で完結する
- **US1（Phase 3・4）**: Phase 3 の作る run を main に入れてから、Phase 4 の確かめ・保管・公開を確かめる
- **US3（Phase 5）**: US1 の公開の流れの上に載る

### Within Each User Story

- テストを先に書き、落ちることを確かめてから実装する
- 判定の純粋な処理（`outcome_of`・RunProvenance・ReleaseSources）を、I/O（JUnit の読み込み・API・展開・push）より先に作る

### Parallel Opportunities

- Phase 1 の T001・T002
- Phase 2 のテスト T007〜T011、CSS の T018
- Phase 2 と Phase 3（どちらも Phase 1 の上に積める）
- Phase 4 のテスト T024〜T028
- Phase 5 のテスト T037・T038
- Phase 6 の T042〜T044

---

## Parallel Example: Phase 2

```bash
Task: "outcome_of の 5 つの状態のテストを libs/interface-spec/docs/tests/test_iface_defs.py に書く"
Task: "SiteStamp のテストを libs/interface-spec/docs/tests/test_iface_defs.py に書く"
Task: "帯と状態の見た目を libs/interface-spec/docs/_static/pecot.css に足す"
```

---

## Implementation Strategy

### MVP First

1. Phase 1 → Phase 3 → Phase 4 で、開発版とリリース版が公開される（US1）
2. **STOP and VALIDATE**: quickstart.md の 3・4

### Incremental Delivery

1. Phase 1 → Phase 2（出し方）と Phase 3（作る run）を並べて進める
2. Phase 3 のマージの後に Phase 4（確かめ・保管・公開）→ リリース版・開発版が見える
3. Phase 4 のマージの後に Phase 5（PR 版）→ PR の間に確かめられる
4. Phase 6 で文書を整える

---

## Notes

- [P] tasks = different files, no dependencies
- workflow の `workflow_dispatch` と `workflow_run` は、既定のブランチの定義で動く。PR のブランチで直しても、その PR の上では動かない
- 保管ブランチ・environment・pages-store の App・ruleset・Pages の設定（T036）は、リポの管理者の権限の操作。App の作成と秘密鍵の発行だけは画面で行う
