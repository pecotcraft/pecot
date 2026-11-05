#!/bin/bash
# check-pm-guard.sh と pm-guard-lib.sh の確認（scripts・devEngines の宣言・.npmrc）を検証する (#1217 / #52)。
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

# --- devEngines.packageManager の読み取り --------------------------------------

# $1 = ラベル、$2 = package.json の JSON、$3 = 期待値（<形>|<name>|<version>|<onFail>|<engines の node 以外>|<packageManager>）
assert_declaration() {
    local label="$1" json="$2" expected="$3" actual
    printf '%s\n' "$json" > "$TMP/package.json"
    actual="$(read_pm_declaration "$TMP/package.json")"
    if [ "$actual" = "$expected" ]; then
        t_pass "$label"
    else
        t_fail "$label (期待 $expected、実際 $actual)"
    fi
}

assert_declaration 'devEngines の単体オブジェクト' '{"devEngines":{"packageManager":{"name":"npm","onFail":"error"}}}' 'object|npm||error||'
assert_declaration 'devEngines の version と packageManager' '{"packageManager":"pnpm@1.2.3+sha512.ab","devEngines":{"packageManager":{"name":"pnpm","version":"1.2.3","onFail":"download"}}}' 'object|pnpm|1.2.3|download||pnpm@1.2.3+sha512.ab'
assert_declaration 'devEngines の配列は array を返す' '{"devEngines":{"packageManager":[{"name":"npm","onFail":"error"}]}}' 'array|||||'
assert_declaration 'devEngines の宣言なし' '{}' 'none|||||'
assert_declaration 'engines の node 以外のキーを返す' '{"engines":{"node":"^24","npm":"<0.0.0","yarn":"<0.0.0"}}' 'none||||npm,yarn|'
assert_declaration 'engines が node だけなら余分なキーは空' '{"engines":{"node":"^24"}}' 'none|||||'

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
    local rel p
    while IFS= read -r rel; do
        mkdir -p "$FIX/$(dirname "$rel")"
        cp "$REAL_REPO_ROOT/$rel" "$FIX/$rel"
    done < <(list_package_jsons "$REAL_REPO_ROOT")
    for p in pecot-visual pecot-tools pecot-workflow; do
        cp "$REAL_REPO_ROOT/plugins/$p/pnpm-workspace.yaml" "$FIX/plugins/$p/"
    done
    cp "$REAL_REPO_ROOT/.npmrc" "$FIX/"
    # pecot-visual のメンバー libs/text-rules は、実ツリーと同じくリンクにする。
    mkdir -p "$FIX/plugins/pecot-visual/libs"
    ln -s ../../../libs/text-rules "$FIX/plugins/pecot-visual/libs/text-rules"
}

