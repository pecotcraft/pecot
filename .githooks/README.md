# .githooks/

## 配置

- root 共通 (リポ全体に適用される) フックは、動く stage ごとのディレクトリに置く
  - `.githooks/pre-commit/` : pre-commit stage の hook
  - `.githooks/commit-msg/` : commit-msg stage の hook
  - `.githooks/pre-push/` : pre-push stage の hook
  - `.githooks/ci/` : CI と共有する実行スクリプト（`run-affected-tests.sh`。stage は今のところ pre-push）
  - `.githooks/lib/` : hook が `source` する共有スクリプトと、所要を記録する `with-timing.sh`
  - `.githooks/tests/` : 上の hook と lib のテスト
  - 例外は、`pre-commit/check-brand-terms.sh`（pre-push で動く）と `ci/run-affected-tests.sh`（pre-push で動く）の 2 件。
    `tests/test_pre_commit_config_wiring.py` が、置き場のディレクトリと `stages:` の一致を確かめる
- プラグイン固有 CI : `plugins/<plugin>/scripts/ci/run-{lint,tests}.sh`

最新の hook 一覧は `.pre-commit-config.yaml` を参照する (本 README には書かない)。

## 規約

### R1. CI スクリプトの dispatch 単位 = プラグイン (固定深さ)

**CI スクリプトの配置単位 = `plugins/<name>/`** (リポジトリ直下から見て 2 階層固定)。

- `plugins/pecot-workflow/`
- `plugins/pecot-visual/`

skill レベルの `scripts/ci/` は持たない。プラグイン直下の dispatcher が内部 skill の build / lint / test を呼び出す。

