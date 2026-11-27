# check-pm-guard.sh と pm-guard-lib.sh の確認（scripts・devEngines の宣言・.npmrc）を確かめる (#1217 / #52)。
# guard の fail() は bats-support の fail を上書きする。guard は run-static-check.sh の子の bash で読み、表の確かめは pm-guard-lib.sh を読む。

bats_require_minimum_version 1.5.0

GUARD="$BATS_TEST_DIRNAME/../check-pm-guard.sh"
STATIC_RUNNER="$BATS_TEST_DIRNAME/run-static-check.sh"
REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../../../.." && pwd -P)"
# shellcheck source=../pm-guard-lib.sh
. "$BATS_TEST_DIRNAME/../pm-guard-lib.sh"

setup_file() {
    # 静的確認が読むファイルだけを、まっさらな複製として 1 回だけ作る。各 @test は写してから書き換える。
    local pristine="$BATS_FILE_TMPDIR/pristine" rel
    mkdir -p "$pristine"
    while IFS= read -r rel; do
        mkdir -p "$pristine/$(dirname "$rel")"
        cp "$REPO_ROOT/$rel" "$pristine/$rel"
    done < <(list_package_jsons "$REPO_ROOT")
    cp "$REPO_ROOT/pnpm-workspace.yaml" "$REPO_ROOT/.npmrc" "$pristine/"
    if [ ! -f "$pristine/package.json" ] || [ ! -f "$pristine/plugins/pecot-visual/package.json" ]; then
        echo "ERROR: fixture の package.json を複製できない" >&2
        return 1
    fi
}

setup() {
    bats_load_library pecot-bats
}

# ---- 表の確かめ（pm-guard-lib.sh） ----

# $1=scripts の JSON。$BATS_TEST_TMPDIR/package.json に書き、list_pm_invoking_scripts の結果を $output・$lines に置く。
run_list_violations() {
    printf '{"name":"probe","scripts":%s}\n' "$1" > "$BATS_TEST_TMPDIR/package.json"
    run --separate-stderr list_pm_invoking_scripts "$BATS_TEST_TMPDIR/package.json"
    assert_success
}

# $1=scripts の JSON $2=違反の件数
assert_scripts_violation() {
    explains "package manager を呼ぶ scripts を持つ \`package.json\` を、\`list_pm_invoking_scripts\` で読むテストです。呼び出しを含む script が、期待した件数だけ違反として返ることを確認します。"
    run_list_violations "$1"
    assert_equal "${#lines[@]}" "$2"
}

