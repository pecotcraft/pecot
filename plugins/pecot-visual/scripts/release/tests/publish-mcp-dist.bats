#!/usr/bin/env bats
# publish-mcp-dist.sh（pecot-visual MCP サーバの tgz 作成と Release への添付）の検証 (#982)。gh は偽物に差し替え、GitHub と registry へ書き込まない。
# 前提は cli・eslint プラグイン・text-rules の build 済みの dist。重い dry-run と本実行は setup_file で 1 回だけ動かし、@test はその出力を確かめる。

bats_require_minimum_version 1.5.0

RELEASE_DIR="$(cd "$BATS_TEST_DIRNAME/.." && pwd -P)"
REPO_ROOT="$(cd "$RELEASE_DIR/../../../.." && pwd -P)"
PECOTV_ROOT="$REPO_ROOT/plugins/pecot-visual"
RUNTIME_SOURCE="$PECOTV_ROOT/assets/slidev/runtime"
# lint の同値性（セクション 6）で talk-dir が参照するテーマ。宣言つきの固定のテーマを複製し、lint の rule だけ差し替える。
FIXTURE_THEME_SOURCE="$PECOTV_ROOT/cli/tests/fixtures/themes/with-declaration"
FIXTURE_THEME_NAME="slidev-theme-pecotv-test-declared"
ESLINT_SOURCE="$PECOTV_ROOT/assets/slidev/scripts/eslint"
ESLINT_PKGS="_shared slidev-pages-lint text-constraints validate-references"
DECK_LINT_SOURCE="$PECOTV_ROOT/assets/slidev/deck-lint.env.config.js"
TEXT_RULES_DIST="$REPO_ROOT/libs/text-rules/dist"
PUBLISH="$RELEASE_DIR/publish-mcp-dist.sh"
FINGERPRINT="$RELEASE_DIR/dist-fingerprint.mjs"

# PECOTV_AUDIT_RECORD の渡し忘れで本体の記録に触れていないことを、teardown_file で由来の印だけを見て確かめる。
REAL_RECORD_FILE="$REPO_ROOT/.nx/release-audit/pecotv-audit.json"
# 本テストが書く記録に載せる由来の印。実監査の registry と決して一致しない値（RFC 2606 の .invalid）。
TEST_REGISTRY="http://pecotv-release-test.invalid/"
# 指紋の突合より前に止まるケース（存在・skipped・HEAD・severity）で使う置き場所。
DUMMY_FP="0000000000000000000000000000000000000000000000000000000000000000"
UNRELATED_SHA="1111111111111111111111111111111111111111"
# 作業ツリーの catalog.vite だけを HEAD と違う値にする。publish が作業ツリーの側を読む誤りを拾う。
WORKTREE_VITE="^0.0.0-worktree"
TEST_OWNER_REPO="test-owner/test-repo"

# setup_file が作り、@test が読むもの。@test はここへ書き込まない。
SF="$BATS_FILE_TMPDIR"
DIST="$SF/dist"
TEST_REPO="$SF/repo"
TEST_PECOTV="$TEST_REPO/plugins/pecot-visual"
TAGGED_PUBLISH="$TEST_PECOTV/scripts/release/publish-mcp-dist.sh"
DIST_ESLINT="$DIST/assets/slidev/scripts/eslint"
DIST_RUNTIME="$DIST/assets/slidev/runtime"
FIXTURE_THEME="$SF/lint-theme/$FIXTURE_THEME_NAME"
LINT_DIR="$SF/lint"
TEXT_DIR="$SF/lint-text"
SMOKE_FIXTURE="$SF/icon-resolvable.drawio"
EMPTY_ICONS="$SF/empty-icons"
FAKE_BROWSERS="$SF/ms-playwright"
SMOKE_MJS="$SF/smoke.mjs"

setup_file() {
    # git hook から継いだ GIT_DIR 等があると `git -C` が本体の index を書き換えるので捨てる。
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
        GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE
    # dry-run の有無は引数で作り分けるので、nx release --dry-run から継いだ値は捨てる。
    unset NX_DRY_RUN
    # 親の値を継ぐと、publish が渡さなくても 1-4 の env の確かめが通る。
    unset PECOTV_SKIP_LIB_BUILD
    # 並べた publish の `git status` が、使い捨てリポの index.lock を取り合わないようにする。
    export GIT_OPTIONAL_LOCKS=0
    export GIT_AUTHOR_NAME="pecotv release test" GIT_AUTHOR_EMAIL="pecotv-release-test@example.invalid"
    export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

    # build 済み dist の存在を先に確かめる（無いと publish が途中で、原因の分からない形で落ちる）。
    local dir pkg
    for dir in "$PECOTV_ROOT/cli/dist" "$TEXT_RULES_DIST" $(for pkg in $ESLINT_PKGS; do echo "$ESLINT_SOURCE/$pkg/dist"; done); do
        if [ ! -d "$dir" ]; then
            echo "ERROR: $dir がありません。build 済みの dist が前提です。" >&2
            echo "  bash plugins/pecot-visual/scripts/ci/run-tests.sh --scope=release" >&2
            return 1
        fi
    done

    # 既定の置き場。@test は setup で自分の置き場に向け直す。置かないと publish が本体の記録を読む。
    export PECOTV_AUDIT_RECORD="$SF/audit-record.json" GH_CALLS="$SF/gh-calls.txt" GH_UPLOAD_COPY="$SF/uploaded.tgz"
    REPO_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    PLUGIN_VERSION="$(node -e "process.stdout.write(require('$PECOTV_ROOT/.claude-plugin/plugin.json').version)")"
    TEST_VERSION="0.0.0-test$$"
    ESLINT_BIN="$(node -e "
const path = require('node:path')
process.stdout.write(path.join(path.dirname(require.resolve('eslint/package.json', { paths: ['$PECOTV_ROOT'] })), 'bin/eslint.js'))
")"
    export REPO_HEAD PLUGIN_VERSION TEST_VERSION ESLINT_BIN

    # 偽 gh は引数を 1 行ずつ記録する。release view は GH_VIEW_RC で終わり、release upload は tgz を GH_UPLOAD_COPY へ写す。
    mkdir -p "$SF/ghbin" "$SF/npmbin"
    cat > "$SF/ghbin/gh" << 'FAKE_GH'
#!/bin/bash
printf '%s\n' "$*" >> "$GH_CALLS"
case "$1 $2" in
    "release view")
        if [ "${GH_VIEW_RC:-0}" != 0 ]; then
            echo "release not found" >&2
        fi
        exit "${GH_VIEW_RC:-0}"
        ;;
    "release upload") cp "$4" "$GH_UPLOAD_COPY" ;;
esac
exit 0
FAKE_GH
    chmod +x "$SF/ghbin/gh"
    export PATH="$SF/ghbin:$PATH"
    # 非 dry-run の実行は PECOT_RELEASE_TEST_NPM_CACHE を拒否する。代わりに偽 npm が install にだけ永続キャッシュを足す。
    # 無指定のときのキャッシュは、npm が同時の書き込みに耐える作りなので、並べた @test で共有する。
    REAL_NPM="$(command -v npm)"
    NPM_PERSIST_CACHE="${PECOT_RELEASE_TEST_NPM_CACHE:-$SF/npm-persist-cache}"
    export REAL_NPM NPM_PERSIST_CACHE
    cat > "$SF/npmbin/npm" << 'FAKE_NPM_PERSIST'
#!/bin/bash
case "$1" in
    install) exec "$REAL_NPM" "$@" "--cache=$NPM_PERSIST_CACHE" --prefer-offline ;;
esac
exec "$REAL_NPM" "$@"
FAKE_NPM_PERSIST
    chmod +x "$SF/npmbin/npm"

    make_test_repo
    TEST_HEAD="$(git -C "$TEST_REPO" rev-parse HEAD)"
    TEST_PARENT="$(git -C "$TEST_REPO" rev-parse HEAD^)"
    # 期待値は HEAD の catalog.vite。被検証物と同じ出力を期待値にしないよう、実装の resolveCatalog は使わない。
    git -C "$TEST_REPO" show HEAD:pnpm-workspace.yaml > "$SF/head-pnpm-workspace.yaml"
    HEAD_VITE="$(node -e "
const { readDefaultCatalog } = require(process.argv[2])
process.stdout.write(readDefaultCatalog(require('node:fs').readFileSync(process.argv[3], 'utf8')).vite)
" _ "$RELEASE_DIR/catalog.mjs" "$SF/head-pnpm-workspace.yaml")"
    export TEST_HEAD TEST_PARENT HEAD_VITE
    make_fixtures

    # 2 つの流れは互いの記録・gh の記録・構築先を使わないので、同時に動かす。
    local dryrun_pid publish_pid dryrun_rc=0
    run_dryrun_chain 3>&- &
    dryrun_pid=$!
    run_publish_chain 3>&- &
    publish_pid=$!
    wait "$publish_pid"
    wait "$dryrun_pid" || dryrun_rc=$?
    [ "$dryrun_rc" -eq 0 ] || return 1
    DIST_FP="$(fingerprint_from_log "$SF/dryrun-skipped.log")"
    TEST_FP="$(fingerprint_from_log "$SF/mismatch.log")"
    export DIST_FP TEST_FP
}

setup() {
    bats_load_library pecot-bats
    T="$BATS_TEST_TMPDIR"
    export PECOTV_AUDIT_RECORD="$T/audit-record.json" GH_CALLS="$T/gh-calls.txt" GH_UPLOAD_COPY="$T/uploaded.tgz"
    : > "$GH_CALLS"
}

# --- 11. テストはリポジトリ本体の監査記録に触れない ---
# 指紋は本体の実監査と一致し得る (#1074) ので、本体の記録が由来の印（TEST_REGISTRY）を持たないことだけを見る。
teardown_file() {
    bats_load_library pecot-bats
    assert_not_equal "$(record_registry "$REAL_RECORD_FILE")" "$TEST_REGISTRY"
}

# 指定パスの記録の registry。記録が無い・読めない・registry が文字列でない場合は空を返す。
record_registry() {
    [ -f "$1" ] || return 0
    node -e '
const fs = require("node:fs")
let data = null
try { data = JSON.parse(fs.readFileSync(process.argv[1], "utf8")) } catch { data = null }
const registry = data !== null && typeof data === "object" ? data.registry : undefined
process.stdout.write(typeof registry === "string" ? registry : "")
' "$1" 2> /dev/null
}

