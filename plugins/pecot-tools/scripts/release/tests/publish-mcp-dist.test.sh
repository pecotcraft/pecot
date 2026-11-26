#!/bin/bash
# publish-mcp-dist.sh（pecot-tools MCP サーバの tgz 化と Release への添付）の検証 (#1056)。
# gh は PATH 先頭のスタブで差し替え、cli/dist は build 済みを前提に --skip-build で流す。
# `set -e` は使わない。早期 return の検証で、非ゼロ終了を意図的に発生させるため。
set -u

# git hook 経由で GIT_DIR 等が export されていると、リポ本体の index を書き換えるので捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE
# 継承した NX_DRY_RUN は、非 dry-run の検証まで dry-run にする。
unset NX_DRY_RUN

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$RELEASE_DIR/../../../.." && pwd)"
TOOLS_ROOT="$REPO_ROOT/plugins/pecot-tools"
PUBLISH="$RELEASE_DIR/publish-mcp-dist.sh"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"

TMP=$(mktemp -d)
cleanup() {
    rm -rf "$TMP"
}
trap cleanup EXIT

# 失敗の補足に使う。log_tail は $TMP からの相対名、file_tail / file_cat は絶対パスを受ける。
log_tail() {
    tail -"$2" "$TMP/$1" | tr '\n' ' '
}
file_tail() {
    tail -"$2" "$1" | tr '\n' ' '
}
file_cat() {
    cat "$1"
}

# build 済み dist の存在を先に確かめる（無いと publish が途中で落ち、原因が分からない出力になる）。
if [ ! -d "$TOOLS_ROOT/cli/dist" ]; then
    echo "ERROR: $TOOLS_ROOT/cli/dist がありません。build 済みの dist が前提です。" >&2
    echo "  bash plugins/pecot-tools/scripts/ci/run-tests.sh --scope=release" >&2
    exit 1
fi

# --- PATH 先頭のスタブ ---
# gh は引数を GH_STUB_LOG に記録し、upload された tgz を写す。npm は install だけ永続キャッシュを足して本物へ渡す。
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
PLUGIN_VERSION="$(node -e "process.stdout.write(require('$TOOLS_ROOT/.claude-plugin/plugin.json').version)")"

export GIT_AUTHOR_NAME="pecot-tools release test" GIT_AUTHOR_EMAIL="pecot-tools-release-test@example.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

# 冪等性の確認は HEAD のタグで判定する。タグはリポ本体に作らず（残ると push に巻き込まれる）、
# 作業ツリーから組んだ使い捨てリポの中に立てる。
TEST_VERSION="0.0.0-test$$"
TEST_TAG="pecot-tools-v$TEST_VERSION"
TEST_REPO="$TMP/repo"
TEST_TOOLS="$TEST_REPO/plugins/pecot-tools"
mkdir -p "$TEST_REPO"
git init --quiet --initial-branch=main "$TEST_REPO" || exit 1
# gh の -R は origin の URL から求める。合成した owner/name の https URL を置く。
TEST_SLUG="acme-labs/example-repo"
git -C "$TEST_REPO" remote add origin "https://github.com/$TEST_SLUG.git" || exit 1
# git 管理対象の入力。ls-files 経由で列挙して node_modules 等を外す。
# pnpm-lib.sh は publish-mcp-dist.sh が resolve_pnpm のために source する。
(cd "$REPO_ROOT" && git ls-files -z -- \
    plugins/pecot-tools/.claude-plugin \
    plugins/pecot-tools/scripts/ci/pnpm-lib.sh \
    plugins/pecot-tools/package.json \
    plugins/pecot-tools/cli/package.json \
    plugins/pecot-tools/scripts/release \
    LICENSE \
    | tar --null -T - -cf -) | tar -xf - -C "$TEST_REPO" || exit 1
# scripts/release は作業ツリーから丸ごと上書きする（git ls-files は追加直後の未追跡ファイルを落とすため）。
rm -rf "$TEST_TOOLS/scripts/release" || exit 1
mkdir -p "$TEST_TOOLS/scripts" || exit 1
cp -a "$TOOLS_ROOT/scripts/release" "$TEST_TOOLS/scripts/release" || exit 1
# 共通スクリプト（pack から gh まで）も同じ理由で作業ツリーから置く。
mkdir -p "$TEST_REPO/.githooks/scripts" || exit 1
cp -a "$REPO_ROOT/.githooks/scripts/attach-mcp-tgz.sh" "$REPO_ROOT/.githooks/scripts/origin-slug.mjs" "$TEST_REPO/.githooks/scripts/" || exit 1
mkdir -p "$TEST_REPO/.githooks/lib" || exit 1
cp -a "$REPO_ROOT/.githooks/lib/mcp-publish-common.sh" "$TEST_REPO/.githooks/lib/" || exit 1
# git 管理外の build 生成物は実体を持ち込む。
cp -a "$TOOLS_ROOT/cli/dist" "$TEST_TOOLS/cli/dist" || exit 1
git -C "$TEST_REPO" add -A > /dev/null 2>&1 || exit 1
git -C "$TEST_REPO" commit --quiet -m "test fixture" > /dev/null 2>&1 || exit 1
git -C "$TEST_REPO" tag "$TEST_TAG" HEAD || exit 1
TAGGED_PUBLISH="$TEST_TOOLS/scripts/release/publish-mcp-dist.sh"

