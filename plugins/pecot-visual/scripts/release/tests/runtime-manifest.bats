# runtime-manifest.mjs（監査対象とする永続層の依存集合）が、元データの runtimeInstallPlan()（cli/dist）とずれていないことの検証 (#1071)。
# .mjs と TS のどちらの変更でも動くよう、test-cli でなく release レーンに置く。cli/dist の build が前提。
# @test は並べて動く。共有の準備は setup_file に置き、@test ごとの書き込みは一時ディレクトリに置く。

SCRIPT_DIR="$BATS_TEST_DIRNAME"
RELEASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PECOTV_ROOT="$(cd "$RELEASE_DIR/../.." && pwd)"
MANIFEST_JS="$RELEASE_DIR/runtime-manifest.mjs"
RUNTIME_INSTALL_JS="$PECOTV_ROOT/cli/dist/infra/_shared/runtime-install.js"
RUNTIME_MANIFEST="$PECOTV_ROOT/assets/slidev/runtime/package.json"
CATALOG_JS="$RELEASE_DIR/catalog.mjs"
REPO_WORKSPACE_YAML="$(cd "$PECOTV_ROOT/../.." && pwd)/pnpm-workspace.yaml"

setup_file() {
    # git hook から起動されたときの GIT_DIR 等を捨てる。
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
        GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

    if [ ! -f "$RUNTIME_INSTALL_JS" ]; then
        echo "ERROR: cli/dist がありません: $RUNTIME_INSTALL_JS (release レーンの cli build 失敗の疑い)" >&2
        return 1
    fi

    # 元データ（cli/dist の runtimeInstallPlan）との比較用スクリプト。
    # specs は `名前@range` の列、manifest は 名前 -> range の map。両方を同じ形へ並べ直して比べる。
    cat > "$BATS_FILE_TMPDIR/compare.mjs" << 'COMPARE_EOF'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [runtimeInstallPath, manifestJsonPath, runtimeManifestPath, field, catalogModulePath, workspaceYamlPath] = process.argv.slice(2)
const { runtimeInstallPlan } = await import(pathToFileURL(runtimeInstallPath).href)
const { readDefaultCatalog, resolveCatalog } = await import(pathToFileURL(catalogModulePath).href)
const plan = runtimeInstallPlan(runtimeManifestPath)
// runtimeInstallPlan は catalog: を解決しない。.mjs と同じ resolveCatalog() を通してから比べる。
const catalog = readDefaultCatalog(readFileSync(workspaceYamlPath, 'utf8'))
const splitSpec = (spec) => [spec.slice(0, spec.lastIndexOf('@')), spec.slice(spec.lastIndexOf('@') + 1)]
const resolvedSpecs = Object.entries(resolveCatalog(Object.fromEntries(plan.specs.map(splitSpec)), catalog))
  .map(([name, range]) => `${name}@${range}`)
const manifest = JSON.parse(readFileSync(manifestJsonPath, 'utf8'))

if (field === 'specs') {
  // @slidev/parser が dependencies に明示されている場合、runtimeInstallPlan は
  // 依存ループ由来の固定版エントリと末尾の明示 push で同一 specifier を 2 度積む。
  // .mjs 側は plain object へ書くため自然に 1 件へ畳まれるので、比較前に畳む (#1071 F-10)。
  process.stdout.write([...new Set(resolvedSpecs)].sort().join('\n'))
} else if (field === 'deps') {
  process.stdout.write(
    Object.entries(manifest.dependencies)
      .map(([name, range]) => `${name}@${range}`)
      .sort()
      .join('\n')
  )
} else if (field === 'plan-overrides') {
  process.stdout.write(JSON.stringify(plan.overrides))
} else if (field === 'manifest-overrides') {
  process.stdout.write(JSON.stringify(manifest.overrides))
}
COMPARE_EOF

    # 合成 root は runtime の manifest だけを持つ（固定版は @slidev/cli の版から読む）。
    # link: / file: / portal: の除外、overrides の入れ子、@slidev/parser の上書きと specs 重複畳み込みを含める。
    mkdir -p "$BATS_FILE_TMPDIR/synthetic-root/assets/slidev/runtime"
    cat > "$BATS_FILE_TMPDIR/synthetic-root/assets/slidev/runtime/package.json" << 'SYNTH_RUNTIME_EOF'
{
  "name": "synthetic-runtime",
  "dependencies": {
    "@slidev/cli": "99.0.0",
    "@slidev/parser": "^1.0.0",
    "@slidev/client": "^1.0.0",
    "@slidev/types": "^1.0.0",
    "some-lib": "^1.2.3",
    "local-thing": "link:../local-thing",
    "file-thing": "file:../file-thing",
    "portal-thing": "portal:../portal-thing",
    "vite": "catalog:"
  },
  "devDependencies": {
    "dom-to-pptx": "^2.1.1"
  },
  "overrides": {
    "some-lib": {
      "nested-dep": "^3.0.0"
    }
  }
}
SYNTH_RUNTIME_EOF
    printf '%s\n' 'catalog:' '  vite: ^8.0.0' > "$BATS_FILE_TMPDIR/synth-workspace.yaml"
}