# 監査 pass の記録を PECOTV_AUDIT_RECORD に書く。引数は dist の指紋・監査時 HEAD・dist の high・runtime の high（省略で 0）。
# 書き手と独立に記録の契約を言い直すため、audit-record.mjs を呼ばず JSON を手組みする (#1071)。
write_audit_record() {
    node -e '
const fs = require("node:fs")
const [out, fingerprint, head, distHigh, registry, runtimeHigh] = process.argv.slice(1)
const tree = (fp, criticalHigh) => ({
  fingerprint: fp,
  total: 1,
  vulnerabilities: { critical: 0, high: criticalHigh, moderate: 0, low: 0, info: 0 },
  excepted: []
})
fs.writeFileSync(
  out,
  JSON.stringify(
    {
      head,
      registry,
      createdAt: new Date().toISOString(),
      dist: tree(fingerprint, Number(distHigh)),
      runtime: tree("1111111111111111111111111111111111111111111111111111111111111111", Number(runtimeHigh ?? 0))
    },
    null,
    2
  ) + "\n"
)
' "$PECOTV_AUDIT_RECORD" "$1" "$2" "$3" "$TEST_REGISTRY" "${4:-0}"
}
# 旧形式（runtime セクションを持たない）の記録。readAuditRecord は 2 セクションを必須とするので INVALID になる (#1071 F-04)。
write_legacy_audit_record() {
    node -e '
const fs = require("node:fs")
const [out, fingerprint, head, high, registry] = process.argv.slice(1)
fs.writeFileSync(
  out,
  JSON.stringify(
    {
      head,
      registry,
      createdAt: new Date().toISOString(),
      dist: {
        fingerprint,
        total: 1,
        vulnerabilities: { critical: 0, high: Number(high), moderate: 0, low: 0, info: 0 },
        excepted: []
      }
    },
    null,
    2
  ) + "\n"
)
' "$PECOTV_AUDIT_RECORD" "$1" "$2" "$3" "$TEST_REGISTRY"
}
# 監査スキップ（pecot-visual 非対象リリース）の記録。
write_skipped_audit_record() {
    node -e '
const fs = require("node:fs")
const [out, head] = process.argv.slice(1)
fs.writeFileSync(
  out,
  JSON.stringify({ skipped: true, head, createdAt: new Date().toISOString() }, null, 2) + "\n"
)
' "$PECOTV_AUDIT_RECORD" "$1"
}
# publish が出力した配布ツリーの指紋。突合の期待値は外から持ち込まず、常に実行結果から取る。
fingerprint_from_log() {
    sed -n 's/^==> 配布ツリーの指紋: \([0-9a-f]\{64\}\)$/\1/p' "$1" | tail -1
}

# 非 dry-run の publish を起動する。PECOT_RELEASE_TEST_NPM_CACHE を拒否するので外し、偽 npm に永続キャッシュを足させる。
publish_real() {
    env -u PECOT_RELEASE_TEST_NPM_CACHE PATH="$SF/npmbin:$PATH" "$@"
}
gh_call_count() {
    wc -l < "$GH_CALLS" | tr -d ' '
}

# 本体ツリーの eslint プラグインの dist の指紋。publish の前後で変わらないことを確かめる。
eslint_source_fingerprint() {
    local pkg dirs=()
    for pkg in $ESLINT_PKGS; do
        dirs+=("$pkg/dist")
    done
    (cd "$ESLINT_SOURCE" && find "${dirs[@]}" -type f -exec cksum {} + 2> /dev/null | sort)
}

# 配布ツリーに npx が作る node_modules を symlink で再現する。複数版があれば npm と同じく宣言の範囲を満たす実体を選ぶ。
# 範囲の判定は、固定 pin が完全一致で、caret が先頭の非ゼロ桁までを固定する。実体の見つからない依存名をカンマ区切りで返す。
link_dist_node_modules() {
    node -e "
const fs = require('node:fs'), path = require('node:path')
const [dist, ...bases] = process.argv.slice(1)
const parseVersion = (text) => text.replace(/^[^0-9]*/, '').split('.').slice(0, 3).map(Number)
const satisfiesRange = (range, version) => {
  const want = parseVersion(range), have = parseVersion(version)
  if (want.length < 3 || have.length < 3 || [...want, ...have].some(Number.isNaN)) return true
  if (!range.trim().startsWith('^')) return want.every((n, i) => n === have[i])
  const pivot = want.findIndex((n) => n !== 0)
  const fixed = pivot === -1 ? 2 : pivot
  for (let i = 0; i <= fixed; i += 1) if (have[i] !== want[i]) return false
  for (let i = fixed + 1; i < 3; i += 1) {
    if (have[i] > want[i]) return true
    if (have[i] < want[i]) return false
  }
  return true
}
const rootOf = (spec, range) => {
  let fallback = null
  for (const base of bases) {
    let dir = path.resolve(base)
    for (;;) {
      const candidate = path.join(dir, 'node_modules', spec)
      const manifest = path.join(candidate, 'package.json')
      if (fs.existsSync(manifest)) {
        const real = fs.realpathSync(candidate)
        const version = JSON.parse(fs.readFileSync(manifest, 'utf8')).version
        if (typeof version === 'string' && satisfiesRange(range, version)) return real
        fallback ??= real
      }
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  return fallback
}
const missing = []
const dependencies = JSON.parse(fs.readFileSync(path.join(dist, 'package.json'), 'utf8')).dependencies
for (const [spec, range] of Object.entries(dependencies)) {
  const root = rootOf(spec, range)
  if (root === null) { missing.push(spec); continue }
  const link = path.join(dist, 'node_modules', spec)
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(root, link)
}
process.stdout.write(missing.join(','))
" "$DIST" "$RUNTIME_SOURCE" "$PECOTV_ROOT/cli"
}

# talk-dir（$1）をテーマ参照の形にし、固定のテーマを node_modules へ symlink する（配布ツリーはテーマを持たない）。
link_dist_theme() {
    mkdir -p "$1/node_modules"
    ln -s "$FIXTURE_THEME" "$1/node_modules/$FIXTURE_THEME_NAME"
    printf '{"name":"lint-fixture","dependencies":{"%s":"file:%s"}}\n' "$FIXTURE_THEME_NAME" "$FIXTURE_THEME" > "$1/package.json"
    printf -- '---\ntheme: "%s"\n---\n\nsrc: ./pages/fixture.md\n' "$FIXTURE_THEME_NAME" > "$1/slides.md"
}

# $1 = deck-lint.env.config.js、$2 = JSON レポート、$3 = talk-dir（省略時 $LINT_DIR）。rc は見ず、レポートの rule ID を返す。
# 解釈済みの lint（PECOTV_DECK_LINT）は、設定と同じ配布ルートの cli/dist の executeSlideTheme に作らせる。
rule_ids() {
    local talk="${3:-$LINT_DIR}" lint_json root
    root="$(cd "$(dirname "$1")/../.." && pwd)"
    lint_json="$(node --input-type=module -e "
const [root, dir] = process.argv.slice(1)
const { executeSlideTheme } = await import(root + '/cli/dist/commands/slidev-project/theme.js')
const { NodeThemeFiles } = await import(root + '/cli/dist/infra/slidev-theme/fs.js')
const { data } = await executeSlideTheme({ dir }, { files: new NodeThemeFiles() })
process.stdout.write(JSON.stringify(data.lint))
" "$root" "$talk")"
    (cd "$talk" && PECOTV_DECK_LINT="$lint_json" node "$ESLINT_BIN" --no-config-lookup --config "$1" -f json 'pages/**/*.md' 'slides.md' > "$2" 2> "$2.err") || true
    node -e "
const fs = require('node:fs')
let report
try { report = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')) }
catch { process.stdout.write('PARSE_ERROR'); process.exit(0) }
process.stdout.write(report.flatMap((r) => r.messages.map((m) => m.ruleId ?? 'FATAL')).sort().join(','))
" "$2"
}

# JSON-RPC 要求列を組み立てる。id は initialize が 1、以降の `<method> <params-json>` の対が 2, 3, 4, … で、判定はこの番号に依存する。
write_requests() {
    local out="$1"
    shift
    node -e "
const fs = require('node:fs')
const [out, ...rest] = process.argv.slice(1)
const messages = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-smoke', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' }
]
for (let i = 0; i < rest.length; i += 2) {
  messages.push({ jsonrpc: '2.0', id: messages.length, method: rest[i], params: JSON.parse(rest[i + 1]) })
}
fs.writeFileSync(out, JSON.stringify(messages))
" "$out" "$@"
}

# tools/call の params。
call_params() {
    printf '{"name":"%s","arguments":%s}' "$1" "$2"
}

# smoke 結果（1 行 JSON）から `<id>.<key>...` を取り出す。無ければ空文字。
smoke_value() {
    node -e "
const fs = require('node:fs')
let value
try { value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')) }
catch { process.stdout.write('PARSE_ERROR'); process.exit(0) }
for (const key of process.argv[2].split('.')) {
  value = value === undefined || value === null ? undefined : value[key]
}
process.stdout.write(value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value))
" "$1" "$2"
}

# smoke（$1 = 結果、$2 = stderr）が MCP サーバとして起動しなかったら、理由を添えてテストを落とす。
smoke_must_start() {
    local head result stderr_tail
    head="$(head -c 5 "$1" 2> /dev/null)"
    result="$(cat "$1" 2> /dev/null)"
    stderr_tail="$(tail -n 3 "$2" | tr '\n' ' ')"
    case "$head" in
        FAIL:) fail "MCP サーバとして起動しない: $result :: $stderr_tail" ;;
        '') fail "smoke が何も出力しなかった: $stderr_tail" ;;
    esac
}

# chromium ガードを実 DL 無しで通すため、Playwright に解かせた `chromium-<rev>` 配下へ INSTALLATION_COMPLETE だけを置く。
place_fake_chromium_marker() {
    node - "$1" "$2" << 'FAKE_CHROMIUM_JS'
process.env.PLAYWRIGHT_BROWSERS_PATH = process.argv[2]
const fs = require('node:fs'), path = require('node:path')
const { chromium } = require(require.resolve('playwright', { paths: [process.argv[3]] }))
let dir = path.dirname(chromium.executablePath())
while (!path.basename(dir).startsWith('chromium-')) {
  const up = path.dirname(dir)
  if (up === dir) throw new Error('chromium-<rev> ディレクトリを特定できません')
  dir = up
}
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'INSTALLATION_COMPLETE'), '')
FAKE_CHROMIUM_JS
}

# `runtime_setup` を 1 回起動する。HOME は毎回別にする（stamp が残ると 2 回目の runtime stage が skip される）。
# $1 = ラベル、$2 = NODE_EXTRA_CA_CERTS（空なら unset）、$3 = PLUGIN_DATA（省略可）。結果は $T/setup-<label>.json。
run_setup_smoke() {
    local label="$1" extra_ca="$2" plugin_data="${3:-}"
    mkdir -p "$T/home-$label"
    (
        if [ -n "$extra_ca" ]; then
            export NODE_EXTRA_CA_CERTS="$extra_ca"
        else
            unset NODE_EXTRA_CA_CERTS
        fi
        export HOME="$T/home-$label"
        # 置き場を既定の場所（$HOME/.local/share/pecot/pecot-visual）に固定する。呼び出し元の値を継承しない。
        unset CLAUDE_PLUGIN_DATA PLUGIN_DATA XDG_DATA_HOME
        if [ -n "$plugin_data" ]; then
            export PLUGIN_DATA="$plugin_data"
        fi
        export PATH="$T/bin:$PATH"
        export PECOTV_TEST_NPM_ENV_OUT="$T/npm-env-$label"
        # patch-package の代役（npm stub が置く）が起動のたびに 1 行追記する記録。runtime_setup では起動されない。
        export PECOTV_TEST_PATCH_RECORD="$T/patch-record-$label.jsonl"
        export PLAYWRIGHT_BROWSERS_PATH="$T/ms-playwright"
        export PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1
        node "$SMOKE_MJS" "$T/setup-requests.json" "$DIST/cli/dist/main.js"
    ) > "$T/setup-$label.json" 2> "$T/setup-$label.err" || true
}