bats_test_function --description "node で npm_execpath を run して自分を呼ぶ script があると、違反として返す" -- assert_scripts_violation '{"build":"node \"$npm_execpath\" run build:assets"}' 1
bats_test_function --description "pnpm run で自分を呼ぶ script があると、違反として返す" -- assert_scripts_violation '{"test":"pnpm run test:plugins"}' 1
bats_test_function --description "npm run を 2 回つなぐ script があると、違反として 1 件返す" -- assert_scripts_violation '{"test":"npm run a && npm run b"}' 1
bats_test_function --description "npx で起動する script があると、違反として返す" -- assert_scripts_violation '{"x":"npx playwright install"}' 1
bats_test_function --description "corepack pnpm で起動する script があると、違反として返す" -- assert_scripts_violation '{"x":"corepack pnpm -r build"}' 1
bats_test_function --description "yarn で起動する script があると、違反として返す" -- assert_scripts_violation '{"x":"yarn build"}' 1
bats_test_function --description "c8 越しに npm_execpath を呼ぶ script があると、違反として返す" -- assert_scripts_violation '{"cov":"c8 node \"$npm_execpath\" test"}' 1
bats_test_function --description "pnpx で起動する script があると、違反として返す" -- assert_scripts_violation '{"x":"pnpx tsx a.ts"}' 1
bats_test_function --description "bunx で起動する script があると、違反として返す" -- assert_scripts_violation '{"x":"bunx tsx a.ts"}' 1
bats_test_function --description "bun run で起動する script があると、違反として返す" -- assert_scripts_violation '{"x":"bun run build"}' 1
bats_test_function --description "npm-run-all で起動する script があると、違反として返す" -- assert_scripts_violation '{"x":"npm-run-all build lint"}' 1
bats_test_function --description "run-s で起動する script があると、違反として返す" -- assert_scripts_violation '{"x":"run-s build lint"}' 1
bats_test_function --description "run-p で起動する script があると、違反として返す" -- assert_scripts_violation '{"x":"run-p build lint"}' 1
bats_test_function --description "concurrently に npm: の指定を渡す script があると、違反として返す" -- assert_scripts_violation '{"x":"concurrently \"npm:build\" \"npm:lint\""}' 1
bats_test_function --description "concurrently に pnpm: の指定を渡す script があると、違反として返す" -- assert_scripts_violation '{"x":"concurrently pnpm:build:*"}' 1
bats_test_function --description "波括弧で囲んだ npm_execpath を node に渡す script があると、違反として返す" -- assert_scripts_violation '{"x":"node ${npm_execpath} run b"}' 1
bats_test_function --description "パスで指定した pnpm を起動する script があると、違反として返す" -- assert_scripts_violation '{"x":"./node_modules/.bin/pnpm run b"}' 1
bats_test_function --description "環境変数の代入の後に npm を起動する script があると、違反として返す" -- assert_scripts_violation '{"x":"CI=1 npm test"}' 1
bats_test_function --description "サブシェルの中で npm を起動する script があると、違反として返す" -- assert_scripts_violation '{"x":"(npm run a)"}' 1
bats_test_function --description "違反の script が 2 つあると、違反として 2 件とも返す" -- assert_scripts_violation '{"a":"pnpm a","b":"node x.mjs","c":"npm run c"}' 2

# $1=scripts の JSON
refute_scripts_violation() {
    explains "package manager を呼ばない scripts を持つ \`package.json\` を、\`list_pm_invoking_scripts\` で読むテストです。語やパスの一部に \`npm\` や \`pnpm\` を含んでも、違反が返らないことを確認します。"
    run_list_violations "$1"
    assert_output ""
}

bats_test_function --description "node と bin だけで動く scripts は、違反として返さない" -- refute_scripts_violation '{"build":"node scripts/build.mjs","lint":"eslint --no-cache . && knip","cov":"c8 sh -c \"node scripts/test.mjs\""}'
bats_test_function --description "語の一部に pnpm を含むパスは、違反として返さない" -- refute_scripts_violation '{"x":"node scripts/pnpm-lock-check.mjs","y":"cat pnpm-lock.yaml"}'
bats_test_function --description "パスの一部に npm を含む scripts は、違反として返さない" -- refute_scripts_violation '{"x":"node scripts/npm.mjs","y":"node ./tools/npm/run.mjs"}'
bats_test_function --description "スコープ付きのパッケージ名の npm- は、違反として返さない" -- refute_scripts_violation '{"x":"node node_modules/@scope/npm-foo/bin.js","y":"eslint @scope/npm-foo"}'
bats_test_function --description "npm: の指定を含まない concurrently は、違反として返さない" -- refute_scripts_violation '{"x":"concurrently \"node a.mjs\" \"node b.mjs\""}'
bats_test_function --description "scripts の無い package.json は、違反を返さない" -- refute_scripts_violation '{}'

# $1=package.json の JSON $2=期待値（<形>|<name>|<version>|<onFail>|<engines の node 以外>|<packageManager>）
assert_pm_declaration() {
    explains "\`read_pm_declaration\` で \`package.json\` の宣言を読むテストです。\`devEngines.packageManager\` の形と値、\`engines\` の \`node\` 以外のキー、\`packageManager\` が、決まった順に区切られて返ることを確認します。"
    printf '%s\n' "$1" > "$BATS_TEST_TMPDIR/package.json"
    run --separate-stderr read_pm_declaration "$BATS_TEST_TMPDIR/package.json"
    assert_success
    assert_output "$2"
}

