# Research: PR ごとのテストとリリースを CI で動かす

調べた日は 2026-11-05 で、出典はリポジトリ（HEAD `2347067`）と GitHub Docs・各 Action のソースとする。

## R1. CI の環境を devcontainer と同じにする方法

Decision: `devcontainers/ci` で `.devcontainer/devcontainer.json` からコンテナを作り、その中で検証を動かす。版は v0.3.1900000450（SHA `513af61f4de4f75d37e4438f184ba4358f0fc1ca`）とする。

- 重い OS パッケージ（LibreOffice・フォント・poppler・shellcheck）と fontconfig の alias を、`.devcontainer/Dockerfile` へ移す
- `devcontainer.json` は `image` を `build.dockerfile` に替える
- イメージは `main` への push（`.devcontainer/**` の変更時と週 1 回）で GHCR に push する。パッケージは public にする
- PR では push せず、GHCR のイメージを `cacheFrom` に使う。`.devcontainer/**` を変えた PR では、キャッシュが外れた層だけをその PR の定義で作り直す。これで FR-004 を満たす
- `post-create.sh` は、`CI=true` のときに git フックの導入と worktree の作成を飛ばす。`setup.sh` と chromium の導入は CI でも動かす

Rationale: features と apt を毎回入れると 5〜10 分かかる見込みとなる。イメージを再利用すれば pull の 1〜2 分に縮む。apt を `postCreateCommand` に置いたままだと、イメージのキャッシュに載らず毎回入れ直す。

Alternatives considered:

| 案 | 採らない理由 |
|---|---|
| ubuntu ランナーに setup-node などで同じ版を入れる | devcontainer の定義と二重管理になり、版のずれが起きる（FR-004 に反する） |
| `@devcontainers/cli` を直接呼ぶ | 版の固定はしやすいが、push の判定とキャッシュを自前で書く。Action で足りる |
| PR ごとに毎回フルビルド | 5〜10 分の上乗せで SC-005 を満たしにくい |

## R2. レーンの選び方と範囲を手元と同じにする

Decision: CI は pre-commit の設定をそのまま使う。呼び方は `pre-commit run --hook-stage <stage> --from-ref <base> --to-ref <head>` とする。

- `nx-affected-tests` と `githooks-tests` の stage を `pre-push` から `manual` に替える。CI と、手で確かめたい開発者は `--hook-stage manual` で呼ぶ（FR-017・FR-019）
- 範囲の base は `nrwl/nx-set-shas` で求めた merge-base とする。版は v5.1.0（SHA `e602fada7ad5987b0f7b1905e7a99ea1c661514c`）
- base を `PECOT_VERSION_PLAN_BASE` に、PR の head を `PRE_COMMIT_TO_REF` に渡す
- 同じ環境変数で動くスクリプトは 3 本ある（`run-affected-tests.sh`・`check-version-plan-required.sh`・`check-text-push.sh`）
- checkout は `fetch-depth: 0` にする
- lint は `nx-affected-lint` を pre-commit の stage で `--from-ref/--to-ref` により PR の変更ファイル全部に掛ける

Rationale: レーンの列挙（`lib/nx-lanes.sh`）と範囲（`lib/push-range.sh`）を手元と共有できる。CI 用に別の呼び出しを書くと、2 つが食い違う（FR-002・FR-003）。

Alternatives considered: CI で `nx affected` を直に呼ぶ案は採らない。レーン名の列挙と fallback の規則を workflow へ写すことになる。

## R3. CI でのタスクキャッシュ

Decision: CI の tests の job は、同じ PR の run の間でだけ nx のタスクキャッシュを受け渡す。job 内で nx のリモートキャッシュのサーバ（`.githooks/ci/nx-cache-server.mjs`）を動かす。
置き場 `.pecot/tmp/ci/nx-remote` は、artifact `nx-cache-tests-{slug}` で渡す。
取り込むのは、同じ repo の同じ PR の成功した run の artifact だけにする。

Rationale: 宣言していない入力の変化を取りこぼさないため、共有の範囲を同じ PR に絞る。
取りこぼしていた root の `pnpm-lock.yaml` は `.nxignore` で file map から外れる。
これとイメージは、`runtime` 入力（`git hash-object`・`dpkg-query`）で hash に入れる。

