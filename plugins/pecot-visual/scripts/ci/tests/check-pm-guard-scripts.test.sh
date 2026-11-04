#!/bin/bash
# check-pm-guard.sh の scripts 確認（list_pm_invoking_scripts）を検証する (#1217)。
#
# scripts から package manager を自己呼び出しすると、次の理由で落ちる。
# pnpm 12 が packageManager の版を @pnpm/exe（単一実行ファイル）で起動する。
# このとき $npm_execpath が ELF を指し、`node "$npm_execpath" run ...` が SyntaxError で落ちる。
# 違反を拾うこと、正当な scripts を誤検知しないこと、現行ツリーが pass することを見る。
#
# `set -e` は使わない: 各ケースの結果を握って評価を続けるため。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GUARD="$CI_DIR/check-pm-guard.sh"

PASS=0
FAIL=0
# check-pm-guard.sh を source すると同名の fail() で上書きされるため、テスト側は別名にする。
t_fail() {
    echo "FAIL: $1"
    FAIL=$((FAIL + 1))
}
t_pass() {
    echo "PASS: $1"
    PASS=$((PASS + 1))
}

# shellcheck source=../check-pm-guard.sh
source "$GUARD"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# $1 = ラベル、$2 = scripts の JSON。違反として返る行数を stdout に出す。
count_violations() {
    printf '{"name":"probe","scripts":%s}\n' "$2" > "$TMP/package.json"
    list_pm_invoking_scripts "$TMP/package.json" | grep -c . || true
}

assert_violations() {
    local label="$1" scripts="$2" expected="$3" actual
    actual="$(count_violations "$label" "$scripts")"
    if [ "$actual" = "$expected" ]; then
        t_pass "$label"
    else
        t_fail "$label (違反 $expected 件を期待、実際 $actual 件)"
    fi
}

# --- 違反を拾う ---------------------------------------------------------------

assert_violations 'node "$npm_execpath" run の自己呼び出し' '{"build":"node \"$npm_execpath\" run build:assets"}' 1
assert_violations 'pnpm run の自己呼び出し' '{"test":"pnpm run test:plugins"}' 1
assert_violations 'npm run の自己呼び出し' '{"test":"npm run a && npm run b"}' 1
assert_violations 'npx の起動' '{"x":"npx playwright install"}' 1
assert_violations 'corepack pnpm の起動' '{"x":"corepack pnpm -r build"}' 1
assert_violations 'yarn の起動' '{"x":"yarn build"}' 1
assert_violations 'c8 越しの自己呼び出し' '{"cov":"c8 node \"$npm_execpath\" test"}' 1
assert_violations 'pnpx の起動' '{"x":"pnpx tsx a.ts"}' 1
assert_violations 'bunx の起動' '{"x":"bunx tsx a.ts"}' 1
assert_violations 'bun の起動' '{"x":"bun run build"}' 1
assert_violations 'npm-run-all の起動' '{"x":"npm-run-all build lint"}' 1
assert_violations 'run-s の起動' '{"x":"run-s build lint"}' 1
assert_violations 'run-p の起動' '{"x":"run-p build lint"}' 1
assert_violations 'concurrently の npm: 指定' '{"x":"concurrently \"npm:build\" \"npm:lint\""}' 1
assert_violations 'concurrently の pnpm: 指定' '{"x":"concurrently pnpm:build:*"}' 1
assert_violations '${npm_execpath} 形式' '{"x":"node ${npm_execpath} run b"}' 1
assert_violations 'パス指定の pnpm' '{"x":"./node_modules/.bin/pnpm run b"}' 1
assert_violations 'env 前置きの後の npm' '{"x":"CI=1 npm test"}' 1
assert_violations 'サブシェル内の npm' '{"x":"(npm run a)"}' 1
assert_violations '複数 script の違反を全件返す' '{"a":"pnpm a","b":"node x.mjs","c":"npm run c"}' 2

# --- 誤検知しない -------------------------------------------------------------

assert_violations 'node / bin だけの scripts' '{"build":"node scripts/build.mjs","lint":"eslint --no-cache . && knip","cov":"c8 sh -c \"node scripts/test.mjs\""}' 0
assert_violations '語の一部に pnpm を含むパス' '{"x":"node scripts/pnpm-lock-check.mjs","y":"cat pnpm-lock.yaml"}' 0
assert_violations 'パスの一部に npm を含む' '{"x":"node scripts/npm.mjs","y":"node ./tools/npm/run.mjs"}' 0
assert_violations 'スコープ付きパッケージ名の npm-' '{"x":"node node_modules/@scope/npm-foo/bin.js","y":"eslint @scope/npm-foo"}' 0
assert_violations 'npm: を含まない concurrently' '{"x":"concurrently \"node a.mjs\" \"node b.mjs\""}' 0
assert_violations 'scripts 無し' '{}' 0

# --- .npmrc の pnpm 固有設定 ---------------------------------------------------