bats_test_function --description "devEngines.packageManager が単体のオブジェクトなら、形と name と onFail を返す" -- assert_pm_declaration '{"devEngines":{"packageManager":{"name":"npm","onFail":"error"}}}' 'object|npm||error||'
bats_test_function --description "devEngines の version と packageManager があると、両方の値を返す" -- assert_pm_declaration '{"packageManager":"pnpm@1.2.3+sha512.ab","devEngines":{"packageManager":{"name":"pnpm","version":"1.2.3","onFail":"download"}}}' 'object|pnpm|1.2.3|download||pnpm@1.2.3+sha512.ab'
bats_test_function --description "devEngines.packageManager が配列なら、形に array を返す" -- assert_pm_declaration '{"devEngines":{"packageManager":[{"name":"npm","onFail":"error"}]}}' 'array|||||'
bats_test_function --description "devEngines の宣言が無いと、形に none を返す" -- assert_pm_declaration '{}' 'none|||||'
bats_test_function --description "engines に node 以外のキーがあると、そのキーをカンマ区切りで返す" -- assert_pm_declaration '{"engines":{"node":"^24","npm":"<0.0.0","yarn":"<0.0.0"}}' 'none||||npm,yarn|'
bats_test_function --description "engines が node だけなら、余分なキーの欄を空で返す" -- assert_pm_declaration '{"engines":{"node":"^24"}}' 'none|||||'

# $1=pnpm-workspace.yaml の中身（\n で改行） $2=nodeLinker の期待値
assert_workspace_setting() {
    explains "\`read_workspace_setting\` で \`pnpm-workspace.yaml\` の \`nodeLinker\` を読むテストです。トップレベルのキーの値だけが YAML として読まれ、コメントの行と入れ子のキーは読まれないことを確認します。"
    printf '%b\n' "$1" > "$BATS_TEST_TMPDIR/pnpm-workspace.yaml"
    run --separate-stderr read_workspace_setting "$BATS_TEST_TMPDIR/pnpm-workspace.yaml" nodeLinker
    assert_success
    assert_output "$2"
}

bats_test_function --description "nodeLinker が hoisted なら、hoisted を返す" -- assert_workspace_setting 'nodeLinker: hoisted' 'hoisted'
bats_test_function --description "nodeLinker の行の末尾にコメントがあっても、値だけを返す" -- assert_workspace_setting 'nodeLinker: hoisted # comment' 'hoisted'
bats_test_function --description "nodeLinker の値がクォートされていても、値だけを返す" -- assert_workspace_setting 'nodeLinker: "hoisted"' 'hoisted'
bats_test_function --description "nodeLinker が isolated なら、isolated を返す" -- assert_workspace_setting 'nodeLinker: isolated' 'isolated'
bats_test_function --description "コメントアウトした nodeLinker の行は、読まずに空を返す" -- assert_workspace_setting '# nodeLinker: hoisted' ''
bats_test_function --description "入れ子のキーの nodeLinker は、読まずに空を返す" -- assert_workspace_setting 'foo:\n  nodeLinker: hoisted' ''

# ---- 静的確認の失敗の挙動（check-pm-guard.sh） ----

# 書き換えの手順。どれも fixture の root を cwd にして呼ぶ。
# $1=package.json の相対パス $2=p を書き換える JS の文
edit_pkg() {
    node -e 'const fs=require("fs");const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,"utf8"));eval(process.argv[2]);fs.writeFileSync(f,JSON.stringify(p,null,2))' "$1" "$2"
}

# $1=相対パス $2=中身の 1 行
put_file() {
    mkdir -p "$(dirname "$1")"
    printf '%s\n' "$2" > "$1"
}

