#!/bin/bash
# publish-mcp-dist.sh の検証 (#352)。配布ツリーの中身・起動・tgz・gh の呼び出しを固定する。
# gh は PATH 先頭のスタブで差し替える。cli/dist が build 済みであることが前提で、publish は --skip-build で流す。
# 早期 return の検証で非ゼロ終了を起こすため、`set -e` は使わない。
set -u

# git hook 経由で GIT_DIR 等が export されていると、リポ本体の index を書き換えるので捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE
# nx release --dry-run の親から起動されると NX_DRY_RUN が届き、非 dry-run の検証まで dry-run になる。
# 本テストは dry-run の有無を引数で作り分けるので、継承した値は先頭で捨てる。
unset NX_DRY_RUN

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$RELEASE_DIR/../../../.." && pwd)"
WORKFLOW_ROOT="$REPO_ROOT/plugins/pecot-workflow"
PUBLISH="$RELEASE_DIR/publish-mcp-dist.sh"

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
# 期待値との一致を 1 行で判定する（不一致時に actual を必ず出す）。
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

# 失敗の補足に使う。末尾 N 行・全体を 1 行にまとめて返す。
# 失敗メッセージの文字列に引用符入りの $(...) を入れないため、ここへ切り出す。
# log_tail は $TMP からの相対名、file_tail / file_cat は絶対パスを受ける。
log_tail() {
    tail -"$2" "$TMP/$1" | tr '\n' ' '
}
file_tail() {
    tail -"$2" "$1" | tr '\n' ' '
}
file_cat() {
    cat "$1"
}

# build 済み dist の存在を前提条件として先に確認する（無いまま進むと publish が途中で落ち、
# 原因が build 未実行だと分からない出力になる）。
if [ ! -d "$WORKFLOW_ROOT/cli/dist" ]; then
    echo "ERROR: $WORKFLOW_ROOT/cli/dist がありません。build 済みの dist が前提です。" >&2
    echo "  bash plugins/pecot-workflow/scripts/ci/run-tests.sh --scope=release" >&2
    exit 1
fi

# --- PATH 先頭のスタブ ---
# gh: 引数を GH_STUB_LOG に記録し、upload された tgz を GH_STUB_DIR/uploaded.tgz へ写す。GH_STUB_NO_RELEASE=1 で release view が失敗する。
# npm: install だけ永続キャッシュと --prefer-offline を足して本物へ渡す。非 dry-run の publish_real だけが PATH の先頭に置く。
mkdir -p "$TMP/bin" "$TMP/npmbin"
REAL_NPM="$(command -v npm)"
# 非 dry-run の実行は opt-in を拒否するので、スタブ側で永続キャッシュを足す。
# publish が渡す --cache は使い捨てなので、後ろに足した --cache が上書きする。
NPM_PERSIST_CACHE="${PECOT_RELEASE_TEST_NPM_CACHE:-$TMP/npm-persist-cache}"
export REAL_NPM NPM_PERSIST_CACHE
cat > "$TMP/bin/gh" << 'STUB_GH'
#!/bin/bash
printf '%s\n' "$*" >> "$GH_STUB_LOG"
case "$1 $2" in
    "release view")
        if [ "${GH_STUB_NO_RELEASE:-}" = 1 ]; then
            echo "release not found" >&2
            exit 1
        fi
        ;;
    "release upload")
        cp "$4" "$GH_STUB_DIR/uploaded.tgz"
        ;;
esac
exit 0
STUB_GH
cat > "$TMP/npmbin/npm" << 'STUB_NPM'
#!/bin/bash
case "$1" in
    install) exec "$REAL_NPM" "$@" "--cache=$NPM_PERSIST_CACHE" --prefer-offline ;;
esac
exec "$REAL_NPM" "$@"
STUB_NPM
chmod +x "$TMP/bin/gh" "$TMP/npmbin/npm"
export GH_STUB_DIR="$TMP/gh-stub"
export GH_STUB_LOG="$GH_STUB_DIR/calls.log"
mkdir -p "$GH_STUB_DIR"
export PATH="$TMP/bin:$PATH"
gh_reset() {
    : > "$GH_STUB_LOG"
    rm -f "$GH_STUB_DIR/uploaded.tgz"
}
gh_reset
# 非 dry-run の publish を起動する。引数は env に渡す command 以降。
# opt-in 付きでは拒否されるので、呼び出しごとに外す。永続キャッシュを足す npm スタブは、ここだけで PATH の先頭に置く。
publish_real() {
    env -u PECOT_RELEASE_TEST_NPM_CACHE PATH="$TMP/npmbin:$PATH" "$@"
}

DIST="$TMP/dist"
PLUGIN_VERSION="$(node -e "process.stdout.write(require('$WORKFLOW_ROOT/.claude-plugin/plugin.json').version)")"

export GIT_AUTHOR_NAME="pecot-workflow release test" GIT_AUTHOR_EMAIL="pecot-workflow-release-test@example.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

# 冪等性の確認は HEAD のタグで判定する。タグはリポ本体に作らず（残ると push に巻き込まれる）、
# 作業ツリーから組んだ使い捨てリポの中に立てる。
TEST_VERSION="0.0.0-test$$"
TEST_TAG="pecot-workflow-v$TEST_VERSION"
TEST_REPO="$TMP/repo"
TEST_WORKFLOW="$TEST_REPO/plugins/pecot-workflow"
mkdir -p "$TEST_REPO"
git init --quiet --initial-branch=main "$TEST_REPO" || exit 1
# gh の -R は origin の URL から求める。合成した owner/name の https URL を置く。
TEST_SLUG="acme-labs/example-repo"
git -C "$TEST_REPO" remote add origin "https://github.com/$TEST_SLUG.git" || exit 1
# git 管理対象の入力（manifest・bin・テンプレート・gitignore 補完・scripts）。ls-files 経由で列挙して
# node_modules 等を自動的に外す。bin は publish-mcp-dist.sh が resolve_pnpm 解決のため
# bin/_lib.sh を source する（run-tests.sh と共通）ので同梱する。
(cd "$REPO_ROOT" && git ls-files -z -- \
    plugins/pecot-workflow/.claude-plugin \
    plugins/pecot-workflow/bin \
    plugins/pecot-workflow/package.json \
    plugins/pecot-workflow/cli/package.json \
    plugins/pecot-workflow/cli/templates \
    plugins/pecot-workflow/hooks/lib/core/pecot-gitignore-ensure.sh \
    plugins/pecot-workflow/scripts/release \
    LICENSE \
    | tar --null -T - -cf -) | tar -xf - -C "$TEST_REPO" || exit 1
