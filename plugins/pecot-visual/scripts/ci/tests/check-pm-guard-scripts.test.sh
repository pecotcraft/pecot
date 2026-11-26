#!/bin/bash
# check-pm-guard.sh と pm-guard-lib.sh の確認（scripts・devEngines の宣言・.npmrc）を確かめる (#1217 / #52)。
# scripts からの package manager の自己呼び出しは、pnpm 12 の @pnpm/exe で $npm_execpath が ELF を指して落ちる。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$(cd "$SCRIPT_DIR/../../../../.." && pwd)/.githooks/scripts/test_report/bash-test.sh"
CI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GUARD="$CI_DIR/check-pm-guard.sh"

# check-pm-guard.sh は REPO_ROOT・PECOTV_PLUGIN_ROOT・fail() を定める。
# shellcheck source=../check-pm-guard.sh
source "$GUARD"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# $1 = ラベル、$2 = scripts の JSON。違反として返る行数を stdout に出す。
count_violations() {
    printf '{"name":"probe","scripts":%s}\n' "$2" > "$TMP/package.json"
    list_pm_invoking_scripts "$TMP/package.json" | grep -c . || true
}

# $1 = ラベル、$2 = scripts の JSON、$3 = 違反の件数の期待値
expect_violations() {
    bt_eq "$1" "$3" "$(count_violations "$1" "$2")"
}

# --- 違反を拾う ---------------------------------------------------------------

expect_violations 'node "$npm_execpath" run の自己呼び出し' '{"build":"node \"$npm_execpath\" run build:assets"}' 1
expect_violations 'pnpm run の自己呼び出し' '{"test":"pnpm run test:plugins"}' 1
expect_violations 'npm run の自己呼び出し' '{"test":"npm run a && npm run b"}' 1
expect_violations 'npx の起動' '{"x":"npx playwright install"}' 1
expect_violations 'corepack pnpm の起動' '{"x":"corepack pnpm -r build"}' 1
expect_violations 'yarn の起動' '{"x":"yarn build"}' 1
expect_violations 'c8 越しの自己呼び出し' '{"cov":"c8 node \"$npm_execpath\" test"}' 1
expect_violations 'pnpx の起動' '{"x":"pnpx tsx a.ts"}' 1
expect_violations 'bunx の起動' '{"x":"bunx tsx a.ts"}' 1
expect_violations 'bun の起動' '{"x":"bun run build"}' 1
expect_violations 'npm-run-all の起動' '{"x":"npm-run-all build lint"}' 1
expect_violations 'run-s の起動' '{"x":"run-s build lint"}' 1
expect_violations 'run-p の起動' '{"x":"run-p build lint"}' 1
expect_violations 'concurrently の npm: 指定' '{"x":"concurrently \"npm:build\" \"npm:lint\""}' 1
expect_violations 'concurrently の pnpm: 指定' '{"x":"concurrently pnpm:build:*"}' 1
expect_violations '${npm_execpath} 形式' '{"x":"node ${npm_execpath} run b"}' 1
expect_violations 'パス指定の pnpm' '{"x":"./node_modules/.bin/pnpm run b"}' 1
expect_violations 'env 前置きの後の npm' '{"x":"CI=1 npm test"}' 1
expect_violations 'サブシェル内の npm' '{"x":"(npm run a)"}' 1
expect_violations '複数 script の違反を全件返す' '{"a":"pnpm a","b":"node x.mjs","c":"npm run c"}' 2

# --- 誤検知しない -------------------------------------------------------------