setup() {
    bats_load_library pecot-bats
    T="$BATS_TEST_TMPDIR"
    COMPARE_MJS="$BATS_FILE_TMPDIR/compare.mjs"
    SYNTH_ROOT="$BATS_FILE_TMPDIR/synthetic-root"
    SYNTH_RUNTIME_MANIFEST="$SYNTH_ROOT/assets/slidev/runtime/package.json"
    SYNTH_WORKSPACE_YAML="$BATS_FILE_TMPDIR/synth-workspace.yaml"
}

# 実リポの manifest を $T/manifest.json に書き出して添付する。
write_manifest() {
    node "$MANIFEST_JS" "$PECOTV_ROOT" > "$T/manifest.json"
    attach_file "$T/manifest.json"
}

# 比べた結果を $T/compare-<観点>.txt に書き、中身を出して添付する。
compare() {
    node "$COMPARE_MJS" "$RUNTIME_INSTALL_JS" "$T/manifest.json" "$RUNTIME_MANIFEST" "$1" "$CATALOG_JS" "$REPO_WORKSPACE_YAML" > "$T/compare-$1.txt"
    read_output "$T/compare-$1.txt"
}

# 合成 root の manifest を $T/synth-manifest.json に書き出して添付する。
write_synth_manifest() {
    node "$MANIFEST_JS" "$SYNTH_ROOT" "$SYNTH_WORKSPACE_YAML" > "$T/synth-manifest.json"
    attach_file "$T/synth-manifest.json"
}

compare_synth() {
    node "$COMPARE_MJS" "$RUNTIME_INSTALL_JS" "$T/synth-manifest.json" "$SYNTH_RUNTIME_MANIFEST" "$1" "$CATALOG_JS" "$SYNTH_WORKSPACE_YAML" > "$T/compare-synth-$1.txt"
    read_output "$T/compare-synth-$1.txt"
}

# 行 $2 が、列 $1 に完全一致で 1 行あること。
assert_has_line() {
    printf '%s\n' "$1" | grep -qxF -- "$2" || fail "行が無い: $2 / 実際: $1"
}

# 文字列 $1 に、部分文字列 $2 が含まれないこと。
refute_has_text() {
    if printf '%s\n' "$1" | grep -qF -- "$2"; then
        fail "含まれてはいけない文字列がある: $2 / 実際: $1"
    fi
}

# catalog: の異常系。合成 root の vite だけを差し替え、非ゼロ終了と出力の文言を見る。
# $1=ラベル $2=vite の範囲 $3=workspace yaml。結果は run の $status・$output に残る。
run_manifest_failure() {
    local label="$1" vite_range="$2" workspace_yaml="$3"
    local root="$T/abnormal-root-$label"
    mkdir -p "$root/assets/slidev/runtime"
    node -e '
const fs = require("node:fs")
const [src, dst, range] = process.argv.slice(1)
const manifest = JSON.parse(fs.readFileSync(src, "utf8"))
manifest.dependencies.vite = range
fs.writeFileSync(dst, JSON.stringify(manifest))
' "$SYNTH_RUNTIME_MANIFEST" "$root/assets/slidev/runtime/package.json" "$vite_range"
    run_attached node "$MANIFEST_JS" "$root" "$workspace_yaml"
}