# scripts/release は作業ツリーから丸ごと上書きする（git ls-files は追加直後の未追跡ファイルを落とすため）。
rm -rf "$TEST_WORKFLOW/scripts/release" || exit 1
mkdir -p "$TEST_WORKFLOW/scripts" || exit 1
cp -a "$WORKFLOW_ROOT/scripts/release" "$TEST_WORKFLOW/scripts/release" || exit 1
# 共通スクリプト（pack から gh まで）も同じ理由で作業ツリーから置く。
mkdir -p "$TEST_REPO/.githooks/scripts" || exit 1
cp -a "$REPO_ROOT/.githooks/scripts/attach-mcp-tgz.sh" "$REPO_ROOT/.githooks/scripts/origin-slug.mjs" "$TEST_REPO/.githooks/scripts/" || exit 1
# git 管理外の build 生成物は実体を持ち込む。
cp -a "$WORKFLOW_ROOT/cli/dist" "$TEST_WORKFLOW/cli/dist" || exit 1
git -C "$TEST_REPO" add -A > /dev/null 2>&1 || exit 1
git -C "$TEST_REPO" commit --quiet -m "test fixture" > /dev/null 2>&1 || exit 1
git -C "$TEST_REPO" tag "$TEST_TAG" HEAD || exit 1
TAGGED_PUBLISH="$TEST_WORKFLOW/scripts/release/publish-mcp-dist.sh"

# --- 1. dry-run で配布ツリーを構築する ---

echo "==> dry-run で配布ツリーを構築"
if bash "$PUBLISH" --dry-run --skip-build --out-dir="$DIST" > "$TMP/dryrun.log" 2>&1; then
    pass "dry-run が正常終了する"
else
    fail "dry-run が失敗した (末尾ログ: $(log_tail dryrun.log 3))"
    echo "--- dry-run log ---"
    cat "$TMP/dryrun.log"
    echo "PASS: $PASS / FAIL: $FAIL"
    exit 1
fi
if grep -qF "dry-run=true" "$TMP/dryrun.log"; then
    pass "dry-run であることをログに出す"
else
    fail "dry-run であることをログに出さない ($(log_tail dryrun.log 2))"
fi
if grep -qF "dry-run のため gh は実行しません" "$TMP/dryrun.log"; then
    pass "dry-run が gh を実行せず終わる"
else
    fail "dry-run の終了メッセージが無い ($(log_tail dryrun.log 2))"
fi
# dry-run は npm pack まで実行する。tgz の名前と中身の一覧を出力に残す。
if grep -qF "tgz: pecot-workflow-mcp-$PLUGIN_VERSION.tgz" "$TMP/dryrun.log"; then
    pass "dry-run が tgz の名前を出力する"
else
    fail "dry-run が tgz の名前を出力しない ($(log_tail dryrun.log 8))"
fi
if grep -qE '^    LICENSE$' "$TMP/dryrun.log"; then
    pass "dry-run の中身の一覧に LICENSE がある"
else
    fail "dry-run の中身の一覧に LICENSE が無い"
fi
if grep -E '^    ' "$TMP/dryrun.log" | grep -E '\.map$|cert' > /dev/null; then
    fail "dry-run の中身の一覧に .map か cert を含むパスがある"
else
    pass "dry-run の中身の一覧に .map と cert を含むパスが無い"
fi
if grep -qE "gh release upload pecot-workflow-v$PLUGIN_VERSION pecot-workflow-mcp-$PLUGIN_VERSION.tgz --clobber -R [^ /]+/[^ /]+\$" "$TMP/dryrun.log" \
    && grep -qE "gh workflow run publish-npm.yml -f tag=pecot-workflow-v$PLUGIN_VERSION --ref pecot-workflow-v$PLUGIN_VERSION -R [^ /]+/[^ /]+\$" "$TMP/dryrun.log"; then
    pass "dry-run が gh release upload と gh workflow run を表示する"
else
    fail "dry-run が gh の表示を出さない ($(log_tail dryrun.log 4))"
fi
assert_eq "dry-run は gh を呼ばない" "0" "$(wc -l < "$GH_STUB_LOG" | tr -d ' ')"
# dry-run の表示は、タグの版が nx の上げる前の値であることを添える。
if grep -qF "版は version の段階より前の値です" "$TMP/dryrun.log"; then
    pass "dry-run が、表示するタグの版は本実行で変わり得ると注記する"
else
    fail "dry-run の表示に版の注記が無い ($(log_tail dryrun.log 3))"
fi

# F-04: forwardAllArgs: false のため、本番で dry-run が届くのは NX_DRY_RUN 環境変数だけ。
# --dry-run フラグを付けずに環境変数だけで同じ終了メッセージになることを固定する。
echo "==> NX_DRY_RUN=1 (フラグ無し) でも dry-run になる"
if NX_DRY_RUN=1 bash "$PUBLISH" --skip-build --out-dir="$TMP/dist-nx-dry-run" \
    > "$TMP/nxdryrun.log" 2>&1; then
    pass "NX_DRY_RUN=1 の実行が正常終了する"