expect_violations 'node / bin だけの scripts' '{"build":"node scripts/build.mjs","lint":"eslint --no-cache . && knip","cov":"c8 sh -c \"node scripts/test.mjs\""}' 0
expect_violations '語の一部に pnpm を含むパス' '{"x":"node scripts/pnpm-lock-check.mjs","y":"cat pnpm-lock.yaml"}' 0
expect_violations 'パスの一部に npm を含む' '{"x":"node scripts/npm.mjs","y":"node ./tools/npm/run.mjs"}' 0
expect_violations 'スコープ付きパッケージ名の npm-' '{"x":"node node_modules/@scope/npm-foo/bin.js","y":"eslint @scope/npm-foo"}' 0
expect_violations 'npm: を含まない concurrently' '{"x":"concurrently \"node a.mjs\" \"node b.mjs\""}' 0
expect_violations 'scripts 無し' '{}' 0

# --- devEngines.packageManager の読み取り --------------------------------------

# $1 = ラベル、$2 = package.json の JSON、$3 = 期待値（<形>|<name>|<version>|<onFail>|<engines の node 以外>|<packageManager>）
expect_declaration() {
    printf '%s\n' "$2" > "$TMP/package.json"
    bt_eq "$1" "$3" "$(read_pm_declaration "$TMP/package.json")"
}

expect_declaration 'devEngines の単体オブジェクト' '{"devEngines":{"packageManager":{"name":"npm","onFail":"error"}}}' 'object|npm||error||'
expect_declaration 'devEngines の version と packageManager' '{"packageManager":"pnpm@1.2.3+sha512.ab","devEngines":{"packageManager":{"name":"pnpm","version":"1.2.3","onFail":"download"}}}' 'object|pnpm|1.2.3|download||pnpm@1.2.3+sha512.ab'
expect_declaration 'devEngines の配列は array を返す' '{"devEngines":{"packageManager":[{"name":"npm","onFail":"error"}]}}' 'array|||||'
expect_declaration 'devEngines の宣言なし' '{}' 'none|||||'
expect_declaration 'engines の node 以外のキーを返す' '{"engines":{"node":"^24","npm":"<0.0.0","yarn":"<0.0.0"}}' 'none||||npm,yarn|'
expect_declaration 'engines が node だけなら余分なキーは空' '{"engines":{"node":"^24"}}' 'none|||||'

# --- pnpm-workspace.yaml の設定読み取り ------------------------------------------

# $1 = ラベル、$2 = yaml の中身、$3 = nodeLinker の期待値
expect_node_linker() {
    printf '%s\n' "$2" > "$TMP/pnpm-workspace.yaml"
    bt_eq "$1" "$3" "$(read_workspace_setting "$TMP/pnpm-workspace.yaml" nodeLinker)"
}

expect_node_linker 'nodeLinker: hoisted' 'nodeLinker: hoisted' 'hoisted'
expect_node_linker '末尾コメント付きでも読める' 'nodeLinker: hoisted # comment' 'hoisted'
expect_node_linker 'クォートされていても読める' 'nodeLinker: "hoisted"' 'hoisted'
expect_node_linker 'isolated は hoisted ではない' 'nodeLinker: isolated' 'isolated'
expect_node_linker 'コメントアウトされた行は読まない' '# nodeLinker: hoisted' ''
expect_node_linker 'ネストしたキーは読まない' $'foo:\n  nodeLinker: hoisted' ''

# --- 静的確認の fail 時の挙動 -----------------------------------------------------

# 実リポジトリを書き換えずに確認する。
# 必要なファイルだけを fixture へ複製し、check-pm-guard.sh が参照する REPO_ROOT と PECOTV_PLUGIN_ROOT を fixture へ向ける。
REAL_REPO_ROOT="$REPO_ROOT"
REAL_PECOTV_ROOT="$PECOTV_PLUGIN_ROOT"

