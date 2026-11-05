# Implementation Plan: PR ごとのテストとリリースを CI で動かし、ローカルフックと CI の役割を分け直す

**Branch**: `019-ci-pr-tests` | **Date**: 2026-11-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/019-ci-pr-tests/spec.md`

## Summary

PR ごとの検証を GitHub Actions に移す。検証は devcontainer と同じ定義から作ったコンテナで動かし、pre-commit の設定と既存のスクリプトをそのまま呼ぶ。
手元の pre-push からは重いテストを外し、`manual` の stage にして CI と手動で動かす。
dependabot の minor・patch の PR は、GitHub App のトークンで merge queue に入れて自動でマージする。
リリースは `workflow_dispatch` の workflow に移す。Environment の承認の後に、App を actor として `main` へ push する。
dependabot の更新の version plan は、リリースの workflow が commit の本文から作る。ブランドの語の確認は廃止する。

## Technical Context

**Language/Version**: Bash（hook と CI スクリプト）、Node.js 24.22.1（nx release のスクリプト）、GitHub Actions の YAML

**Primary Dependencies**: nx 24、pre-commit 4.4 以上と、次の Action（版と SHA は [research.md](research.md)）

- `devcontainers/ci`・`nrwl/nx-set-shas`・`dependabot/fetch-metadata`
- `actions/create-github-app-token`・`actions/checkout`

**Storage**: なし（設定ファイル・commit の本文・version plan のファイル）

**Testing**: githooks-tests（pytest）、`nx-release:test-unit`（`node --test`）、各プラグインの `test-release`、actionlint

**Type check / Lint**: `nx-release` に `typecheck`（`tsc --noEmit --checkJs --strict`）と `lint`（eslint）のレーンを足す。対象は `src/` で、既存の `version-actions.js` も含める（憲法 III）

**Target Platform**: GitHub Actions の `ubuntu-latest` の上の devcontainer（ubuntu 26.04）

**Project Type**: monorepo の開発基盤（フック・CI・リリース）

**Performance Goals**: 手元の pre-push は 5 秒以内（SC-004）。PR の結果は手元の最大（約 2 分）の 2 倍以内（SC-005、research の R9）

**Constraints**: 検証は秘密を使わない。`main` に直接 push できるのはリリースの App だけ。配布物（スキル）の変更は w-release に限る

**Scale/Scope**: workflow 4 本、ruleset 1 つ、スクリプト 1 本の追加。hook 3 本の stage 変更と廃止、文書 3 か所（CLAUDE.md・`.githooks/README.md`・w-release）

## Constitution Check

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. DDD | 守る | 新しいコードは `dependabot-plans.js` だけ。読む・判定する・書くを関数で分け、git と fs の呼び出しを外側に置く |
| II. TDD | 守る | `dependabot-plans.js` は contracts のテスト観点を先に書く。hook の stage 変更とブランドの語の廃止は、wiring テストを先に直す。workflow は quickstart の確かめ方で検証する |
| III. コード品質 | 強める | 自動の検証が PR の必須チェックになる。`nx-release` に型の確認と lint のレーンを足す。`nx release` の push の `--no-verify` は III の除外に当たり、中身は PR の検証を通っている |
| IV. シンプルさ | 守る | CI は pre-commit の設定を呼ぶだけで、hook の中身を写さない。CI のタスクキャッシュは入れない（R3） |
| V. 本体実装優先 | 守る | 成果物の大半は本体（`.githooks/`・`.github/`・`.devcontainer/`・`plugins/`）の変更で、`specs/` は新規の一式だけ |

原則への違反は無い。Phase 1 の後に見直しても変わらない。

## Project Structure

### Documentation (this feature)

```text
specs/019-ci-pr-tests/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── workflows.md
│   └── dependabot-plans.md
└── tasks.md            # /speckit-tasks で作る
```

### Source Code (repository root)

```text
.devcontainer/
├── Dockerfile                      # 新規。apt のパッケージと fontconfig の alias
├── devcontainer.json               # image → build.dockerfile
└── scripts/post-create.sh          # apt を Dockerfile へ移す。CI=true でフックと worktree を飛ばす
.github/
├── workflows/
│   ├── ci.yml                      # 新規。PR と merge_group の検証
│   ├── devcontainer-image.yml      # 新規。GHCR のイメージの更新
│   ├── dependabot-auto-merge.yml   # 新規
│   ├── release.yml                 # 新規
│   └── publish-npm.yml             # 変えない
├── rulesets/main.json              # 新規
└── dependabot.yml                  # 変えない
.githooks/                          # stage ごとのディレクトリに分ける（FR-016a）
├── pre-commit/                     # pre-commit の stage の hook だけを残す。check-brand-terms.sh は削除
├── commit-msg/                     # 新規。check-direct-commit.sh・check-commit-text.sh を移す
├── pre-push/                       # 新規。check-text-push.sh・check-version-plan-required.sh・check-nx-env-inputs.sh を移す
├── ci/                             # 新規。run-affected-tests.sh を移し、run-pr-checks.sh を足す
├── lib/                            # pre-commit/lib と with-timing.sh を移す
├── tests/                          # pre-commit/tests を移す。wiring テストにディレクトリと stage の一致を足す
└── README.md                       # 役割の表
.pre-commit-config.yaml             # nx-affected-tests・githooks-tests を manual へ、check-brand-terms を削除
.nx/nx-release/
├── tsconfig.json                   # 新規。checkJs と strict
├── eslint.config.js                # 新規
├── src/dependabot-plans.js         # 新規。`// @ts-check` と JSDoc の型
└── tests/dependabot-plans.test.js  # 新規
plugins/pecot-visual/scripts/release/  # audit・publish の語の確認を削除、テストも
plugins/pecot-tools/scripts/release/   # publish の語の確認を削除、テストも
plugins/pecot-workflow/skills/w-release/  # SKILL.md と references を workflow の起動手順へ
CLAUDE.md
```

**Structure Decision**: hook のスクリプトは stage ごとのディレクトリに置く。CI だけが使うスクリプトは `.githooks/ci/` に置き、hook と同じテスト（githooks-tests）の対象にする。

移すと、パスを書いた次の箇所も直す。pecot-workflow・pecot-visual・pecot-tools の変更になるので、Phase 3 には 3 group の version plan を足す。

- `.pre-commit-config.yaml`・`.markdownlint-cli2.jsonc`・CLAUDE.md・`.githooks/README.md`
- 各プラグインの `project.json`、`bin/pecotv`・`bin/pecot-tools`
- `audit-mcp-dist.sh`・両 `publish-mcp-dist.sh` とそのテスト、`python-version.sh`
- pecot-workflow の `nx-scope.ts`・`auth.ts`・`nx_scope.py` とそのテスト、`project-root.sh`・`test_entry_point_linter.py`
- 両プラグインの `node-runtime.test.ts`

## Phases（tasks の下書き）

前の phase が `main` に入ってから次へ進む。順序の理由は、検証の空白を作らないことにある。CI がテストを担う前に pre-push からテストを外さない。

| Phase | 中身 | 関わる US・FR | 終わりの確かめ方 |
|---|---|---|---|
| 1 | devcontainer の Dockerfile 化、`post-create.sh` の CI 分岐、`devcontainer-image.yml` | US1・FR-004 | 作り直した devcontainer で全テストが通る。GHCR にイメージが載る |
| 2 | hook のスクリプトを stage ごとのディレクトリへ移す（中身は変えない） | US3・FR-016a | 全テストが通る。wiring テストがディレクトリと stage の一致を確かめる |
| 3 | `ci.yml` と `.githooks/ci/run-pr-checks.sh`。Summary の書式 | US1・FR-001〜010・FR-029 | quickstart の 1 |
| 4 | テストを manual へ移す、ブランドの語の廃止、役割の表 | US3・FR-016〜020・FR-018a | quickstart の 2 |
| 5 | `nx-release` の型の確認と lint、`dependabot-plans.js`、App・Environment・`release.yml`、w-release | US4・FR-015a・015b・FR-023〜027・FR-030 | quickstart の 4 の 1〜4 |
| 6 | version plan の author による判定、`version-plan` の job、`merge_group`、ruleset の適用 | US2・FR-013〜015・FR-024 | quickstart の 4 の 5 |
| 7 | dependabot の件名の例外、自動マージの workflow | US2・FR-011・012・014 | quickstart の 3 |
| 8 | CLAUDE.md と `.githooks/README.md`、緊急の force push の手順 | US5・FR-021・022・028 | quickstart の 5 |
| 9 | 所要の確認、SC のまとめ | SC-001〜008 | Epic へのまとめ |

Phase 5 の後、Phase 6 の ruleset を入れるまでは、手元のリリースも動く。切り替えの期間はこの 2 phase の間だけにする。
自動マージ（Phase 7）は ruleset（Phase 6）の適用を確かめてから入れる。必須チェックの無い状態で、自動マージを動かさない。

## Complexity Tracking

違反は無いので空にする。