else
    fail "NX_DRY_RUN=1 の実行が失敗した ($(log_tail nxdryrun.log 3))"
fi
if grep -qF "dry-run=true" "$TMP/nxdryrun.log"; then
    pass "NX_DRY_RUN=1 が dry-run であることをログに出す"
else
    fail "NX_DRY_RUN=1 で dry-run であることをログに出さない ($(log_tail nxdryrun.log 2))"
fi
if grep -qF "dry-run のため gh は実行しません" "$TMP/nxdryrun.log"; then
    pass "NX_DRY_RUN=1 が gh を実行せず終わる"
else
    fail "NX_DRY_RUN=1 の終了メッセージが無い ($(log_tail nxdryrun.log 2))"
fi
assert_eq "NX_DRY_RUN=1 でも gh を呼ばない" "0" "$(wc -l < "$GH_STUB_LOG" | tr -d ' ')"

# F-17: forwardAllArgs: false を選んだ根拠そのもの。未対応引数は exit 1 になる。
if bash "$PUBLISH" --dryRun=true --skip-build --out-dir="$TMP/dist-badflag" \
    > "$TMP/badflag.log" 2>&1; then
    fail "--dryRun=true が exit 1 にならなかった"
else
    pass "--dryRun=true が exit 1 になる"
fi
# 配布先の上書き（--repo）は無い。
if bash "$PUBLISH" --dry-run --skip-build --repo=acme-labs/example-repo --out-dir="$TMP/dist-repoflag" \
    > "$TMP/repoflag.log" 2>&1; then
    fail "--repo が受け付けられた"
else
    pass "--repo は未対応の引数として exit 1 になる"
fi

# --- 2. 配布ツリーの中身 ---

read_manifest() {
    node -e "
const m = require('$DIST/package.json')
const q = process.argv[1]
if (q === 'version') process.stdout.write(m.version)
else if (q === 'name') process.stdout.write(m.name)
else if (q === 'bin') process.stdout.write(JSON.stringify(m.bin))
else if (q === 'license') process.stdout.write(m.license)
else if (q === 'repository') process.stdout.write(JSON.stringify(m.repository))
else if (q === 'engines') process.stdout.write(Object.keys(m.engines).sort().join(','))
else if (q === 'hasDevEngines') process.stdout.write(String('devEngines' in m))
else if (q === 'deps') process.stdout.write(Object.keys(m.dependencies).sort().join(','))
else if (q === 'hasScripts') process.stdout.write(String('scripts' in m))
" "$1"
}

assert_eq "package.json の name が配布パッケージ名" "@pecot/workflow-mcp" "$(read_manifest name)"
assert_eq "package.json の version がプラグイン版と一致" "$PLUGIN_VERSION" "$(read_manifest version)"
assert_eq "package.json の bin が shim を指す" '{"pecot-workflow-mcp":"bin/pecot-workflow-mcp.mjs"}' "$(read_manifest bin)"
assert_eq "package.json の license が MIT" "MIT" "$(read_manifest license)"
assert_eq "package.json の repository が公開リポを指す" \
    '{"type":"git","url":"git+https://github.com/pecotcraft/pecot.git","directory":"plugins/pecot-workflow"}' "$(read_manifest repository)"
# engines は node のみ。
assert_eq "package.json の engines は node のみ" "node" "$(read_manifest engines)"
# devEngines に pnpm を写すと、npm が EBADDEVENGINES で止まり、npx 自身が起動しない。
assert_eq "package.json に devEngines キーが無い" "false" "$(read_manifest hasDevEngines)"
# 配布物は npx が展開するだけで、ビルド・テストの script は持たない。
assert_eq "package.json に scripts キーが無い" "false" "$(read_manifest hasScripts)"

# 期待値を列挙で持つと finalize-dist.mjs の宣言を人手で写しただけになり、両方が同時に
# 古くなって drift を検出できない。cli/package.json の dependencies と等値比較する。
cli_dep_set() {
    node -e "process.stdout.write(Object.keys(require('$WORKFLOW_ROOT/cli/package.json').dependencies).sort().join(','))"
}
assert_eq "配布 package.json の依存が cli/package.json の dependencies と一致する" \
    "$(cli_dep_set)" "$(read_manifest deps)"

# 実行時に node が解決する bare import は、すべて配布 package.json で宣言されている必要がある。
# 宣言が無いと、npm の hoisting 次第で解決できたりできなかったりする。
SCAN_RESULT="$(node -e "
const fs = require('node:fs'), path = require('node:path')
const [dist] = process.argv.slice(1)
const walk = (dir) => fs.readdirSync(dir).flatMap((entry) => {
  const child = path.join(dir, entry)
  return fs.statSync(child).isDirectory() ? walk(child) : [child]
})
const declared = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(dist, 'package.json'), 'utf8')).dependencies))
const packageOf = (specifier) => {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}
const missing = new Set()
let matchCount = 0
// tsc の出力がダブルクォートに変わっても走査が無効化されないよう両方の引用符に対応する。
for (const file of walk(path.join(dist, 'cli/dist'))) {
  if (!file.endsWith('.js')) continue
  const source = fs.readFileSync(file, 'utf8')
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*(['\"])([^'\"]+)\1/g)) {
    matchCount++
    const specifier = match[2]
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
    const name = packageOf(specifier)
    if (!declared.has(name)) missing.add(name)
  }
}
process.stdout.write(JSON.stringify({ missing: [...missing].sort(), matchCount }))
" "$DIST")"
UNDECLARED="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).missing.join(','))" "$SCAN_RESULT")"
IMPORT_MATCH_COUNT="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).matchCount))" "$SCAN_RESULT")"
assert_eq "cli/dist の bare import がすべて配布 package.json で宣言されている" "" "$UNDECLARED"
if [ "$IMPORT_MATCH_COUNT" -ge 1 ] 2> /dev/null; then
    pass "bare import の走査が 1 件以上を検出する（走査 0 件での無条件 pass を防ぐ）"