# patch-package の代役が残した記録の起動回数を返す。記録が無ければ 0。
patch_launch_count() {
    if [ -f "$1" ]; then
        grep -c . "$1" || true
    else
        echo 0
    fi
}

# 本実行の監査記録の確認で止まることを確かめる。$1 = 理由の文言、$2 = --out-dir。
reject_record() {
    run publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build --out-dir="$2"
    assert_failure
    assert_output --partial "$1"
    assert_equal "$(gh_call_count)" 0
}

# --out-dir のガードで止まることを確かめる。記録を置かないので、ガードが外れても構築の前に止まる。
reject_out_dir() {
    run bash "$PUBLISH" --dry-run --skip-build --out-dir="$1"
    assert_failure
    assert_output --partial "ERROR: --out-dir"
}

# タグは worktree 間で共有されるので本体に作らず、publish の入力だけを持つ使い捨てリポに立てる。
# 中身は、未コミットの変更を漏らさないよう作業ツリーから取る。
make_test_repo() {
    local pkg
    mkdir -p "$TEST_REPO"
    git init --quiet --initial-branch=main "$TEST_REPO"
    # gh の -R は origin の URL から求める。https 形式の使い捨ての URL を置く。
    git -C "$TEST_REPO" remote add origin "https://github.com/$TEST_OWNER_REPO.git"
    # 監査記録の HEAD は HEAD かその親に一致すれば通る。親の場合を再現できるよう、ベース commit を 1 本置く。
    git -C "$TEST_REPO" commit --quiet --allow-empty -m base > /dev/null 2>&1
    # git 管理の入力を ls-files で写す。publish は pnpm を解決するため scripts/ci/pnpm-lib.sh を source する。
    (cd "$REPO_ROOT" && git ls-files -z -- \
        plugins/pecot-visual/assets/drawio-icons \
        plugins/pecot-visual/assets/slidev/runtime \
        plugins/pecot-visual/assets/slidev/package.json \
        plugins/pecot-visual/assets/slidev/deck-lint.config.js \
        plugins/pecot-visual/assets/slidev/deck-lint.env.config.js \
        plugins/pecot-visual/assets/slidev/scripts/eslint/_shared \
        plugins/pecot-visual/assets/slidev/scripts/eslint/slidev-pages-lint \
        plugins/pecot-visual/assets/slidev/scripts/eslint/text-constraints \
        plugins/pecot-visual/assets/slidev/scripts/eslint/validate-references \
        plugins/pecot-visual/.claude-plugin \
        plugins/pecot-visual/scripts/ci/pnpm-lib.sh \
        plugins/pecot-visual/cli/package.json \
        plugins/pecot-visual/scripts/release \
        libs/text-rules/package.json \
        LICENSE \
        pnpm-workspace.yaml \
        | tar --null -T - -cf -) | tar -xf - -C "$TEST_REPO"
    # ls-files は未追跡ファイルを落とすので、追加直後のスクリプトも入るよう scripts/release は作業ツリーから上書きする。
    rm -rf "$TEST_PECOTV/scripts/release"
    cp -a "$PECOTV_ROOT/scripts/release" "$TEST_PECOTV/scripts/release"
    # 共通スクリプト（pack から gh まで）と runtime の manifest も同じ理由で作業ツリーから置く。
    mkdir -p "$TEST_REPO/.githooks/scripts" "$TEST_REPO/.githooks/lib"
    cp -a "$REPO_ROOT/.githooks/scripts/attach-mcp-tgz.sh" "$REPO_ROOT/.githooks/scripts/origin-slug.mjs" "$TEST_REPO/.githooks/scripts/"
    cp -a "$REPO_ROOT/.githooks/lib/mcp-publish-common.sh" "$TEST_REPO/.githooks/lib/"
    rm -rf "$TEST_PECOTV/assets/slidev/runtime"
    mkdir -p "$TEST_PECOTV/assets/slidev"
    cp -a "$RUNTIME_SOURCE" "$TEST_PECOTV/assets/slidev/runtime"
    # git 管理外の build 生成物は実体を持ち込む。
    cp -a "$PECOTV_ROOT/cli/dist" "$TEST_PECOTV/cli/dist"
    for pkg in $ESLINT_PKGS; do
        cp -a "$ESLINT_SOURCE/$pkg/dist" "$TEST_PECOTV/assets/slidev/scripts/eslint/$pkg/dist"
    done
    mkdir -p "$TEST_REPO/libs/text-rules"
    cp -a "$TEXT_RULES_DIST" "$TEST_REPO/libs/text-rules/dist"
    git -C "$TEST_REPO" add -A > /dev/null 2>&1
    git -C "$TEST_REPO" commit --quiet -m "test fixture" > /dev/null 2>&1
    git -C "$TEST_REPO" tag "pecot-visual-v$TEST_VERSION" HEAD
    # catalog.mjs が使う yaml の解決元。commit の後に置き、fixture の内容に含めない。
    ln -s "$REPO_ROOT/node_modules" "$TEST_REPO/node_modules"
    # pnpm-workspace.yaml は publish の乖離判定の対象外なので、ほかの確かめに響かない。
    sed -i "s|^\(  vite: \).*|\1$WORKTREE_VITE|" "$TEST_REPO/pnpm-workspace.yaml"
    if [ "$(git -C "$TEST_REPO" show HEAD:pnpm-workspace.yaml)" = "$(cat "$TEST_REPO/pnpm-workspace.yaml")" ] \
        || ! grep -qF "vite: $WORKTREE_VITE" "$TEST_REPO/pnpm-workspace.yaml"; then
        echo "fixture の作業ツリーの catalog.vite を書き換えられません" >&2
        return 1
    fi
}

# lint と smoke が使う talk-dir・テーマ・drawio の入力と、smoke の要求を流す smoke.mjs を置く。
make_fixtures() {
    mkdir -p "$SF/lint-theme" "$LINT_DIR/pages" "$TEXT_DIR/pages" "$EMPTY_ICONS" "$FAKE_BROWSERS" "$SF/home-smoke"
    cp -a "$FIXTURE_THEME_SOURCE" "$FIXTURE_THEME"
    jq '.lint.rules = {
    "slidev-pages-lint/no-triple-hyphen-in-frontmatter": "error",
    "text-constraints/textlint": "error"
}' "$FIXTURE_THEME_SOURCE/pecot-theme.json" > "$FIXTURE_THEME/pecot-theme.json"
    # 既知違反（フロントマター内の余分な `---`）。
    cat > "$LINT_DIR/pages/fixture.md" << 'FIXTURE'
---
layout: cover
title: Fixture
---
subtitle: broken
---

# Fixture
FIXTURE
    link_dist_theme "$LINT_DIR"
    # 違反文は、このファイル自体が文章規則に当たらないよう、2 つに分けた語の連結で組み立てる。
    local hype_phrase="ゲーム""チェンジャー"
    printf -- '---\nlayout: section\nheading: "基盤の話"\ndescription: "%sとなる基盤です。"\n---\n' \
        "$hype_phrase" > "$TEXT_DIR/pages/fixture.md"
    link_dist_theme "$TEXT_DIR"
    cp "$PECOTV_ROOT/cli/tests/fixtures/drawio/icon-resolvable.drawio" "$SMOKE_FIXTURE"
    cat > "$SMOKE_MJS" << 'SMOKE'
// node smoke.mjs <requests.json> <script> [args...]: 要求を流し、id ごとの結果要約を 1 行 JSON で返す（起動の失敗だけ `FAIL: <理由>`）。
// SMOKE_BIN があれば node の代わりにその実行ファイルを起動する（npx 経由の起動用）。
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const [requestsPath, ...command] = process.argv.slice(2)
const requests = JSON.parse(readFileSync(requestsPath, 'utf8'))
const expected = requests.filter((message) => message.id !== undefined).map((message) => message.id)
const TIMEOUT_MS = 120_000

const child = spawn(process.env.SMOKE_BIN ?? process.execPath, command, { stdio: ['pipe', 'pipe', 'pipe'] })
const seen = new Map()
let stderr = ''
let buffer = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { stderr += chunk })
child.stdout.setEncoding('utf8')

const pending = () => expected.filter((id) => !seen.has(id)).join(',')

const settled = new Promise((resolve) => {
  const finish = (result) => { clearTimeout(timer); resolve(result) }
  const timer = setTimeout(() => finish({ ok: false, reason: `timeout (未応答 id: ${pending()})` }), TIMEOUT_MS)
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === '') continue
      let message
      try { message = JSON.parse(line) } catch { return finish({ ok: false, reason: `stdout が JSON-RPC でない: ${line.slice(0, 200)}` }) }
      if (message.id !== undefined) seen.set(message.id, message)
      if (expected.every((id) => seen.has(id))) finish({ ok: true })
    }
  })
  child.on('error', (error) => finish({ ok: false, reason: `起動失敗: ${error.message}` }))
  child.on('exit', (code) => finish({ ok: false, reason: `応答前に終了 (code=${code}, 未応答 id: ${pending()})` }))
})

for (const message of requests) child.stdin.write(`${JSON.stringify(message)}\n`)

const result = await settled
child.kill('SIGKILL')

if (!result.ok) {
  process.stdout.write(`FAIL: ${result.reason} :: ${stderr.slice(-400).replaceAll('\n', ' ')}`)
  process.exit(1)
}

// 要約は判定に使う分だけ載せる（tools/list の JSON Schema 全文は落とす）。error は message を独立したキーに残す。
const summarize = (message) => {
  if (message.error !== undefined) {
    return {
      ok: false,
      error: {
        message: String(message.error.message ?? ''),
        raw: JSON.stringify(message.error).slice(0, 300)
      }
    }
  }
  const payload = message.result ?? {}
  const summary = { ok: true }
  if (Array.isArray(payload.tools)) {
    summary.tools = payload.tools.map((tool) => tool.name).sort()
    summary.toolCount = payload.tools.length
  }
  if (payload.isError !== undefined) summary.isError = payload.isError
  if (payload.structuredContent !== undefined) {
    summary.call = {
      ok: payload.isError !== true,
      data: payload.structuredContent
    }
  }
  return summary
}
process.stdout.write(JSON.stringify(Object.fromEntries(expected.map((id) => [id, summarize(seen.get(id))]))))
SMOKE
    local rc=0
    place_fake_chromium_marker "$FAKE_BROWSERS" "$PECOTV_ROOT/cli" 2> "$SF/fake-chromium.err" || rc=$?
    echo "$rc" > "$SF/fake-chromium.rc"
}

