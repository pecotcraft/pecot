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

- [ ] T007 [P] [US2] `libs/interface-spec/docs/tests/test_iface_defs.py` に `outcome_of` の 5 つの状態のテストを書く。
  data-model.md の表を上から順に当てる: 「そのプラグインの合否のレーンのうち、JUnit が無いものがある」→ `not-run`、
  「JUnit はそろっているが、項目につながるケースが 0 件」→ `no-test`、
  「failed か error が 1 つでもある」→ `failed`、
  「passed が 1 つ以上あり、ほかは passed か skipped」→ `passed`、
  「すべて skipped」→ `skipped`。
  入力は実物の vitest の JUnit の形（`tests/fixtures` に置く）
- [ ] T008 [P] [US2] 同じファイルに、落ちたケースの要旨のテストを書く。`message` は `<failure>`・`<error>` の `message` 属性、無ければ本文の先頭の 1 行。`detail` は本文
- [ ] T009 [P] [US2] 同じファイルに、状態ごとの数のテストを書く。0 件の状態は出さない。一覧表の行（コマンド・ツールごと）と、トップの全体の合否（プラグインごと）。
  spec の Edge Cases「同じテストが複数の結果のファイルに出る: 1 件として数える」も確かめる
- [ ] T010 [P] [US4] 同じファイルに、SiteStamp のテストを書く。
  `PECOT_SITE_*` が無いときは `side=local`・手元の HEAD・今の時刻・`run_url` 無し。
  `side=pr` で `PECOT_SITE_PR` が無いと失敗。
  `sha` が取れないと失敗。
  プラグインの版は各 `plugins/<name>/package.json` の `version`
- [ ] T011 [P] [US4] 同じファイルに、`PECOT_SITE_STRICT=1` で JUnit が欠けたレーンがあると、そのレーンの名前を出して build が失敗するテストを書く。STRICT が無ければ失敗しない

### Implementation for User Story 2 + 4

- [ ] T012 [US2] `libs/interface-spec/docs/_ext/iface_defs.py` の `outcome_of` を 5 つの状態にし、`OUTCOME_LABELS` に記号（`✓`・`✗`・`−`・`–`・`?`）と文字を持たせる。表示は記号と文字の両方を出す（FR-015）
- [ ] T013 [US2] `libs/interface-spec/docs/_ext/iface_defs.py` で、`failed` の項目のページに落ちたケースの名前と要旨を出し、本文（スタック）は折りたたむ。`passed` で一部が skipped の項目は、飛ばしたケースを示す
- [ ] T014 [US2] `libs/interface-spec/docs/_ext/iface_defs.py` の `_summary` と `IfaceIndex` を、5 つの状態ごとの数にする
- [ ] T015 [US2] `libs/interface-spec/docs/_ext/iface_defs.py` に、プラグインごとの状態ごとの数をまとめる directive を足し、`libs/interface-spec/docs/index.rst` に置く（FR-018）
- [ ] T016 [US4] `libs/interface-spec/docs/conf.py` で SiteStamp を決めて `html_context` に渡す。`PECOT_SITE_STRICT` を拡張の設定に渡す
- [ ] T017 [US2] `libs/interface-spec/docs/_templates/header.html` に版の帯を出す。中身は contracts/pages.md の「版の帯」の表のとおり。リリース版と開発版への行き来のリンクは、公開サイトの絶対パス（`/pecot/`・`/pecot/dev/`）で張る
- [ ] T018 [P] [US2] `libs/interface-spec/docs/_static/pecot.css` に、帯と 5 つの状態の見た目を足す。色は補いにだけ使う
- [ ] T019 [US4] `libs/interface-spec/docs/_ext/iface_defs.py` の `IfaceTests` の「JUnit のファイルが見つからないため…」の文言を、欠けたレーンの名前を出す形に直す

**Checkpoint**: quickstart.md の 1 が通る。一部のレーンだけ動かして作っても失敗せず、`PECOT_SITE_STRICT=1` では失敗する

---

## Phase 3: User Story 1 - 側を作る run (Priority: P1)

**Goal**: `pages-build.yml` が、合否のレーンを全部動かし、JUnit がそろったときだけ側の HTML を artifact に上げる。公開はしない

**Independent Test**: この PR の上で、`pull_request` の契機の run が `pages-side-pr-<番号>` の artifact を作ることを、`gh run view` で確かめる（`pull_request` は PR のブランチの定義で動く）

### Tests for User Story 1（作る run）

- [x] T020 [P] [US1] `.githooks/tests/test_pages_workflows.py` に、`pages-build.yml` の形のテストを書く。
  contracts/pages.md の「`pages-build.yml`」の表のとおり: 契機（`push` の `main`・`pull_request` の opened/synchronize/reopened/closed・`workflow_dispatch` の `side` と `sha`）、
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

## Phase 4: User Story 1 - 集めて公開する run (Priority: P1) 🎯 MVP

**Goal**: `pages-deploy.yml` が、リリース版と開発版の artifact を集めて 1 つのツリーに組み、公式の `deploy-pages` で公開する。release.yml の本番が、リリース版を作る run を起こす

