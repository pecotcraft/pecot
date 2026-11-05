# Data Model: PR ごとのテストとリリースを CI で動かす

この Epic のデータは、設定ファイルと commit の本文と version plan のファイルにある。DB は持たない。

## 1. 検証の置き場（役割の表の行）

役割の表は `.githooks/README.md` に置く（FR-016）。1 行が 1 つの検証で、列は次のとおり。

| 列 | 中身 | 例 |
|---|---|---|
| 検証 | hook id か CI の job 名 | `nx-affected-tests` |
| 置き場 | pre-commit / commit-msg / pre-push / manual+CI のどれか 1 つ。スクリプトのディレクトリもこれに合わせる | manual+CI |
| 所要の目安 | `githooks-timing.tsv` か CI の記録から | 平均 24 秒・最大 123 秒 |
| 理由 | その置き場にする理由。二重にするものは二重の理由も書く | 重いので CI に任せる |

整理後の割り当ては次のとおり。

| 検証 | 整理前 | 整理後 | 理由 |
|---|---|---|---|
| `check-forbidden-dirs` などの単機能ガード | pre-commit | pre-commit（CI でも動く） | 秒未満で、commit の前に止めたい |
| `check-text` | pre-commit | pre-commit（CI でも動く） | 同上 |
| `nx-affected-lint` | pre-commit | pre-commit（CI でも動く） | staged に絞れて速く、commit の前に直せる（clarify の決定） |
| `plugin-validate` | pre-commit | pre-commit（CI でも動く） | 対象のファイルのときだけ動き、数秒で済む |
| `check-direct-commit`・`check-commit-text`・gitlint | commit-msg | commit-msg | commit のメッセージは手元でしか見えない |
| `check-text-push` | pre-push | pre-push（CI でも動く） | 0.5 秒 |
| `check-version-plan-required` | pre-push | pre-push と、CI の `version-plan` の job（PR と merge queue だけ） | 0.4 秒。`main` への push では確かめない。dependabot の plan はリリース時に作るので、`main` には無くて正しい |
| `nx-env-inputs` | pre-push | pre-push（CI でも動く） | 0.3 秒 |
| `check-brand-terms` | pre-push | 廃止 | 名前の移行が済んだ |
| `githooks-tests` | pre-push | manual（CI） | テストで、数十秒かかる |
| `nx-affected-tests` | pre-push | manual（CI） | 重い。CI だけが担う |

「CI でも動く」は、CI が pre-commit と pre-push の stage をそのまま実行することを指し、手元と二重になる。どれも秒単位なので、二重を受け入れる。
CI でも動かす理由は、`--no-verify` で手元を飛ばした push を PR で拾うことにある。

スクリプトの置き場は次のとおり（FR-016a）。

| ディレクトリ | 置くもの |
|---|---|
| `.githooks/pre-commit/` | pre-commit の stage の hook |
| `.githooks/commit-msg/` | `check-direct-commit.sh`・`check-commit-text.sh` |
| `.githooks/pre-push/` | `check-text-push.sh`・`check-version-plan-required.sh`・`check-nx-env-inputs.sh` |
| `.githooks/ci/` | manual の stage と CI だけが使うもの（`run-affected-tests.sh`・`run-pr-checks.sh`） |
| `.githooks/lib/` | 共有の `push-range.sh`・`nx-lanes.sh`・`timing.sh`・`text-rules-ready.sh`・`with-timing.sh` |
| `.githooks/tests/` | githooks-tests（pytest）。`run.sh` もここに置く |

弱まる保証（FR-020）は 1 つある。push の時点ではテストが動かないので、落ちるテストを含むブランチも push できる。
そのようなブランチも、PR の必須チェックが `main` へのマージを止める。そのため受け入れる。

## 2. CI の実行の単位