# --- 1. dry-run で配布ツリーを構築する ---

echo "==> dry-run で配布ツリーを構築"
if bash "$PUBLISH" --dry-run --skip-build --out-dir="$DIST" > "$TMP/dryrun.log" 2>&1; then
    bt_pass "dry-run が正常終了する"
else
    bt_fail "dry-run が正常終了する" "失敗した (末尾ログ: $(log_tail dryrun.log 3))"
    echo "--- dry-run log ---"
    cat "$TMP/dryrun.log"
    bt_finish
    exit 1
fi
if grep -qF "dry-run=true" "$TMP/dryrun.log"; then
    bt_pass "dry-run であることをログに出す"
else
    bt_fail "dry-run であることをログに出す" "出さない ($(log_tail dryrun.log 2))"
fi
if grep -qF "dry-run のため gh は実行しません" "$TMP/dryrun.log"; then
    bt_pass "dry-run が gh を実行せず終わる"
else
    bt_fail "dry-run が gh を実行せず終わる" "終了メッセージが無い ($(log_tail dryrun.log 2))"
fi
# dry-run は npm pack まで実行する。tgz の名前と中身の一覧を出力に残す。
if grep -qF "tgz: pecot-tools-mcp-$PLUGIN_VERSION.tgz" "$TMP/dryrun.log"; then
    bt_pass "dry-run が tgz の名前を出力する"
else
    bt_fail "dry-run が tgz の名前を出力する" "出力しない ($(log_tail dryrun.log 8))"
fi
if grep -qE '^    LICENSE$' "$TMP/dryrun.log"; then
    bt_pass "dry-run の中身の一覧に LICENSE がある"
else
    bt_fail "dry-run の中身の一覧に LICENSE がある" "LICENSE が無い"
fi
if grep -E '^    ' "$TMP/dryrun.log" | grep -E '\.map$|cert' > /dev/null; then
    bt_fail "dry-run の中身の一覧に .map と cert を含むパスが無い" ".map か cert を含むパスがある"
else
    bt_pass "dry-run の中身の一覧に .map と cert を含むパスが無い"
fi
if grep -qE "gh release upload pecot-tools-v$PLUGIN_VERSION pecot-tools-mcp-$PLUGIN_VERSION.tgz --clobber -R [^ /]+/[^ /]+\$" "$TMP/dryrun.log" \
    && grep -qE "gh workflow run publish-npm.yml -f tag=pecot-tools-v$PLUGIN_VERSION --ref pecot-tools-v$PLUGIN_VERSION -R [^ /]+/[^ /]+\$" "$TMP/dryrun.log"; then
    bt_pass "dry-run が gh release upload と gh workflow run を表示する"
else
    bt_fail "dry-run が gh release upload と gh workflow run を表示する" "gh の表示を出さない ($(log_tail dryrun.log 4))"
fi
bt_eq "dry-run は gh を呼ばない" "0" "$(wc -l < "$GH_STUB_LOG" | tr -d ' ')"
# dry-run の表示は、タグの版が nx の上げる前の値であることを添える。
if grep -qF "版は version の段階より前の値です" "$TMP/dryrun.log"; then
    bt_pass "dry-run が、表示するタグの版は本実行で変わり得ると注記する"
else
    bt_fail "dry-run が、表示するタグの版は本実行で変わり得ると注記する" "版の注記が無い ($(log_tail dryrun.log 3))"
fi

# F-04: forwardAllArgs: false のため、本番で dry-run が届くのは NX_DRY_RUN 環境変数だけ。
# --dry-run フラグを付けずに環境変数だけで同じ終了メッセージになることを固定する。
echo "==> NX_DRY_RUN=1 (フラグ無し) でも dry-run になる"
if NX_DRY_RUN=1 bash "$PUBLISH" --skip-build --out-dir="$TMP/dist-nx-dry-run" \
    > "$TMP/nxdryrun.log" 2>&1; then
    bt_pass "NX_DRY_RUN=1 の実行が正常終了する"
