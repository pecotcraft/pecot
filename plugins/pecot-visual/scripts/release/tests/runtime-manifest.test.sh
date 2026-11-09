#!/bin/bash
# runtime-manifest.mjs（監査対象とする永続層の依存集合）の検証 (#1071)。
#
# 永続層へ何を install するかの元データは、cli/src/infra/_shared/runtime-install.ts の runtimeInstallPlan()。
# 監査側はビルド成果物に依存しないよう、同じ規則を .mjs へ写している。
# 写しが元データとずれていないことを、ここで固定する。
#
# release レーンに置くのは、.mjs 側と TS 側のどちらの変更でも実行するため。
# release レーン（pecot-visual:test-release）は、cache: false で動く。
# pecot-visual が affected な push では、毎回実行される。
# cli 側 vitest（test-cli）に置くと、test-cli の inputs に入らない .mjs 単独の変更が、チェックされずに通る。
#
# run-tests.sh の release レーンは RUN_CLI=false のとき cli を build するため、
# cli/dist は本テストの実行時点で必ず存在する。ネットワーク不要。
#
# `set -e` は使わない: 引数不足の非ゼロ終了を意図的に発生させるため。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PECOTV_ROOT="$(cd "$RELEASE_DIR/../.." && pwd)"
MANIFEST_JS="$RELEASE_DIR/runtime-manifest.mjs"
RUNTIME_INSTALL_JS="$PECOTV_ROOT/cli/dist/infra/_shared/runtime-install.js"
RUNTIME_MANIFEST="$PECOTV_ROOT/assets/slidev/runtime/package.json"

PASS=0
FAIL=0
fail() {
    echo "FAIL: $1"
    FAIL=$((FAIL + 1))
}
pass() {
    echo "PASS: $1"
    PASS=$((PASS + 1))
}
assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        pass "$label"
    else
        fail "$label (expected='$expected' actual='$actual')"
    fi
}

TMP=$(mktemp -d)
cleanup() {
    rm -rf "$TMP"
}
trap cleanup EXIT

if [ ! -f "$RUNTIME_INSTALL_JS" ]; then
    echo "ERROR: cli/dist がありません: $RUNTIME_INSTALL_JS (release レーンの cli build 失敗の疑い)" >&2
    exit 1
fi

# --- 1. 直接起動が有効な JSON を返す ---

MANIFEST_RC=0
node "$MANIFEST_JS" "$PECOTV_ROOT" > "$TMP/manifest.json" 2> "$TMP/manifest.err" || MANIFEST_RC=$?
assert_eq "直接起動が exit 0" "0" "$MANIFEST_RC"

MANIFEST_NAME="$(node -e 'const fs=require("node:fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).name))' \
    "$TMP/manifest.json" 2> /dev/null || echo "__INVALID_JSON__")"
assert_eq "出力が有効な JSON で name は pecotv-runtime" "pecotv-runtime" "$MANIFEST_NAME"

# --- 2. 元データ（cli/dist の runtimeInstallPlan）との同値 ---
#
# specs は `名前@range` の列、manifest は 名前 -> range の map。
# 両方を同じ形へ並べ直して比べる。
# 差分が出た場合は両者の列を出して、どの依存がずれたかを直接読めるようにする。

cat > "$TMP/compare.mjs" << 'COMPARE_EOF'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [runtimeInstallPath, manifestJsonPath, runtimeManifestPath, field] = process.argv.slice(2)
const { runtimeInstallPlan } = await import(pathToFileURL(runtimeInstallPath).href)
const plan = runtimeInstallPlan(runtimeManifestPath)
const manifest = JSON.parse(readFileSync(manifestJsonPath, 'utf8'))

