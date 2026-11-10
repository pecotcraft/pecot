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

dependabot の PR の最初の commit の本文から読む（#220 以降）。`dependabot-commit.yml` が PR ごとに動かし、`--pr <N>` で PR 番号を受ける。
PR 番号は引数で受けるので、件名の `(#N)` には頼らない。

| 項目 | 読む場所 | 例 |
|---|---|---|
| 対象の commit | 本文に `updated-dependencies:` だけの行を持つ commit。作者では選ばない | |
| PR 番号 | `--pr` の引数 | `5` |
| directory | 件名の `in /path`、group の PR では本文の `in the /path directory`。どちらも読めなければ `/` とみなす | `/plugins/pecot-tools` |
| 依存名・新しい版・種類 | `updated-dependencies:` の YAML の `dependency-name`・`dependency-version`・`dependency-type`。本文のどこからでも探す | `commander`・`15.0.0`・`direct:production` |
| 古い版 | 本文の `Bumps [x](...) from A to B` か `Updates \`x\` from A to B` | `14.0.3` |

古い版が読めないときは、文面を「名前 → 新しい版」にする。YAML が読めない commit は、エラーにしてリリースを止める。

## 5. 配布物に届くかの判定

group は directory ではなく、その commit の時点の `package.json` と lock で決める。

# 113 で npm の dependabot は root の `/` だけになり、directory は group を示さない。

| 依存の種類 | 判定 |
|---|---|
| direct（npm） | その commit で指定が変わった `package.json` を根拠にする。lock だけが変わったときは、その依存を宣言している `package.json` を探す |
| `indirect`（npm） | root の lock で判定する。group の本番の依存から辿って `<名前>@<新版>` へ届けば、その group で作る。pecot-visual は配布物の依存名に入る devDependencies も起点にする。それ以外の devDependencies からしか届かなければ作らない |
| uv（`/plugins/pecot-workflow/cli`） | その commit で `<directory>/uv.lock` が変わったかで決める。group は pecot-workflow。`indirect` は、その commit の `uv.lock` でプロジェクトの本番の依存から辿って届くときだけ作る。dev からしか届かなければ「開発用」とする。`indirect` があるのに lock を読めないときは、コード 1 で止める |
| github-actions・audit-canary | 作らない。`plugins/pecot-visual/scripts/release/audit-canary/` の宣言は数えない |

direct の依存は、`package.json` の path の前方一致で group を決める。`tests/` を含む path は数えない。

| 宣言の場所 | plan を作る条件 |
|---|---|
| `dependencies`・`optionalDependencies` | 常に作る |
| `plugins/pecot-visual/` の下の `devDependencies` | pecot-visual の配布物の依存名に入るときだけ作る |
| 上記以外の `devDependencies` | 作らない（開発用） |

配布物の依存名は、`dist-manifest.mjs` の `buildDistManifest()` の戻り値のキーから取る。
どの package にも当たらない依存は、plan を作らない。

## 6. 依存の更新の version plan（出力）

| 項目 | 値 |
|---|---|
| ファイル | `.nx/version-plans/<PR 番号>-dependabot-deps.md`。1 PR が 2 つ以上の group に届くときは `<PR 番号>-dependabot-deps-<group>.md` に分ける |
| ファイル名の決め方 | `-<group>` の有無は、範囲で絞る前に、その commit が届く group の数で決める。実行ごとに名前が変わらないようにする |
| frontmatter | `<group>: patch` の 1 行 |
| 本文 | 「依存を更新した（名前 旧版 → 新版、…）。(#N)」の 1 文。100 字を超えるなら数件で切り「ほか N 件」で締める |
| 出す順 | commit の古い順 |
| 件数の行 | 作った件数と、作らなかった件数を理由ごとに 1 行ずつ出す。範囲外で除いた commit は数えない |
| 失敗したとき | 例外で止まるときも、書いた plan を消す |
| 検証 | 作った後に `check-version-plan-format.sh` と `check-text.sh` を通す。通らなければリリースを止める |

本文の末尾に `(#N)` を置くのは、未追跡の plan では nx が commit を引けず、CHANGELOG に PR のリンクが付かない。

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
| 秘密 | 秘密鍵は Environment `release` と `release-plan` の secret `PECOT_BOT_PRIVATE_KEY` に置く。client id は変数 `vars.PECOT_BOT_CLIENT_ID` に置く |
| 置き場所の理由 | Actions の secret に置くと、書き込み権のある人が任意のブランチから contents:write のトークンを作れる。Environment は deployment branch を `main` だけにして防ぐ |
| Dependabot secrets | 自動マージ（Phase 7）の作業として置く。リリースでは使わない |
| ruleset | bypass に `Integration`（App）を `always` で載せる |
| git の作者 | `<app-slug>[bot]` と `<id>+<app-slug>[bot]@users.noreply.github.com` |
