---

description: "PR ごとのテストとリリースを CI で動かし、ローカルフックと CI の役割を分け直す"
---

# Tasks: PR ごとのテストとリリースを CI で動かし、ローカルフックと CI の役割を分け直す

**Input**: `specs/019-ci-pr-tests/` の設計文書

**Prerequisites**: plan.md・spec.md・research.md・data-model.md・contracts/・quickstart.md

**Tests**: constitution II（TDD）により、テストのタスクを実装の前に置く。workflow は quickstart の確かめ方で検証する。

**Organization**: phase ごとに 1 つの PR にする。前の phase が `main` に入ってから次へ進む。CI がテストを担う前に、pre-push からテストを外さない。

## Format: `[ID] [P?] [Story] Description`

| 印 | 意味 |
|---|---|
| `[P]` | 別のファイルで、未完了のタスクに依存しないので並べられる |
| `[Story]` | 対応する user story（spec.md の US1〜US5） |

## 共通の約束

- Action は SHA で固定し、版をコメントに書く。版と SHA は research.md の各節にある
- workflow を足すか変えたら、actionlint（pre-commit の `actionlint-system`）を通す
- release group のファイルを変える phase では、その group の version plan を `.nx/version-plans/` に足す
- 文言は CLAUDE.md の規約に従い、`check-text` を通す

---

## Phase 1: Setup（CI のコンテナを devcontainer の定義から作れるようにする）

**Purpose**: CI と手元が同じ定義のコンテナを使う下地を作る（FR-004、research R1）

- [x] T001 `.devcontainer/Dockerfile` を作り、今 `post-create.sh` が入れている apt のパッケージを入れる
  - `FROM mcr.microsoft.com/devcontainers/base:ubuntu26.04` とする
  - パッケージは shellcheck・fontconfig・fonts-noto-cjk・fonts-inter・fonts-crosextra-carlito
  - 続けて libreoffice-impress・libreoffice-calc・poppler-utils
  - `--no-install-recommends` は付けない（poppler-data が recommends で入るため）
- [x] T002 `.devcontainer/Dockerfile` に、fontconfig の strong alias と `fc-cache -f` を移す
  - alias は Noto Sans JP → Noto Sans CJK JP と、Calibri Light → Carlito の 2 つ
  - コメントの理由（#165・#728）も一緒に移す
- [x] T003 `.devcontainer/devcontainer.json` の `image` を `build: { dockerfile: "Dockerfile" }` に替える。features・mounts・lifecycle は変えない
- [x] T004 `.devcontainer/scripts/post-create.sh` から apt と fontconfig の処理を消す
  - `CI=true` のときは、`install-git-hooks.sh` と `pecot worktree add` を飛ばす
  - `setup.sh` と `playwright install --with-deps chromium` は CI でも動かす
- [x] T005 `.github/workflows/devcontainer-image.yml` を作る
  - 約束は contracts/workflows.md の「devcontainer-image.yml」にある
  - `devcontainers/ci` で build する
  - push するのは、`main` への push・schedule・`workflow_dispatch` のときだけにする
  - push 先は `ghcr.io/pecotcraft/pecot-devcontainer:latest`
- [x] T006 手元で devcontainer を作り直し、全テスト（`nx run-many -t test`）が通ることを確かめる。結果を PR 本文に書く

**Checkpoint**: 作り直した devcontainer で全テストが通る。`main` に入った後、GHCR にイメージが載る

---

## Phase 2: Foundational（hook のスクリプトを stage ごとのディレクトリへ移す）

**Purpose**: CI のスクリプトを置く `.githooks/ci/` と、共有の `.githooks/lib/` を先に作る（FR-016a、plan の Phase 3a）。中身は変えない

**⚠️ CRITICAL**: Phase 3 の `run-pr-checks.sh` は、移した後のパスを前提にする

- [x] T007 wiring テストに、ディレクトリと stage の一致を確かめるテストを足す
  - ファイルは `.githooks/pre-commit/tests/test_pre_commit_config_wiring.py`（T008 で `.githooks/tests/` に移る）
  - `.githooks/pre-commit/` の hook は `stages: [pre-commit]` であること
  - `commit-msg/` は `[commit-msg]`、`pre-push/` は `[pre-push]` であること
  - この時点では落ちることを確かめる