else
    fail "bare import の走査が 0 件になった。正規表現が無効化されている疑い (matchCount=$IMPORT_MATCH_COUNT)"
fi

assert_eq "npm-shrinkwrap.json が lockfileVersion 3 で生成される" "3" \
    "$(node -e "process.stdout.write(String(require('$DIST/npm-shrinkwrap.json').lockfileVersion))" 2> /dev/null)"
assert_eq ".claude-plugin/plugin.json が実版を持つ" "$PLUGIN_VERSION" \
    "$(node -e "process.stdout.write(require('$DIST/.claude-plugin/plugin.json').version)" 2> /dev/null)"

# cli/dist は平坦なコピーではなくサブディレクトリを持つ。MCP サーバの起動に要る 4 点が
# 階層ごと届いていることを見る（cp の -a 落ちや部分コピーの検出）。
for entry in cli.js package.json infra/template-store.js mcp/server.js; do
    if [ -f "$DIST/cli/dist/$entry" ]; then
        pass "cli/dist/$entry が配布ツリーにある"
    else
        fail "cli/dist/$entry が配布ツリーに無い"
    fi
done

# サーバが実行時に dist の外から読むファイル。テンプレートは issue_comment の prepare 等、
# gitignore 補完のスクリプトは worktree_* が読む。同梱し忘れると、起動はしても呼んだときに失敗する。
for entry in cli/templates/comment/plan.md hooks/lib/core/pecot-gitignore-ensure.sh; do
    if [ -f "$DIST/$entry" ]; then
        pass "$entry が配布ツリーにある"
    else
        fail "$entry が配布ツリーに無い"
    fi
done

assert_eq "配布ツリーに .gitignore が無い" "0" \
    "$(find "$DIST" -name '.gitignore' | wc -l | tr -d ' ')"
# ソースマップは npm の配布物に入れない（spec 018 US4）。
assert_eq "配布ツリーにソースマップ（*.map）が無い" "0" \
    "$(find "$DIST" -name '*.map' -type f | wc -l | tr -d ' ')"

# MIT は許諾表示の同梱を条件にする。ルートの LICENSE と同じ中身が配布ツリーに届く。
if cmp -s "$REPO_ROOT/LICENSE" "$DIST/LICENSE"; then
    pass "配布ツリーにルートの LICENSE が写る"
else
    fail "配布ツリーの LICENSE が無いか、ルートの LICENSE と違う"
fi
assert_eq "配布ツリーに cert を含むパスが無い" "0" \
    "$(find "$DIST" -iname '*cert*' | wc -l | tr -d ' ')"

if [ -x "$DIST/bin/pecot-workflow-mcp.mjs" ]; then
    pass "bin shim に実行権がある"
else
    fail "bin shim に実行権がない"
fi

# --- 3. README の登録例 ---

# 登録例は npm のパッケージ名を直に書く。URL のプレースホルダも git の URL も残らない。
# 2 件 = 直接起動の登録例 + WSL 経由の登録例（bash -lc の行は引用符が付かず対象外）。
assert_eq "README に git の URL が残っていない" "0" \
    "$(grep -c 'git+' "$DIST/README.md" | tr -d ' ')"
# プレースホルダの名前は固定せず、`__` で囲んだ語が未置換で残っていないことを見る。
assert_eq "README に未置換のプレースホルダ（__NAME__）が残っていない" "0" \
    "$(grep -cE '__[A-Za-z0-9_]+__' "$DIST/README.md" | tr -d ' ')"
assert_eq "README の登録例 2 件が @pecot/workflow-mcp を指す" "2" \
    "$(grep -cF '"--package=@pecot/workflow-mcp", "pecot-workflow-mcp"]' "$DIST/README.md" | tr -d ' ')"
# devEngines を持つリポの中でも起動できるよう、登録例は --prefix を付ける。
assert_eq "README の登録例 2 件が --prefix を付ける" "2" \
    "$(grep -cF '"--prefix=/"' "$DIST/README.md" | tr -d ' ')"
# 登録例のサーバ名は initialize の serverInfo.name に合わせる。
assert_eq "README の登録例 2 件がサーバ名 pecot-workflow を使う" "2" \
    "$(grep -cF '"pecot-workflow":' "$DIST/README.md" | tr -d ' ')"

# --- 4. 配布ツリーの起動 smoke ---
# 構築した配布ツリーを起動して JSON-RPC を往復させる。npx が作る node_modules は symlink で再現し、ネットワーク無しで回す。

MISSING_LINKS="$(node -e "
const fs = require('node:fs'), path = require('node:path')
const [dist, base] = process.argv.slice(1)
// 解決の起点は cli（配布 package.json の依存はすべて cli/package.json 由来）。
// require.resolve はエントリのファイルを返すだけで package の実体ディレクトリを返さず、
// exports に package.json を公開しないパッケージでは /package.json も引けない。そのため
// node_modules を実際に辿って package の実体ディレクトリを引き当てる。
const rootOf = (spec) => {
  let dir = path.resolve(base)
  for (;;) {
    const candidate = path.join(dir, 'node_modules', spec)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate)
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}
const missing = []
const dependencies = JSON.parse(fs.readFileSync(path.join(dist, 'package.json'), 'utf8')).dependencies
for (const spec of Object.keys(dependencies)) {
  const root = rootOf(spec)
  if (root === null) { missing.push(spec); continue }
  const link = path.join(dist, 'node_modules', spec)
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(root, link)
}
process.stdout.write(missing.join(','))
" "$DIST" "$WORKFLOW_ROOT/cli")"
assert_eq "配布 package.json の依存がすべてローカルに実体を持つ" "" "$MISSING_LINKS"