- 同じ repo の PR（書き込み権限者・dependabot）は許容する。
  書き込み権限者は、main へ変更を入れられる信頼の範囲にいる。取り込み元は同じ PR に限る
- fork の PR は、キャッシュを上げず、取り込まない。信頼できない変更の結果は、キャッシュに残さない
- dependabot の PR の install で、依存の lifecycle スクリプトは動かない。`pnpm-workspace.yaml` の `permissions` で build を明示した依存だけが対象で、`build: true` は現在ない。宣言のない build は `ERR_PNPM_IGNORED_BUILDS` で止まる

Alternatives considered:

| 案 | 採らない理由 |
|---|---|
| `actions/cache` で `~/.nx` を共有する | `merge_group` の run は、PR の merge ref の cache を読めない sibling になる。ブランチをまたぐ共有は CREEP（CVE-2025-36852）の型で、信頼境界の外の cache を取り込む |
| キャッシュを使わない（`NX_SKIP_NX_CACHE=true`） | 同じ PR の再実行に限れば、取りこぼしの危険を増やさずに所要を減らせる |

## R4. 自動マージと「最新の base で検証」

Decision: `main` の ruleset で merge queue を有効にする。dependabot の minor・patch の PR は、GitHub App のトークンで `gh pr merge --auto --squash` を呼んで queue に入れる。

- 必須チェックの workflow は `pull_request` と `merge_group` の両方で動かす
- 判定は `dependabot/fetch-metadata`（v3.1.0、SHA `25dd0e34f4fe68f24cc83900b1fe3fe149efef98`）の `update-type` を使う。group の PR では PR 内の最大の変化が返る。major を含む group は対象外になる
- GITHUB_TOKEN では merge queue に入れられないので、App のトークンを使う。dependabot が起動した workflow で使える secret は Dependabot secrets だけなので、App の鍵は Dependabot secrets にも登録する

Rationale: Strict（branches up to date）にすると、dependabot は base の遅れだけでは rebase しない。そのため、1 件目のマージで残りの PR が止まる。merge queue は最新の base に重ねて検証してからマージする（FR-013）。

Alternatives considered:

| 案 | 採らない理由 |
|---|---|
| Strict の必須チェック | 上の理由で dependabot の PR が溜まる |
| `pull_request_target` で動かす | 公式が必要時以外は避けるよう勧めている。`pull_request` で足りる |

## R5. dependabot の更新の version plan

Decision: リリースの workflow が、`nx release` の前に dependabot の commit から version plan を作る（clarify の決定）。

- 対象は、release group の前回の tag から `HEAD` までの commit のうち、author が `dependabot[bot]` のもの
- squash の commit 本文には dependabot の記録が残る。#5 の commit（`ab704e0`）で確かめた
- 記録は `updated-dependencies:` の YAML と、`Bumps ... from A to B`・`Updates \`x\` from A to B` の行である
- 配布物に届くかは、release group と依存の種類で決める（data-model の「届く判定」）
- 作る plan のファイル名は `<PR 番号>-dependabot-deps.md` である。`check-version-plan-format.sh` の Rule 0（数字で始まる kebab-case）に合う
- 生成する処理は `.nx/nx-release/src/` に置き、既存の `nx-release:test-unit`（`node --test`）でテストする

Rationale: PR ブランチに CI が commit を積むと、`fetch-metadata` は head commit の author が dependabot でないので空を返す。dependabot もその PR の rebase をやめる。`main` に積むと、平常時に直接 push する主体が増える。

Alternatives considered: clarify で示した 3 案のうち、残り 2 案（main へ足す・PR に積む）は上の理由で採らない。

## R6. リリースの actor と ruleset の bypass

Decision: 専用の GitHub App を作り、ruleset の bypass（`bypass_mode: always`）に載せる。
workflow では `actions/create-github-app-token` で installation token を出す。版は v3.3.0（SHA `64ab729a6294000f5aa4a4bc0b73d1f32bc45510`）とする。

App の権限は次のとおり。