if (field === 'specs') {
  // @slidev/parser が dependencies に明示されている場合、runtimeInstallPlan は
  // 依存ループ由来の固定版エントリと末尾の明示 push で同一 specifier を 2 度積む。
  // .mjs 側は plain object へ書くため自然に 1 件へ畳まれるので、比較前に畳む (#1071 F-10)。
  process.stdout.write([...new Set(plan.specs)].sort().join('\n'))
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

compare() {
    node "$TMP/compare.mjs" "$RUNTIME_INSTALL_JS" "$TMP/manifest.json" "$RUNTIME_MANIFEST" "$1"
}

PLAN_SPECS="$(compare specs)"
MANIFEST_DEPS="$(compare deps)"
assert_eq "dependencies が runtimeInstallPlan の specs と一致" "$PLAN_SPECS" "$MANIFEST_DEPS"
if [ -n "$PLAN_SPECS" ]; then
    pass "specs が空でない（比較が無意味になっていない）"
else
    fail "specs が空（比較が無意味になっている）"
fi

assert_eq "overrides が runtimeInstallPlan と一致" "$(compare plan-overrides)" "$(compare manifest-overrides)"

# --- 3. 合成 root での同値 ---
# 合成 root は runtime の manifest だけを持つ（固定版は @slidev/cli の版から読む）。
# link: / file: / portal: の除外、overrides の入れ子、@slidev/parser の上書きと specs 重複畳み込みを含める。
# @slidev/cli が無い manifest では、.mjs と TS の両方が失敗する。.mjs の失敗は下の NOCLI で確かめる。
SYNTH_ROOT="$TMP/synthetic-root"
mkdir -p "$SYNTH_ROOT/assets/slidev/runtime"
cat > "$SYNTH_ROOT/assets/slidev/runtime/package.json" << SYNTH_RUNTIME_EOF
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
    "portal-thing": "portal:../portal-thing"
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
SYNTH_RUNTIME_MANIFEST="$SYNTH_ROOT/assets/slidev/runtime/package.json"

SYNTH_MANIFEST_RC=0
node "$MANIFEST_JS" "$SYNTH_ROOT" > "$TMP/synth-manifest.json" 2> "$TMP/synth-manifest.err" || SYNTH_MANIFEST_RC=$?
assert_eq "合成 root への直接起動が exit 0" "0" "$SYNTH_MANIFEST_RC"

compare_synth() {
    node "$TMP/compare.mjs" "$RUNTIME_INSTALL_JS" "$TMP/synth-manifest.json" "$SYNTH_RUNTIME_MANIFEST" "$1"
}
SYNTH_PLAN_SPECS="$(compare_synth specs)"
SYNTH_MANIFEST_DEPS="$(compare_synth deps)"
assert_eq "合成 root でも dependencies が runtimeInstallPlan の specs と一致。link/file/portal 除外と @slidev/parser 重複畳み込みを含む" \
    "$SYNTH_PLAN_SPECS" "$SYNTH_MANIFEST_DEPS"
if printf '%s\n' "$SYNTH_MANIFEST_DEPS" | grep -qxF '@slidev/parser@99.0.0' \
    && ! printf '%s\n' "$SYNTH_MANIFEST_DEPS" | grep -qF '@slidev/parser@^1.0.0'; then
    pass "合成 root で @slidev/parser が @slidev/cli の版へ上書きされ 1 件に畳まれる"
else
    fail "合成 root で @slidev/parser が 99.0.0 に上書きされていない: $SYNTH_MANIFEST_DEPS"
fi
for CORE_PKG in '@slidev/client' '@slidev/types'; do
    if printf '%s\n' "$SYNTH_MANIFEST_DEPS" | grep -qxF "${CORE_PKG}@99.0.0" \
        && ! printf '%s\n' "$SYNTH_MANIFEST_DEPS" | grep -qF "${CORE_PKG}@^1.0.0"; then
        pass "合成 root の .mjs で $CORE_PKG が @slidev/cli の版へ固定される"
    else
        fail "合成 root の .mjs で $CORE_PKG が 99.0.0 に固定されていない: $SYNTH_MANIFEST_DEPS"
    fi
    if printf '%s\n' "$SYNTH_PLAN_SPECS" | grep -qxF "${CORE_PKG}@99.0.0" \
        && ! printf '%s\n' "$SYNTH_PLAN_SPECS" | grep -qF "${CORE_PKG}@^1.0.0"; then
        pass "合成 root の TS で $CORE_PKG が @slidev/cli の版へ固定される"
    else
        fail "合成 root の TS で $CORE_PKG が 99.0.0 に固定されていない: $SYNTH_PLAN_SPECS"
    fi
done
if [ -n "$SYNTH_PLAN_SPECS" ]; then
    pass "合成 root の specs が空でない（比較が無意味になっていない）"
else
    fail "合成 root の specs が空（比較が無意味になっている）"
fi
assert_eq "合成 root でも overrides の入れ子が一致" "$(compare_synth plan-overrides)" "$(compare_synth manifest-overrides)"

# @slidev/cli の無い manifest は、.mjs が非ゼロ終了し、版指定がない旨を stderr に出す。
NOCLI_ROOT="$TMP/nocli-root"
mkdir -p "$NOCLI_ROOT/assets/slidev/runtime"
printf '%s\n' '{"name":"nocli","dependencies":{"some-lib":"^1.2.3"}}' > "$NOCLI_ROOT/assets/slidev/runtime/package.json"
NOCLI_RC=0
node "$MANIFEST_JS" "$NOCLI_ROOT" > "$TMP/nocli.out" 2> "$TMP/nocli.err" || NOCLI_RC=$?
if [ "$NOCLI_RC" -ne 0 ]; then
    pass "@slidev/cli が無い manifest で .mjs が非ゼロ終了"
else
    fail "@slidev/cli が無い manifest で .mjs が exit 0 になった"
fi
if grep -qF "@slidev/cli の版指定がありません" "$TMP/nocli.err"; then
    pass "@slidev/cli が無い manifest で stderr に版指定なしを出す"
else
    NOCLI_TAIL="$(tail -3 "$TMP/nocli.err" | tr '\n' ' ')"
    fail "@slidev/cli が無い manifest で stderr に版指定なしを出さない: $NOCLI_TAIL"
fi

# --- 4. runtime の manifest の物理パスが cli の RUNTIME_MANIFEST_DIRECTORY と一致する ---
#
# .mjs 側は、release スクリプトが cli/dist に依存しない設計を保つため、固定パスのままにしている。
# ただし、二重管理している事実そのものが自明ではなかった (#1071 F-15)。
# cli 側の元データ（runtime-install.ts の RUNTIME_MANIFEST_DIRECTORY）から導いたパスと一致することを、ここで固定する。
RESOLVED_RUNTIME_DIR="$(node -e "
import('$RUNTIME_INSTALL_JS').then((m) => process.stdout.write(require('node:path').join(process.argv[1], m.RUNTIME_MANIFEST_DIRECTORY)))
" "$PECOTV_ROOT")"
assert_eq ".mjs の固定パスが cli の RUNTIME_MANIFEST_DIRECTORY の解決結果と一致" \
    "$(cd "$RESOLVED_RUNTIME_DIR" && pwd)" \
    "$(cd "$(dirname "$RUNTIME_MANIFEST")" && pwd)"

# --- 5. 引数不足で usage を出す ---

USAGE_RC=0
node "$MANIFEST_JS" > "$TMP/usage.out" 2> "$TMP/usage.err" || USAGE_RC=$?
assert_eq "引数不足で exit 1" "1" "$USAGE_RC"
if grep -qF "usage: runtime-manifest.mjs" "$TMP/usage.err"; then
    pass "引数不足で usage を出す"
else
    USAGE_ERR_TAIL="$(tail -3 "$TMP/usage.err" | tr '\n' ' ')"
    fail "引数不足で usage を出さない: $USAGE_ERR_TAIL"
fi

echo
echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