- [x] T008 `git mv` で共有のファイルとテストを移す
  - `.githooks/pre-commit/lib/*` と `with-timing.sh` → `.githooks/lib/`
  - `.githooks/pre-commit/tests/` → `.githooks/tests/`
- [x] T009 `git mv` で commit-msg と pre-push の hook を移す
  - `check-direct-commit.sh`・`check-commit-text.sh` → `.githooks/commit-msg/`
  - `check-text-push.sh`・`check-version-plan-required.sh` → `.githooks/pre-push/`
  - `check-nx-env-inputs.sh` → `.githooks/pre-push/`
- [x] T010 `git mv` で `run-affected-tests.sh` を `.githooks/ci/` へ移す。stage はこの phase では pre-push のままにし、Phase 4 で変える
- [x] T011 移したスクリプトの `source` のパスを直す
  - 対象は `lib/push-range.sh`・`lib/nx-lanes.sh`・`lib/timing.sh`・`lib/text-rules-ready.sh`
- [x] T012 `.pre-commit-config.yaml` の `entry` と `files` のパスと、`.markdownlint-cli2.jsonc` を直す
- [x] T013 [P] plugin の設定と bin の参照を直す
  - `plugins/pecot-visual/project.json`・`plugins/pecot-tools/project.json`
  - `plugins/pecot-workflow/project.json`
  - `plugins/pecot-visual/bin/pecotv`・`plugins/pecot-tools/bin/pecot-tools`
- [x] T014 [P] plugin のリリースと CI のスクリプトの参照を直す
  - 両プラグインの `scripts/release/audit-mcp-dist.sh`・`publish-mcp-dist.sh` とそのテスト
  - `plugins/pecot-workflow/scripts/ci/python-version.sh`
- [x] T015 [P] pecot-workflow のコードとテストの参照を直す
  - `cli-node/src/infra/nx-scope.ts`・`cli-node/src/infra/github/auth.ts`
  - `cli-node/src/infra/tests/nx-scope.test.ts`
  - `cli/core/nx_scope.py`・`cli/tests/core/test_nx_scope.py`
  - `hooks/lib/core/project-root.sh`・`hooks/lib/tests/test_entry_point_linter.py`
- [x] T016 [P] 両プラグインの `cli/src/tests/node-runtime.test.ts` と、CLAUDE.md・`.githooks/README.md` のパスを直す
- [x] T017 移したファイルへの古いパスが残っていないことを確かめる
  - コマンドは `grep -rn 'githooks/pre-commit/' . --exclude-dir=node_modules --exclude-dir=specs`
- [x] T018 version plan を足す
  - pecot-workflow・pecot-visual・pecot-tools の各 patch
  - 本文は「hook のスクリプトの置き場を変えた参照を直した。」とする
- [x] T019 T007 のテストと githooks-tests が通ることを確かめる。全量は pre-push のチェックに任せ、手では動かさない

**Checkpoint**: hook の動きは変わらず、スクリプトの置き場だけが stage ごとになる

---

## Phase 3: User Story 1 - PR を開くと、変更が届いたレーンの検証が動いて結果が PR に付く (Priority: P1) 🎯 MVP

**Goal**: PR ごとに pre-commit・pre-push・テストを devcontainer で動かし、結果を PR のチェックと Step Summary に付ける（FR-001〜010）

**Independent Test**: quickstart の「1. PR の検証」の 5 行

### Tests for User Story 1

- [x] T020 [P] [US1] `.githooks/tests/test_run_pr_checks.py` を書く
  - 一時リポに base と head の commit を作り、pre-commit と nx は偽物で置き換える
  - 各 stage が `--from-ref <base> --to-ref <head>` で呼ばれること
  - レーンが 0 件なら、Summary に「対象なし（成功）」と書くこと
  - hook が失敗したら非 0 を返すこと
  - `check-version-plan-required` を呼ばないこと

### Implementation for User Story 1