# 1-2・1-3 の dry-run で $DIST を作り、5 の node_modules と 8 の smoke まで進める。配布ツリーを作れなければ 1 で終わる。
run_dryrun_chain() {
    export PECOTV_AUDIT_RECORD="$SF/record-dryrun.json" GH_CALLS="$SF/gh-calls-dryrun.txt"
    : > "$GH_CALLS"
    write_skipped_audit_record "$REPO_HEAD"
    if ! bash "$PUBLISH" --dry-run --skip-build --out-dir="$SF/dist-skipped" > "$SF/dryrun-skipped.log" 2>&1; then
        echo "監査スキップの記録で dry-run が失敗しました" >&2
        cat "$SF/dryrun-skipped.log" >&2
        return 1
    fi
    write_audit_record "$(fingerprint_from_log "$SF/dryrun-skipped.log")" "$REPO_HEAD" 0
    if ! bash "$PUBLISH" --dry-run --skip-build --out-dir="$DIST" > "$SF/dryrun.log" 2>&1; then
        echo "監査記録のある dry-run が失敗しました" >&2
        cat "$SF/dryrun.log" >&2
        return 1
    fi
    link_dist_node_modules > "$SF/missing-links.txt" 2> "$SF/missing-links.err" || echo "LINK_ERROR" >> "$SF/missing-links.txt"
    # 実 export（id 7）は PECOTV_FORCE_SVG_FAIL=1 で embed への到達だけを落とす。
    write_requests "$SF/smoke-requests.json" \
        tools/list '{}' \
        tools/call "$(call_params drawio_export "{\"input_path\":\"$SMOKE_FIXTURE\",\"print_hash\":true}")" \
        tools/call "$(call_params drawio_export "{\"input_path\":\"$SMOKE_FIXTURE\",\"icons_dir\":\"$DIST/assets/drawio-icons\",\"print_hash\":true}")" \
        tools/call "$(call_params drawio_export "{\"input_path\":\"$SMOKE_FIXTURE\",\"icons_dir\":\"$EMPTY_ICONS\",\"print_hash\":true}")" \
        tools/call "$(call_params drawio_create "{\"input_path\":\"$SMOKE_FIXTURE\"}")" \
        tools/call "$(call_params drawio_export "{\"input_path\":\"$SMOKE_FIXTURE\",\"out_path\":\"$SF/smoke-export.svg\"}")" \
        tools/call "$(call_params slide_lint "{\"dir\":\"$TEXT_DIR\"}")"
    # 開発者の実ホームの永続層が依存ルートの候補に入らないよう、HOME と置き場の変数は隔離する。
    env -u CLAUDE_PLUGIN_DATA -u PLUGIN_DATA -u XDG_DATA_HOME HOME="$SF/home-smoke" \
        PLAYWRIGHT_BROWSERS_PATH="$FAKE_BROWSERS" PECOTV_FORCE_SVG_FAIL=1 \
        node "$SMOKE_MJS" "$SF/smoke-requests.json" "$DIST/cli/dist/main.js" \
        > "$SF/smoke.json" 2> "$SF/smoke.err" || true
}

# 9-3 の指紋の不一致で止まる本実行と、その指紋で記録を作り直した 9-4 の本実行。終了コードはファイルに残す。
run_publish_chain() {
    local rc=0
    export PECOTV_AUDIT_RECORD="$SF/record-publish.json" GH_CALLS="$SF/gh-calls-mismatch.txt"
    : > "$GH_CALLS"
    write_audit_record "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" "$TEST_HEAD" 0
    publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
        --out-dir="$SF/dist-mismatch" > "$SF/mismatch.log" 2>&1 || rc=$?
    echo "$rc" > "$SF/mismatch.rc"
    # 監査時 HEAD が現在の HEAD の親（nx が作る release commit の分）でも通ることを見る。
    export GH_CALLS="$SF/gh-calls-publish.txt" GH_UPLOAD_COPY="$SF/uploaded.tgz"
    : > "$GH_CALLS"
    write_audit_record "$(fingerprint_from_log "$SF/mismatch.log")" "$TEST_PARENT" 0
    rc=0
    publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
        --out-dir="$SF/dist-1" > "$SF/publish1.log" 2>&1 || rc=$?
    echo "$rc" > "$SF/publish1.rc"
    # 9-4b が絶対パスの import への退行を拾えるよう、配布ツリーの構築先は消しておく。
    rm -rf "$SF/dist-1"
}

# --- 1. dry-run: 監査記録の確認と配布ツリーの構築 ---

@test "監査記録が無いと、dry-run でも配布ツリーを構築せずに止まる" {
    explains "監査記録が存在しない状態で \`--dry-run\` を実行するテストです。終了コード 1 で記録が無い理由を表示し、配布ツリーを構築しないことを確認します。"
    run bash "$PUBLISH" --dry-run --skip-build --out-dir="$T/dist-norecord"
    assert_failure 1
    assert_output --partial "監査記録がありません"
    [ ! -d "$T/dist-norecord" ] || fail "記録が無いのに配布ツリーを構築した"
}

@test "監査スキップの記録では、dry-run が突合を省略して配布ツリーの指紋を出力する" {
    explains "監査スキップの記録で \`--dry-run\` を実行するテストです。突合を省略して正常終了し、生成した shrinkwrap と同じ 64 桁の指紋を出力することを確認します。"
    run cat "$SF/dryrun-skipped.log"
    assert_output --partial "突合を省略"
    assert_regex "$DIST_FP" '^[0-9a-f]{64}$'
    assert_equal "$DIST_FP" "$(node "$FINGERPRINT" "$SF/dist-skipped/npm-shrinkwrap.json" 2> /dev/null || echo __NO_SHRINKWRAP__)"
}

@test "監査記録の指紋が一致すると、dry-run が突合を通り、同じ指紋の配布ツリーを構築する" {
    explains "監査スキップの dry-run が出力した指紋で監査記録を作り、\`--dry-run\` をもう一度実行するテストです。記録が由来の印を持ち、同じ指紋で監査記録との一致を出力することを確認します。"
    # teardown_file の陽性側。印が載らなくなると teardown_file の確かめが常に通るので、ここで固定する。
    assert_equal "$(record_registry "$SF/record-dryrun.json")" "$TEST_REGISTRY"
    run cat "$SF/dryrun.log"
    assert_output --partial "配布ツリーの指紋: $DIST_FP"
    assert_output --partial "監査記録と一致"
}

@test "high の残る監査記録でも、dry-run は件数を警告して正常終了する" {
    explains "\`high\` の脆弱性が残る監査記録で \`--dry-run\` を実行するテストです。件数を含む警告を表示して正常終了することを確認します。"
    write_audit_record "$DIST_FP" "$REPO_HEAD" 0 2
    run bash "$PUBLISH" --dry-run --skip-build --out-dir="$T/dist-dev-high"
    assert_success
    assert_output --partial "WARNING: 監査記録に high 以上の脆弱性が残っています (2 件)"
    assert_equal "$(gh_call_count)" 0
}

@test "dry-run は gh を呼ばず、実行予定の gh コマンドと tgz の中身を表示する" {
    explains "\`--dry-run\` が表示する内容のテストです。\`gh\` を呼ばずに予定の \`gh\` コマンドと tgz の中身を表示し、中身にソースマップと証明書が無いことを確認します。"
    local log="$SF/dryrun.log"
    assert_equal "$(wc -l < "$SF/gh-calls-dryrun.txt" | tr -d ' ')" 0
    # dry-run の表示は、タグの版が nx の上げる前の値であることを添える。
    run cat "$log"
    assert_output --partial "版は version の段階より前の値です"
    assert_line "==> tgz: pecot-visual-mcp-$PLUGIN_VERSION.tgz"
    assert_line "    LICENSE"
    assert_line "    cli/dist/main.js"
    assert_equal "$(grep -c '^    .*\.map$' "$log" | tr -d ' ')" 0
    # 証明書の同梱を見る。extra-ca-certs.js や certificate.svg のような、実装と icon の名前は対象外。
    assert_equal "$(grep -E '^    (.*/)?certs?/|^    .*\.(pem|crt|cer)$' "$log" | tr -d ' ' | tr '\n' ' ')" ""
    # -R は origin の URL から求める。
    assert_output --partial "gh release view pecot-visual-v$PLUGIN_VERSION -R"
    assert_output --partial "gh release upload pecot-visual-v$PLUGIN_VERSION pecot-visual-mcp-$PLUGIN_VERSION.tgz --clobber -R"
    assert_output --partial "gh workflow run publish-npm.yml -f tag=pecot-visual-v$PLUGIN_VERSION --ref pecot-visual-v$PLUGIN_VERSION -R"
}

# --- 1-4. build を伴う場合の pnpm 呼び出し順 ---

@test "build を伴う dry-run は、install・text-rules・cli・eslint プラグインの順に pnpm を呼ぶ" {
    explains "偽の \`pnpm\` を置いて、build を伴う \`--dry-run\` を実行するテストです。\`install\`・text-rules・cli・eslint プラグインの順に呼び、本体ツリーの dist に触れないことを確認します。"
    local pkg PNPM_CALLS="$T/pnpm-calls.txt" ESLINT_TREE="$T/eslint-tree" ESLINT_BACKUP="$T/eslint-dist-backup" ESLINT_DIST_AT_BUILD="$T/eslint-dist-at-build.txt"
    local calls="$PNPM_CALLS" tree="$ESLINT_TREE" backup="$ESLINT_BACKUP" at_build="$ESLINT_DIST_AT_BUILD"
    local source_before text_rules_line cli_line
    write_audit_record "$DIST_FP" "$REPO_HEAD" 0
    # 本体ツリーの eslint プラグインの dist は別のレーンが読んでいるので、publish には一時の写しを指させる (#82)。
    # 偽 pnpm は build しないので、写しの dist を退避し、build の時点の有無を記録してから戻す。
    mkdir -p "$T/bin" "$backup" "$tree"
    for pkg in $ESLINT_PKGS; do
        mkdir -p "$tree/$pkg"
        cp -a "$ESLINT_SOURCE/$pkg/dist" "$tree/$pkg/dist"
        cp -a "$ESLINT_SOURCE/$pkg/dist" "$backup/$pkg"
    done
    source_before="$(eslint_source_fingerprint)"
    cat > "$T/bin/pnpm" << 'FAKE_PNPM'
#!/bin/bash
# 呼び出しごとに「cwd<TAB>引数<TAB>PECOTV_SKIP_LIB_BUILD の値」を 1 行追記する。build はしない。
printf '%s\t%s\t%s\n' "$PWD" "$*" "${PECOTV_SKIP_LIB_BUILD-unset}" >> "$PNPM_CALLS"
case "$*" in
    "--filter @pecot/slidev-assets-dev run build")
        for pkg in $ESLINT_PKGS; do
            if [ -d "$ESLINT_TREE/$pkg/dist" ]; then echo "$pkg"; fi
        done > "$ESLINT_DIST_AT_BUILD"
        for pkg in $ESLINT_PKGS; do
            rm -rf "$ESLINT_TREE/$pkg/dist"
            cp -a "$ESLINT_BACKUP/$pkg" "$ESLINT_TREE/$pkg/dist"
        done
        ;;