else
    bt_fail "NX_DRY_RUN=1 の実行が正常終了する" "失敗した ($(log_tail nxdryrun.log 3))"
fi
if grep -qF "dry-run=true" "$TMP/nxdryrun.log"; then
    bt_pass "NX_DRY_RUN=1 が dry-run であることをログに出す"
else
    bt_fail "NX_DRY_RUN=1 が dry-run であることをログに出す" "出さない ($(log_tail nxdryrun.log 2))"
fi
if grep -qF "dry-run のため gh は実行しません" "$TMP/nxdryrun.log"; then
    bt_pass "NX_DRY_RUN=1 が gh を実行せず終わる"
else
    bt_fail "NX_DRY_RUN=1 が gh を実行せず終わる" "終了メッセージが無い ($(log_tail nxdryrun.log 2))"
fi
bt_eq "NX_DRY_RUN=1 でも gh を呼ばない" "0" "$(wc -l < "$GH_STUB_LOG" | tr -d ' ')"

# F-17: forwardAllArgs: false を選んだ根拠そのもの。未対応引数は exit 1 になる。
if bash "$PUBLISH" --dryRun=true --skip-build --out-dir="$TMP/dist-badflag" \
    > "$TMP/badflag.log" 2>&1; then
    bt_fail "--dryRun=true が exit 1 になる" "exit 1 にならなかった"
else
    bt_pass "--dryRun=true が exit 1 になる"
fi
# 配布先の上書き（--repo）は無い。
if bash "$PUBLISH" --dry-run --skip-build --repo=acme-labs/example-repo --out-dir="$TMP/dist-repoflag" \
    > "$TMP/repoflag.log" 2>&1; then
    bt_fail "--repo は未対応の引数として exit 1 になる" "受け付けられた"
else
    bt_pass "--repo は未対応の引数として exit 1 になる"
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

bt_eq "package.json の name が配布パッケージ名" "@pecot/tools-mcp" "$(read_manifest name)"
bt_eq "package.json の version がプラグイン版と一致" "$PLUGIN_VERSION" "$(read_manifest version)"
bt_eq "package.json の bin が cli/dist/main.js を指す" '{"pecot-tools-mcp":"cli/dist/main.js"}' "$(read_manifest bin)"
bt_eq "package.json の license が MIT" "MIT" "$(read_manifest license)"
bt_eq "package.json の repository が公開リポを指す" \
    '{"type":"git","url":"git+https://github.com/pecotcraft/pecot.git","directory":"plugins/pecot-tools"}' "$(read_manifest repository)"
# engines は node のみ。
bt_eq "package.json の engines は node のみ" "node" "$(read_manifest engines)"
# devEngines に pnpm を写すと、npm が EBADDEVENGINES で止まり、npx 自身が起動しない。
bt_eq "package.json に devEngines キーが無い" "false" "$(read_manifest hasDevEngines)"
# 配布物は npx が展開するだけで、ビルド・テストの script は持たない。
bt_eq "package.json に scripts キーが無い" "false" "$(read_manifest hasScripts)"

# 期待値を列挙で持つと drift を検出できないので、cli/package.json の dependencies と比べる。
cli_dep_set() {
    node -e "process.stdout.write(Object.keys(require('$TOOLS_ROOT/cli/package.json').dependencies).sort().join(','))"
}
bt_eq "配布 package.json の依存が cli/package.json の dependencies と一致する" \
    "$(cli_dep_set)" "$(read_manifest deps)"
# サーバは引数を読まないので、引数の解釈の commander は配布物に要らない。
if printf ',%s,' "$(read_manifest deps)" | grep -qF ',commander,'; then
    bt_fail "配布 package.json の dependencies に commander が無い" "commander がある"
else
    bt_pass "配布 package.json の dependencies に commander が無い"
fi

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
bt_eq "cli/dist の bare import がすべて配布 package.json で宣言されている" "" "$UNDECLARED"
if [ "$IMPORT_MATCH_COUNT" -ge 1 ] 2> /dev/null; then
    bt_pass "bare import の走査が 1 件以上を検出する（走査 0 件での無条件 pass を防ぐ）"
else
    bt_fail "bare import の走査が 1 件以上を検出する（走査 0 件での無条件 pass を防ぐ）" \
        "0 件になった。正規表現が無効化されている疑い (matchCount=$IMPORT_MATCH_COUNT)"
fi

bt_eq "npm-shrinkwrap.json が lockfileVersion 3 で生成される" "3" \
    "$(node -e "process.stdout.write(String(require('$DIST/npm-shrinkwrap.json').lockfileVersion))" 2> /dev/null)"