cat > "$TMP/smoke.mjs" << 'SMOKE'
// MCP サーバを stdio で起動し、initialize / tools/list を送って応答が揃うまで待つ。
// 揃ったら要約（initialize の serverInfo.name・tools/list の件数・先頭ツール名・全ツール名・
// 任意の tools/call 結果）を 1 行 JSON で返す。起動そのものに失敗したときだけ
// `FAIL: <理由>` を返す。
//
// 使い方: node smoke.mjs <script> [args...]  （script は node で起動する）
// 環境変数 SMOKE_TOOL_CALLS に [{"name":..,"arguments":{..}}, ...] の JSON を渡すと、
// tools/list の後に続けて tools/call を送り、各応答の終了コード（_meta）と本文を
// 返り値の calls 配列（呼び出し順）に載せる（配布ツリーが実際に起動して応答することの検証。
// tools/list が緑のまま tools/call だけ壊れる回帰を拾うため）。
// 環境変数 SMOKE_CWD があれば、それをサーバの cwd にする。
import { spawn } from 'node:child_process'

const command = process.argv.slice(2)
const TIMEOUT_MS = 120_000
const CALLS = process.env['SMOKE_TOOL_CALLS'] === undefined
  ? []
  : JSON.parse(process.env['SMOKE_TOOL_CALLS'])
const CALL_ID_BASE = 100
const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-smoke', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ...CALLS.map((call, index) => ({ jsonrpc: '2.0', id: CALL_ID_BASE + index, method: 'tools/call', params: call }))
]
const expected = requests.filter((message) => message.id !== undefined).map((message) => message.id)

const child = spawn(process.execPath, command, { stdio: ['pipe', 'pipe', 'pipe'], cwd: process.env['SMOKE_CWD'] })
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

const listed = seen.get(2)
if (listed?.error !== undefined) {
  process.stdout.write(JSON.stringify({ error: String(listed.error.message ?? '') }))
  process.exit(0)
}
const tools = listed?.result?.tools ?? []
const calls = CALLS.map((_, index) => {
  const response = seen.get(CALL_ID_BASE + index)
  const outcome = response?.result?._meta?.['io.github.pecotcraft/outcome']
  const text = (response?.result?.content ?? []).map((block) => block.text ?? '').join('')
  return { exitCode: outcome?.exitCode ?? null, isError: response?.result?.isError ?? false, text }
})
const initialized = seen.get(1)
process.stdout.write(JSON.stringify({
  toolCount: tools.length,
  firstTool: tools[0]?.name ?? '',
  toolNames: tools.map((tool) => tool.name),
  serverName: initialized?.result?.serverInfo?.name ?? '',
  calls
}))
SMOKE

smoke_value() {
    node -e "
const fs = require('node:fs')
let value
try { value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')) }
catch { process.stdout.write('PARSE_ERROR'); process.exit(0) }
value = value[process.argv[2]]
process.stdout.write(value === undefined ? '' : String(value))
" "$1" "$2"
}

# tools/list の期待値。MCP のツールの数と先頭は、cli/src/commands/registry.ts の COMMANDS の並びで決まる。
# 配布ツリーに TS ソースは含まれず、ここから参照できないので写している（cli/tests/bootstrap/run.sh と同値）。
EXPECTED_TOOL_COUNT=34
EXPECTED_FIRST_TOOL="add_to_project"

# smoke の起動は、プラグインとセッションの環境変数を外す。値が残ると、同梱し忘れたテンプレートも
# ソースツリーから読めて、smoke が通ってしまう。
smoke_node() {
    env -u CLAUDE_PLUGIN_ROOT -u PLUGIN_ROOT -u COPILOT_PLUGIN_ROOT \
        -u COPILOT_SESSION_CWD -u CLAUDE_PROJECT_DIR -u PECOT_SESSION_PROJECT_DIR \
        node "$TMP/smoke.mjs" "$@"
}

# 登録例と同じ引数なし起動と、`mcp` を明示した起動の双方を見る。前者は shim の argv 注入、
# 後者は注入が無いときの素通しを担保する。
run_smoke() {
    local label="$1" out="$2"
    shift 2
    smoke_node "$@" > "$out" 2> "$out.err"
    case "$(head -c 5 "$out")" in
        FAIL:)
            smoke_output="$(file_cat "$out")"
            fail "$label で配布ツリーが MCP サーバとして起動しない ($smoke_output)"
            return 1
            ;;
        '')
            smoke_err_tail="$(file_tail "$out.err" 3)"
            fail "$label の smoke が何も出力しなかった ($smoke_err_tail)"
            return 1
            ;;
    esac
    local error
    error="$(smoke_value "$out" error)"
    if [ -n "$error" ]; then
        fail "$label で tools/list がエラーを返した (error.message: $error)"
        return 1
    fi
    assert_eq "$label で tools/list が $EXPECTED_TOOL_COUNT 件を返す" \
        "$EXPECTED_TOOL_COUNT" "$(smoke_value "$out" toolCount)"
    assert_eq "$label で tools/list の先頭が COMMANDS の順になる" \
        "$EXPECTED_FIRST_TOOL" "$(smoke_value "$out" firstTool)"
}

run_smoke "引数なし起動" "$TMP/smoke-default.json" "$DIST/bin/pecot-workflow-mcp.mjs"
run_smoke "mcp を明示した起動" "$TMP/smoke-mcp.json" "$DIST/bin/pecot-workflow-mcp.mjs" mcp

# README のツール表（`| \`name\`` の行）が tools/list の名前列と順序込みで一致することを固定する。
# ツールの追加・改名・順序変更で表だけが古くなっても緑のままになるのを防ぐ。
README_TOOL_NAMES="$(grep -oE '^\| `[a-z][a-z0-9_]+`' "$DIST/README.md" | sed -E 's/^\| `//; s/`$//' | paste -sd, -)"
assert_eq "README のツール表が tools/list の名前と順序込みで一致する" \
    "$README_TOOL_NAMES" "$(smoke_value "$TMP/smoke-default.json" toolNames)"