# $1=ファイル $2=置き換える行 $3=新しい行（省くと行を消す）。行が無ければ失敗する。
replace_line() {
    grep -qxF -- "$2" "$1" || { echo "行が無い: $1: $2" >&2; return 1; }
    awk -v old="$2" -v new="${3-}" -v del="$(($# < 3))" '$0 == old { if (del) next; print new; next } { print }' "$1" > "$1.new"
    mv "$1.new" "$1"
}

# 静的確認の 1 行。$1=落ちるときの文言（空なら通る） $2...=書き換えの手順
# まっさらな複製を写して書き換え、子の bash で guard を読んで run_static_check を動かす。
static_case() {
    local needle="$1" fix="$BATS_TEST_TMPDIR/fix"
    shift
    cp -R "$BATS_FILE_TMPDIR/pristine" "$fix"
    (cd "$fix" && "$@") || fail "fixture を書き換えられない: $*"
    run_attached bash "$STATIC_RUNNER" "$GUARD" "$fix"
    if [ -z "$needle" ]; then
        assert_success
        assert_output --partial "OK: 全 package.json の宣言と .npmrc"
    else
        assert_failure
        assert_output --partial "$needle"
    fi
}

VIS=plugins/pecot-visual

# $@=書き換えの手順
assert_static_accepts() {
    explains "現行ツリーの \`package.json\` などを複製した fixture に、受け入れられる書き換えをして静的確認を動かすテストです。終了コード 0 で終わることを確認します。"
    static_case "" "$@"
}

bats_test_function --description "現行ツリーをそのまま複製すると、静的確認が通る" -- assert_static_accepts true
bats_test_function --description "nodeLinker の行の末尾にコメントを付けても、静的確認が通る" -- assert_static_accepts replace_line pnpm-workspace.yaml 'nodeLinker: hoisted' 'nodeLinker: hoisted # 末尾コメント'
bats_test_function --description "宣言しない例外の監査の canary を置いても、静的確認が通る" -- assert_static_accepts put_file "$VIS/scripts/release/audit-canary/package.json" '{"name":"canary"}'

# $1=落ちるときの文言 $2...=書き換えの手順
assert_static_rejects_workspace() {
    explains "fixture の \`pnpm-workspace.yaml\` を書き換えて、静的確認を動かすテストです。\`nodeLinker: hoisted\` が無い場合と、メンバーが \`packages\` から外れた場合に、失敗することを確認します。"
    static_case "$@"
}

bats_test_function --description "nodeLinker が hoisted でないと、静的確認が落ちる" -- assert_static_rejects_workspace 'nodeLinker: hoisted が無い' replace_line pnpm-workspace.yaml 'nodeLinker: hoisted' 'nodeLinker: isolated'
bats_test_function --description "メンバーが workspace から外れて未分類になると、静的確認が落ちる" -- assert_static_rejects_workspace 'package.json の種類を分けられない' replace_line pnpm-workspace.yaml "  - $VIS/cli"

# $1=落ちるときの文言 $2...=書き換えの手順
assert_static_rejects_missing_declaration() {
    explains "fixture の \`package.json\` から \`devEngines\` を削除して、静的確認を動かすテストです。宣言の無い \`package.json\` を、相対パスで示して失敗することを確認します。"
    static_case "$@"
}

bats_test_function --description "ルートの package.json に devEngines が無いと、静的確認が落ちる" -- assert_static_rejects_missing_declaration 'devEngines.packageManager の宣言が無い: package.json' edit_pkg package.json 'delete p.devEngines'
bats_test_function --description "libs/text-rules に devEngines が無いと、静的確認が落ちる" -- assert_static_rejects_missing_declaration 'devEngines.packageManager の宣言が無い: libs/text-rules/package.json' edit_pkg libs/text-rules/package.json 'delete p.devEngines'
bats_test_function --description "workspace のメンバーに devEngines が無いと、静的確認が落ちる" -- assert_static_rejects_missing_declaration "devEngines.packageManager の宣言が無い: $VIS/cli/package.json" edit_pkg "$VIS/cli/package.json" 'delete p.devEngines'
bats_test_function --description "プラグインのルートに devEngines が無いと、静的確認が落ちる" -- assert_static_rejects_missing_declaration "devEngines.packageManager の宣言が無い: $VIS/package.json" edit_pkg "$VIS/package.json" 'delete p.devEngines'