# $1 = ラベル、$2 = .npmrc の中身、$3 = 期待件数
assert_npmrc_keys() {
    local label="$1" content="$2" expected="$3" actual
    printf '%s\n' "$content" > "$TMP/.npmrc"
    actual="$(list_pnpm_only_npmrc_keys "$TMP" | grep -c . || true)"
    if [ "$actual" = "$expected" ]; then
        t_pass "$label"
    else
        t_fail "$label (違反 $expected 件を期待、実際 $actual 件)"
    fi
}

assert_npmrc_keys '.npmrc の node-linker を拾う' $'node-linker=hoisted\nengine-strict=true' 1
assert_npmrc_keys '.npmrc の pnpm 固有設定を全件拾う' $'shared-workspace-lockfile=true\npublic-hoist-pattern[]=*\nonly-built-dependencies[]=esbuild' 3
assert_npmrc_keys 'npm 向けの設定は拾わない' $'# node-linker=hoisted\nengine-strict=true\naudit=false\nfund=false' 0

# --- devEngines.packageManager の読み取り --------------------------------------

# $1 = ラベル、$2 = devEngines の JSON、$3 = 期待値（<name>:<onFail>）
assert_dev_engine_pm() {
    local label="$1" dev="$2" expected="$3" actual
    printf '{"name":"probe","devEngines":%s}\n' "$dev" > "$TMP/package.json"
    actual="$(read_dev_engine_pm "$TMP/package.json")"
    if [ "$actual" = "$expected" ]; then
        t_pass "$label"
    else
        t_fail "$label (期待 $expected、実際 $actual)"
    fi
}

assert_dev_engine_pm 'devEngines の単体オブジェクト' '{"packageManager":{"name":"npm","onFail":"error"}}' 'npm:error'
assert_dev_engine_pm 'devEngines の配列（npm 1 要素）' '{"packageManager":[{"name":"npm","onFail":"error"}]}' 'npm:error'
assert_dev_engine_pm 'devEngines の配列に npm 以外が入ると止められない' '{"packageManager":[{"name":"npm","onFail":"error"},{"name":"pnpm"}]}' 'mixed:'
assert_dev_engine_pm 'devEngines の onFail が error でない' '{"packageManager":{"name":"npm","onFail":"warn"}}' 'npm:warn'
assert_dev_engine_pm 'devEngines の宣言なし' '{}' ':'

# --- pnpm-workspace.yaml の設定読み取り ------------------------------------------

# $1 = ラベル、$2 = yaml の中身、$3 = nodeLinker の期待値
assert_node_linker() {
    local label="$1" content="$2" expected="$3" actual
    printf '%s\n' "$content" > "$TMP/pnpm-workspace.yaml"
    actual="$(read_workspace_setting "$TMP/pnpm-workspace.yaml" nodeLinker)"
    if [ "$actual" = "$expected" ]; then
        t_pass "$label"
    else
        t_fail "$label (期待 '$expected'、実際 '$actual')"
    fi
}

assert_node_linker 'nodeLinker: hoisted' 'nodeLinker: hoisted' 'hoisted'
assert_node_linker '末尾コメント付きでも読める' 'nodeLinker: hoisted # comment' 'hoisted'
assert_node_linker 'クォートされていても読める' 'nodeLinker: "hoisted"' 'hoisted'
assert_node_linker 'isolated は hoisted ではない' 'nodeLinker: isolated' 'isolated'
assert_node_linker 'コメントアウトされた行は読まない' '# nodeLinker: hoisted' ''
assert_node_linker 'ネストしたキーは読まない' $'foo:\n  nodeLinker: hoisted' ''

# --- 静的確認の fail 時の挙動 -----------------------------------------------------

# 実リポジトリを書き換えずに確認する。
# 必要なファイルだけを fixture へ複製し、check-pm-guard.sh が参照する REPO_ROOT と PECOTV_PLUGIN_ROOT を fixture へ向ける。
REAL_REPO_ROOT="$REPO_ROOT"
REAL_PECOTV_ROOT="$PECOTV_PLUGIN_ROOT"

make_fixture() {
    FIX="$(mktemp -d "$TMP/fix.XXXXXX")"
    local rel
    local -a members
    local -a rels=(".")
    mapfile -t members < <(list_workspace_members "$REAL_PECOTV_ROOT/pnpm-workspace.yaml")
    rels+=("${members[@]}")
    mkdir -p "$FIX/plugins/pecot-visual"
    cp "$REAL_PECOTV_ROOT/pnpm-workspace.yaml" "$FIX/plugins/pecot-visual/"
    for rel in "${rels[@]}"; do
        mkdir -p "$FIX/plugins/pecot-visual/$rel"
        cp "$REAL_PECOTV_ROOT/$rel/package.json" "$FIX/plugins/pecot-visual/$rel/"
        [ ! -f "$REAL_PECOTV_ROOT/$rel/.npmrc" ] || cp "$REAL_PECOTV_ROOT/$rel/.npmrc" "$FIX/plugins/pecot-visual/$rel/"
    done
    cp "$REAL_REPO_ROOT/package.json" "$REAL_REPO_ROOT/.npmrc" "$FIX/"
}