esac
exit 0
FAKE_PNPM
    chmod +x "$T/bin/pnpm"
    : > "$calls"
    run env PECOTV_ESLINT_PLUGINS_DIR="$tree" PNPM_CALLS="$calls" \
        ESLINT_TREE="$tree" ESLINT_BACKUP="$backup" ESLINT_DIST_AT_BUILD="$at_build" \
        ESLINT_PKGS="$ESLINT_PKGS" PATH="$T/bin:$PATH" \
        bash "$PUBLISH" --dry-run --out-dir="$T/dist-build"
    assert_success
    # 古い dist が残ると、削除したソースに対応するモジュールが配布へ同梱される。build の前に消えていることを見る。
    assert_equal "$(wc -l < "$at_build" | tr -d ' ')" 0
    assert_equal "$(for pkg in $ESLINT_PKGS; do [ -f "$tree/$pkg/dist/index.js" ] && echo "$pkg"; done | wc -l | tr -d ' ')" 4
    [ "$(eslint_source_fingerprint)" = "$source_before" ] || fail "build を伴う dry-run が、本体ツリーの eslint プラグインの dist を変えた"
    assert_equal "$(sed -n '1p' "$calls" | cut -f2)" "install --frozen-lockfile"
    assert_equal "$(sed -n '1p' "$calls" | cut -f1)" "$REPO_ROOT"
    assert_equal "$(sed -n '2p' "$calls" | cut -f2)" "--filter @pecot/text-rules-src run build"
    assert_equal "$(sed -n '2p' "$calls" | cut -f1)" "$REPO_ROOT"
    assert_equal "$(sed -n '3p' "$calls" | cut -f2)" "--filter @pecot/pecotv-cli run build"
    assert_equal "$(sed -n '4p' "$calls" | cut -f2)" "--filter @pecot/slidev-assets-dev run build"
    assert_equal "$(wc -l < "$calls" | tr -d ' ')" 4
    text_rules_line="$(awk -F'\t' '$2 ~ /text-rules-src run build/ { print NR; exit }' "$calls")"
    cli_line="$(awk -F'\t' '$2 ~ /pecotv-cli run build/ { print NR; exit }' "$calls")"
    [ -n "$text_rules_line" ] && [ -n "$cli_line" ] && [ "$text_rules_line" -lt "$cli_line" ] \
        || fail "text-rules の build が cli の build より前にない (text-rules=$text_rules_line cli=$cli_line)"
    assert_equal "$(awk -F'\t' '$3 == "1" { print NR }' "$calls" | paste -sd, -)" "4"
    assert_equal "$(awk -F'\t' '$3 == "unset" { print NR }' "$calls" | paste -sd, -)" "1,2,3"
}

@test "pnpm の install が失敗すると、build へ進まずに非ゼロ終了する" {
    explains "\`install --frozen-lockfile\` が失敗する偽の \`pnpm\` で \`--dry-run\` を実行するテストです。非ゼロで終了し、build を呼ばないことを確認します。"
    local PNPM_CALLS="$T/pnpm-calls.txt"
    local calls="$PNPM_CALLS"
    write_audit_record "$DIST_FP" "$REPO_HEAD" 0
    mkdir -p "$T/bin"
    cat > "$T/bin/pnpm" << 'FAKE_PNPM_FAIL'
#!/bin/bash
printf '%s\t%s\t%s\n' "$PWD" "$*" "${PECOTV_SKIP_LIB_BUILD-unset}" >> "$PNPM_CALLS"
case "$*" in
    "install --frozen-lockfile") exit 1 ;;
esac
exit 0
FAKE_PNPM_FAIL
    chmod +x "$T/bin/pnpm"
    : > "$calls"
    run env PNPM_CALLS="$calls" PATH="$T/bin:$PATH" bash "$PUBLISH" --dry-run --out-dir="$T/dist-install-fail"
    assert_failure
    # 記録が空だと下の build 不在は自明に成立するため、install が実際に呼ばれた印を先に見る。
    assert_equal "$(sed -n '1p' "$calls" | cut -f2)" "install --frozen-lockfile"
    assert_equal "$(grep -c 'run build' "$calls" | tr -d ' ')" 0
}

# --- 2. 生成 package.json ---

@test "生成する package.json が公開名・版・依存を宣言し、shrinkwrap と plugin.json が実版で揃う" {
    explains "配布ツリーに生成する \`package.json\` のテストです。公開名・版・\`bin\`・依存がソースの宣言と一致し、shrinkwrap と \`plugin.json\` が実版で揃うことを確認します。"
    local manifest="$DIST/package.json" dist_deps dep
    read_manifest() {
        node -e "
const m = require(process.argv[1])
const q = process.argv[2]
if (q === 'version') process.stdout.write(m.version)
else if (q === 'name') process.stdout.write(m.name)
else if (q === 'license') process.stdout.write(m.license)
else if (q === 'repository') process.stdout.write(JSON.stringify(m.repository))
else if (q === 'bin') process.stdout.write(JSON.stringify(m.bin))
else if (q === 'engines') process.stdout.write(Object.keys(m.engines).sort().join(','))
else if (q === 'hasDevEngines') process.stdout.write(String('devEngines' in m))
else if (q === 'deps') process.stdout.write(Object.keys(m.dependencies).sort().join(','))
" "$manifest" "$1"
    }
    assert_equal "$(read_manifest version)" "$PLUGIN_VERSION"
    assert_equal "$(read_manifest name)" "@pecot/visual-mcp"
    assert_equal "$(read_manifest bin)" '{"pecot-visual-mcp":"cli/dist/main.js"}'
    assert_equal "$(read_manifest license)" "MIT"
    assert_equal "$(read_manifest repository)" \
        '{"type":"git","url":"git+https://github.com/pecotcraft/pecot.git","directory":"plugins/pecot-visual"}'
    assert_equal "$(read_manifest engines)" "node"
    # devEngines に pnpm を写すと、npm が EBADDEVENGINES で止まり、npx 自身が起動しない。
    assert_equal "$(read_manifest hasDevEngines)" "false"
    # 期待値は、cli/package.json の dependencies から永続層 3 件（runtime_setup が入れる重量物）と text-rules（vendor で同梱）を除いた集合。
    runtime_dep_set() {
        node -e "
const cli = require('$PECOTV_ROOT/cli/package.json').dependencies
const dist = require('$manifest').dependencies
const persistent = new Set(['@slidev/cli', '@slidev/parser', 'dom-to-pptx'])
const set = process.argv[1] === 'expected'
  ? Object.keys(cli).filter((name) => !persistent.has(name) && name !== '@pecot/text-rules')
  : Object.keys(dist).filter((name) => name in cli)
process.stdout.write(set.sort().join(','))
" "$1"
    }
    assert_equal "$(runtime_dep_set actual)" "$(runtime_dep_set expected)"
    # 同梱する text-rules の依存は、libs/text-rules/package.json の宣言と範囲まで比べる（無い・範囲が違う名前を返す）。
    assert_equal "$(node -e "
const textRules = require('$REPO_ROOT/libs/text-rules/package.json').dependencies
const dist = require('$manifest').dependencies
if (!textRules || Object.keys(textRules).length === 0) {
  process.stdout.write('TEXT_RULES_HAS_NO_DEPENDENCIES')
  process.exit(0)
}
const gap = Object.entries(textRules).filter(([name, range]) => dist[name] !== range).map(([name]) => name)
process.stdout.write(gap.sort().join(','))
")" ""
    # eslint と @eslint/markdown は assets/slidev/package.json の由来なので、上の比較に現れない。
    dist_deps="$(read_manifest deps)"
    for dep in eslint @eslint/markdown js-yaml ajv synckit; do
        [[ ",$dist_deps," == *",$dep,"* ]] || fail "lint 系の依存 $dep が package.json に無い ($dist_deps)"
    done
    assert_equal "$(node -e "
const slidev = require('$PECOTV_ROOT/assets/slidev/package.json').devDependencies
const dist = require('$manifest').dependencies
process.stdout.write(['eslint', '@eslint/markdown'].filter((name) => dist[name] !== slidev[name]).join(','))
")" ""
    [ -f "$DIST/assets/slidev/package.json" ] || fail "assets/slidev/package.json が配布ツリーに無い"
    assert_equal "$(node -e "process.stdout.write(String(require('$DIST/npm-shrinkwrap.json').lockfileVersion))" 2> /dev/null)" 3
    assert_equal "$(node -e "process.stdout.write(require('$DIST/.claude-plugin/plugin.json').version)" 2> /dev/null)" "$PLUGIN_VERSION"
}

# --- 2-2. README の登録例 ---

@test "README の登録例が公開名と --prefix=/ を使い、LICENSE が HEAD のものと一致する" {
    explains "配布ツリーの \`README.md\` と \`LICENSE\` のテストです。登録例が公開名と \`--prefix=/\` を使い、\`LICENSE\` が HEAD のものと一致することを確認します。"
    local readme="$DIST/README.md"
    assert_equal "$(grep -cE '__[A-Za-z0-9_]+__' "$readme" | tr -d ' ')" 0
    # 4 件 = 直接起動・PLUGIN_DATA 付き・WSL 経由・WSL で PLUGIN_DATA を渡す登録例（bash -lc の行は引用符が付かず対象外）。
    assert_equal "$(grep -cF '"--prefix=/", "@pecot/visual-mcp"' "$readme" | tr -d ' ')" 4
    assert_equal "$(grep -cF 'npx -y --prefix=/ @pecot/visual-mcp' "$readme" | tr -d ' ')" 1
    assert_equal "$(grep -cF '"command": "pecot-visual-mcp"' "$readme" | tr -d ' ')" 1
    # --package= で渡すと子に npm_config_package が残り、子の npx が別のパッケージを実行する。
    assert_equal "$(grep -cF -- '--package=@' "$readme" | tr -d ' ')" 0
    assert_equal "$(grep -c 'git+' "$readme" | tr -d ' ')" 0
    assert_equal "$(grep -cF '@pecot/visual-mcp@1.2.3' "$readme" | tr -d ' ')" 1
    assert_equal "$(cksum < "$DIST/LICENSE" 2> /dev/null || echo __NO_LICENSE__)" "$(git -C "$TEST_REPO" show HEAD:LICENSE | cksum)"
}

# --- 3. .gitignore 除去と eslint プラグイン dist の同梱 ---