@test "実リポの runtime を直接起動すると、name が pecotv-runtime の有効な JSON を返す" {
    explains '`runtime-manifest.mjs` を実リポのルートに対して直接起動するテストです。終了コード 0 で、出力が有効な JSON であり、`name` が `pecotv-runtime` であることを確認します。'
    local rc=0
    node "$MANIFEST_JS" "$PECOTV_ROOT" > "$T/manifest.json" 2> "$T/manifest-stderr.txt" || rc=$?
    attach_file "$T/manifest.json"
    attach_file "$T/manifest-stderr.txt"
    assert_equal "$rc" "0"
    local name
    name="$(node -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).name))' \
        "$T/manifest.json" 2> /dev/null || echo "__INVALID_JSON__")"
    assert_equal "$name" "pecotv-runtime"
}

@test "実リポの manifest は、dependencies と overrides が runtimeInstallPlan の結果と一致する" {
    explains '`runtime-manifest.mjs` の出力と、`cli/dist` の `runtimeInstallPlan` の結果を比べるテストです。依存の集合と overrides が一致し、比べる specs が空でないことを確認します。'
    write_manifest
    local plan_specs
    plan_specs="$(compare specs)"
    assert_equal "$(compare deps)" "$plan_specs"
    [ -n "$plan_specs" ] || fail "specs が空"
    assert_equal "$(compare manifest-overrides)" "$(compare plan-overrides)"
}

@test "合成 root を直接起動すると、link・file・portal を除いた依存が runtimeInstallPlan の specs と一致する" {
    explains '`@slidev/parser` の重複と `link:`・`file:`・`portal:` を含む合成 root を `runtime-manifest.mjs` に渡すテストです。終了コード 0 で、依存が `runtimeInstallPlan` の specs と一致し、specs が空でないことを確認します。'
    local rc=0
    node "$MANIFEST_JS" "$SYNTH_ROOT" "$SYNTH_WORKSPACE_YAML" > "$T/synth-manifest.json" 2> "$T/synth-manifest-stderr.txt" || rc=$?
    attach_file "$T/synth-manifest.json"
    attach_file "$T/synth-manifest-stderr.txt"
    assert_equal "$rc" "0"
    local plan_specs
    plan_specs="$(compare_synth specs)"
    assert_equal "$(compare_synth deps)" "$plan_specs"
    [ -n "$plan_specs" ] || fail "specs が空"
}

@test "合成 root の @slidev/parser は、@slidev/cli の版へ上書きされて 1 件に畳まれる" {
    explains '`@slidev/parser` に別の版を書いた合成 root を `runtime-manifest.mjs` に渡すテストです。出力の依存で、`@slidev/parser` が `@slidev/cli` の版に上書きされ、元の版が残らないことを確認します。'
    write_synth_manifest
    local deps
    deps="$(compare_synth deps)"
    assert_has_line "$deps" '@slidev/parser@99.0.0'
    refute_has_text "$deps" '@slidev/parser@^1.0.0'
}

@test "合成 root の @slidev/client と @slidev/types は、.mjs と TS のどちらでも @slidev/cli の版へ固定される" {
    explains '`@slidev/client` と `@slidev/types` に別の版を書いた合成 root のテストです。`runtime-manifest.mjs` の出力と `runtimeInstallPlan` の specs の両方で、2 つのパッケージが `@slidev/cli` の版に固定されることを確認します。'
    write_synth_manifest
    local deps specs pkg
    deps="$(compare_synth deps)"
    specs="$(compare_synth specs)"
    for pkg in '@slidev/client' '@slidev/types'; do
        assert_has_line "$deps" "${pkg}@99.0.0"
        refute_has_text "$deps" "${pkg}@^1.0.0"
        assert_has_line "$specs" "${pkg}@99.0.0"
        refute_has_text "$specs" "${pkg}@^1.0.0"
    done
}

@test "合成 root の catalog: の vite は、catalog の範囲に解決され、catalog: が残らない" {
    explains '`vite` を `catalog:` で書いた合成 root と、`vite` の範囲を持つ workspace yaml を渡すテストです。出力の依存で `vite` が catalog の範囲に解決され、`catalog:` が残らないことを確認します。'
    write_synth_manifest
    local deps
    deps="$(compare_synth deps)"
    assert_has_line "$deps" 'vite@^8.0.0'
    refute_has_text "$deps" 'catalog:'
}