# README の登録例のサーバ名（mcpServers のキー）が initialize の serverInfo.name と一致することを固定する。
assert_eq "README の登録名が initialize の serverInfo.name と一致する" "pecot-workflow" \
    "$(smoke_value "$TMP/smoke-default.json" serverName)"

# tools/list が緑でも、dist の外のファイルを読めないと tools/call は失敗する。
# 一時 git リポ（ブランチ名に Issue 番号なし）を cwd に、gh を呼ばない session_status と issue_comment (prepare) を投げる。
call_value() {
    # $1 = smoke の出力 json, $2 = calls 配列の index, $3 = 'exitCode' か 'text'
    node -e "
const fs = require('node:fs')
let value
try { value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')) }
catch { process.stdout.write('PARSE_ERROR'); process.exit(0) }
const call = (value.calls ?? [])[Number(process.argv[2])]
const field = call === undefined ? undefined : call[process.argv[3]]
process.stdout.write(field === undefined || field === null ? '' : String(field))
" "$1" "$2" "$3"
}

CALL_REPO="$TMP/call-repo"
mkdir -p "$CALL_REPO"
git init --quiet --initial-branch=smoke-branch "$CALL_REPO" || exit 1
git -C "$CALL_REPO" commit --quiet --allow-empty -m "smoke" > /dev/null 2>&1 || exit 1
SMOKE_CALLS_OUT="$TMP/smoke-calls.json"
SMOKE_CWD="$CALL_REPO" \
    SMOKE_TOOL_CALLS='[{"name":"session_status","arguments":{"directory":"."}},{"name":"issue_comment","arguments":{"prepare":true,"template":"plan"}}]' \
    smoke_node "$DIST/bin/pecot-workflow-mcp.mjs" mcp \
    > "$SMOKE_CALLS_OUT" 2> "$SMOKE_CALLS_OUT.err"
case "$(head -c 5 "$SMOKE_CALLS_OUT")" in
    FAIL:)
        smoke_output="$(file_cat "$SMOKE_CALLS_OUT")"
        fail "tools/call smoke で配布ツリーが MCP サーバとして起動しない ($smoke_output)"
        ;;
    '')
        smoke_err_tail="$(file_tail "$SMOKE_CALLS_OUT.err" 3)"
        fail "tools/call smoke が何も出力しなかった ($smoke_err_tail)"
        ;;
    *)
        assert_eq "session_status の tools/call が終了コード 0 を返す" "0" \
            "$(call_value "$SMOKE_CALLS_OUT" 0 exitCode)"
        SESSION_TEXT="$(call_value "$SMOKE_CALLS_OUT" 0 text)"
        case "$SESSION_TEXT" in
            *"- Branch: smoke-branch"*) pass "session_status が一時リポのブランチ名を返す" ;;
            *) fail "session_status の結果にブランチ名が無い: $SESSION_TEXT" ;;
        esac
        assert_eq "issue_comment (prepare) の tools/call が終了コード 0 を返す" "0" \
            "$(call_value "$SMOKE_CALLS_OUT" 1 exitCode)"
        PREPARED="$(call_value "$SMOKE_CALLS_OUT" 1 text | tr -d '\n')"
        case "$PREPARED" in
            "$CALL_REPO"/.pecot/tmp/output/comment-plan-*.md) pass "issue_comment (prepare) が一時リポの出力先にファイルを作る" ;;
            *) fail "issue_comment (prepare) の出力先が期待と違う: $PREPARED" ;;
        esac
        if [ -f "$PREPARED" ] && grep -qxF '## Plan' "$PREPARED"; then
            pass "prepare したファイルに同梱テンプレートの '## Plan' 節がある"
        else
            fail "prepare したファイルが無いか、'## Plan' 節が無い: $PREPARED"
        fi
        ;;
esac

# 引数がある起動は、そのまま commander へ渡す（argv 注入が --version を止めない）。
VERSION_RC=0
node "$DIST/bin/pecot-workflow-mcp.mjs" --version > "$TMP/version.out" 2> "$TMP/version.err" || VERSION_RC=$?
assert_eq "--version が exit 0 で終わる" "0" "$VERSION_RC"
assert_eq "--version が配布ツリーの plugin.json の版を返す" "pecot version $PLUGIN_VERSION" \
    "$(tr -d '\n' < "$TMP/version.out")"

# smoke 用に張った symlink は配布ツリーの一部ではない。以降の publish は $DIST を使わないが、
# 消し残すと、「配布物に node_modules が無い」の判定が smoke の副作用に依存してしまう。
rm -rf "$DIST/node_modules"
assert_eq "smoke 用の node_modules を配布ツリーに残さない" "0" \
    "$(find "$DIST" -maxdepth 1 -name 'node_modules' | wc -l | tr -d ' ')"

# --- 5. 冪等性の確認と Release への添付 ---

gh_lines() {
    wc -l < "$GH_STUB_LOG" | tr -d ' '
}
gh_line() {
    sed -n "${1}p" "$GH_STUB_LOG"
}
tgz_names() {
    tar -tzf "$GH_STUB_DIR/uploaded.tgz" 2> /dev/null
}

# 5-1. HEAD に pecot-workflow のリリースタグが無ければ、gh を一切呼ばずに終了する。
#      他プラグインのみのリリース時に、GitHub への到達性・認証がリリースの成否に結びつかないことを見る。
#      $TEST_VERSION のタグはリポジトリ本体には存在しないため、本体側で検証できる。
if publish_real bash "$PUBLISH" --version="$TEST_VERSION" --skip-build \
    --out-dir="$TMP/dist-gate" > "$TMP/gate.log" 2>&1; then
    if grep -q "スキップ" "$TMP/gate.log" && [ ! -d "$TMP/dist-gate" ]; then
        pass "リリースタグが無いとき配布ツリーを作らず早期 return する"
    else
        fail "リリースタグが無いのに処理が進んだ ($(log_tail gate.log 2))"
    fi