bt_eq ".claude-plugin/plugin.json が実版を持つ" "$PLUGIN_VERSION" \
    "$(node -e "process.stdout.write(require('$DIST/.claude-plugin/plugin.json').version)" 2> /dev/null)"

# MCP サーバの起動に要る 4 点が、cli/dist の階層ごと届いていることを見る（cp の -a 落ちや部分コピーの検出）。
for entry in main.js package.json infra/sso/login-registry.js mcp/tools/sso.js; do
    if [ -f "$DIST/cli/dist/$entry" ]; then
        bt_pass "cli/dist/$entry が配布ツリーにある"
    else
        bt_fail "cli/dist/$entry が配布ツリーにある" "無い"
    fi
done

bt_eq "配布ツリーに .gitignore が無い" "0" \
    "$(find "$DIST" -name '.gitignore' | wc -l | tr -d ' ')"
# ソースマップは npm の配布物に入れない（spec 018 US4）。
bt_eq "配布ツリーにソースマップ（*.map）が無い" "0" \
    "$(find "$DIST" -name '*.map' -type f | wc -l | tr -d ' ')"

# MIT は許諾表示の同梱を条件にする。ルートの LICENSE と同じ中身が配布ツリーに届く。
if cmp -s "$REPO_ROOT/LICENSE" "$DIST/LICENSE"; then
    bt_pass "配布ツリーにルートの LICENSE が写る"
else
    bt_fail "配布ツリーにルートの LICENSE が写る" "LICENSE が無いか、ルートの LICENSE と違う"
fi
bt_eq "配布ツリーに cert を含むパスが無い" "0" \
    "$(find "$DIST" -iname '*cert*' | wc -l | tr -d ' ')"

# --- 3. README の登録例 ---

# 登録例は npm のパッケージ名を直に書く。URL のプレースホルダも git の URL も残らない。
# 2 件 = npx 起動の登録例 + WSL 経由の登録例（bash -lc の行は引用符が付かず対象外）。
bt_eq "README に git の URL が残っていない" "0" \
    "$(grep -c 'git+' "$DIST/README.md" | tr -d ' ')"
# プレースホルダの名前は固定せず、`__` で囲んだ語が未置換で残っていないことを見る。
bt_eq "README に未置換のプレースホルダ（__NAME__）が残っていない" "0" \
    "$(grep -cE '__[A-Za-z0-9_]+__' "$DIST/README.md" | tr -d ' ')"
bt_eq "README の登録例 2 件が --prefix=/ 付きで @pecot/tools-mcp を指す" "2" \
    "$(grep -cF '"--prefix=/", "@pecot/tools-mcp"]' "$DIST/README.md" | tr -d ' ')"
# --package= で渡すと子に npm_config_package が残り、子の npx が別のパッケージを実行する。
bt_eq "README の登録例が --package= で渡していない" "0" \
    "$(grep -cF -- '--package=@' "$DIST/README.md" | tr -d ' ')"
bt_eq "README の bash -lc の差し替え例が --prefix=/ を付ける" "1" \
    "$(grep -cF 'npx -y --prefix=/ @pecot/tools-mcp' "$DIST/README.md" | tr -d ' ')"
# 登録例のサーバ名は initialize の serverInfo.name に合わせる。
# 3 件 = npx 起動 + 事前インストール後の直接起動 + WSL 経由。
bt_eq "README の登録例 3 件がサーバ名 pecot-tools を使う" "3" \
    "$(grep -cF '"pecot-tools":' "$DIST/README.md" | tr -d ' ')"

# --- 4. 配布物の起動 smoke ---
# 配布ツリーの tgz を npm install し、node_modules/.bin/pecot-tools-mcp から起動する。
# tsc の出力は実行権を持たない。実行権は npm の bin-links が導入時に付ける。
# npm はリポの外で打つ（リポの中は devEngines で EBADDEVENGINES になる）。

SMOKE_ROOT="$TMP/smoke-install"
mkdir -p "$TMP/smoke-pack" "$SMOKE_ROOT"
printf '{"private":true}\n' > "$SMOKE_ROOT/package.json"
SMOKE_TGZ_NAME="$(cd "$TMP" && "$REAL_NPM" pack "$DIST" --ignore-scripts --pack-destination "$TMP/smoke-pack" 2> "$TMP/smoke-pack.err" | tail -n 1)"
SMOKE_BIN="$SMOKE_ROOT/node_modules/.bin/pecot-tools-mcp"
if [ -n "$SMOKE_TGZ_NAME" ] && (cd "$SMOKE_ROOT" && "$REAL_NPM" install "$TMP/smoke-pack/$SMOKE_TGZ_NAME" \
    --no-audit --no-fund --fetch-timeout=30000 --fetch-retries=1 \
    "--cache=$NPM_PERSIST_CACHE" --prefer-offline > "$TMP/smoke-install.log" 2>&1); then
    bt_pass "配布物の tgz を npm install できる"