**Independent Test**: quickstart.md の「3. 開発版の公開」「4. リリース版の公開」「6. 止まる場合」の 2 行目

### Tests for User Story 1（公開する run）

- [ ] T024 [P] [US1] `.githooks/tests/test_pages_assemble.py` に、`.githooks/scripts/pages_site/plan.py` の DeployPlan の判定のテストを書く。
  入力は GitHub の REST の応答（workflow run の一覧・artifact の一覧）の実物の形。
  確かめること: 「`release` の artifact が無いときは公開しない」、「`dev` の artifact が無いときは、`/dev/` を置かずに公開し、run の summary に書く」、
  各側で run の作成時刻が最も新しい成功した run を選ぶ（後に終わった古い run を選ばない）。
  リリース版の作り直しは、同じ SHA の `side=release` の作る run が進行中か、最後のものが失敗なら起こさない（ループの止め）
- [ ] T025 [P] [US1] 同じファイルに、組み立てのテストを書く。「展開した中身が、自分の `path` の外を指すもの（絶対パス・`..`・シンボリックリンク）を含むときは、その側を外して run の summary に書く」、「組み立てたツリーの大きさが 900 MB を超えたら、run の summary に警告を書く」、組んだツリーの内部リンク（側の行き来を含む）が切れていたら失敗する
- [ ] T026 [P] [US1] `.githooks/tests/test_pages_workflows.py` に、`pages-deploy.yml` の形のテストを書く。
  契機は `workflow_run`（`pages-build.yml` の completed）と `workflow_dispatch`。
  組み立ての job の権限は `contents: read`・`actions: write`・`pull-requests: read`・`statuses: write`。
  公開の job の権限は `pages: write`・`id-token: write`。
  environment は `github-pages`。
  concurrency は `group: pages`・`cancel-in-progress: false`。
  action は `configure-pages`・`upload-pages-artifact` v5・`deploy-pages` v5 を SHA で固定
- [ ] T027 [P] [US1] `.githooks/tests/test_release_workflow.py` に、本番（`dry-run=false`）の成功の後にだけ `gh workflow run pages-build.yml -f side=release -f sha=<本番の SHA>` を打つ段があり、その job に `actions: write` があるテストを足す

### Implementation for User Story 1（公開する run）

- [ ] T028 [US1] `.githooks/scripts/pages_site/plan.py` を作る。API の応答から DeployPlan（`release`・`dev`）とリリース版の作り直しの要否を決める純粋な処理だけを置く
- [ ] T029 [US1] `.githooks/scripts/pages_site/assemble.py` を作る。
  API を叩き（`gh api`）、DeployPlan の artifact を `gh run download <run-id> -n <name>` で取り、`/`・`/dev/` に展開する。
  パスの確かめ・大きさの警告・内部リンクの確かめをして、job summary に側ごとの採否を書く
- [ ] T030 [US1] `.github/workflows/pages-deploy.yml` を書く。組み立ての job と公開の job を分け、公開の job は `upload-pages-artifact` → `deploy-pages` だけにする
- [ ] T031 [US1] `pages-deploy.yml` に、リリース版の artifact が無いときの段を足す。
  公開せずに失敗し、GitHub の Latest のリリースのタグが指すコミットで `pages-build.yml` を `side=release` で起こす。
  起こすかどうかは T028 の判定に従う（同じ SHA の作る run が進行中か、最後のものが失敗なら起こさない）
- [ ] T032 [US1] `.github/workflows/release.yml` の本番の最後に、`pages-build.yml` を起こす段を足す。dry-run では打たない。その job に `actions: write` を付ける
- [ ] T033 [US1] GitHub Pages の公開元を「GitHub Actions」にし、environment `github-pages` の deployment branch を既定のブランチだけにする。リポの設定の変更なので、マージの前に利用者に打ってもらうコマンドを PR に書く

**Checkpoint**: マージの後、main への push で `/pecot/dev/` が公開される。手でリリース版を作ると `/pecot/` が変わり、`/pecot/dev/` は変わらない

---

## Phase 5: User Story 3 - PR 版 (Priority: P3)

**Goal**: 開いている同じリポの PR の PR 版を `/pr/<番号>/` に並べ、PR の head のコミットに URL の commit status を付ける。PR が閉じたら外す

**Independent Test**: quickstart.md の「5. PR 版」

### Tests for User Story 3

- [ ] T034 [P] [US3] `.githooks/tests/test_pages_assemble.py` に、DeployPlan の `prs` の判定のテストを足す。
  「今開いている、同じリポのブランチの PR。
  それぞれについて、`side=pr` かつその PR の番号の最新の成功した run」。
  「PR の artifact が無い PR（作る run がまだ終わっていない・落ちた）は、その PR の側を置かない」。
  fork の PR と閉じた PR は入らない
- [ ] T035 [P] [US3] 同じファイルに、PR 版の commit status のテストを足す。context `pages / preview`、state `success`、`target_url` は `https://pecotcraft.github.io/pecot/pr/<番号>/`、付け先は PR の今の head のコミット