# $1=落ちるときの文言 $2...=書き換えの手順
assert_static_rejects_array() {
    explains "fixture の \`devEngines.packageManager\` を配列に書き換えて、静的確認を動かすテストです。corepack が読まない配列の宣言として、失敗することを確認します。"
    static_case "$@"
}

bats_test_function --description "ルートの devEngines.packageManager が配列だと、静的確認が落ちる" -- assert_static_rejects_array 'devEngines.packageManager が配列' edit_pkg package.json 'p.devEngines.packageManager=[p.devEngines.packageManager]'
bats_test_function --description "メンバーの devEngines.packageManager が配列だと、静的確認が落ちる" -- assert_static_rejects_array "devEngines.packageManager が配列（corepack は配列を読まずに無視する。オブジェクトにする）: $VIS/cli/package.json" edit_pkg "$VIS/cli/package.json" 'p.devEngines.packageManager=[p.devEngines.packageManager]'

# $1=落ちるときの文言 $2...=書き換えの手順
assert_static_rejects_engines() {
    explains "fixture の \`engines\` に \`node\` 以外のキーを追加して、静的確認を動かすテストです。余分なキーの名前と \`package.json\` を示して、失敗することを確認します。"
    static_case "$@"
}

bats_test_function --description "メンバーの engines に node 以外のキーがあると、静的確認が落ちる" -- assert_static_rejects_engines "engines に node 以外のキーがある（npm）: $VIS/cli/package.json" edit_pkg "$VIS/cli/package.json" 'p.engines.npm="<0.0.0"'
bats_test_function --description "ルートの engines に node 以外のキーがあると、静的確認が落ちる" -- assert_static_rejects_engines 'engines に node 以外のキーがある（pnpm）: package.json' edit_pkg package.json 'p.engines={pnpm:"<0.0.0"}'

# $1=落ちるときの文言 $2...=書き換えの手順
assert_static_rejects_npmrc() {
    explains "fixture の \`.npmrc\` をプラグインの下に置くか、ルートから削除して静的確認を動かすテストです。\`.npmrc\` がルートの 1 本だけでない場合に、失敗することを確認します。"
    static_case "$@"
}

bats_test_function --description "プラグインの下に .npmrc が残ると、静的確認が落ちる" -- assert_static_rejects_npmrc ".npmrc はルートの 1 本だけに置く（プラグインの下に置かない）: $VIS/cli/.npmrc" put_file "$VIS/cli/.npmrc" 'engine-strict=true'
bats_test_function --description "ルートの .npmrc が無いと、静的確認が落ちる" -- assert_static_rejects_npmrc 'engine-strict=true が無い' rm .npmrc

# $1=落ちるときの文言 $2...=書き換えの手順
assert_static_rejects_declaration_value() {
    explains "fixture の \`devEngines.packageManager\` や \`packageManager\` の値を書き換えて、静的確認を動かすテストです。値がルートとメンバーの種類ごとの決まりと違う場合は、失敗することを確認します。"
    static_case "$@"
}