else
    smoke_install_tail="$(file_tail "$TMP/smoke-pack.err" 3) $(log_tail smoke-install.log 3)"
    bt_fail "配布物の tgz を npm install できる" "$smoke_install_tail"
fi
if [ -x "$SMOKE_BIN" ]; then
    bt_pass "npm install が node_modules/.bin/pecot-tools-mcp を実行できる形で張る"
else
    bt_fail "npm install が node_modules/.bin/pecot-tools-mcp を実行できる形で張る" "無いか、実行できない"
fi

cat > "$TMP/smoke.mjs" << 'SMOKE'
// node smoke.mjs <command> [args...]: MCP サーバに initialize / tools/list（と SMOKE_TOOL_CALLS）を送り、要約を 1 行 JSON で返す。
// command はそのまま実行する。起動そのものに失敗したときだけ `FAIL: <理由>` を返す。
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

const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
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
  const structured = response?.result?.structuredContent ?? {}
  return { isError: response === undefined ? null : response.result?.isError ?? false, kind: structured.kind ?? null }
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

# tools/list の期待値は契約書の表（24 件・先頭 aws_sso_login）。配布ツリーから TS ソースを引けないので写している。
EXPECTED_TOOL_COUNT=24
EXPECTED_FIRST_TOOL="aws_sso_login"

# smoke の出力が要約の JSON でなければ、理由を SMOKE_BROKEN に入れて 1 を返す。
smoke_broken() {
    local out="$1" detail
    SMOKE_BROKEN=""
    case "$(head -c 5 "$out")" in
        FAIL:)
            detail="$(file_cat "$out")"
            SMOKE_BROKEN="配布ツリーが MCP サーバとして起動しない ($detail)"
            ;;
        '')
            detail="$(file_tail "$out.err" 3)"
            SMOKE_BROKEN="smoke が何も出力しなかった ($detail)"
            ;;
    esac
    [ -n "$SMOKE_BROKEN" ]
}

# 登録例と同じ引数なし起動と、`mcp` を付けた起動（引数を読まないこと）の双方を見る。
run_smoke() {
    local label="$1" out="$2"
    shift 2
    local count_title="$label で tools/list が $EXPECTED_TOOL_COUNT 件を返す"
    local first_title="$label で tools/list の先頭が契約表の順になる"
    node "$TMP/smoke.mjs" "$@" > "$out" 2> "$out.err"
    local reason=""
    if smoke_broken "$out"; then
        reason="$SMOKE_BROKEN"
    else
        local error
        error="$(smoke_value "$out" error)"
        [ -z "$error" ] || reason="tools/list がエラーを返した (error.message: $error)"
    fi
    if [ -n "$reason" ]; then
        bt_fail "$count_title" "$reason"
        bt_fail "$first_title" "$reason"
        return 1
    fi
    bt_eq "$count_title" "$EXPECTED_TOOL_COUNT" "$(smoke_value "$out" toolCount)"
    bt_eq "$first_title" "$EXPECTED_FIRST_TOOL" "$(smoke_value "$out" firstTool)"
}

run_smoke "引数なし起動" "$TMP/smoke-default.json" "$SMOKE_BIN"
run_smoke "mcp を付けた起動" "$TMP/smoke-mcp.json" "$SMOKE_BIN" mcp

# F-06: README のツール表（`| \`aws_...\`` の行）が tools/list の名前列と順序込みで一致することを固定する。
README_TOOL_NAMES="$(grep -oE '^\| `aws_[A-Za-z0-9_]+`' "$DIST/README.md" | sed -E 's/^\| `//; s/`$//' | paste -sd, -)"
bt_eq "README のツール表が tools/list の名前と順序込みで一致する" \
    "$README_TOOL_NAMES" "$(smoke_value "$TMP/smoke-default.json" toolNames)"

# F-12: README の登録例のサーバ名（mcpServers のキー）が initialize の serverInfo.name と一致することを固定する。
bt_eq "README の登録名が initialize の serverInfo.name と一致する" "pecot-tools" \
    "$(smoke_value "$TMP/smoke-default.json" serverName)"