- [x] T021 [US1] `.githooks/ci/run-pr-checks.sh` を作る。引数は base と head の SHA にする
  - 1 つ目に `pre-commit run --hook-stage pre-commit --from-ref --to-ref` を動かす
  - 続けて `--hook-stage pre-push`、最後に `--hook-stage manual` を動かす
  - pre-push と manual では、`PECOT_VERSION_PLAN_BASE=<base>` を渡す
  - 同じく `PRE_COMMIT_TO_REF=<head>` も渡す
  - `SKIP=check-version-plan-required` を付ける。version plan は `version-plan` の job だけが確かめる
  - この phase の間は、pre-push の stage に `SKIP=nx-affected-tests,githooks-tests` も足す
  - テストを pre-push と manual の両方で 2 回動かさないための措置とし、Phase 4 で外す
- [x] T022 [US1] `run-pr-checks.sh` に Step Summary の書き出しを足す
  - 欄は contracts/workflows.md の「checks の Step Summary」の 4 つ（範囲・レーン・失敗・環境）
  - `$GITHUB_STEP_SUMMARY` が無ければ標準出力に出す
  - レーン名と成否は、`.pecot/tmp/pre-push/nx-affected-tests.log` から読む
  - 所要は `githooks-timing.tsv` から読む
  - レーンごとの skip の件数も出す（SC-002）
- [x] T023 [US1] `run-pr-checks.sh` で `NX_SKIP_NX_CACHE=true` を立てる（research R3）
- [x] T024 [US1] `.pre-commit-config.yaml` の `nx-affected-tests` と `githooks-tests` に、`manual` の stage を足す
  - この phase では pre-push にも残し、Phase 4 で pre-push から外す
- [x] T025 [US1] `.github/workflows/ci.yml` を作る。約束は contracts/workflows.md の「ci.yml」にある
  - step は `checkout`（`fetch-depth: 0`）、`nx-set-shas`、`devcontainers/ci` の順にする
  - `devcontainers/ci` は `cacheFrom: ghcr.io/pecotcraft/pecot-devcontainer`・`push: never` にする
  - `runCmd` は `.githooks/ci/run-pr-checks.sh "$NX_BASE" "$NX_HEAD"` にする
  - 起動は `pull_request` と `main` への `push` にする（FR-001a）
  - `concurrency` は contracts のとおり、PR のときだけ `cancel-in-progress` にする（FR-007）
  - job ごとに `timeout-minutes: 45` を付ける（FR-008）
  - push では、nx-set-shas の `main-branch-name: main` で直前に成功した run を base にする
- [x] T026 [US1] 書き換え後の履歴での範囲を確かめる（FR-029）
  - `.githooks/tests/test_run_pr_checks.py` に、base の SHA が履歴に無いときのテストを足す
  - そのとき `run-affected-tests.sh` が全量（`run-many`）へ切り替わることを確かめる
  - `ci.yml` の nx-set-shas は、成功した run が見つからなくても止めない設定にする
- [x] T027 [US1] `ci.yml` に `ci-result` の job を足す。`needs: checks`・`if: always()` にし、`checks` が success でなければ落とす
- [x] T028 [US1] `ci.yml` で、コンテナの取得・起動の step と、検証の step を分ける。基盤の失敗は step 名で見分けられるようにする
- [x] T029 [US1] 手元と CI の skip の件数を比べる（SC-002）
  - pecot-visual と pecot-tools の全レーンを、手元の devcontainer と CI の両方で動かす
  - レーンごとの skip の件数が同じことを確かめ、違えば原因を直す
  - 比べた表を PR 本文に書く
- [x] T030 [US1] この PR 自身で quickstart の「1. PR の検証」を確かめる
  - 下書きの PR に、テストをわざと落とした commit とその revert を積む
  - 結果と所要を PR 本文に書く

**Checkpoint**: PR に `ci-result` が付く。必須チェックにはまだしない（ruleset は Phase 6）

---

## Phase 4: User Story 3 - pre-commit・pre-push・CI の役割が分かれていて、同じ検証を二度待たない (Priority: P2)

**Goal**: pre-push からテストを外し、ブランドの語の確認を廃止し、役割の表を置く（FR-016〜020・FR-018a）

**Independent Test**: quickstart の「2. 手元のフック」

### Tests for User Story 3