else
    fail "タグ無しの実行が非ゼロ終了した ($(log_tail gate.log 2))"
fi
assert_eq "タグ無しの実行は gh を呼ばない" "0" "$(gh_lines)"

# 5-2. タグがある使い捨てリポ側のスクリプトを起動すると、tgz を Release に添えてワークフローを起動する。
#      gh は PATH 先頭のスタブで、引数と順序を見る。
if publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
    --out-dir="$TMP/dist-1" > "$TMP/publish1.log" 2>&1; then
    pass "タグがあるとき publish が正常終了する"
else
    fail "publish が失敗した ($(log_tail publish1.log 3))"
fi
assert_eq "gh の呼び出しが 3 回（view / upload / workflow run）" "3" "$(gh_lines)"
assert_eq "1 番目は gh release view（-R の値は origin の owner/name）" \
    "release view $TEST_TAG -R $TEST_SLUG" "$(gh_line 1)"
case "$(gh_line 2)" in
    "release upload $TEST_TAG "*"/pecot-workflow-mcp-$TEST_VERSION.tgz --clobber -R $TEST_SLUG")
        pass "2 番目は gh release upload（tgz・--clobber・-R 付き）"
        ;;
    *) fail "gh release upload の引数が期待と違う: $(gh_line 2)" ;;
esac
assert_eq "3 番目は gh workflow run（tag・--ref・-R 付き）" \
    "workflow run publish-npm.yml -f tag=$TEST_TAG --ref $TEST_TAG -R $TEST_SLUG" "$(gh_line 3)"
if grep -qF "tgz: pecot-workflow-mcp-$TEST_VERSION.tgz" "$TMP/publish1.log"; then
    pass "publish が tgz の名前を出力する"
else
    fail "publish が tgz の名前を出力しない ($(log_tail publish1.log 6))"
fi

# upload された tgz の中身。
assert_eq "tgz の package.json の name" "@pecot/workflow-mcp" \
    "$(tar -xzOf "$GH_STUB_DIR/uploaded.tgz" package/package.json 2> /dev/null | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).name)")"
assert_eq "tgz の package.json の version" "$TEST_VERSION" \
    "$(tar -xzOf "$GH_STUB_DIR/uploaded.tgz" package/package.json 2> /dev/null | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).version)")"
TREE="$TMP/tgz-list.txt"
tgz_names > "$TREE"
for entry in package/package.json package/npm-shrinkwrap.json package/README.md package/LICENSE \
    package/.claude-plugin/plugin.json package/cli/dist/cli.js package/cli/templates/comment/plan.md package/hooks/lib/core/pecot-gitignore-ensure.sh package/bin/pecot-workflow-mcp.mjs; do
    if grep -qxF "$entry" "$TREE"; then
        pass "tgz に $entry が入る"
    else
        fail "tgz に $entry が入っていない"
    fi
done
if grep -E '\.map$|cert' "$TREE" > /dev/null; then
    BAD_PATHS="$(grep -E '\.map$|cert' "$TREE" | head -3 | tr '\n' ' ')"
    fail "tgz に .map か cert を含むパスがある: $BAD_PATHS"
else
    pass "tgz に .map と cert を含むパスが無い"
fi
for excluded in package/node_modules/ package/cli/src/ package/cli/tests/ package/.gitignore; do
    if grep -qF "$excluded" "$TREE"; then
        fail "tgz に $excluded が混入している"
    else
        pass "tgz に $excluded が入らない"
    fi
done

# 5-3. 同版の再実行でも同じ呼び出しが通る（--clobber で上書きし、ワークフロー側が既出を判定する）。
gh_reset
if publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
    --out-dir="$TMP/dist-2" > "$TMP/publish2.log" 2>&1; then
    pass "同版の連続再実行が正常終了する"
else
    fail "同版の連続再実行が失敗した ($(log_tail publish2.log 3))"
fi
assert_eq "同版の再実行でも gh を 3 回呼ぶ" "3" "$(gh_lines)"

# 5-3b. 版が上がる publish は、新しい版のタグと tgz で呼ぶ。
TEST_VERSION_2="0.0.0-test$$-2"
TEST_TAG_2="pecot-workflow-v$TEST_VERSION_2"
node -e "
const fs = require('node:fs')
const file = process.argv[1]
const m = JSON.parse(fs.readFileSync(file, 'utf8'))
m.version = process.argv[2]
fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n')
" "$TEST_WORKFLOW/.claude-plugin/plugin.json" "$TEST_VERSION_2"
git -C "$TEST_REPO" add -A > /dev/null 2>&1 || exit 1
git -C "$TEST_REPO" -c user.name=test -c user.email=test@example.invalid \
    commit --quiet -m "test fixture v2" > /dev/null 2>&1 || exit 1
git -C "$TEST_REPO" tag "$TEST_TAG_2" HEAD || exit 1

gh_reset
if publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION_2" --skip-build \
    --out-dir="$TMP/dist-3" > "$TMP/publish3.log" 2>&1; then
    pass "版が上がる publish が正常終了する"
else
    fail "版が上がる publish が失敗した ($(log_tail publish3.log 3))"
fi
assert_eq "版が上がると workflow run が新しいタグを指す" \
    "workflow run publish-npm.yml -f tag=$TEST_TAG_2 --ref $TEST_TAG_2 -R $TEST_SLUG" "$(gh_line 3)"
assert_eq "版が上がると tgz の version が新版になる" "$TEST_VERSION_2" \
    "$(tar -xzOf "$GH_STUB_DIR/uploaded.tgz" package/package.json 2> /dev/null | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).version)")"

# 5-3c. origin が ssh 形式でも owner/name を求められる。
git -C "$TEST_REPO" remote set-url origin "git@github.com:$TEST_SLUG.git"
gh_reset
publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION_2" --skip-build \
    --out-dir="$TMP/dist-ssh" > "$TMP/publish-ssh.log" 2>&1 || true