| 権限 | 使う場面 |
|---|---|
| Contents: write | release commit・tag・CHANGELOG の push と GitHub Release の作成 |
| Pull requests: write | dependabot の PR を merge queue に入れる |
| Actions: write | `publish-npm.yml` を `gh workflow run` で起動する |
| Dependabot alerts: read | `pecot release preflight` と `security-alerts.yml` が open の alert を読む |
| Code scanning alerts: read | 同上 |
| Secret scanning alerts: read | 同上 |
| Issues: write | `security-alerts.yml` が alert の Issue を作り、閉じる |
| Organization の Projects: read and write | `security-alerts.yml` が alert の Issue をボードに載せ、フィールドを設定する |
| Metadata: read | 必須（自動で付く） |

Rationale: ruleset の bypass に GitHub Actions（GITHUB_TOKEN）は載せられない。GITHUB_TOKEN で push しても後続の workflow は起動しない。

Alternatives considered: 個人の PAT は、持ち主の離脱で止まり、権限も広いので採らない。

## R7. リリースをランナーで動かす

Decision: `release.yml` を `workflow_dispatch` で置き、devcontainer の中で今の w-release の手順を動かす。

- job は 2 つに分ける。`plan` は dry-run と preflight を動かして、bump と CHANGELOG の案を Step Summary に出す。`release` は Environment `release`（必須レビュアー＝リリース担当者）の承認の後に本実行する。今の手順の「人が dry-run を見て承認する」を Environment の承認に置き換える
- `checkout` は `persist-credentials: false` にする。コンテナの中で `GH_TOKEN`（App のトークン）を使って `gh auth setup-git` を実行し、git の作者を `<app-slug>[bot]` にする
- `nx release --yes` の push は `--atomic` である。途中で `main` が進めば non-fast-forward で失敗する（FR-026）
- release commit の pre-commit フックは、CI のコンテナに入れないので動かない。中身は PR の CI で検証済みである
- `attach-mcp-tgz.sh` の `gh workflow run publish-npm.yml` は App のトークンで起動する。`publish-npm.yml` は最上位の workflow として動くので、trusted publishing の主体は今と変わらない
- concurrency は `release` で 1 本に絞り、`cancel-in-progress: false` にする

Rationale: 手順と成果物を今と同じに保つ（FR-025）。承認の場所が端末から Environment に移るだけにする。

Alternatives considered: `--skip-publish` で release を作り、tag の push で publish を起動する案は採らない。tgz の添付が publish の段にあるので崩れる。group が 4 つあり、tag が 3 つを超えると tag の push で workflow が起動しない制約もある。

## R8. ブランドの語の確認の廃止

Decision: 次を消す。

| 対象 | 場所 |
|---|---|
| hook 本体とテスト | `.githooks/pre-commit/check-brand-terms.sh`、`tests/test_check_brand_terms.py` |
| hook の配線とそのテスト | `.pre-commit-config.yaml` の `check-brand-terms`、`test_pre_commit_config_wiring.py` の該当 assert |
| リリースの確認 | `audit-mcp-dist.sh` の一覧の確認、両プラグインの `publish-mcp-dist.sh` の 2 か所ずつ |
| リリースのテスト | `audit-mcp-dist.test.sh`・両 `publish-mcp-dist.test.sh`・両 `npm-cache-opt-in.test.sh` の一覧の export と該当ケース |
| 文書 | CLAUDE.md の「ブランドの語の確認」節、`attach-mcp-tgz.sh` のコメント |

Rationale: 名前の移行は済んでいる（clarify の決定）。

## R9. 所要の見積もり

| 区間 | 見積もり | 根拠 |
|---|---|---|
| 手元の pre-push（整理後） | 2 秒前後 | `check-text-push` 0.5 秒・`check-version-plan-required` 0.4 秒・`nx-env-inputs` 0.3 秒（`githooks-timing.tsv` の記録） |
| CI のイメージの取得 | 1〜2 分 | GHCR からの pull（推測） |
| CI の install（`setup.sh` と chromium） | 2〜4 分 | 手元の post-create の実績から推測 |
| CI の affected のテスト | 0.5〜2 分 | 手元の `nx-affected-tests` の平均 24 秒・最大 123 秒 |

SC-005 は、手元の最大（約 2 分）の 2 倍以内を目指す。install を含めると超えうる。超えたときは R3 のキャッシュと、install のキャッシュを検討する。所要は実装の後に CI の記録で確かめる。