- [x] T031 [P] [US3] `.githooks/tests/test_pre_commit_config_wiring.py` を先に直す
  - `nx-affected-tests`・`githooks-tests` の stage が `[manual]` だけであること
  - verbose の組から `check-brand-terms` を外す
  - `check-brand-terms` の stage と並び順の 2 テストを消す

### Implementation for User Story 3

- [x] T032 [US3] `.pre-commit-config.yaml` の `nx-affected-tests` と `githooks-tests` を `stages: [manual]` にする
  - `githooks-tests` の `files` の条件を manual でどう扱うか決め、コメントに書く
  - `run-pr-checks.sh` の pre-push の stage から、Phase 3 で足した `SKIP=nx-affected-tests,githooks-tests` を外す
- [x] T033 [US3] `.githooks/ci/run-affected-tests.sh` の、pre-push の stdin を読む分岐を残すか決める。`--hook-stage manual` から手で呼べることを確かめる
- [x] T034 [P] [US3] ブランドの語の hook を消す
  - `.githooks/pre-commit/check-brand-terms.sh` と `.githooks/tests/test_check_brand_terms.py` を削除する
  - `.pre-commit-config.yaml` の `check-brand-terms` を削除する
- [x] T035 [P] [US3] pecot-visual のリリースから語の確認を消す
  - `plugins/pecot-visual/scripts/release/audit-mcp-dist.sh` の一覧の確認
  - 同じディレクトリの `publish-mcp-dist.sh` の 2 か所
- [x] T036 [P] [US3] `plugins/pecot-tools/scripts/release/publish-mcp-dist.sh` の語の確認 2 か所を消す
- [x] T037 [US3] リリースのテストから語の確認を消す
  - 対象は `audit-mcp-dist.test.sh`・両 `publish-mcp-dist.test.sh`・両 `npm-cache-opt-in.test.sh`
  - 一覧の export と、写すファイルの一覧の `check-brand-terms.sh` を消す
  - 語の確認のケースを消す
- [x] T038 [US3] `.githooks/scripts/attach-mcp-tgz.sh` のコメントと、CLAUDE.md の「ブランドの語の確認」節を消す
- [x] T039 [US3] `.githooks/README.md` に役割の表を書く
  - 列と行は data-model.md の 1 節のとおりにする
  - 二重にする hook の理由と、弱まる保証（FR-020）も書く
  - 手で 1 レーンを動かすコマンドも書く
  - コマンドは `pre-commit run --hook-stage manual nx-affected-tests --from-ref origin/main --to-ref HEAD`
- [x] T040 [US3] version plan を足す。pecot-visual・pecot-tools の各 patch で、本文は「リリースのブランドの語の確認を外した。」とする
- [x] T041 [US3] quickstart の「2. 手元のフック」を確かめ、`time git push` の結果を PR 本文に書く（SC-004 の 5 秒以内）

**Checkpoint**: pre-push は秒単位で終わる。テストは CI と manual だけで動く

---

## Phase 5: User Story 4 - リリースを GitHub Actions のランナーで実行する (Priority: P2)

**Goal**: dependabot の更新の version plan を作り、承認付きの workflow でリリースする（FR-015a・015b・FR-023〜027）

**Independent Test**: quickstart の「4. リリース」の 1〜4。5 は ruleset を入れる Phase 6 で確かめる

### Setup for User Story 4（憲法 III）

- [x] T042 [US4] `.nx/nx-release/` に型の確認のレーンを足す
  - `tsconfig.json` は `checkJs: true`・`strict: true`・`noEmit: true`、対象は `src/`
  - `project.json` に `typecheck` の target（`tsc -p .nx/nx-release`）を足す
  - 既存の `version-actions.js`・`package-version-actions.js` で出た型の誤りは、同じ PR で直す
- [x] T043 [US4] `.nx/nx-release/` に lint のレーン（eslint）を足す
  - `project.json` の `lint` の target と `eslint.config.js` を置く
  - nx-affected-lint の対象になることを確かめる

### Tests for User Story 4

- [x] T044 [US4] `.nx/nx-release/tests/dependabot-plans.test.js` を書く
  - 観点は contracts/dependabot-plans.md の「テストの観点」の 7 つ
  - 入力の本文は、`git log -1 --format=%B ab704e0` などの実物から写す