@test "配布ツリーが eslint プラグインの dist・icon カタログ・runtime の manifest を同梱し、不要なファイルを含まない" {
    explains "配布ツリーに同梱するもののテストです。eslint プラグインの dist と icon カタログがあり、runtime の manifest が HEAD の catalog で解決されることを確認します。"
    local pkg runtime_diff dist_vite
    assert_equal "$(find "$DIST" -name '.gitignore' | wc -l | tr -d ' ')" 0
    for pkg in $ESLINT_PKGS; do
        [ -f "$DIST_ESLINT/$pkg/dist/index.js" ] \
            || fail "eslint プラグイン $pkg の dist が配布ツリーに無い（.gitignore の dist/ に落とされた疑い）"
    done
    # icon カタログは drawio_export の既定 icons root の実体。欠けると icon:// を解決できないまま別のハッシュが返る。
    [ -f "$DIST/assets/drawio-icons/science/brain-circuit.svg" ] && [ -f "$DIST/assets/drawio-icons/weather/cloud.svg" ] \
        || fail "smoke で使う icon カタログが配布ツリーに無い"
    # 期待値は、ソースの manifest の vite だけを HEAD の catalog.vite に差し替えて作る。
    runtime_diff="$(node -e "
const fs = require('node:fs')
const source = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const dist = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
source.dependencies.vite = process.argv[4]
process.stdout.write(JSON.stringify(source) === JSON.stringify(dist) ? 'same' : 'different')
" _ "$RUNTIME_SOURCE/package.json" "$DIST_RUNTIME/package.json" "$HEAD_VITE" 2> /dev/null || echo error)"
    [ -f "$DIST_RUNTIME/package.json" ] && [ "$runtime_diff" = "same" ] \
        || fail "runtime の manifest が配布ツリーに無い、または catalog: の解決以外でソースと異なる ($runtime_diff)"
    assert_equal "$(grep -c 'catalog:' "$DIST_RUNTIME/package.json" | tr -d ' ')" 0
    dist_vite="$(node -e "process.stdout.write(require('$DIST_RUNTIME/package.json').dependencies.vite)" 2> /dev/null || true)"
    assert_equal "$dist_vite" "$HEAD_VITE"
    assert_not_equal "$dist_vite" "$WORKTREE_VITE"
    # pecot は証明書を同梱しない。プロキシの CA は利用者が NODE_EXTRA_CA_CERTS で渡す（8-3 で受け渡しを見る）。
    [ ! -e "$DIST/assets/certs" ] || fail "配布ツリーに assets/certs が入っている"
    # npm の配布物にソースマップを入れない（spec 018 US4）。
    assert_equal "$(find "$DIST" -name '*.map' -type f | head -n 3)" ""
    [ -f "$DIST/assets/drawio-icons/LICENSE" ] || fail "assets/drawio-icons/LICENSE が配布ツリーに無い"
}

# --- 4. specifier 書き換え ---

@test "配布ツリーの import を、同梱の text-rules への相対パスに書き換える" {
    explains "配布ツリーの import の書き換えのテストです。\`@v-slidev\` と \`@pecot/text-rules\` の bare import が残らず、同梱の text-rules を相対パスで読み込むことを確認します。"
    count_js_containing() {
        grep -rl --include='*.js' --include='*.mjs' "$2" "$1" 2> /dev/null | wc -l | tr -d ' '
    }
    count_js_matching() {
        grep -rlE --include='*.js' --include='*.mjs' "$2" "$1" 2> /dev/null | wc -l | tr -d ' '
    }
    count_file_deps() {
        find "$1" -name 'package.json' -print0 | xargs -0 grep -l '"file:' 2> /dev/null | wc -l | tr -d ' '
    }
    assert_equal "$(count_file_deps "$DIST")" 0
    # 実行時に node が解決するのは .js だけなので、.d.ts と package.json の workspace: 宣言は書き換えの対象外。
    assert_equal "$(count_js_containing "$DIST_ESLINT" '@v-slidev/')" 0
    assert_equal "$(count_js_containing "$DIST_ESLINT" '@pecot/text-rules')" 0
    # 書き換え先の実体が同梱され、text-constraints dist がそれを相対パスで指す（import が消えただけの退行を拾う）。
    [ -f "$DIST/vendor/text-rules/dist/index.js" ] || fail "text-rules の dist が配布ツリーに無い: vendor/text-rules/dist/index.js"
    [ "$(count_js_matching "$DIST_ESLINT/text-constraints/dist" "from '(\\.\\./)+vendor/text-rules/dist/index\\.js'")" -gt 0 ] \
        || fail "text-constraints dist に vendor/text-rules/dist/index.js への相対 import が無い"
    # cli/dist の動的 import も同じ実体へ向く。bare import のままだと npx 起動の drawio_create などが text-lint-failed になる。
    assert_equal "$(count_js_containing "$DIST/cli/dist" '@pecot/text-rules')" 0
    [ "$(count_js_matching "$DIST/cli/dist" "import\\('(\\.\\./)+vendor/text-rules/dist/index\\.js'\\)")" -gt 0 ] \
        || fail "cli/dist に vendor/text-rules/dist/index.js への相対の動的 import が無い"
    assert_equal "$(count_js_containing "$DIST/cli/dist" '_shared/dist/index.js')" 0
    # build は削除したソースに対応する dist を掃除しない。消したモジュールが配布へ残っていないことを見る。
    assert_equal "$(find "$DIST_ESLINT/text-constraints/dist/lib/textlint" -name 'rules.*' 2> /dev/null | wc -l | tr -d ' ')" 0
    assert_equal "$(count_js_containing "$DIST/assets/slidev/deck-lint.config.js" '@v-slidev/')" 0
}

# --- 5. 配布ツリーの node_modules を用意する ---

@test "配布 package.json の依存が、すべてローカルの実体に解決できる" {
    explains "配布ツリーの \`node_modules\` を symlink で再現するテストです。配布 \`package.json\` のすべての依存に、ローカルの実体が見つかることを確認します。"
    run cat "$SF/missing-links.txt"
    assert_output ""
}

# --- 6. lint 結果がプラグイン側の実行と一致する ---

@test "書き換え後の配布ツリーの lint が、プラグイン側と同じ既知違反と文面違反を検出する" {
    explains "既知の違反を含む talk-dir を、プラグイン側と配布ツリー側の lint で調べるテストです。frontmatter の違反と文面違反を、両方が同じ rule ID で検出することを確認します。"
    local plugin_rules dist_rules err_tail
    plugin_rules="$(rule_ids "$DECK_LINT_SOURCE" "$T/lint-plugin.json")"
    dist_rules="$(rule_ids "$DIST/assets/slidev/deck-lint.env.config.js" "$T/lint-dist.json")"
    err_tail="$(tail -n 3 "$T/lint-dist.json.err" | tr '\n' ' ')"
    assert_equal "$plugin_rules" "slidev-pages-lint/no-triple-hyphen-in-frontmatter"
    [ "$plugin_rules" = "$dist_rules" ] \
        || fail "lint 結果が不一致 (plugin='$plugin_rules' dist='$dist_rules'): $err_tail"
    # 文面チェックは synckit worker で text-rules を呼ぶので、配布ツリーでは worker の解決と依存の宣言が揃って初めて動く。
    assert_equal "$(rule_ids "$DECK_LINT_SOURCE" "$T/lint-text-plugin.json" "$TEXT_DIR")" "text-constraints/textlint"
    assert_equal "$(rule_ids "$DIST/assets/slidev/deck-lint.env.config.js" "$T/lint-text-dist.json" "$TEXT_DIR")" "text-constraints/textlint"
}

# --- 7. 除外の検証 ---

@test "配布ツリーが、スキルの指示文・cli の TypeScript ソース・eslint プラグインの tests を含まない" {
    explains "配布ツリーから除外するもののテストです。\`SKILL.md\` と cli の TypeScript ソースと eslint プラグインの \`tests/\` が、配布ツリーに無いことを確認します。"
    assert_equal "$(find "$DIST" -name 'SKILL.md' | wc -l | tr -d ' ')" 0
    assert_equal "$(find "$DIST/cli" -maxdepth 1 -name 'src' | wc -l | tr -d ' ')" 0
    # eslint プラグインの tests/ は skills/ を逆参照するテストを含み、配布ツリーでは必ず落ちる。
    assert_equal "$(find "$DIST_ESLINT" -type d -name 'tests' | wc -l | tr -d ' ')" 0
}

# --- 8. 配布ツリーの起動 smoke と drawio 系ツールの実呼び出し ---

@test "配布ツリーが引数なしで MCP サーバとして起動し、drawio 系と slide_lint の tools/call に応答する" {
    explains "配布ツリーの MCP サーバを引数なしで起動し、JSON-RPC で呼び出すテストです。\`tools/list\` と drawio 系のツールと \`slide_lint\` が期待どおりの結果を返すことを確認します。"
    local json="$SF/smoke.json" tools_error hash_default hash_explicit hash_empty detail chromium_err
    # tsc の出力は実行権を持たず、npm の bin-links が導入時に付ける。ここでは node の shebang を見る。
    assert_equal "$(head -n 1 "$DIST/cli/dist/main.js")" "#!/usr/bin/env node"
    chromium_err="$(tail -n 2 "$SF/fake-chromium.err" | tr '\n' ' ')"
    [ "$(cat "$SF/fake-chromium.rc")" = 0 ] || fail "偽 chromium キャッシュを用意できない: $chromium_err"
    # smoke.mjs は id を持つ全要求の応答が揃うまで待つので、起動できていれば全要求に応答が返っている。
    smoke_must_start "$json" "$SF/smoke.err"
    # 一部の系統が import 失敗で欠けたままの tools/list を拾うため、件数まで固定する（allTools() が公開する数の写し）。
    tools_error="$(smoke_value "$json" 2.error.message)"
    [ -z "$tools_error" ] || fail "tools/list がエラーを返した (error.message: $tools_error)"
    assert_equal "$(smoke_value "$json" 2.toolCount)" 14
    run smoke_value "$json" 2.tools
    assert_output --partial '"runtime_setup"'
    assert_output --partial '"slide_theme"'
    hash_default="$(smoke_value "$json" 3.call.data.sourceSha256)"
    hash_explicit="$(smoke_value "$json" 4.call.data.sourceSha256)"
    hash_empty="$(smoke_value "$json" 5.call.data.sourceSha256)"
    detail="$(smoke_value "$json" 3)"
    [ -n "$hash_default" ] || fail "icons_dir 省略の drawio_export が失敗した: $detail"
    assert_equal "$hash_default" "$hash_explicit"
    [ -n "$hash_empty" ] && [ "$hash_empty" != "$hash_default" ] \
        || fail "icons_dir の明示が既定を上書きしていない (empty='$hash_empty' default='$hash_default')"
    # ok（isError が無い）と warnings の無さは 1 件の判定にまとめる。warnings は、警告が無いと項目ごと入らない。
    assert_equal "ok=$(smoke_value "$json" 6.call.ok) warnings=$(smoke_value "$json" 6.call.data.warnings)" "ok=true warnings="
    assert_equal "$(smoke_value "$json" 8.call.ok) $(smoke_value "$json" 8.call.data | grep -o 'text-constraints/textlint' | sort -u)" \
        "true text-constraints/textlint"
    # 失敗理由が export-failed なら、icon の解決と chromium ガードを通過している。
    assert_equal "$(smoke_value "$json" 7.call.data.kind)" "export-failed"
    # 偽 chromium にはバイナリが無く、注入が外れても export-failed になるので、detail で embed への到達を見る。
    detail="$(smoke_value "$json" 7.call.data.detail)"
    [[ "$detail" == *PECOTV_FORCE_SVG_FAIL* ]] || fail "embed 到達前に失敗している (detail: $detail)"
    # 失敗した export は成果物を残さない。部分的な SVG が、陳腐化の判定をすり抜けないようにする。
    [ ! -e "$SF/smoke-export.svg" ] || fail "実 export が失敗したのに SVG が残っている"
}

# --- 8-2. CLAUDE_PLUGIN_ROOT が別の場所を指す起動 ---