@test "合成 root の overrides は、入れ子も runtimeInstallPlan の結果と一致する" {
    explains '`some-lib` の下に入れ子の overrides を持つ合成 root のテストです。`runtime-manifest.mjs` の出力の overrides が、`runtimeInstallPlan` の overrides と一致することを確認します。'
    write_synth_manifest
    assert_equal "$(compare_synth manifest-overrides)" "$(compare_synth plan-overrides)"
}

@test "名前付き catalog を指す依存があると、非ゼロで終了し、名前付き catalog を扱えない旨を出す" {
    explains '`vite` が `catalog:named` を指す合成 root を `runtime-manifest.mjs` に渡すテストです。非ゼロで終了し、名前付き catalog を扱えない旨が出力されることを確認します。'
    run_manifest_failure named "catalog:named" "$SYNTH_WORKSPACE_YAML"
    assert_failure
    assert_output --partial "名前付き catalog"
}

@test "workspace yaml の catalog に無い名前を指す依存があると、非ゼロで終了し、catalog に無い旨を出す" {
    explains '`vite` が `catalog:` を指すのに、workspace yaml の catalog に `vite` が無い場合のテストです。`runtime-manifest.mjs` が非ゼロで終了し、catalog に無い旨が出力されることを確認します。'
    printf '%s\n' 'catalog:' '  other: ^1.0.0' > "$T/other-workspace.yaml"
    run_manifest_failure missing "catalog:" "$T/other-workspace.yaml"
    assert_failure
    assert_output --partial "catalog にありません"
}

@test "default catalog が 2 通りに定義されていると、非ゼロで終了し、重複の旨を出す" {
    explains '`catalog:` と `catalogs.default` の両方で `vite` を定義した workspace yaml のテストです。`runtime-manifest.mjs` が非ゼロで終了し、複数回定義されている旨が出力されることを確認します。'
    printf '%s\n' 'catalog:' '  vite: ^8.0.0' 'catalogs:' '  default:' '    vite: ^7.0.0' > "$T/both-workspace.yaml"
    run_manifest_failure both "catalog:" "$T/both-workspace.yaml"
    assert_failure
    assert_output --partial "defined multiple times"
}

@test "@slidev/cli の版指定が無い manifest を渡すと、非ゼロで終了し、版指定が無い旨を出す" {
    explains '`@slidev/cli` を含まない runtime の manifest を持つ root を渡すテストです。`runtime-manifest.mjs` が非ゼロで終了し、`@slidev/cli` の版指定が無いという文言を出力することを確認します。'
    mkdir -p "$T/nocli-root/assets/slidev/runtime"
    printf '%s\n' '{"name":"nocli","dependencies":{"some-lib":"^1.2.3"}}' > "$T/nocli-root/assets/slidev/runtime/package.json"
    run_attached node "$MANIFEST_JS" "$T/nocli-root"
    assert_failure
    assert_output --partial "@slidev/cli の版指定がありません"
}

@test ".mjs の固定パスは、cli の RUNTIME_MANIFEST_DIRECTORY を解決した場所と一致する" {
    explains '`runtime-manifest.mjs` が持つ runtime の manifest の固定パスのテストです。`cli/dist` の `RUNTIME_MANIFEST_DIRECTORY` から導いたディレクトリと、同じ場所を指すことを確認します。'
    local resolved
    resolved="$(node -e "
import('$RUNTIME_INSTALL_JS').then((m) => process.stdout.write(require('node:path').join(process.argv[1], m.RUNTIME_MANIFEST_DIRECTORY)))
" "$PECOTV_ROOT")"
    assert_equal "$(cd "$resolved" && pwd)" "$(cd "$(dirname "$RUNTIME_MANIFEST")" && pwd)"
}

@test "引数が足りないと、終了コード 1 で usage を出す" {
    explains '引数を渡さずに `runtime-manifest.mjs` を起動するテストです。終了コード 1 で終わり、`usage: runtime-manifest.mjs` が出力されることを確認します。'
    run_attached node "$MANIFEST_JS"
    assert_failure 1
    assert_output --partial "usage: runtime-manifest.mjs"
}