- [x] T045 [US4] 同じテストに、作った plan が `check-version-plan-format.sh` を通ることを足す
  - ファイル名は Rule 0 の `^[0-9]+-[a-z0-9]+(-[a-z0-9]+)*\.md$` に合うこと
  - 本文は「各行 100 字以内・空でない行 3 行以内・総文字数 200 以内」に合うこと

### Implementation for User Story 4

- [x] T046 [US4] 同じテストに、force push 後の重複を除くことを足す（FR-030）
  - 一時リポで、tag の後に履歴を書き換え、同じ中身の dependabot の commit を作る
  - その commit の plan を作らないことを確かめる
- [x] T047 [US4] `.nx/nx-release/src/dependabot-plans.js` を作る
  - ファイルの先頭に `// @ts-check` を置き、関数の引数と戻り値に JSDoc の型を付ける
  - commit の本文を読む関数、配布物に届くかを決める関数、plan の文面を作る関数を分ける
  - git と fs の呼び出しは、CLI として起動された部分にだけ置く
  - 判定は data-model.md の 4・5 節、出力は 6 節に従う
- [x] T048 [US4] `dependabot-plans.js` の CLI を、contracts/dependabot-plans.md の「呼び方」「終了コード」どおりにする
  - 作った後に `check-version-plan-format.sh` と `check-text.sh` を呼ぶ
  - 通らなければコード 1 で止める
- [x] T049 [US4] quickstart の「0. 準備」のうち 3 つを済ませる
  - GitHub App を作り、secrets を登録し、Environment `release` を作る
  - 管理者の作業なので、手順と結果（App の slug と id）を PR 本文に書く
- [x] T050 [US4] `.github/workflows/release.yml` を作る。約束は contracts/workflows.md の「release.yml」にある
  - `plan` の job では、devcontainer で `dependabot-plans.js` と `pecot release preflight` を動かす
  - 続けて `nx release --dry-run --verbose --yes` を動かし、案を Summary に出す
- [x] T051 [US4] `release.yml` に `release` の job を足す
  - `environment: release` で承認を待つ
  - `plan` の SHA と `main` の SHA が違えば止める
  - App のトークンを `GH_TOKEN` に入れ、コンテナで `gh auth setup-git` を実行する
  - git の作者を `<app-slug>[bot]` に設定してから、`nx release --verbose --yes` を動かす
- [x] T052 [US4] `release.yml` の設定を足す
  - concurrency は `group: release`・`cancel-in-progress: false`
  - `checkout` は `persist-credentials: false`
- [x] T053 [US4] w-release をランナーでのリリースの手順に書き換える
  - 対象は `plugins/pecot-workflow/skills/w-release/SKILL.md` と、同じスキルの次の 2 つ
  - `references/release-nx.md`・`references/release-nx-recovery.md`
  - 単一ブランチの nx の手順を、`gh workflow run release.yml` の起動に替える
  - 起動の後は、plan の Summary を確かめ、Environment で承認する
  - 失敗時の確かめ方とやり直し方（FR-027）も書く
- [x] T054 [US4] version plan を足す。pecot-workflow の patch で、本文は「w-release のリリースを workflow から起動する手順にした。」とする
- [x] T055 [US4] `main` に入った後、quickstart の「4. リリース」の 1〜4 を確かめる。結果を PR のコメントに書く

**Checkpoint**: ランナーでリリースが終わる。ruleset はまだ無いので、手元のリリースも動く

---

## Phase 6: User Story 2 - 必須チェックと ruleset を入れる (Priority: P2)

**Goal**: version plan のチェックを CI に足し、`main` に ruleset を入れる（FR-013〜015・FR-024）。自動マージはまだ入れない

**Independent Test**: quickstart の「4. リリース」の 5。人の PR が必須チェックを通ってからしかマージできないこと

### Tests for User Story 2

- [x] T056 [P] [US2] `.githooks/tests/test_check_version_plan_required.py` にテストを足す
  - 範囲内の commit がすべて `dependabot[bot]` の作なら、要求せずに通すこと
  - 人の commit が 1 つでも混じれば、今までどおり要求すること
  - PR のイベントの情報を使わずに判定すること（merge queue の範囲でも同じに動く）