@test "CLAUDE_PLUGIN_ROOT が別の場所を指しても、既定の icons root が配布ツリーを指す" {
    explains "\`CLAUDE_PLUGIN_ROOT\` を別の場所に向けて、配布ツリーの \`drawio_export\` を呼び出すテストです。既定の icons root が配布ツリーのカタログを指し、明示した場合と同じハッシュになることを確認します。"
    local hash_explicit
    # npx の起動でも、Claude Code は導入済みのプラグインの置き場所を CLAUDE_PLUGIN_ROOT に渡す。サーバはそれを読まない。
    hash_explicit="$(smoke_value "$SF/smoke.json" 4.call.data.sourceSha256)"
    [ -n "$hash_explicit" ] || fail "比較対象（icons_dir 明示のハッシュ）が smoke から取れていない"
    mkdir -p "$T/other-plugin-root"
    cp -a "$SF/home-smoke" "$T/home-smoke"
    write_requests "$T/direct-requests.json" \
        tools/call "$(call_params drawio_export "{\"input_path\":\"$SMOKE_FIXTURE\",\"print_hash\":true}")"
    env -u CLAUDE_PLUGIN_DATA -u PLUGIN_DATA -u XDG_DATA_HOME HOME="$T/home-smoke" CLAUDE_PLUGIN_ROOT="$T/other-plugin-root" \
        node "$SMOKE_MJS" "$T/direct-requests.json" "$DIST/cli/dist/main.js" > "$T/direct.json" 2> "$T/direct.err" || true
    smoke_must_start "$T/direct.json" "$T/direct.err"
    assert_equal "$(smoke_value "$T/direct.json" 2.call.data.sourceSha256)" "$hash_explicit"
}

# --- 8-3. runtime_setup が利用者の NODE_EXTRA_CA_CERTS をそのまま取得プロセスへ渡す ---

@test "runtime_setup が、利用者の NODE_EXTRA_CA_CERTS をそのまま渡し、PLUGIN_DATA に従う置き場へ実行時依存を入れる" {
    explains "偽の \`npm\` を置いて、配布ツリーの \`runtime_setup\` を呼び出すテストです。\`NODE_EXTRA_CA_CERTS\` をそのまま渡し、\`PLUGIN_DATA\` の有無で決まる置き場へ実行時依存を入れることを確認します。"
    local location entries=0 missing=0 json detail preset_ca="$T/preset-ca.pem"
    # 取得は単体配布でだけ動く。npm の代役は受け取った値を記録し、RUNTIME_DEPENDENCY_PROBES を満たす最小の node_modules を作る。
    mkdir -p "$T/bin"
    cat > "$T/bin/npm" << 'STUB_NPM'
#!/usr/bin/env node
// 拡張子を持てない（PATH 上の `npm` として起動される）ため CommonJS で書く。
const fs = require('node:fs')
const path = require('node:path')

const argv = process.argv.slice(2)
fs.writeFileSync(process.env.PECOTV_TEST_NPM_ENV_OUT, process.env.NODE_EXTRA_CA_CERTS ?? '<unset>')

const prefix = argv[argv.indexOf('--prefix') + 1]
// `dom-to-pptx` だけは `<pkg>/package.json` ではなく本体を解決するため main の実体も置く。
for (const name of ['@slidev/cli', '@slidev/client', '@slidev/parser', 'dom-to-pptx', 'patch-package']) {
  const directory = path.join(prefix, 'node_modules', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', main: 'index.js' })
  )
  fs.writeFileSync(path.join(directory, 'index.js'), '')
}

// runtime_setup は patch-package を起動しない（テーマの patch は slide sync が当てる）。起動されたら記録が残る。
fs.writeFileSync(
  path.join(prefix, 'node_modules', 'patch-package', 'index.js'),
  [
    "const fs = require('node:fs')",
    "const record = process.env.PECOTV_TEST_PATCH_RECORD",
    "if (record) {",
    "  fs.appendFileSync(record, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n')",
    "}",
    '',
  ].join('\n')
)
STUB_NPM
    chmod +x "$T/bin/npm"
    # chromium stage は必ず install を起動するので、install --dry-run が挙げる全エントリへ完了マーカーを置く。
    # 件数は playwright の版で動くので、各 location にマーカーが在ることだけを見る（到達できない DOWNLOAD_HOST は保険）。
    cp -a "$FAKE_BROWSERS" "$T/ms-playwright"
    PLAYWRIGHT_BROWSERS_PATH="$T/ms-playwright" node "$DIST/node_modules/playwright/cli.js" \
        install --dry-run chromium > "$T/dry-run.out" 2> "$T/dry-run.err" || true
    while read -r location; do
        entries=$((entries + 1))
        mkdir -p "$location" && : > "$location/INSTALLATION_COMPLETE"
        [ -f "$location/INSTALLATION_COMPLETE" ] || missing=$((missing + 1))
    done < <(sed -n 's/^ *Install location: *//p' "$T/dry-run.out")
    detail="$(tail -n 2 "$T/dry-run.err" | tr '\n' ' ')"
    [ "$entries" -gt 0 ] && [ "$missing" -eq 0 ] \
        || fail "完了マーカーを用意できない (entries=$entries missing=$missing): $detail"
    write_requests "$T/setup-requests.json" tools/call "$(call_params runtime_setup '{}')"

    run_setup_smoke unset ""
    json="$T/setup-unset.json"
    smoke_must_start "$json" "$T/setup-unset.err"
    assert_equal "ok=$(smoke_value "$json" 2.call.ok) event=$(smoke_value "$json" 2.call.data.event)" "ok=true event=setup.done"
    assert_equal "$(cat "$T/npm-env-unset" 2> /dev/null)" "<unset>"
    # runtime_setup に patch 段は無い。npm の後に patch-package が起動されないことを固定する。
    assert_equal "$(patch_launch_count "$T/patch-record-unset.jsonl")" 0
    [ -f "$T/home-unset/.local/share/pecot/pecot-visual/mcp-dist/node_modules/@slidev/cli/package.json" ] \
        || fail "永続層ルートに実行時依存が入っていない"

    # 利用者が設定済みの NODE_EXTRA_CA_CERTS を、pecot は書き換えずに子へ渡す。
    printf '%s\n' 'test-ca-bundle' > "$preset_ca"
    run_setup_smoke preset "$preset_ca"
    smoke_must_start "$T/setup-preset.json" "$T/setup-preset.err"
    assert_equal "$(cat "$T/npm-env-preset" 2> /dev/null)" "$preset_ca"

    # 単体配布の登録の `env` に PLUGIN_DATA を書けば、そこが置き場になる（既定の場所は作られない）。
    run_setup_smoke pdata "" "$T/sa-data"
    json="$T/setup-pdata.json"
    smoke_must_start "$json" "$T/setup-pdata.err"
    assert_equal "ok=$(smoke_value "$json" 2.call.ok) event=$(smoke_value "$json" 2.call.data.event)" "ok=true event=setup.done"
    [ -f "$T/sa-data/mcp-dist/node_modules/@slidev/cli/package.json" ] || fail "<PLUGIN_DATA>/mcp-dist に実行時依存が入っていない"
    [ ! -e "$T/home-pdata/.local/share" ] || fail "既定の場所 \$HOME/.local/share が作られた"
}

# --- 9. 冪等性の確認 ---

@test "HEAD にリリースタグが無いと、gh を呼ばず配布ツリーも作らずに正常終了する" {
    explains "リリースタグの無い HEAD で本実行するテストです。\`gh\` を呼ばず、配布ツリーも構築せずに正常終了することを確認します。"
    # 記録は pecot 単独リリースの実態に合わせて skipped を置く。冪等性の確認は監査記録の確認より先に働く。
    write_skipped_audit_record "$REPO_HEAD"
    run publish_real bash "$PUBLISH" --version="$TEST_VERSION" --skip-build --out-dir="$T/dist-gate"
    assert_success
    assert_output --partial "スキップ"
    [ ! -d "$T/dist-gate" ] || fail "リリースタグが無いのに配布ツリーを構築した"
    assert_equal "$(gh_call_count)" 0
}

@test "素性を満たさない監査記録では、本実行が gh を呼ばずに publish を拒否する" {
    explains "素性を満たさない監査記録で本実行するテストです。記録が無い・破損・旧形式・HEAD の不一致・\`high\` の残存のどれでも、\`gh\` を呼ばずに拒否することを確認します。"
    # いずれも pack / upload より前で止まる (#1059)。
    reject_record "監査記録がありません" "$T/dist-rec-none"
    write_skipped_audit_record "$TEST_HEAD"
    reject_record "監査がスキップされたリリース" "$T/dist-rec-skipped"
    printf 'not json' > "$PECOTV_AUDIT_RECORD"
    reject_record "監査記録を読めません" "$T/dist-rec-broken"
    write_legacy_audit_record "$DUMMY_FP" "$TEST_HEAD" 0
    reject_record "監査記録を読めません" "$T/dist-rec-legacy"
    write_audit_record "$DUMMY_FP" "$UNRELATED_SHA" 0
    reject_record "対応しません" "$T/dist-rec-head"
    write_audit_record "$DUMMY_FP" "$TEST_HEAD" 1
    reject_record "high 以上の脆弱性が残っています" "$T/dist-rec-high"
    # blocking は両ツリーの合計。配布ツリー側が 0 でも、永続層側に high が残れば拒否する (#1071 F-05)。
    write_audit_record "$DUMMY_FP" "$TEST_HEAD" 0 1
    reject_record "high 以上の脆弱性が残っています" "$T/dist-rec-runtime-high"
}

# --- 9-2b. 親 commit を持たないリポ ---

@test "親 commit の無いリポでも、HEAD が一致しない監査記録で publish を拒否する" {
    explains "親 commit を持たない使い捨てのリポで本実行するテストです。HEAD の一致しない監査記録を理由とともに拒否し、\`gh\` と配布ツリーの構築に進まないことを確認します。"
    local solo="$T/solo-repo"
    # publish は記録の確認で止まるので、起動に要る scripts/release とリリースタグだけを置く。
    mkdir -p "$solo/plugins/pecot-visual/scripts" "$solo/.githooks/lib"
    git init --quiet --initial-branch=main "$solo"
    cp -a "$PECOTV_ROOT/scripts/release" "$solo/plugins/pecot-visual/scripts/release"
    cp -a "$REPO_ROOT/.githooks/lib/mcp-publish-common.sh" "$solo/.githooks/lib/"
    git -C "$solo" add -A > /dev/null 2>&1
    git -C "$solo" commit --quiet -m "solo fixture" > /dev/null 2>&1
    git -C "$solo" tag "pecot-visual-v$TEST_VERSION" HEAD
    assert_equal "$(git -C "$solo" rev-parse -q --verify HEAD^ || true)" ""
    write_audit_record "$DUMMY_FP" "$UNRELATED_SHA" 0
    run publish_real bash "$solo/plugins/pecot-visual/scripts/release/publish-mcp-dist.sh" --version="$TEST_VERSION" \
        --skip-build --out-dir="$T/dist-solo"
    assert_failure 1
    assert_output --partial "対応しません"
    assert_equal "$(gh_call_count)" 0
    [ ! -d "$T/dist-solo" ] || fail "親が無いリポの拒否で配布ツリーを構築した"
}

# --- 9-3. 指紋が配布ツリーと異なれば配布しない ---