# F-05: tools/list が緑でも、cli/dist の外を読むと tools/call は失敗する。
# 偽 awscli を PATH 先頭に置き、読み取り系 (aws_s3_ls) と実行前拒否系 (Athena の DROP TABLE) を配布ツリーへ投げる。
call_value() {
    # $1 = smoke の出力 json, $2 = calls 配列の index, $3 = 'isError' か 'kind'
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

FAKE_AWS_DIR="$TOOLS_ROOT/cli/tests/_fixtures/fake-aws"
SMOKE_CALLS_OUT="$TMP/smoke-calls.json"
SMOKE_TOOL_CALLS='[{"name":"aws_s3_ls","arguments":{}},{"name":"aws_athena_start_query_execution","arguments":{"query_string":"DROP TABLE orders"}}]' \
    PATH="$FAKE_AWS_DIR:$PATH" FAKE_AWS_FIXTURE_DIR="$FAKE_AWS_DIR/fixtures" \
    node "$TMP/smoke.mjs" "$SMOKE_BIN" \
    > "$SMOKE_CALLS_OUT" 2> "$SMOKE_CALLS_OUT.err"
CALL_TITLES=(
    "aws_s3_ls の tools/call が 成功（isError が false）を返す"
    "DROP TABLE の tools/call が 失敗（isError が true）を返す"
    "DROP TABLE の tools/call が kind:not-allowed を返す"
)
if smoke_broken "$SMOKE_CALLS_OUT"; then
    for title in "${CALL_TITLES[@]}"; do
        bt_fail "$title" "tools/call smoke: $SMOKE_BROKEN"
    done
else
    bt_eq "${CALL_TITLES[0]}" "false" "$(call_value "$SMOKE_CALLS_OUT" 0 isError)"
    bt_eq "${CALL_TITLES[1]}" "true" "$(call_value "$SMOKE_CALLS_OUT" 1 isError)"
    bt_eq "${CALL_TITLES[2]}" "not-allowed" "$(call_value "$SMOKE_CALLS_OUT" 1 kind)"
fi

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

# 5-1. HEAD に pecot-tools のリリースタグが無ければ、gh を一切呼ばずに終了する（$TEST_VERSION のタグは本体に無い）。
GATE_TITLE="リリースタグが無いとき配布ツリーを作らず早期 return する"
if publish_real bash "$PUBLISH" --version="$TEST_VERSION" --skip-build \
    --out-dir="$TMP/dist-gate" > "$TMP/gate.log" 2>&1; then
    if grep -q "スキップ" "$TMP/gate.log" && [ ! -d "$TMP/dist-gate" ]; then
        bt_pass "$GATE_TITLE"
    else
        bt_fail "$GATE_TITLE" "処理が進んだ ($(log_tail gate.log 2))"
    fi
else
    bt_fail "$GATE_TITLE" "タグ無しの実行が非ゼロ終了した ($(log_tail gate.log 2))"
fi
bt_eq "タグ無しの実行は gh を呼ばない" "0" "$(gh_lines)"

# 5-2. タグがある使い捨てリポ側のスクリプトは、tgz を Release に添えてワークフローを起動する。gh はスタブで引数と順序を見る。
if publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
    --out-dir="$TMP/dist-1" > "$TMP/publish1.log" 2>&1; then
    bt_pass "タグがあるとき publish が正常終了する"
else
    bt_fail "タグがあるとき publish が正常終了する" "失敗した ($(log_tail publish1.log 3))"
fi
bt_eq "gh の呼び出しが 3 回（view / upload / workflow run）" "3" "$(gh_lines)"
bt_eq "1 番目は gh release view（-R の値は origin の owner/name）" \
    "release view $TEST_TAG -R $TEST_SLUG" "$(gh_line 1)"
case "$(gh_line 2)" in
    "release upload $TEST_TAG "*"/pecot-tools-mcp-$TEST_VERSION.tgz --clobber -R $TEST_SLUG")
        bt_pass "2 番目は gh release upload（tgz・--clobber・-R 付き）"
        ;;
    *) bt_fail "2 番目は gh release upload（tgz・--clobber・-R 付き）" "引数が期待と違う: $(gh_line 2)" ;;
esac
bt_eq "3 番目は gh workflow run（tag・--ref・-R 付き）" \
    "workflow run publish-npm.yml -f tag=$TEST_TAG --ref $TEST_TAG -R $TEST_SLUG" "$(gh_line 3)"
if grep -qF "tgz: pecot-tools-mcp-$TEST_VERSION.tgz" "$TMP/publish1.log"; then
    bt_pass "publish が tgz の名前を出力する"
else
    bt_fail "publish が tgz の名前を出力する" "出力しない ($(log_tail publish1.log 6))"
fi