### Implementation for User Story 2

- [x] T057 [US2] `.githooks/pre-push/check-version-plan-required.sh` に、author による判定を足す
  - 範囲の commit の author 名がすべて `dependabot[bot]` なら、理由を出して exit 0 にする
  - 出す理由は「dependabot の更新の version plan はリリース時に作る」
- [x] T058 [US2] `ci.yml` に `version-plan` の job を足す
  - `check-version-plan-required.sh` を範囲指定で動かし、結果を Summary に書く
  - `main` への push では動かさない
- [x] T059 [US2] `ci.yml` の起動に `merge_group` を足す。`nx-set-shas` が queue の commit で範囲を出すことを確かめる
- [x] T060 [US2] `.github/rulesets/main.json` を作る
  - 規則は contracts/workflows.md の「main の ruleset」の表のとおり
  - bypass には Phase 5 の App の id を入れる
- [x] T061 [US2] この PR がマージされた後に、ruleset を適用する（quickstart の「0. 準備」の注意）
  - 適用は `gh api -X PUT repos/pecotcraft/pecot/rulesets/26538811 --input .github/rulesets/main.json`
  - 人の PR で、必須チェックの前にマージできないことを確かめる
  - 手元から `main` への直接 push が拒否されることを確かめる（quickstart の「4. リリース」の 5）

**Checkpoint**: `main` は PR と必須チェックでしか進まない

---

## Phase 7: User Story 2 - テストが通った dependabot の minor・patch の PR は、人が触らずにマージされる (Priority: P2)

**Goal**: dependabot の件名を規約の例外にし、dependabot の PR を merge queue で自動マージする（FR-011・012・014）

**Independent Test**: quickstart の「3. 自動マージ」

**前提**: Phase 6 の ruleset が適用済みであること。必須チェックの無い状態で自動マージを動かさない

### Tests for User Story 2

- [x] T062 [P] [US2] gitlint の日本語の規則のテストを足す
  - `build(pecot-tools): bump commander in /plugins/pecot-tools` が通ること
  - `build(repo): bump the root-minor-patch group ...` のような group の件名も通ること
  - `build(pecot-tools): update deps` のような、人が書いた英語の件名は今までどおり落ちること

### Implementation for User Story 2

- [x] T063 [US2] `.githooks/gitlint/japanese_rule.py` に、dependabot の件名の例外を足す
  - `allow-release` と同じ形の `allow-dependabot` の option にする
  - 件名の形は `^build\([^)]+\): bump` とする
- [x] T064 [US2] `.github/workflows/dependabot-auto-merge.yml` を作る
  - 約束は contracts/workflows.md の「dependabot-auto-merge.yml」にある
  - fetch-metadata の `update-type` が minor か patch のときだけ動く
  - App のトークンで `gh pr merge --auto --squash` を呼ぶ
  - トークンは `permission-pull-requests: write` に絞る
  - merge queue への投入に `contents: write` が要るかを確かめ、要るときだけ足す。結果を PR 本文に書く
- [x] T065 [US2] リポジトリの Allow auto-merge を有効にする。この PR がマージされた後に行う
- [x] T066 [US2] quickstart の「3. 自動マージ」を確かめる
  - 溜まっている dependabot の PR は `@dependabot recreate` で作り直す
  - マージされた件数と、残った件数（major・失敗）を Epic にコメントする

**Checkpoint**: dependabot の minor・patch は人の操作なしにマージされる

---

## Phase 8: User Story 5 - 文書が、CI がテストとリリースを担う前提で書かれている (Priority: P3)

**Goal**: CLAUDE.md と `.githooks/README.md` を新しい分担に合わせる（FR-021・022）

**Independent Test**: quickstart の「5. 文書」

- [x] T067 [US5] CLAUDE.md の「テスト・lint の実行」を書き直す
  - PR ごとに CI が担うことを書く
  - 手元で動かすのは、変更箇所に絞ったテストと、CI の失敗の再現だけだと書く
  - 再現の手順は `pre-commit run --hook-stage manual ...` と `run-tests.sh --scope` にする
- [x] T068 [US5] CLAUDE.md の古い記述を消し、4 つの workflow の役割を 1 行ずつ書く
  - 消すのは「GitHub Actions は publish だけ」と「commit 時の品質は pre-commit に依拠」