# fixture の package.json を node の式で書き換える。$1=相対パス $2=p を書き換える JS の文
edit_fixture_pkg() {
    node -e 'const fs=require("fs");const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,"utf8"));eval(process.argv[2]);fs.writeFileSync(f,JSON.stringify(p,null,2))' "$FIX/$1" "$2"
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

VIS=plugins/pecot-visual

make_fixture
assert_static '静的確認: 現行ツリーの複製は pass する' ''

sed -i 's/^nodeLinker: hoisted$/nodeLinker: isolated/' "$FIX/$VIS/pnpm-workspace.yaml"
assert_static '静的確認: nodeLinker: hoisted が無いと落ちる' 'nodeLinker: hoisted が無い'

make_fixture
sed -i 's/^nodeLinker: hoisted$/nodeLinker: hoisted # 末尾コメント/' "$FIX/$VIS/pnpm-workspace.yaml"
assert_static '静的確認: nodeLinker の末尾コメントでは落ちない' ''

make_fixture
edit_fixture_pkg package.json 'p.devEngines.packageManager.onFail="warn"'
assert_static '静的確認: ルートの onFail が error でないと落ちる' 'devEngines.packageManager が { name: npm, onFail: error } でない: package.json'

make_fixture
edit_fixture_pkg package.json 'delete p.devEngines'
assert_static '静的確認: ルートの宣言の欠けで落ちる' 'devEngines.packageManager の宣言が無い: package.json'

make_fixture
edit_fixture_pkg libs/text-rules/package.json 'delete p.devEngines'
assert_static '静的確認: libs/text-rules の宣言の欠けで落ちる' 'devEngines.packageManager の宣言が無い: libs/text-rules/package.json'

make_fixture
edit_fixture_pkg $VIS/cli/package.json 'delete p.devEngines'
assert_static '静的確認: メンバーの宣言の欠けで落ちる' "devEngines.packageManager の宣言が無い: $VIS/cli/package.json"

make_fixture
edit_fixture_pkg $VIS/package.json 'delete p.devEngines'
assert_static '静的確認: プラグインのルートの宣言の欠けで落ちる' "devEngines.packageManager の宣言が無い: $VIS/package.json"

make_fixture
edit_fixture_pkg package.json 'p.devEngines.packageManager=[p.devEngines.packageManager]'
assert_static '静的確認: ルートの配列の宣言で落ちる' 'devEngines.packageManager が配列'

make_fixture
edit_fixture_pkg $VIS/cli/package.json 'p.devEngines.packageManager=[p.devEngines.packageManager]'
assert_static '静的確認: メンバーの配列の宣言で落ちる' "devEngines.packageManager が配列（corepack は配列を読まずに無視する。オブジェクトにする）: $VIS/cli/package.json"

make_fixture
edit_fixture_pkg $VIS/cli/package.json 'p.engines.npm="<0.0.0"'
assert_static '静的確認: engines の余分なキーで落ちる' "engines に node 以外のキーがある（npm）: $VIS/cli/package.json"

make_fixture
edit_fixture_pkg package.json 'p.engines={pnpm:"<0.0.0"}'
assert_static '静的確認: ルートの engines の余分なキーで落ちる' 'engines に node 以外のキーがある（pnpm）: package.json'

make_fixture
printf 'engine-strict=true\n' > "$FIX/$VIS/cli/.npmrc"
assert_static '静的確認: プラグインの下の .npmrc の残りで落ちる' ".npmrc はルートの 1 本だけに置く（プラグインの下に置かない）: $VIS/cli/.npmrc"

make_fixture
rm "$FIX/.npmrc"
assert_static '静的確認: ルートの .npmrc が無いと落ちる' 'engine-strict=true が無い'

make_fixture
edit_fixture_pkg $VIS/package.json 'p.devEngines.packageManager.version="12.16.1"'
assert_static '静的確認: packageManager と devEngines の版のずれで落ちる' 'packageManager（'"'pnpm@12.15.0'"'）が devEngines.packageManager の版（pnpm@12.16.1）とずれている'

make_fixture
edit_fixture_pkg $VIS/package.json 'p.devEngines.packageManager.version="^12.15.0"'
assert_static '静的確認: プラグインのルートの版が完全一致の semver でないと落ちる' '完全一致の semver でない'

make_fixture
edit_fixture_pkg $VIS/package.json 'p.devEngines.packageManager.onFail="error"'
assert_static '静的確認: プラグインのルートの onFail が download でないと落ちる' 'devEngines.packageManager が { name: pnpm, version, onFail: download } でない'

make_fixture
edit_fixture_pkg $VIS/cli/package.json 'p.packageManager="pnpm@12.15.0"'
assert_static '静的確認: メンバーに packageManager があると落ちる' 'packageManager はプラグインのルートだけに置く'

make_fixture
edit_fixture_pkg $VIS/cli/package.json 'p.devEngines.packageManager.name="npm"'
assert_static '静的確認: メンバーが pnpm でないと落ちる' "devEngines.packageManager が { name: pnpm, onFail: error } でない: $VIS/cli/package.json"

make_fixture
mkdir -p "$FIX/plugins/pecot-tools/stray"
printf '{"name":"stray"}\n' > "$FIX/plugins/pecot-tools/stray/package.json"
assert_static '静的確認: 未分類の package.json で落ちる' 'package.json の種類を分けられない'
assert_static '静的確認: 未分類の package.json は相対パスで報告する' 'plugins/pecot-tools/stray/package.json'

make_fixture
mkdir -p "$FIX/$VIS/scripts/release/audit-canary"
printf '{"name":"canary"}\n' > "$FIX/$VIS/scripts/release/audit-canary/package.json"
assert_static '静的確認: 宣言しない例外（監査の canary）は pass する' ''

make_fixture
edit_fixture_pkg $VIS/package.json 'p.scripts={...p.scripts,x:"pnpm run y"}'
assert_static '静的確認: scripts が package manager を呼ぶと落ちる' 'scripts が package manager を呼んでいる'

# scripts の確認は libs/text-rules にも掛かる。
make_fixture
edit_fixture_pkg libs/text-rules/package.json 'p.scripts={...p.scripts,x:"pnpm run y"}'
assert_static '静的確認: libs/text-rules の scripts が package manager を呼ぶと落ちる' 'libs/text-rules/package.json の'

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