# upload された tgz の中身。
bt_eq "tgz の package.json の name" "@pecot/tools-mcp" \
    "$(tar -xzOf "$GH_STUB_DIR/uploaded.tgz" package/package.json 2> /dev/null | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).name)")"
bt_eq "tgz の package.json の version" "$TEST_VERSION" \
    "$(tar -xzOf "$GH_STUB_DIR/uploaded.tgz" package/package.json 2> /dev/null | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).version)")"
TREE="$TMP/tgz-list.txt"
tgz_names > "$TREE"
for entry in package/package.json package/npm-shrinkwrap.json package/README.md package/LICENSE \
    package/.claude-plugin/plugin.json package/cli/dist/main.js; do
    if grep -qxF "$entry" "$TREE"; then
        bt_pass "tgz に $entry が入る"
    else
        bt_fail "tgz に $entry が入る" "入っていない"
    fi
done
if grep -E '\.map$|cert' "$TREE" > /dev/null; then
    BAD_PATHS="$(grep -E '\.map$|cert' "$TREE" | head -3 | tr '\n' ' ')"
    bt_fail "tgz に .map と cert を含むパスが無い" "含むパスがある: $BAD_PATHS"
else
    bt_pass "tgz に .map と cert を含むパスが無い"
fi
for excluded in package/node_modules/ package/cli/src/ package/cli/tests/ package/.gitignore; do
    if grep -qF "$excluded" "$TREE"; then
        bt_fail "tgz に $excluded が入らない" "混入している"
    else
        bt_pass "tgz に $excluded が入らない"
    fi
done

# 5-3. 同版の再実行でも同じ呼び出しが通る（--clobber で上書きし、ワークフロー側が既出を判定する）。
gh_reset
if publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
    --out-dir="$TMP/dist-2" > "$TMP/publish2.log" 2>&1; then
    bt_pass "同版の連続再実行が正常終了する"
else
    bt_fail "同版の連続再実行が正常終了する" "失敗した ($(log_tail publish2.log 3))"
fi
bt_eq "同版の再実行でも gh を 3 回呼ぶ" "3" "$(gh_lines)"

# 5-3b. 版が上がる publish は、新しい版のタグと tgz で呼ぶ。
TEST_VERSION_2="0.0.0-test$$-2"
TEST_TAG_2="pecot-tools-v$TEST_VERSION_2"
node -e "
const fs = require('node:fs')
const file = process.argv[1]
const m = JSON.parse(fs.readFileSync(file, 'utf8'))
m.version = process.argv[2]
fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n')
" "$TEST_TOOLS/.claude-plugin/plugin.json" "$TEST_VERSION_2"
git -C "$TEST_REPO" add -A > /dev/null 2>&1 || exit 1
git -C "$TEST_REPO" -c user.name=test -c user.email=test@example.invalid \
    commit --quiet -m "test fixture v2" > /dev/null 2>&1 || exit 1
git -C "$TEST_REPO" tag "$TEST_TAG_2" HEAD || exit 1

gh_reset
if publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION_2" --skip-build \
    --out-dir="$TMP/dist-3" > "$TMP/publish3.log" 2>&1; then
    bt_pass "版が上がる publish が正常終了する"
else
    bt_fail "版が上がる publish が正常終了する" "失敗した ($(log_tail publish3.log 3))"
fi
bt_eq "版が上がると workflow run が新しいタグを指す" \
    "workflow run publish-npm.yml -f tag=$TEST_TAG_2 --ref $TEST_TAG_2 -R $TEST_SLUG" "$(gh_line 3)"
bt_eq "版が上がると tgz の version が新版になる" "$TEST_VERSION_2" \
    "$(tar -xzOf "$GH_STUB_DIR/uploaded.tgz" package/package.json 2> /dev/null | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).version)")"

# 5-3c. origin が ssh 形式でも owner/name を求められる。
git -C "$TEST_REPO" remote set-url origin "git@github.com:$TEST_SLUG.git"
gh_reset
publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION_2" --skip-build \
    --out-dir="$TMP/dist-ssh" > "$TMP/publish-ssh.log" 2>&1 || true
bt_eq "origin が scp 形式でも -R が owner/name になる" \
    "release view $TEST_TAG_2 -R $TEST_SLUG" "$(gh_line 1)"
git -C "$TEST_REPO" remote set-url origin "ssh://git@github.com/$TEST_SLUG.git"
gh_reset
publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION_2" --skip-build \
    --out-dir="$TMP/dist-ssh2" > "$TMP/publish-ssh2.log" 2>&1 || true
bt_eq "origin が ssh:// 形式でも -R が owner/name になる" \
    "release view $TEST_TAG_2 -R $TEST_SLUG" "$(gh_line 1)"