### Implementation for User Story 3

- [ ] T036 [US3] `.githooks/scripts/pages_site/plan.py` に `prs` の判定を足す
- [ ] T037 [US3] `.githooks/scripts/pages_site/assemble.py` で PR 版を `/pr/<番号>/` に展開し、commit status を付ける
- [ ] T038 [US3] `libs/interface-spec/docs/_templates/header.html` の PR 版の帯に、PR の番号と PR へのリンクを出す。PR 版どうしのリンクは置かない（FR-025）

**Checkpoint**: マージの後、同じリポのブランチから開いた PR に `pages / preview` が付き、`/pecot/pr/<番号>/` が開く。PR を閉じると、次の公開で消える

---

## Phase 6: Polish（文書）

**Purpose**: 公開サイトの案内と、保守者の手順

- [ ] T039 [P] `README.md` に、公開サイトへのリンクを足す（FR-011）。README の全面的な書き直しはしない
- [ ] T040 [P] `libs/interface-spec/README.md` を書き直す。「定義書と合否の HTML」に版の帯と `PECOT_SITE_STRICT` を足し、「CI の artifact に上げない理由」を、公開の流れが全レーンを動かす今の形に直す。GitHub Pages を有効にする手順と、公開の流れの起動・やり直しの方法を書く（FR-010）
- [ ] T041 [P] `plugins/pecot-workflow/CONTRIBUTING.md` の「このリポだけの運用」の表に、公開サイト（`pages-build.yml`・`pages-deploy.yml`）の行を足す。確かめ方は `.githooks/tests/test_pages_workflows.py`・`test_pages_assemble.py` と、マージの後の実物
- [ ] T042 quickstart.md の 1〜6 を通して動かし、結果を PR に書く。3 と 5 では、push から公開の終わりまでの時間を run の時刻で測り、30 分以内（SC-001・SC-007）であることを書く

---

## Dependencies & Execution Order

### Phase Dependencies

| Phase | 前提 | 種類 | 理由 |
|---|---|---|---|
| 2 | 1 | 積める | 「未実行」と「テストが無い」の区別と STRICT が、`junit-lanes.json` のプラグインごとのレーンの一覧を読む。Phase 1 のブランチの上で手元で作って確かめられる |
| 3 | 1 | 積める | 作る run の matrix が `pages_site/lanes.py` の出力を読む。`pull_request` の run は PR のブランチの定義で動くので、積んだブランチの PR で確かめられる |
| 4 | 2 | 積める | 組み立ての内部リンクの確かめ（T025）が、Phase 2 の帯の側の行き来のリンクを読む。Phase 2 のブランチの上で、手元で作ったツリーを組んで確かめられる |
| 4 | 3 | マージを待つ | `pages-deploy.yml` は `workflow_run` で起き、既定のブランチの定義で動く。作る run が main への push で動いて artifact を残していないと、組み立てと公開を確かめられない |
| 5 | 4 | マージを待つ | PR 版の組み立ては `pages-deploy.yml` の中にあり、`workflow_run` は既定のブランチの定義で動く。公開の流れが main に入っていないと、PR 版を公開して確かめられない |
| 6 | 5 | 積める | 文書は、PR 版までの仕組みと URL を書く。Phase 5 のブランチの上で書いて、内容を突き合わせられる |

Phase 2 と Phase 3 は、どちらも Phase 1 だけを前提にするので並べて進められる。Phase 3 の作る run は、Phase 2 が入っていなくても側を作れる（版の帯が出ないだけ）。
Phase 5 の T038 と Phase 6 の T040 も Phase 2 の帯を使うが、Phase 4 を通して Phase 2 を間接に前提にするので、表には書かない。

### User Story Dependencies

- **US2・US4（Phase 2）**: 手元で完結する
- **US1（Phase 3・4）**: Phase 3 の作る run を main に入れてから、Phase 4 の公開を確かめる
- **US3（Phase 5）**: US1 の公開の流れの上に載る

### Within Each User Story

- テストを先に書き、落ちることを確かめてから実装する
- 判定の純粋な処理（`outcome_of`・DeployPlan）を、I/O（JUnit の読み込み・API・展開）より先に作る

### Parallel Opportunities

- Phase 1 の T001・T002
- Phase 2 のテスト T007〜T011、CSS の T018
- Phase 2 と Phase 3（どちらも Phase 1 の上に積める）
- Phase 4 のテスト T024〜T027
- Phase 5 のテスト T034・T035
- Phase 6 の T039〜T041

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
2. Phase 3 のマージの後に Phase 4（公開）→ リリース版・開発版が見える
3. Phase 4 のマージの後に Phase 5（PR 版）→ PR の間に確かめられる
4. Phase 6 で文書を整える

---

## Notes

- [P] tasks = different files, no dependencies
- workflow の `workflow_dispatch` と `workflow_run` は、既定のブランチの定義で動く。PR のブランチで直しても、その PR の上では動かない
- Pages の設定（T033）は、リポの管理者の操作。エージェントは、打つコマンドを示して利用者に打ってもらう