bats_test_function --description "ルートの onFail が download でないと、静的確認が落ちる" -- assert_static_rejects_declaration_value 'devEngines.packageManager が { name: pnpm, version, onFail: download } でない: package.json' edit_pkg package.json 'p.devEngines.packageManager.onFail="warn"'
bats_test_function --description "packageManager の版が devEngines の版とずれると、静的確認が落ちる" -- assert_static_rejects_declaration_value "packageManager（'pnpm@12.15.0'）が devEngines.packageManager の版（pnpm@12.16.1）とずれている" edit_pkg "$VIS/package.json" 'p.devEngines.packageManager.version="12.16.1"'
bats_test_function --description "プラグインのルートの版が完全一致の semver でないと、静的確認が落ちる" -- assert_static_rejects_declaration_value '完全一致の semver でない' edit_pkg "$VIS/package.json" 'p.devEngines.packageManager.version="^12.15.0"'
bats_test_function --description "プラグインのルートの onFail が download でないと、静的確認が落ちる" -- assert_static_rejects_declaration_value 'devEngines.packageManager が { name: pnpm, version, onFail: download } でない' edit_pkg "$VIS/package.json" 'p.devEngines.packageManager.onFail="error"'
bats_test_function --description "メンバーに packageManager があると、静的確認が落ちる" -- assert_static_rejects_declaration_value 'packageManager はプラグインのルートだけに置く' edit_pkg "$VIS/cli/package.json" 'p.packageManager="pnpm@12.15.0"'
bats_test_function --description "メンバーの devEngines の name が pnpm でないと、静的確認が落ちる" -- assert_static_rejects_declaration_value "devEngines.packageManager が { name: pnpm, onFail: error } でない: $VIS/cli/package.json" edit_pkg "$VIS/cli/package.json" 'p.devEngines.packageManager.name="npm"'

# $1=落ちるときの文言 $2...=書き換えの手順
assert_static_rejects_scripts() {
    explains "fixture の \`scripts\` に \`pnpm run\` を呼ぶ script を追加して、静的確認を動かすテストです。違反を持つ \`package.json\` を示して、失敗することを確認します。"
    static_case "$@"
}

bats_test_function --description "プラグインのルートの scripts が package manager を呼ぶと、静的確認が落ちる" -- assert_static_rejects_scripts 'scripts が package manager を呼んでいる' edit_pkg "$VIS/package.json" 'p.scripts={...p.scripts,x:"pnpm run y"}'
bats_test_function --description "libs/text-rules の scripts が package manager を呼ぶと、静的確認が落ちる" -- assert_static_rejects_scripts 'libs/text-rules/package.json の' edit_pkg libs/text-rules/package.json 'p.scripts={...p.scripts,x:"pnpm run y"}'

# $1・$2=落ちるときの文言（理由と相対パス）
assert_static_rejects_unclassified() {
    explains "どの種類にも当たらない \`package.json\` を fixture に置いて、静的確認を動かすテストです。種類を分けられない理由と、そのファイルの相対パスを示して失敗することを確認します。"
    static_case "$1" put_file plugins/pecot-tools/stray/package.json '{"name":"stray"}'
    assert_output --partial "$2"
}

bats_test_function --description "種類を分けられない package.json があると、静的確認が落ちて相対パスを示す" -- assert_static_rejects_unclassified 'package.json の種類を分けられない' 'plugins/pecot-tools/stray/package.json'

# ---- 現行ツリー ----

@test "現行ツリーの pnpm-workspace.yaml は、nodeLinker に hoisted を宣言している" {
    explains "リポジトリの \`pnpm-workspace.yaml\` を \`read_workspace_setting\` で読むテストです。\`nodeLinker\` の値が \`hoisted\` であることを確認します。"
    run --separate-stderr read_workspace_setting "$REPO_ROOT/pnpm-workspace.yaml" nodeLinker
    assert_success
    assert_output hoisted
}

# $1=repo root からの相対パス
refute_tree_scripts_violation() {
    explains "リポジトリの root と workspace のメンバーの \`package.json\` を読むテストです。\`scripts\` が package manager を呼んでいないことを確認します。"
    run --separate-stderr list_pm_invoking_scripts "$REPO_ROOT/$1/package.json"
    assert_success
    assert_output ""
}

mapfile -t TREE_MEMBERS < <(list_workspace_members "$REPO_ROOT/pnpm-workspace.yaml")
for rel in "." "${TREE_MEMBERS[@]}"; do
    bats_test_function --description "現行ツリーの ${rel/#./root} の scripts は、package manager を呼ばない" -- refute_tree_scripts_violation "$rel"
done