| 名前 | 中身 |
|---|---|
| CI のコンテナ | `.devcontainer/devcontainer.json` から作る。イメージは `ghcr.io/pecotcraft/pecot-devcontainer` |
| 範囲 | base は nx-set-shas が決める。PR では merge-base、`merge_group` では queue の直前の commit、`main` への push では直前に成功した run の commit |
| 結果 | job の成否と Step Summary。Summary に選ばれたレーンと成否を並べる。レーンが 0 件なら「対象なし」と書く |

## 3. 自動マージの条件

| 条件 | 判定のもと |
|---|---|
| PR の作成者が `dependabot[bot]` | `github.event.pull_request.user.login` |
| 更新が minor か patch | fetch-metadata の `update-type`（group の PR では最大の変化） |
| 必須チェックがすべて成功 | ruleset の必須チェック |
| 最新の base に重ねて成功 | merge queue の `merge_group` の検証 |

major を 1 件でも含む group の PR は、自動マージの対象から外れる。

## 4. dependabot の更新の記録（入力）

squash でマージした dependabot の commit の本文から読む。

| 項目 | 読む場所 | 例 |
|---|---|---|
| PR 番号 | 件名の末尾の `(#N)` | `(#5)` |
| directory | 件名の `in /path`、group の PR では本文の `in the /path directory` | `/plugins/pecot-tools` |
| 依存名・新しい版・種類 | `updated-dependencies:` の YAML の `dependency-name`・`dependency-version`・`dependency-type` | `commander`・`15.0.0`・`direct:production` |
| 古い版 | 本文の `Bumps [x](...) from A to B` か `Updates \`x\` from A to B` | `14.0.3` |

古い版が読めないときは、文面を「名前 → 新しい版」にする。YAML が読めない commit は、エラーにしてリリースを止める。

## 5. 配布物に届くかの判定

directory から release group を決め、依存の種類で plan を作るかを決める。

| directory | release group | plan を作る種類 |
|---|---|---|
| `/plugins/pecot-visual` | pecot-visual | `direct:production`・`indirect`。`direct:development` のうち配布物の一覧（`dist-manifest.mjs` の `LINT_DEPS` など）にあるもの |
| `/plugins/pecot-tools` | pecot-tools | `direct:production`・`indirect` |
| `/plugins/pecot-workflow` | pecot-workflow | `direct:production`・`indirect` |
| `/plugins/pecot-workflow/cli`（uv） | pecot-workflow | `direct:production`・`indirect` |
| `/libs/text-rules` | text-rules | `direct:production`・`indirect` |
| `/`（root）・github-actions・audit-canary | なし | 作らない |

`indirect` は lock だけの更新を指す。pecot-visual・pecot-tools は lock から shrinkwrap を作って配るので、配布物に届く。

## 6. 依存の更新の version plan（出力）

| 項目 | 値 |
|---|---|
| ファイル | `.nx/version-plans/<PR 番号>-dependabot-deps.md`。1 PR が 2 つの group に届くときは `<PR 番号>-dependabot-deps-<group>.md` に分ける |
| frontmatter | `<group>: patch` の 1 行 |
| 本文 | 「依存を更新した（名前 旧版 → 新版、…）。」の 1 文。100 字を超えるなら数件で切り「ほか N 件」で締める |
| 検証 | 作った後に `check-version-plan-format.sh` と `check-text.sh` を通す。通らなければリリースを止める |

状態の移り方は次のとおり。

```text
dependabot の PR がマージされる（main に commit が載る。plan はまだ無い）
  → リリースの workflow が起動される
  → plan を作る（作業ツリーだけ）
  → nx release が plan を消費し、CHANGELOG に行を足し、plan の削除ごと release commit にする
```

すでに同じ名前の plan があるときは作らない（人が先に書いた plan を優先する）。

## 7. リリースの actor

| 項目 | 値 |
|---|---|
| 主体 | 専用の GitHub App（名前は quickstart の準備で決める） |
| 秘密 | App の client id と秘密鍵。Actions secrets と Dependabot secrets の両方に置く |
| ruleset | bypass に `Integration`（App）を `always` で載せる |
| git の作者 | `<app-slug>[bot]` と `<id>+<app-slug>[bot]@users.noreply.github.com` |