@test "指紋が監査記録と一致しないと、gh を呼ばずに非ゼロ終了し、配布ツリーの指紋を出力する" {
    explains "指紋が配布ツリーと一致しない監査記録で本実行するテストです。理由と配布ツリーの指紋を出力して \`gh\` を呼ばずに止まり、\`vite\` が HEAD の catalog で解決されることを確認します。"
    local tagged_vite
    assert_equal "$(cat "$SF/mismatch.rc")" 1
    run cat "$SF/mismatch.log"
    assert_output --partial "監査した依存ツリーと配布ツリーが一致しません"
    assert_equal "$(wc -l < "$SF/gh-calls-mismatch.txt" | tr -d ' ')" 0
    assert_regex "$TEST_FP" '^[0-9a-f]{64}$'
    # 使い捨てリポ側で作った配布ツリーも HEAD の catalog を使う（作業ツリーの値と違うのを見られるのはここだけ）。
    tagged_vite="$(node -e "process.stdout.write(require('$SF/dist-mismatch/assets/slidev/runtime/package.json').dependencies.vite)" 2> /dev/null || true)"
    assert_equal "$tagged_vite" "$HEAD_VITE"
    assert_not_equal "$tagged_vite" "$WORKTREE_VITE"
}

# --- 9-4. 監査時 HEAD が現在の HEAD の親でも通る ---

@test "監査時 HEAD が現在の HEAD の親でも publish が通り、gh で tgz を Release に添えてワークフローを起動する" {
    explains "監査時 HEAD を親 commit にした監査記録で本実行するテストです。突合を通り、\`gh\` を確認・添付・ワークフローの起動の順に 3 回呼び、添付した tgz に配布物が入ることを確認します。"
    local calls="$SF/gh-calls-publish.txt" tgz="$SF/uploaded.tgz" list="$T/uploaded-files.txt"
    local tag="pecot-visual-v$TEST_VERSION" tgz_name="pecot-visual-mcp-$TEST_VERSION.tgz" upload_line
    assert_equal "$(cat "$SF/publish1.rc")" 0
    run cat "$SF/publish1.log"
    assert_output --partial "監査記録と一致"
    assert_output --partial "tgz: $tgz_name"
    # 順序は view → upload → workflow run。-R は origin の URL から求めた値になる。
    assert_equal "$(wc -l < "$calls" | tr -d ' ')" 3
    assert_equal "$(sed -n '1p' "$calls")" "release view $tag -R $TEST_OWNER_REPO"
    upload_line="$(sed -n '2p' "$calls")"
    [[ "$upload_line" == "release upload $tag /"*"/$tgz_name --clobber -R $TEST_OWNER_REPO" ]] \
        || fail "添付の形でない ($upload_line)"
    assert_equal "$(sed -n '3p' "$calls")" "workflow run publish-npm.yml -f tag=$tag --ref $tag -R $TEST_OWNER_REPO"
    tar -tzf "$tgz" > "$list" 2> /dev/null || : > "$list"
    assert_equal "$(tar -xzOf "$tgz" package/package.json 2> /dev/null | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0, 'utf8')).name)" 2> /dev/null)" "@pecot/visual-mcp"
    assert_equal "$(tar -xzOf "$tgz" package/package.json 2> /dev/null | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0, 'utf8')).version)" 2> /dev/null)" "$TEST_VERSION"
    assert_equal "$(tar -xzOf "$tgz" package/LICENSE 2> /dev/null | cksum)" "$(git -C "$TEST_REPO" show HEAD:LICENSE | cksum)"
    assert_equal "$(grep -cx 'package/cli/dist/main.js' "$list" | tr -d ' ')" 1
    assert_equal "$(grep -cx 'package/npm-shrinkwrap.json' "$list" | tr -d ' ')" 1
    assert_equal "$(grep -cx 'package/assets/slidev/scripts/eslint/_shared/dist/index.js' "$list" | tr -d ' ')" 1
    assert_equal "$(grep -c '\.map$' "$list" | tr -d ' ')" 0
    assert_equal "$(grep -E '(^|/)certs?/|\.(pem|crt|cer)$' "$list" | tr '\n' ' ')" ""
}

# --- 9-4b. 添付された tgz を npx で起動する ---

@test "添付した tgz を npx で起動すると、初回と 2 回目のどちらでも同梱の text-rules で文面違反を返す" {
    explains "添付した tgz を、登録例と同じ \`npx --prefix=/\` で 2 回起動するテストです。初回と 2 回目のどちらでも、同梱の text-rules による \`slide_lint\` が文面違反を返すことを確認します。"
    # 依存は PECOT_RELEASE_TEST_NPM_CACHE があればそのキャッシュを優先し、無ければ使い捨てのキャッシュでレジストリから取る。
    local npx_cache="${PECOT_RELEASE_TEST_NPM_CACHE:-$T/npx-cache}" home="$T/home-npx" kind json
    local npx_flags=(--yes "--cache=$npx_cache")
    if [ -n "${PECOT_RELEASE_TEST_NPM_CACHE:-}" ]; then
        # 前回の中断で opt-in のキャッシュに _npx が残ると、cold が warm になる。
        rm -rf "$npx_cache/_npx"
        npx_flags+=(--prefer-offline)
    fi
    write_requests "$T/npx-requests.json" tools/call "$(call_params slide_lint "{\"dir\":\"$TEXT_DIR\"}")"
    mkdir -p "$home"
    # pnpm の devEngines を宣言した利用者のリポジトリを再現する。onFail は書かない（warn にすると退行を見逃す）。
    printf '%s\n' '{"name":"devengines-repo","private":true,"devEngines":{"packageManager":{"name":"pnpm"}}}' > "$home/package.json"
    cd "$home"
    # --prefix=/ が無ければ、この cwd の npx は EBADDEVENGINES で止まる。止まらなければ --prefix=/ の要否を見直す。
    run env HOME="$home" npx --yes "--cache=$npx_cache" node -v
    assert_failure
    assert_output --partial EBADDEVENGINES
    for kind in cold warm; do
        json="$T/npx-$kind.json"
        env -u CLAUDE_PLUGIN_DATA -u PLUGIN_DATA -u XDG_DATA_HOME -u CLAUDE_PLUGIN_ROOT HOME="$home" \
            SMOKE_BIN="$(command -v npx)" PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
            node "$SMOKE_MJS" "$T/npx-requests.json" "${npx_flags[@]}" --prefix=/ "file:$SF/uploaded.tgz" \
            > "$json" 2> "$T/npx-$kind.err" || true
        smoke_must_start "$json" "$T/npx-$kind.err"
        assert_equal "$(smoke_value "$json" 1.ok)" "true"
        assert_equal "$(smoke_value "$json" 2.call.ok) $(smoke_value "$json" 2.call.data | grep -o 'text-constraints/textlint' | sort -u)" \
            "true text-constraints/textlint"
    done
    # opt-in のキャッシュに npx の作業ディレクトリを残さない。
    if [ -n "${PECOT_RELEASE_TEST_NPM_CACHE:-}" ]; then
        rm -rf "$npx_cache/_npx"
    fi
}

# --- 9-5. 同版の再実行 ---

@test "同じ版で再実行しても、初回と同じ gh の呼び出しで正常終了する" {
    explains "同じ版で本実行をやり直すテストです。正常終了し、初回と同じ Release の確認とワークフローの起動を含む 3 回の \`gh\` を呼ぶことを確認します。"
    local first="$SF/gh-calls-publish.txt"
    # --clobber で上書きし、publish 済みの版はワークフローが飛ばす。
    write_audit_record "$TEST_FP" "$TEST_HEAD" 0
    run publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build --out-dir="$T/dist-2"
    assert_success
    assert_equal "$(gh_call_count)" 3
    assert_equal "$(sed -n '1p' "$GH_CALLS")" "$(sed -n '1p' "$first")"
    assert_equal "$(sed -n '3p' "$GH_CALLS")" "$(sed -n '3p' "$first")"
    assert_equal "$(git -C "$REPO_ROOT" tag -l "pecot-visual-v$TEST_VERSION" | wc -l | tr -d ' ')" 0
}

# --- 9-5b. Release が無いとき ---

@test "Release が無いと、添付もワークフローの起動もせずに非ゼロ終了する" {
    explains "\`gh release view\` が失敗する状態で本実行するテストです。理由と \`gh\` の標準エラーを表示し、確認の 1 回だけで非ゼロ終了することを確認します。"
    write_audit_record "$TEST_FP" "$TEST_HEAD" 0
    export GH_VIEW_RC=1
    run publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build --out-dir="$T/dist-norelease"
    assert_failure 1
    assert_output --partial "Release pecot-visual-v$TEST_VERSION を確認できません"
    assert_output --partial "release not found"
    assert_equal "$(gh_call_count)" 1
    assert_equal "$(tail -1 "$GH_CALLS")" "release view pecot-visual-v$TEST_VERSION -R $TEST_OWNER_REPO"
}

# --- 9-6. 作業ツリーが HEAD と乖離しているとき ---

@test "作業ツリーが HEAD と乖離していると、gh を呼ばずに publish を拒否する" {
    explains "作業ツリーに未コミットの変更がある使い捨てのリポで本実行するテストです。\`gh\` を呼ばずに、未コミットの変更を理由に拒否することを確認します。"
    # タグの指すコミットに対応しない配布物を防ぐ。共有のリポを汚さないよう、写しで動かす。
    cp -a "$TEST_REPO" "$T/repo"
    printf '\ndirty\n' >> "$T/repo/plugins/pecot-visual/scripts/release/mcp-dist-README.md"
    write_audit_record "$TEST_FP" "$TEST_HEAD" 0
    run publish_real bash "$T/repo/plugins/pecot-visual/scripts/release/publish-mcp-dist.sh" --version="$TEST_VERSION" \
        --skip-build --out-dir="$T/dist-dirty"
    assert_failure
    assert_output --partial "未コミットの変更"
    assert_equal "$(gh_call_count)" 0
}

# --- 10. --out-dir ガード ---

@test "廃止した --repo を、未対応の引数として拒否する" {
    explains "廃止した \`--repo\` を渡して \`--dry-run\` を実行するテストです。未対応の引数として拒否することを確認します。"
    run bash "$PUBLISH" --dry-run --skip-build --repo=owner/name --out-dir="$T/dist-oldflag"
    assert_failure
    assert_output --partial "未対応の引数: --repo=owner/name"
}

@test "--out-dir が消してはいけない場所を指すと、消さずに拒否する" {
    explains "\`--out-dir\` に消してはいけない場所を渡すテストです。リポジトリの中・ルート・空でないディレクトリ・symlink 経由のパスを拒否し、対象を消さないことを確認します。"
    # 構築前に rm -rf する引数のため、消してはいけない場所を弾けることを固定する。
    reject_out_dir "$REPO_ROOT/plugins/pecot-visual/scripts"
    reject_out_dir "$REPO_ROOT"
    reject_out_dir "/"
    mkdir -p "$T/nonempty/keep"
    reject_out_dir "$T/nonempty"
    # symlink を経由してリポジトリ配下を指す場合も、正規化して同じ扱いにする。
    ln -s "$REPO_ROOT" "$T/repo-link"
    reject_out_dir "$T/repo-link/docs"
    assert_equal "$(find "$T/nonempty" -mindepth 1 | wc -l | tr -d ' ')" 1
}