assert_eq "origin が scp 形式でも -R が owner/name になる" \
    "release view $TEST_TAG_2 -R $TEST_SLUG" "$(gh_line 1)"
git -C "$TEST_REPO" remote set-url origin "ssh://git@github.com/$TEST_SLUG.git"
gh_reset
publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION_2" --skip-build \
    --out-dir="$TMP/dist-ssh2" > "$TMP/publish-ssh2.log" 2>&1 || true
assert_eq "origin が ssh:// 形式でも -R が owner/name になる" \
    "release view $TEST_TAG_2 -R $TEST_SLUG" "$(gh_line 1)"
git -C "$TEST_REPO" remote set-url origin "https://github.com/$TEST_SLUG.git"

# 5-3d. Release が無いときは、理由を出して止まる。upload と workflow run へは進まない。
gh_reset
NORELEASE_RC=0
GH_STUB_NO_RELEASE=1 publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION_2" --skip-build \
    --out-dir="$TMP/dist-norelease" > "$TMP/norelease.log" 2>&1 || NORELEASE_RC=$?
assert_eq "Release が無いと非ゼロ終了" "1" "$NORELEASE_RC"
assert_eq "Release が無いときは gh を view の 1 回しか呼ばない" "1" "$(gh_lines)"
if grep -qF "release not found" "$TMP/norelease.log"; then
    pass "Release が無い理由を出す"
else
    fail "Release が無い理由を出さない ($(log_tail norelease.log 3))"
fi

# 5-4. 作業ツリーが HEAD と乖離していれば publish しない。HEAD は v2 なので、以降は v2 のタグを使う。
printf '\ndirty\n' >> "$TEST_WORKFLOW/scripts/release/mcp-dist-README.md"
gh_reset
if publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION_2" --skip-build \
    --out-dir="$TMP/dist-dirty" > "$TMP/dirty.log" 2>&1; then
    fail "作業ツリーが HEAD と乖離していても publish が通った"
elif grep -q "未コミットの変更" "$TMP/dirty.log"; then
    pass "作業ツリーが HEAD と乖離しているとき publish を拒否する"
else
    fail "乖離判定以外の理由で失敗した ($(log_tail dirty.log 2))"
fi
assert_eq "乖離時の実行は gh を呼ばない" "0" "$(gh_lines)"
git -C "$TEST_REPO" checkout --quiet -- plugins/pecot-workflow/scripts/release/mcp-dist-README.md

assert_eq "テストはリポジトリ本体に検証用タグ (版 1) を残さない" "0" \
    "$(git -C "$REPO_ROOT" tag -l "$TEST_TAG" | wc -l | tr -d ' ')"
assert_eq "テストはリポジトリ本体に検証用タグ (版 2) を残さない" "0" \
    "$(git -C "$REPO_ROOT" tag -l "$TEST_TAG_2" | wc -l | tr -d ' ')"

# --- 6. --out-dir ガード ---
# 構築前に rm -rf する引数のため、消してはいけない場所を弾けることを固定する。

reject_out_dir() {
    local label="$1" target="$2"
    if bash "$PUBLISH" --dry-run --skip-build --out-dir="$target" \
        > "$TMP/outdir.log" 2>&1; then
        fail "--out-dir ガードが $label を通した ($target)"
    else
        pass "--out-dir ガードが $label を弾く"
    fi
}

reject_out_dir "リポジトリ配下" "$REPO_ROOT/plugins/pecot-workflow/scripts"
reject_out_dir "リポジトリルート" "$REPO_ROOT"
reject_out_dir "ルート /" "/"
mkdir -p "$TMP/nonempty/keep"
reject_out_dir "空でない既存ディレクトリ" "$TMP/nonempty"
# symlink を経由してリポジトリ配下を指す場合も、正規化して同じ扱いにする。
ln -s "$REPO_ROOT" "$TMP/repo-link"
reject_out_dir "symlink 経由でリポジトリ配下を指すパス" "$TMP/repo-link/plugins"
# F-18: --out-dir ガードの未検証だった 2 分岐（ファイルを指す場合・親ディレクトリ不在）。
touch "$TMP/plain-file"
reject_out_dir "ファイルを指すパス" "$TMP/plain-file"
reject_out_dir "親ディレクトリが不在のパス" "$TMP/does-not-exist/child"
assert_eq "ガードは対象ディレクトリを消さない" "1" \
    "$(ls -A "$TMP/nonempty" | wc -l | tr -d ' ')"

# F-02: REPO_ROOT を pwd -P で確定させている。
# そのため、リポジトリを指す symlink 経由で本体を起動しても、--out-dir の前方一致 (条件 a) が働くことを固定する。
# --out-dir 自体は symlink を経由させず、起動パスだけを symlink 経由にする。
SYMLINK_SCRIPT="$TMP/repo-link/plugins/pecot-workflow/scripts/release/publish-mcp-dist.sh"
SYMLINK_LAUNCH_OUT="$REPO_ROOT/plugins/pecot-workflow/scripts/release/.f02-outdir-check-$$"
if bash "$SYMLINK_SCRIPT" --dry-run --skip-build --out-dir="$SYMLINK_LAUNCH_OUT" \
    > "$TMP/symlink-launch.log" 2>&1; then
    fail "symlink 経由の起動で --out-dir ガードがリポジトリ配下を通した ($SYMLINK_LAUNCH_OUT)"
elif grep -qF "の外を指定してください: $SYMLINK_LAUNCH_OUT" "$TMP/symlink-launch.log"; then
    pass "symlink 経由の起動でも --out-dir ガードが条件 (a) の文言で拒否する"
else
    fail "symlink 経由の起動で条件 (a) 以外の理由で失敗した ($(log_tail symlink-launch.log 2))"
fi

echo
echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