- [x] T069 [US5] CLAUDE.md の「リリース・nx release group の規約」を直す
  - `base/pecot` で実行する記述を消し、`release.yml` を起動することを書く
  - 「環境の既知事項」の base の扱いも合わせて直す
- [x] T070 [P] [US5] `.githooks/README.md` の「配置」と R1・R2・R5 を、stage ごとのディレクトリと manual の stage に合わせる
- [x] T071 [US5] commit の規約の文書に、dependabot の件名の例外を書く。場所は `.githooks/README.md` の規約の節
- [x] T072 [US5] `.githooks/README.md` に、緊急の force push の手順を書く（FR-028）
  - ruleset の enforcement を `disabled` にする `gh api` のコマンドと、`active` に戻すコマンド
  - version plan は要らないこと、押した後の `main` の CI を確かめること
  - Release の添付や npm の配布物に情報が入っていた場合は、この手順の範囲外と書く
- [x] T073 [US5] quickstart の「5. 文書」を確かめる

**Checkpoint**: 文書と役割の表と設定が一致する

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T074 CI の記録から、典型的な 1 プラグインの PR の所要を 3 件分集める
  - SC-005（手元の最大の約 2 分の 2 倍以内）を満たすかを Epic にコメントする
  - 超えるなら、install のキャッシュを別の Issue に起こす
- [ ] T075 `.pre-commit-config.yaml` の actionlint のコメントを直す
  - 「導入は post-create.sh」を、devcontainer の feature で入るという事実に合わせる
  - あわせて `.nx/nx-release/project.json` の `test` の説明（「pre-push の nx-affected-tests が起動する起点」）を直す
- [ ] T076 quickstart.md の全節を通しで確かめ、spec の SC-001〜008 の達成を Epic にまとめる

---

## Dependencies & Execution Order

### Phase Dependencies

```text
Phase 1 (devcontainer) ─┐
Phase 2 (hook の置き場) ─┴→ Phase 3 (US1: ci.yml) → Phase 4 (US3: pre-push からテストを外す)
                                                  └→ Phase 5 (US4: リリース) → Phase 6 (US2: ruleset) → Phase 7 (US2: 自動マージ)
Phase 4・Phase 7 → Phase 8 (US5: 文書) → Phase 9
```

- Phase 1 と Phase 2 は互いに独立で、並べられる
- Phase 4 は Phase 3 の CI が動いてからにする。先に外すと、テストがどこでも動かない期間ができる
- Phase 6 の ruleset は Phase 5 の後にする。先に入れると、手元のリリースが直接 push できずに止まる
- Phase 7 は Phase 6 の ruleset を適用してからにする。必須チェックの無い状態で自動マージを動かさない
- Phase 4 と Phase 5 は、Phase 3 の後なら並べられる

### Within Each Phase

- テストのタスクを先に書き、落ちることを確かめてから実装する
- 管理者の作業（T049・T061・T065）は、PR のマージの前後の指定どおりに行う

### Parallel Opportunities

- Phase 2 の T013〜T016 は別のファイルなので並べられる
- Phase 4 の T034〜T036 も別のファイルなので並べられる
- Phase 5 の T044〜T046 は同じファイルなので 1 つずつ進める。T047 の後の T050 と T053 は並べられる

## Parallel Example: Phase 4

```text
Task: "T034 [US3] ブランドの語の hook を消す"
Task: "T035 [US3] pecot-visual のリリースから語の確認を消す"
Task: "T036 [US3] pecot-tools のリリースから語の確認を消す"
```

## Implementation Strategy

### MVP First

1. Phase 1・Phase 2 を終える
2. Phase 3（US1）を終え、PR に結果が付くことを確かめる
3. ここで止めても、PR の検証は手元の自己申告から、誰でも確かめられる結果に変わる

### Incremental Delivery

1. Phase 4 で、手元の待ち時間を減らす
2. Phase 5 で、リリースをランナーへ移す
3. Phase 6 で `main` の保護を入れ、Phase 7 で自動マージを入れる
4. Phase 8・Phase 9 で、文書と達成の確認をまとめる