make_fixture() {
    FIX="$(mktemp -d "$TMP/fix.XXXXXX")"
    local rel
    while IFS= read -r rel; do
        mkdir -p "$FIX/$(dirname "$rel")"
        cp "$REAL_REPO_ROOT/$rel" "$FIX/$rel"
    done < <(list_package_jsons "$REAL_REPO_ROOT")
    cp "$REAL_REPO_ROOT/pnpm-workspace.yaml" "$FIX/"
    cp "$REAL_REPO_ROOT/.npmrc" "$FIX/"
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
expect_static() {
    local label="$1" needle="$2"
    run_static_on_fixture
    if [ -z "$needle" ]; then
        if [ "$STATIC_RC" -eq 0 ]; then bt_pass "$label"; else bt_fail "$label" "pass を期待、rc=$STATIC_RC: $STATIC_OUT"; fi
    elif [ "$STATIC_RC" -ne 0 ] && [[ "$STATIC_OUT" == *"$needle"* ]]; then
        bt_pass "$label"
    else
        bt_fail "$label" "「$needle」で失敗することを期待、rc=$STATIC_RC: $STATIC_OUT"
    fi
}

VIS=plugins/pecot-visual

make_fixture
expect_static '静的確認: 現行ツリーの複製は pass する' ''

sed -i 's/^nodeLinker: hoisted$/nodeLinker: isolated/' "$FIX/pnpm-workspace.yaml"
expect_static '静的確認: nodeLinker: hoisted が無いと落ちる' 'nodeLinker: hoisted が無い'

make_fixture
sed -i 's/^nodeLinker: hoisted$/nodeLinker: hoisted # 末尾コメント/' "$FIX/pnpm-workspace.yaml"
expect_static '静的確認: nodeLinker の末尾コメントでは落ちない' ''

make_fixture
edit_fixture_pkg package.json 'p.devEngines.packageManager.onFail="warn"'
expect_static '静的確認: ルートの onFail が download でないと落ちる' 'devEngines.packageManager が { name: pnpm, version, onFail: download } でない: package.json'

make_fixture
edit_fixture_pkg package.json 'delete p.devEngines'
expect_static '静的確認: ルートの宣言の欠けで落ちる' 'devEngines.packageManager の宣言が無い: package.json'

make_fixture
edit_fixture_pkg libs/text-rules/package.json 'delete p.devEngines'
expect_static '静的確認: libs/text-rules の宣言の欠けで落ちる' 'devEngines.packageManager の宣言が無い: libs/text-rules/package.json'

make_fixture
edit_fixture_pkg $VIS/cli/package.json 'delete p.devEngines'
expect_static '静的確認: メンバーの宣言の欠けで落ちる' "devEngines.packageManager の宣言が無い: $VIS/cli/package.json"

make_fixture
edit_fixture_pkg $VIS/package.json 'delete p.devEngines'
expect_static '静的確認: プラグインのルートの宣言の欠けで落ちる' "devEngines.packageManager の宣言が無い: $VIS/package.json"

make_fixture
edit_fixture_pkg package.json 'p.devEngines.packageManager=[p.devEngines.packageManager]'
expect_static '静的確認: ルートの配列の宣言で落ちる' 'devEngines.packageManager が配列'

make_fixture
edit_fixture_pkg $VIS/cli/package.json 'p.devEngines.packageManager=[p.devEngines.packageManager]'
expect_static '静的確認: メンバーの配列の宣言で落ちる' "devEngines.packageManager が配列（corepack は配列を読まずに無視する。オブジェクトにする）: $VIS/cli/package.json"

make_fixture
edit_fixture_pkg $VIS/cli/package.json 'p.engines.npm="<0.0.0"'
expect_static '静的確認: engines の余分なキーで落ちる' "engines に node 以外のキーがある（npm）: $VIS/cli/package.json"

make_fixture
edit_fixture_pkg package.json 'p.engines={pnpm:"<0.0.0"}'
expect_static '静的確認: ルートの engines の余分なキーで落ちる' 'engines に node 以外のキーがある（pnpm）: package.json'

make_fixture
printf 'engine-strict=true\n' > "$FIX/$VIS/cli/.npmrc"
expect_static '静的確認: プラグインの下の .npmrc の残りで落ちる' ".npmrc はルートの 1 本だけに置く（プラグインの下に置かない）: $VIS/cli/.npmrc"

make_fixture
rm "$FIX/.npmrc"
expect_static '静的確認: ルートの .npmrc が無いと落ちる' 'engine-strict=true が無い'

make_fixture
edit_fixture_pkg $VIS/package.json 'p.devEngines.packageManager.version="12.16.1"'
expect_static '静的確認: packageManager と devEngines の版のずれで落ちる' 'packageManager（'"'pnpm@12.15.0'"'）が devEngines.packageManager の版（pnpm@12.16.1）とずれている'

make_fixture
edit_fixture_pkg $VIS/package.json 'p.devEngines.packageManager.version="^12.15.0"'
expect_static '静的確認: プラグインのルートの版が完全一致の semver でないと落ちる' '完全一致の semver でない'

make_fixture
edit_fixture_pkg $VIS/package.json 'p.devEngines.packageManager.onFail="error"'
expect_static '静的確認: プラグインのルートの onFail が download でないと落ちる' 'devEngines.packageManager が { name: pnpm, version, onFail: download } でない'

make_fixture
edit_fixture_pkg $VIS/cli/package.json 'p.packageManager="pnpm@12.15.0"'
expect_static '静的確認: メンバーに packageManager があると落ちる' 'packageManager はプラグインのルートだけに置く'

make_fixture
edit_fixture_pkg $VIS/cli/package.json 'p.devEngines.packageManager.name="npm"'
expect_static '静的確認: メンバーが pnpm でないと落ちる' "devEngines.packageManager が { name: pnpm, onFail: error } でない: $VIS/cli/package.json"

make_fixture
mkdir -p "$FIX/plugins/pecot-tools/stray"
printf '{"name":"stray"}\n' > "$FIX/plugins/pecot-tools/stray/package.json"
expect_static '静的確認: 未分類の package.json で落ちる' 'package.json の種類を分けられない'
expect_static '静的確認: 未分類の package.json は相対パスで報告する' 'plugins/pecot-tools/stray/package.json'

make_fixture
mkdir -p "$FIX/$VIS/scripts/release/audit-canary"
printf '{"name":"canary"}\n' > "$FIX/$VIS/scripts/release/audit-canary/package.json"
expect_static '静的確認: 宣言しない例外（監査の canary）は pass する' ''

make_fixture
edit_fixture_pkg $VIS/package.json 'p.scripts={...p.scripts,x:"pnpm run y"}'
expect_static '静的確認: scripts が package manager を呼ぶと落ちる' 'scripts が package manager を呼んでいる'

# scripts の確認は libs/text-rules にも掛かる。
make_fixture
edit_fixture_pkg libs/text-rules/package.json 'p.scripts={...p.scripts,x:"pnpm run y"}'
expect_static '静的確認: libs/text-rules の scripts が package manager を呼ぶと落ちる' 'libs/text-rules/package.json の'

# メンバーが root の workspace に無いプラグインの scripts 確認は、その旨で落ちる。
make_fixture
sed -i '/^  - plugins\/pecot-visual\/cli$/d' "$FIX/pnpm-workspace.yaml"
expect_static '静的確認: メンバーが workspace から外れて未分類になると落ちる' 'package.json の種類を分けられない'

# --- 現行ツリー ---------------------------------------------------------------

bt_eq "現行ツリー: pnpm-workspace.yaml が nodeLinker: hoisted を宣言している" hoisted \
    "$(read_workspace_setting "$REPO_ROOT/pnpm-workspace.yaml" nodeLinker)"

members=()
mapfile -t members < <(list_workspace_members "$REPO_ROOT/pnpm-workspace.yaml")
for rel in "." "${members[@]}"; do
    pkg="$REPO_ROOT/$rel/package.json"
    out="$(list_pm_invoking_scripts "$pkg")"
    bt_eq "現行ツリー: $rel の scripts は package manager を呼ばない" "" "$out"
done

bt_finish