# fixture に対して run_static_check を実行する。出力は $STATIC_OUT、終了コードは $STATIC_RC に入れる。
run_static_on_fixture() {
    REPO_ROOT="$FIX"
    PECOTV_PLUGIN_ROOT="$FIX/plugins/pecot-visual"
    STATIC_FAIL=0
    if STATIC_OUT="$(run_static_check 2>&1)"; then STATIC_RC=0; else STATIC_RC=$?; fi
    REPO_ROOT="$REAL_REPO_ROOT"
    PECOTV_PLUGIN_ROOT="$REAL_PECOTV_ROOT"
}

# $1 = ラベル、$2 = 出力に含まれるべき文言（空なら pass を期待）
assert_static() {
    local label="$1" needle="$2"
    run_static_on_fixture
    if [ -z "$needle" ]; then
        if [ "$STATIC_RC" -eq 0 ]; then t_pass "$label"; else t_fail "$label (pass を期待、rc=$STATIC_RC: $STATIC_OUT)"; fi
    elif [ "$STATIC_RC" -ne 0 ] && [[ "$STATIC_OUT" == *"$needle"* ]]; then
        t_pass "$label"
    else
        t_fail "$label (「$needle」で失敗することを期待、rc=$STATIC_RC: $STATIC_OUT)"
    fi
}

make_fixture
assert_static '静的確認: 現行ツリーの複製は pass する' ''

sed -i 's/^nodeLinker: hoisted$/nodeLinker: isolated/' "$FIX/plugins/pecot-visual/pnpm-workspace.yaml"
assert_static '静的確認: nodeLinker: hoisted が無いと落ちる' 'nodeLinker: hoisted が無い'

make_fixture
sed -i 's/^nodeLinker: hoisted$/nodeLinker: hoisted # 末尾コメント/' "$FIX/plugins/pecot-visual/pnpm-workspace.yaml"
assert_static '静的確認: nodeLinker の末尾コメントでは落ちない' ''

make_fixture
node -e 'const fs=require("fs");const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,"utf8"));p.devEngines.packageManager.onFail="warn";fs.writeFileSync(f,JSON.stringify(p))' "$FIX/package.json"
assert_static '静的確認: devEngines.packageManager が npm:error でないと落ちる' 'devEngines.packageManager が'

make_fixture
node -e 'const fs=require("fs");const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,"utf8"));p.devEngines.packageManager=[p.devEngines.packageManager];fs.writeFileSync(f,JSON.stringify(p))' "$FIX/package.json"
assert_static '静的確認: devEngines.packageManager の配列形式（npm:error）は pass する' ''

make_fixture
node -e 'const fs=require("fs");const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,"utf8"));p.scripts={...p.scripts,x:"pnpm run y"};fs.writeFileSync(f,JSON.stringify(p))' "$FIX/plugins/pecot-visual/package.json"
assert_static '静的確認: scripts が package manager を呼ぶと落ちる' 'scripts が package manager を呼んでいる'

# engines の確認の例外は libs/text-rules の 1 件だけで、scripts の確認は text-rules にも掛かる。
make_fixture
node -e 'const fs=require("fs");const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,"utf8"));p.scripts={...p.scripts,x:"pnpm run y"};fs.writeFileSync(f,JSON.stringify(p))' "$FIX/plugins/pecot-visual/libs/text-rules/package.json"
assert_static '静的確認: libs/text-rules の scripts が package manager を呼ぶと落ちる' 'libs/text-rules/package.json の'

make_fixture
node -e 'const fs=require("fs");const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,"utf8"));delete p.engines;fs.writeFileSync(f,JSON.stringify(p))' "$FIX/plugins/pecot-visual/libs/text-rules/package.json"
assert_static '静的確認: libs/text-rules は engines が無くても pass する' ''

make_fixture
node -e 'const fs=require("fs");const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,"utf8"));delete p.engines.npm;fs.writeFileSync(f,JSON.stringify(p))' "$FIX/plugins/pecot-visual/cli/package.json"
assert_static '静的確認: libs/text-rules 以外のメンバーから engines.npm を消すと落ちる' 'engines.npm != "<0.0.0": '"$FIX"'/plugins/pecot-visual/cli/package.json'

# --- 現行ツリー ---------------------------------------------------------------

if [ "$(read_workspace_setting "$PECOTV_PLUGIN_ROOT/pnpm-workspace.yaml" nodeLinker)" = "hoisted" ]; then
    t_pass "現行ツリー: pnpm-workspace.yaml が nodeLinker: hoisted を宣言している"
else
    t_fail "現行ツリー: pnpm-workspace.yaml に nodeLinker: hoisted が無い"
fi

members=()
mapfile -t members < <(list_workspace_members "$PECOTV_PLUGIN_ROOT/pnpm-workspace.yaml")
for rel in "." "${members[@]}"; do
    pkg="$PECOTV_PLUGIN_ROOT/$rel/package.json"
    out="$(list_pm_invoking_scripts "$pkg")"
    if [ -z "$out" ]; then
        t_pass "現行ツリー: $rel の scripts は package manager を呼ばない"
    else
        t_fail "現行ツリー: $rel の scripts が package manager を呼んでいる: $out"
    fi
done

echo
echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