> [!NOTE]
> lint / test の発火はプラグイン単位ではなく、root 共通フック各 1 本が
> `nx affected` で各 `project.json` の lint / test target を dispatch する。
> プラグイン単位の `<plugin>-run-lint` / `<plugin>-run-tests` hook は廃止した。
>
> - lint（pre-commit）は、`nx-affected-lint` が staged 変更ファイルを
>   `nx affected -t <lint レーン名の列挙> --files=<csv>` に渡す。push range の解決は不要である。
> - test（pre-push）は、`nx-affected-tests` が `nx affected -t <test レーン名の列挙>` を
>   push range（merge-base..tip）で実行する。
>   - base/head 解決は version-plan gate（`check-version-plan-required.sh`）と同一の共有 lib
>     （`lib/push-range.sh`）を使い、両チェックが同じ範囲判定を構造的に共有する。
>   - nx の出力は `.pecot/tmp/pre-push/nx-affected-tests.log` に残る。
>     実行中の進行確認は `tail -f` で行い、失敗時は端末に失敗レーンの出力と nx の要約が出る。
>   - 成功時は、合計秒・最長 test task・並列度・レーン数の 1 行が端末に出る。
>     先頭は `nx affected tests:` で、run-many の予備手段を使った push は `nx run-many tests:` になる。
>     pre-commit の `verbose` により、その前に `- hook id:` / `- duration:` の 2 行が出る。
>   - 「最長」は test task 単体の秒で、dependsOn の install / build は含まない。
> - レーン名の列挙 (#1232) では、`-t` に起点の `test` / `lint`（nx:noop）ではなく、レーンの target 名をカンマ区切りで渡す。
>   - nx 24 のタスク単位 affected は、変更が届いた「要求 target のタスク」だけを選び、その依存を実行対象に足す。
>     起点を要求すると、起点自身が project 全体を入力にして全レーンを連れてくる。
>   - レーン名は実行のたびに `nx graph --file` の JSON から集める（`lib/nx-lanes.sh`）。
>     名前が test は `^test(-|$)`、lint は `^lint(-|$)` に当たり、executor が `nx:noop`（起点）でも
>     `nx:run-script`（package.json の scripts 由来）でもない target が対象になる。
>     そのため、レーンを project.json に足してもフックは直さない。
>   - graph が取れない、またはレーンが 1 つも無いときは ERROR で止める（空の `-t` で nx を起動しない）。
>   - graph の計算は 1 回約 0.3 秒である。全 project のフォールバック（`run-many -t test`）は起点を要求する。
>   - 起点の inputs は `nx.json` の `nx:noop` で空にしてある。
>     pecot-visual の起点 `lint` が lint-* と同じ列挙に入っても、全レーンを連れてこないためである。
> - 所要の記録は、自前 hook の所要を `.pecot/tmp/githooks-timing.tsv` に追記する。
>   - 列は時刻 / 種別 / 名前 / 秒 / 補足である。
>   - 種別 `hook` は hook 起動 1 回、`task` は nx task 1 件、`nx` は nx 起動 1 回につき 1 行になる。
>   - `nx-affected-lint` がバッチ分割されたときは、同名の `hook` 行が複数並ぶ。
>   - `nx` 行の `longest` は、その回で最長の test task 名である。
> - タスクキャッシュ (#1225) では、test / lint target は `cache: true` である。
>   - 入力が変わらず前回成功したレーンは再実行されず、`local-cache` になる。
>     outputs の無い target では `local-cache-kept-existing` になる。失敗は保存されない。
>   - キャッシュ本体と索引 db の置き場は、nx 24 で `~/.nx/<id>/{cache,databases}` になった。
>     `<id>` は repo の識別子の sha256 から決めた 16 桁である。
>     識別子は origin の domain/slug で、remote が無ければ最初の commit の SHA を使う。
>   - 同じ remote の worktree は共有し、nx 22 の worktree（repo の `.nx/cache`）とは共有しない。
>     `nx reset` は全 worktree の共有キャッシュを消す。
>   - 実 nx を一時リポで動かすテストは、`NX_CACHE_DIRECTORY` / `NX_WORKSPACE_DATA_DIRECTORY` を
>     テストごとの一時ディレクトリへ向けて、`~/.nx` を汚さない。
>   - 入力は、`nx.json` の namedInput `runtime`（`node --version`、レーン固有に `uv` / `aws`）、
>     `env`（結果に影響する環境変数）、各 Globals・project.json の file 入力である。
>   - 宣言していない入力の変更は検知されない。
>     レーンが読む環境変数は、`test_nx_env_inputs.py` が走査して `env` か理由つきの対象外に載っていることを要求する。
>     リポ内ファイルの宣言の抜けは、strace で棚卸しする。
>   - build・install・chromium-preflight と、レーンを束ねる起点（nx:noop）は `cache: false` である。
>   - リリース系 test は外部レジストリの状態を入力に表せない。
>     その変化はリリース時の dry-run と監査で拾う前提で、キャッシュする。
>     `PECOT_RELEASE_TEST_NPM_CACHE` で依存解決の npm キャッシュも永続化する。
>     置き場 `.pecot/tmp/release-npm-cache/<plugin>` は増え続けるので、不要なら消す。
>
> 1 プラグイン = 1 nx project（`pecot-workflow` / `pecot-visual` / `pecot-tools`）で、release group にも
> その project を 1 つずつ入れる。
> `test` target はレーン（`test-*`）を dependsOn で束ねる `nx:noop` の起点である。
> affected な project のレーンのうち、入力の変わったものだけがキャッシュを外れて実行される。
> install・build は毎回実行する。
> lint は pecot-visual と pecot-workflow が `lint-*` のレーンに分かれ、pecot-tools は `lint` 1 つである。
> version-plan gate は affected ではなく、変更ファイルが属する project で release group を決める。
> project の割り当ては `nx release plan:check` と同じ持ち主の割り当てで、ignore の除外はしない。
> その group の宣言がブランチで足した version plan にあるかを見る。
> path 正規表現で発火する plugin 関連 hook は、`check-engines-node-drift` 等の単機能チェックのみである。
>
> `.nx/nx-release/`（release の versionActions）は plugin 外の nx project `nx-release` で、
> test レーン（`test-unit`）だけを持つ。
> 依存する nx 本体（root package.json）と各 plugin-root の project.json / plugin.json を `inputs` に宣言しており、
> これらの変更でも affected になる。
>
> `libs/<name>/`（現在は `libs/text-rules`）は plugin ではないライブラリの nx project で、release group にも
> その project を入れる。レーンは `test-unit`、lint は `lint` 1 つである。

### R2. CI スクリプトのペア必須

各プラグインに **2 ファイル両方** を持たせる。次の配置とする。

```
plugins/<plugin>/scripts/ci/run-lint.sh    # nx lint target の被呼び出し側, 必須
plugins/<plugin>/scripts/ci/run-tests.sh   # nx test target の被呼び出し側, 必須
```

どちらも **pre-commit hook から直接発火しない**。`<plugin>-run-lint` / `<plugin>-run-tests` hook は廃止した。
発火は root 共通フック `nx-affected-lint`（pre-commit）/ `nx-affected-tests`（pre-push）が行う。
このフックは `nx affected -t <レーン名の列挙>` で各 `project.json` の target を起動する。
target がプラグインの `run-{lint,tests}.sh` を呼ぶ。
2 本は被呼び出し側スクリプトとして存続する。
ペア必須（lint と test の 2 ファイル）と下記の責務排他は不変。

責務境界 (固定):

| ファイル | 含めるもの | 含めないもの |
|---|---|---|
| `run-lint.sh` | lint / format check (サブパッケージにも dispatch) | test / build (重ければ) |
| `run-tests.sh` | test / 型チェック / build / 統合検証 (サブパッケージにも dispatch) | **lint (pre-commit で実行済みの前提、保険でも入れない)** |

pre-commit と pre-push の責務はそれぞれ排他に固定する。`run-tests.sh` で保険 lint を入れたり、`run-lint.sh` で test を呼んだりしない。

plugin 内のサブパッケージが複雑な build / test を持つ場合、plugin 側 dispatcher が `cd <サブパッケージ dir>/` する。
その後で、そのサブパッケージの npm scripts を呼ぶ。
例は `(cd "$PECOTV_PLUGIN_ROOT" && $PNPM --filter @pecot/slidev-assets-dev run lint)`。

### R3. CI スクリプトの先頭定型 (固定)

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."   # プラグインルート (= plugins/<plugin>/)
```

shebang と `set -euo pipefail` も規約。`#!/bin/bash` + `set -e` への揺れは認めない。

### R4. hook id (機械的派生)

lint / test とも root 共通フックに一本化した。このフックには `<plugin>` を付けず、R7 の対象。
そのため、プラグイン単位の `<plugin>-run-{lint,tests}` hook は持たない。
プラグイン名を冠する hook は、`check-engines-node-drift` 等の単機能チェック（R7 の命名規約外）のみ。

### R5. `.pre-commit-config.yaml` のエントリ (固定テンプレ)

lint / test は root 共通フック各 1 本に一本化する。次のとおり。

```yaml
- id: nx-affected-lint
  name: nx affected lint
  entry: .githooks/lib/with-timing.sh nx-affected-lint .githooks/pre-commit/run-affected-lint.sh
  language: unsupported_script
  require_serial: true
  stages: [pre-commit]

- id: nx-affected-tests
  name: nx affected tests
  entry: .githooks/lib/with-timing.sh nx-affected-tests .githooks/ci/run-affected-tests.sh
  language: unsupported_script
  pass_filenames: false
  always_run: true
  verbose: true
  stages: [pre-push]
```

自前 hook の `entry` は `with-timing.sh <hook id>` で包み、所要を記録する。
`verbose: true` は成功 push の 1 行を端末へ出すため `nx-affected-tests` だけに付ける。

トップレベルの `default_stages: [pre-commit]` により、`stages` を明示しない hook
（外部リポの標準 hook）は pre-commit stage だけで動く。

`files:` は付けない（path 正規表現の並行判定系を再導入しない）。
範囲の決定は `nx affected` の project graph に一本化する。
`nx.json`・ルート package.json 等の設定変更が plugin に波及するケースも取りこぼさない。
lint は pass_filenames（既定）で staged ファイルを受けて `--files=<csv>` に渡す。
`require_serial: true` は、バッチ分割時の nx 並列起動（pnpm install 競合）を防ぐ。
test は `always_run` + push range で評価する。

`nx.json` の `pecot(v)PluginGlobals` は、lock / manifest / CI スクリプトを affected に乗せる。
lint / test に分割して、各 target の `inputs` で宣言する。
build target は hook から単独で起動されないため、PluginGlobals は宣言しない（lint / test のみ）。

### R6. `repo: local` 内の並び順 (固定)

1. root 共通 hook (`check-*` / `githooks-tests` / `nx-affected-{lint,tests}`) — 既存順を
   保持。pre-push は version-plan gate（軽）→ `githooks-tests`（中）→
   `nx-affected-tests`（重）の fail-fast 順
2. plugin 関連の単機能チェック hook（`check-engines-node-drift` 等）を続ける

### R7. root 共通フック / 外部 hook (対象外)

- `.githooks/{pre-commit,commit-msg,pre-push,ci}/` のプラグイン非依存フックは命名・配置とも本規約の対象外。`<plugin>` を付けない。
- `repo: https://...` の外部 hook (`ruff-pre-commit`, `markdownlint-cli2`, `gitlint`) も対象外。
  - 外部 `ruff-pre-commit` はリポ全体に適用されるため、`run-lint.sh`（`nx-affected-lint` 経由）内の ruff と二重に動く。
    これは許容する。前者はリポ全体、後者はプラグイン専用 lint で、見ていない領域を補う。
- `.githooks/gitlint/**/*.py` は `githooks-lint` hook の対象。
  この hook は `.githooks/scripts/run-lint.sh` 経由で pyright --strict を実行する。
  `build/` 等の自動生成・未追跡ファイルは対象外。

### R8. lock ファイル運用

`uv.lock` / `package-lock.json` は **すべて git 管理対象**。依存追加・更新時は lock ファイルも同一コミットに含める。`npm ci` / `uv sync --locked` の決定性を保証するため、lock のずれを残したコミットは作らない。

### R9. dispatcher の skill 拡張余地

現状 `plugins/pecot-visual/scripts/ci/run-{lint,tests}.sh` は v-slidev 1 つだけを subshell で呼ぶ。
将来 skill が増えた場合は、dispatcher 内で次の形式に拡張するか、内部で skill 一覧を明示列挙する形を取る。

```bash
for skill in skills/*/; do (cd "$skill" && npm ...); done
```

プラグイン内部の構造は dispatcher
責任で、規約は変えない (= `run-{lint,tests}.sh` が nx target の被呼び出し側である構造のまま)。