git -C "$TEST_REPO" remote set-url origin "https://github.com/$TEST_SLUG.git"

# 5-3d. Release が無いときは、理由を出して止まる。upload と workflow run へは進まない。
gh_reset
NORELEASE_RC=0
GH_STUB_NO_RELEASE=1 publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION_2" --skip-build \
    --out-dir="$TMP/dist-norelease" > "$TMP/norelease.log" 2>&1 || NORELEASE_RC=$?
bt_eq "Release が無いと非ゼロ終了" "1" "$NORELEASE_RC"
bt_eq "Release が無いときは gh を view の 1 回しか呼ばない" "1" "$(gh_lines)"
if grep -qF "release not found" "$TMP/norelease.log"; then
    bt_pass "Release が無い理由を出す"
else
    bt_fail "Release が無い理由を出す" "出さない ($(log_tail norelease.log 3))"
fi

# 5-4. 作業ツリーが HEAD と乖離しているときは publish しない（タグの指すコミットに対応しない配布物を防ぐ）。
#      v1 のタグは HEAD を指さず先に早期 return するので、v2 側の版・タグを使う。
DIRTY_TITLE="作業ツリーが HEAD と乖離しているとき publish を拒否する"
printf '\ndirty\n' >> "$TEST_TOOLS/scripts/release/mcp-dist-README.md"
gh_reset
if publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION_2" --skip-build \
    --out-dir="$TMP/dist-dirty" > "$TMP/dirty.log" 2>&1; then
    bt_fail "$DIRTY_TITLE" "乖離していても publish が通った"
elif grep -q "未コミットの変更" "$TMP/dirty.log"; then
    bt_pass "$DIRTY_TITLE"
else
    bt_fail "$DIRTY_TITLE" "乖離判定以外の理由で失敗した ($(log_tail dirty.log 2))"
fi
bt_eq "乖離時の実行は gh を呼ばない" "0" "$(gh_lines)"
git -C "$TEST_REPO" checkout --quiet -- plugins/pecot-tools/scripts/release/mcp-dist-README.md

bt_eq "テストはリポジトリ本体に検証用タグ (版 1) を残さない" "0" \
    "$(git -C "$REPO_ROOT" tag -l "$TEST_TAG" | wc -l | tr -d ' ')"
bt_eq "テストはリポジトリ本体に検証用タグ (版 2) を残さない" "0" \
    "$(git -C "$REPO_ROOT" tag -l "$TEST_TAG_2" | wc -l | tr -d ' ')"

# --- 6. --out-dir ガード ---
# 構築前に rm -rf する引数のため、消してはいけない場所を弾けることを固定する。

reject_out_dir() {
    local label="$1" target="$2"
    if bash "$PUBLISH" --dry-run --skip-build --out-dir="$target" \
        > "$TMP/outdir.log" 2>&1; then
        bt_fail "--out-dir ガードが $label を弾く" "通した ($target)"
    else
        bt_pass "--out-dir ガードが $label を弾く"
    fi
}

reject_out_dir "リポジトリ配下" "$REPO_ROOT/plugins/pecot-tools/scripts"
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
bt_eq "ガードは対象ディレクトリを消さない" "1" \
    "$(ls -A "$TMP/nonempty" | wc -l | tr -d ' ')"

# F-02: 起動パスだけを symlink 経由にしても、--out-dir の前方一致 (条件 a) が働くことを固定する（REPO_ROOT は pwd -P で確定）。
SYMLINK_SCRIPT="$TMP/repo-link/plugins/pecot-tools/scripts/release/publish-mcp-dist.sh"
SYMLINK_LAUNCH_OUT="$REPO_ROOT/plugins/pecot-tools/scripts/release/.f02-outdir-check-$$"
SYMLINK_TITLE="symlink 経由の起動でも --out-dir ガードが条件 (a) の文言で拒否する"
if bash "$SYMLINK_SCRIPT" --dry-run --skip-build --out-dir="$SYMLINK_LAUNCH_OUT" \
    > "$TMP/symlink-launch.log" 2>&1; then
    bt_fail "$SYMLINK_TITLE" "リポジトリ配下を通した ($SYMLINK_LAUNCH_OUT)"
elif grep -qF "の外を指定してください: $SYMLINK_LAUNCH_OUT" "$TMP/symlink-launch.log"; then
    bt_pass "$SYMLINK_TITLE"
else
    bt_fail "$SYMLINK_TITLE" "条件 (a) 以外の理由で失敗した ($(log_tail symlink-launch.log 2))"
fi

bt_finish
