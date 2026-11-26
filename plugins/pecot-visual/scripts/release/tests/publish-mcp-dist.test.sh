#!/bin/bash
# publish-mcp-dist.sh（pecot-visual MCP サーバの tgz 作成と Release への添付）の検証 (#982)。gh は偽物に差し替え、GitHub と registry へ書き込まない。
# 前提は cli・eslint プラグイン・text-rules の build 済みの dist。`set -e` は使わない（非ゼロ終了を意図的に起こす）。
set -u

# git hook から継いだ GIT_DIR 等があると `git -C` が本体の index を書き換えるので捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE
# dry-run の有無は引数で作り分けるので、nx release --dry-run から継いだ値は捨てる。
unset NX_DRY_RUN
# 親の値を継ぐと、publish が渡さなくても 1-4 の env の assert が通る。
unset PECOTV_SKIP_LIB_BUILD

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$RELEASE_DIR/../../../.." && pwd)"
PECOTV_ROOT="$REPO_ROOT/plugins/pecot-visual"
RUNTIME_SOURCE="$PECOTV_ROOT/assets/slidev/runtime"
# lint の同値性（セクション 6）で talk-dir が参照するテーマ。宣言つきの固定のテーマを複製し、lint の rule だけ差し替える。
FIXTURE_THEME_SOURCE="$PECOTV_ROOT/cli/tests/fixtures/themes/with-declaration"
FIXTURE_THEME_NAME="slidev-theme-pecotv-test-declared"
ESLINT_SOURCE="$PECOTV_ROOT/assets/slidev/scripts/eslint"
DECK_LINT_SOURCE="$PECOTV_ROOT/assets/slidev/deck-lint.env.config.js"
PUBLISH="$RELEASE_DIR/publish-mcp-dist.sh"
FINGERPRINT="$RELEASE_DIR/dist-fingerprint.mjs"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"

# PECOTV_AUDIT_RECORD の渡し忘れで本体の記録に触れていないことを、末尾で由来の印だけを見て確かめる（並行する書き込みを拾わないため）。
REAL_RECORD_FILE="$REPO_ROOT/.nx/release-audit/pecotv-audit.json"
# 本テストが書く記録に載せる由来の印。実監査の registry と決して一致しない値（RFC 2606 の .invalid）。
TEST_REGISTRY="http://pecotv-release-test.invalid/"
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

TMP=$(mktemp -d)
cleanup() {
    rm -rf "$TMP"
}
trap cleanup EXIT

# 監査記録は publish が読む。テストは全呼び出しを $TMP 配下へ向ける。
export PECOTV_AUDIT_RECORD="$TMP/audit-record.json"

# 失敗の補足に使う。$TMP 配下のログの末尾 N 行・全体・指定文字列を含む行を 1 行にまとめて返す（引数は $TMP からの相対名）。
log_tail() {
    tail -"$2" "$TMP/$1" | tr '\n' ' '
}
log_cat() {
    cat "$TMP/$1"
}
log_lines() {
    grep -F "$2" "$TMP/$1" | tr '\n' ' '
}

# 監査 pass の記録を書く。引数は dist の指紋・監査時 HEAD・dist の high・runtime の high（省略で 0）。
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
# 旧形式（runtime セクションを持たない）の記録を書く。
# readAuditRecord は 2 セクションを必須とする（audit-record.mjs の TREE 定数）ので、INVALID になる場合の検証に使う (#1071 F-04)。
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
# 指紋の突合より前に止まるケース（存在・skipped・HEAD・severity）で使う置き場所。
DUMMY_FP="0000000000000000000000000000000000000000000000000000000000000000"
UNRELATED_SHA="1111111111111111111111111111111111111111"

REPO_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"

ESLINT_PKGS=(_shared slidev-pages-lint text-constraints validate-references)

# build 済み dist の存在を先に確かめる（無いと publish が途中で、原因の分からない形で落ちる）。
TEXT_RULES_DIST="$REPO_ROOT/libs/text-rules/dist"
BUILT_DIRS=("$PECOTV_ROOT/cli/dist" "$TEXT_RULES_DIST")
for pkg in "${ESLINT_PKGS[@]}"; do
    BUILT_DIRS+=("$ESLINT_SOURCE/$pkg/dist")
done
for dir in "${BUILT_DIRS[@]}"; do
    if [ ! -d "$dir" ]; then
        echo "ERROR: $dir がありません。build 済みの dist が前提です。" >&2
        echo "  bash plugins/pecot-visual/scripts/ci/run-tests.sh --scope=release" >&2
        exit 1
    fi
done

# 偽 gh は引数を 1 行ずつ記録する。release view は GH_VIEW_RC で終わり、release upload は tgz を GH_UPLOAD_COPY へ写す。
REAL_NPM="$(command -v npm)"
GH_CALLS="$TMP/gh-calls.txt"
GH_UPLOAD_COPY="$TMP/uploaded.tgz"
: > "$GH_CALLS"
mkdir -p "$TMP/ghbin" "$TMP/npmbin" || exit 1
cat > "$TMP/ghbin/gh" << 'FAKE_GH'
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
chmod +x "$TMP/ghbin/gh"
export GH_CALLS GH_UPLOAD_COPY
export PATH="$TMP/ghbin:$PATH"

# 非 dry-run の実行は PECOT_RELEASE_TEST_NPM_CACHE を拒否する。
# 代わりに偽 npm が install にだけ永続キャッシュと --prefer-offline を足す。
NPM_PERSIST_CACHE="${PECOT_RELEASE_TEST_NPM_CACHE:-$TMP/npm-persist-cache}"
cat > "$TMP/npmbin/npm" << 'FAKE_NPM_PERSIST'
#!/bin/bash
case "$1" in
    install) exec "$REAL_NPM" "$@" "--cache=$NPM_PERSIST_CACHE" --prefer-offline ;;
esac
exec "$REAL_NPM" "$@"
FAKE_NPM_PERSIST
chmod +x "$TMP/npmbin/npm"
export REAL_NPM NPM_PERSIST_CACHE
# 非 dry-run の publish を起動する。引数は env に渡す command 以降。
publish_real() {
    env -u PECOT_RELEASE_TEST_NPM_CACHE PATH="$TMP/npmbin:$PATH" "$@"
}
gh_call_count() {
    wc -l < "$GH_CALLS" | tr -d ' '
}

DIST="$TMP/dist"
PLUGIN_VERSION="$(node -e "process.stdout.write(require('$PECOTV_ROOT/.claude-plugin/plugin.json').version)")"

export GIT_AUTHOR_NAME="pecotv release test" GIT_AUTHOR_EMAIL="pecotv-release-test@example.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

# タグは worktree 間で共有されるので本体に作らず、publish の入力だけを持つ使い捨てリポに立てる。
# 中身は、未コミットの変更を漏らさないよう作業ツリーから取る。
TEST_VERSION="0.0.0-test$$"
TEST_TAG="pecot-visual-v$TEST_VERSION"
TEST_REPO="$TMP/repo"
TEST_PECOTV="$TEST_REPO/plugins/pecot-visual"
mkdir -p "$TEST_REPO"
git init --quiet --initial-branch=main "$TEST_REPO" || exit 1
# gh の -R は origin の URL から求める。https 形式の使い捨ての URL を置く。
TEST_OWNER_REPO="test-owner/test-repo"
git -C "$TEST_REPO" remote add origin "https://github.com/$TEST_OWNER_REPO.git" || exit 1
# 監査記録の HEAD は HEAD かその親に一致すれば通る。親の場合を再現できるよう、ベース commit を 1 本置く。
git -C "$TEST_REPO" commit --quiet --allow-empty -m base > /dev/null 2>&1 || exit 1
# git 管理の入力を ls-files で写す。bin は publish が pnpm の解決に bin/_lib.sh を source するために要る。
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
    plugins/pecot-visual/bin \
    plugins/pecot-visual/cli/package.json \
    plugins/pecot-visual/scripts/release \
    libs/text-rules/package.json \
    LICENSE \
    pnpm-workspace.yaml \
    | tar --null -T - -cf -) | tar -xf - -C "$TEST_REPO" || exit 1
# ls-files は未追跡ファイルを落とすので、追加直後のスクリプトも入るよう scripts/release は作業ツリーから上書きする。
rm -rf "$TEST_PECOTV/scripts/release" || exit 1
cp -a "$PECOTV_ROOT/scripts/release" "$TEST_PECOTV/scripts/release" || exit 1
# 共通スクリプト（pack から gh まで）も同じ理由で作業ツリーから置く。
mkdir -p "$TEST_REPO/.githooks/scripts" || exit 1
cp -a "$REPO_ROOT/.githooks/scripts/attach-mcp-tgz.sh" "$REPO_ROOT/.githooks/scripts/origin-slug.mjs" "$TEST_REPO/.githooks/scripts/" || exit 1
mkdir -p "$TEST_REPO/.githooks/lib" || exit 1
cp -a "$REPO_ROOT/.githooks/lib/mcp-publish-common.sh" "$TEST_REPO/.githooks/lib/" || exit 1
# runtime の manifest も同じ理由で作業ツリーから置く。追加直後の未追跡の状態でも、git archive の対象が揃う。
rm -rf "$TEST_PECOTV/assets/slidev/runtime" || exit 1
mkdir -p "$TEST_PECOTV/assets/slidev" || exit 1
cp -a "$RUNTIME_SOURCE" "$TEST_PECOTV/assets/slidev/runtime" || exit 1
# git 管理外の build 生成物は実体を持ち込む（本体リポと同じく .gitignore で commit から外れる）。
cp -a "$PECOTV_ROOT/cli/dist" "$TEST_PECOTV/cli/dist" || exit 1
for pkg in "${ESLINT_PKGS[@]}"; do
    cp -a "$ESLINT_SOURCE/$pkg/dist" \
        "$TEST_PECOTV/assets/slidev/scripts/eslint/$pkg/dist" || exit 1
done
mkdir -p "$TEST_REPO/libs/text-rules" || exit 1
cp -a "$TEXT_RULES_DIST" "$TEST_REPO/libs/text-rules/dist" || exit 1
git -C "$TEST_REPO" add -A > /dev/null 2>&1 || exit 1
git -C "$TEST_REPO" commit --quiet -m "test fixture" > /dev/null 2>&1 || exit 1
git -C "$TEST_REPO" tag "$TEST_TAG" HEAD || exit 1
# catalog.mjs が使う yaml の解決元。commit の後に置き、fixture の内容に含めない。
ln -s "$REPO_ROOT/node_modules" "$TEST_REPO/node_modules" || exit 1
TAGGED_PUBLISH="$TEST_PECOTV/scripts/release/publish-mcp-dist.sh"
# 作業ツリーの catalog.vite だけを HEAD と違う値にする（commit しない）。publish が作業ツリーの側を読む誤りを拾う。
# pnpm-workspace.yaml は publish の乖離判定の対象外なので、後続の項目に影響しない。
WORKTREE_VITE="^0.0.0-worktree"
sed -i "s|^\(  vite: \).*|\1$WORKTREE_VITE|" "$TEST_REPO/pnpm-workspace.yaml" || exit 1
if [ "$(git -C "$TEST_REPO" show HEAD:pnpm-workspace.yaml)" = "$(cat "$TEST_REPO/pnpm-workspace.yaml")" ] \
    || ! grep -qF "vite: $WORKTREE_VITE" "$TEST_REPO/pnpm-workspace.yaml"; then
    echo "fixture の作業ツリーの catalog.vite を書き換えられません" >&2
    exit 1
fi

# --- 1. dry-run: 監査記録の確認と配布ツリーの構築 ---

# 1-1. 監査記録が無ければ build にも入らず止まる（#1059）。
#      監査を経ていないツリーを配布させないための確認で、dry-run でも同じように働く。
NORECORD_RC=0
rm -f "$PECOTV_AUDIT_RECORD"
bash "$PUBLISH" --dry-run --skip-build --out-dir="$TMP/dist-norecord" \
    > "$TMP/norecord.log" 2>&1 || NORECORD_RC=$?
bt_eq "監査記録が無いと dry-run でも非ゼロ終了" "1" "$NORECORD_RC"
if grep -qF "監査記録がありません" "$TMP/norecord.log"; then
    bt_pass "記録が無い理由を出す"
else
    bt_fail "記録が無い理由を出す" "記録が無い理由を出さない ($(log_tail norecord.log 2))"
fi
if [ ! -d "$TMP/dist-norecord" ]; then
    bt_pass "記録が無いときは配布ツリーを構築しない"
else
    bt_fail "記録が無いときは配布ツリーを構築しない" "記録が無いのに配布ツリーを構築した"
fi

# 1-2. 監査スキップの記録（pecot 単独リリース）は dry-run では突合を省略して通る。
#      指紋の期待値はこの実行が出力した値から取る（外部から持ち込まない）。
echo "==> dry-run で配布ツリーを構築（監査スキップの記録）"
write_skipped_audit_record "$REPO_HEAD"
if bash "$PUBLISH" --dry-run --skip-build --out-dir="$TMP/dist-skipped" \
    > "$TMP/dryrun-skipped.log" 2>&1; then
    bt_pass "監査スキップの記録で dry-run が正常終了する"
else
    bt_fail "監査スキップの記録で dry-run が正常終了する" "失敗した (末尾ログ: $(log_tail dryrun-skipped.log 3))"
    echo "--- dry-run log ---"
    cat "$TMP/dryrun-skipped.log"
    bt_finish
    exit 1
fi
if grep -qF "突合を省略" "$TMP/dryrun-skipped.log"; then
    bt_pass "監査スキップの dry-run は突合を省略する"
else
    bt_fail "監査スキップの dry-run は突合を省略する" "突合を省略した旨を出さない ($(log_tail dryrun-skipped.log 2))"
fi

DIST_FP="$(fingerprint_from_log "$TMP/dryrun-skipped.log")"
bt_eq "配布ツリーの指紋を 64 桁 hex で出力する" "1" \
    "$(printf '%s' "$DIST_FP" | grep -cE '^[0-9a-f]{64}$' | tr -d ' ')"
bt_eq "出力の指紋が生成された shrinkwrap の指紋と一致" \
    "$(node "$FINGERPRINT" "$TMP/dist-skipped/npm-shrinkwrap.json" 2> /dev/null || echo __NO_SHRINKWRAP__)" \
    "$DIST_FP"

# 1-3. 監査記録があれば指紋を突合して通る。以降のセクションはこの $DIST を検証する。
echo "==> dry-run で配布ツリーを構築（指紋の突合あり）"
write_audit_record "$DIST_FP" "$REPO_HEAD" 0
# セクション 11 の陽性側。印が載らなくなると 11 が常に pass するので、ここで固定する。
bt_eq "テストが書く記録は由来の印を持つ" "$TEST_REGISTRY" \
    "$(record_registry "$PECOTV_AUDIT_RECORD")"
if bash "$PUBLISH" --dry-run --skip-build --out-dir="$DIST" > "$TMP/dryrun.log" 2>&1; then
    bt_pass "dry-run が正常終了する"
else
    bt_fail "dry-run が正常終了する" "失敗した (末尾ログ: $(log_tail dryrun.log 3))"
    echo "--- dry-run log ---"
    cat "$TMP/dryrun.log"
    bt_finish
    exit 1
fi
if grep -qF "配布ツリーの指紋: $DIST_FP" "$TMP/dryrun.log"; then
    bt_pass "再構築しても配布ツリーの指紋が同じ"
else
    bt_fail "再構築しても配布ツリーの指紋が同じ" "再構築で配布ツリーの指紋が変わった ($(log_lines dryrun.log 配布ツリーの指紋))"
fi
if grep -qF "監査記録と一致" "$TMP/dryrun.log"; then
    bt_pass "監査記録との一致を出力する"
else
    bt_fail "監査記録との一致を出力する" "監査記録との一致を出力しない ($(log_tail dryrun.log 2))"
fi

# 1-4. high の残る記録でも、dry-run（開発版の tgz 作り）は警告して通る (#658)。本実行の拒否は 9-2 で確かめる。
write_audit_record "$DIST_FP" "$REPO_HEAD" 0 2
if bash "$PUBLISH" --dry-run --skip-build --out-dir="$TMP/dist-dev-high" > "$TMP/dryrun-high.log" 2>&1; then
    bt_pass "high の残る記録でも dry-run が正常終了する"
else
    bt_fail "high の残る記録でも dry-run が正常終了する" "high の残る記録で dry-run が失敗した ($(log_tail dryrun-high.log 3))"
fi
if grep -qF "WARNING: 監査記録に high 以上の脆弱性が残っています (2 件)" "$TMP/dryrun-high.log"; then
    bt_pass "high の残る記録の dry-run は件数を警告する"
else
    bt_fail "high の残る記録の dry-run は件数を警告する" "high の残る記録の dry-run が警告を出さない ($(log_tail dryrun-high.log 2))"
fi
write_audit_record "$DIST_FP" "$REPO_HEAD" 0

# dry-run は npm pack まで実行し、gh の 3 つは表示だけにする。
bt_eq "dry-run は gh を呼ばない" "0" "$(gh_call_count)"
# dry-run の表示は、タグの版が nx の上げる前の値であることを添える。
if grep -qF "版は version の段階より前の値です" "$TMP/dryrun.log"; then
    bt_pass "dry-run が、表示するタグの版は本実行で変わり得ると注記する"
else
    bt_fail "dry-run が、表示するタグの版は本実行で変わり得ると注記する" "dry-run の表示に版の注記が無い ($(log_tail dryrun.log 3))"
fi
bt_eq "dry-run は tgz の名前を出力する" "1" \
    "$(grep -cxF "==> tgz: pecot-visual-mcp-$PLUGIN_VERSION.tgz" "$TMP/dryrun.log" | tr -d ' ')"
bt_eq "dry-run は tgz の中身に LICENSE を出力する" "1" \
    "$(grep -cxF '    LICENSE' "$TMP/dryrun.log" | tr -d ' ')"
bt_eq "dry-run は tgz の中身に shim を出力する" "1" \
    "$(grep -cxF '    bin/pecot-visual-mcp.mjs' "$TMP/dryrun.log" | tr -d ' ')"
bt_eq "dry-run の tgz の中身に .map を含むパスが無い" "0" \
    "$(grep -c '^    .*\.map$' "$TMP/dryrun.log" | tr -d ' ')"
# 証明書の同梱を見る。extra-ca-certs.js や certificate.svg のような、実装と icon の名前は対象外。
bt_eq "dry-run の tgz の中身に証明書（certs 配下・.pem・.crt・.cer）が無い" "" \
    "$(grep -E '^    (.*/)?certs?/|^    .*\.(pem|crt|cer)$' "$TMP/dryrun.log" | tr -d ' ' | tr '\n' ' ')"
# dry-run が表示する gh の 3 行。-R は origin の URL から求める。
for needle in "gh release view pecot-visual-v$PLUGIN_VERSION -R" \
    "gh release upload pecot-visual-v$PLUGIN_VERSION pecot-visual-mcp-$PLUGIN_VERSION.tgz --clobber -R" \
    "gh workflow run publish-npm.yml -f tag=pecot-visual-v$PLUGIN_VERSION --ref pecot-visual-v$PLUGIN_VERSION -R"; do
    # 題に版を入れないよう、gh のサブコマンドだけを題に使う。
    gh_command="$(printf '%s' "$needle" | cut -d' ' -f2-3)"
    if grep -qF "$needle" "$TMP/dryrun.log"; then
        bt_pass "dry-run が実行予定の gh コマンドを表示する: gh $gh_command"
    else
        bt_fail "dry-run が実行予定の gh コマンドを表示する: gh $gh_command" "表示しない: $needle"
    fi
done

# --- 1-4. build を伴う場合の pnpm 呼び出し順 ---
# PATH 先頭の偽 pnpm で、build の順・cwd・PECOTV_SKIP_LIB_BUILD を固定する (#1087, #245)。
echo "==> dry-run で pnpm 呼び出し順を検証（偽 pnpm）"
mkdir -p "$TMP/bin"
PNPM_CALLS="$TMP/pnpm-calls.txt"
# 本体ツリーの eslint プラグインの dist は別のレーンが読んでいるので、publish には一時の写しを指させる (#82)。
# 偽 pnpm は build しないので、写しの dist を退避し、build の時点の有無を記録してから戻す。
ESLINT_TREE="$TMP/eslint-tree"
ESLINT_BACKUP="$TMP/eslint-dist-backup"
ESLINT_DIST_AT_BUILD="$TMP/eslint-dist-at-build.txt"
mkdir -p "$ESLINT_BACKUP" "$ESLINT_TREE" || exit 1
for pkg in "${ESLINT_PKGS[@]}"; do
    mkdir -p "$ESLINT_TREE/$pkg" || exit 1
    cp -a "$ESLINT_SOURCE/$pkg/dist" "$ESLINT_TREE/$pkg/dist" || exit 1
    cp -a "$ESLINT_SOURCE/$pkg/dist" "$ESLINT_BACKUP/$pkg" || exit 1
done
# 本体ツリーの dist の指紋。publish の前後で変わらないことを確かめる。
eslint_source_fingerprint() {
    (cd "$ESLINT_SOURCE" && find "${ESLINT_PKGS[@]/%//dist}" -type f -exec cksum {} + 2>/dev/null | sort)
}
ESLINT_SOURCE_BEFORE="$(eslint_source_fingerprint)"
cat > "$TMP/bin/pnpm" << 'FAKE_PNPM'
#!/bin/bash
# 呼び出しごとに「cwd<TAB>引数<TAB>PECOTV_SKIP_LIB_BUILD の値」を 1 行追記する。build はしない。
# eslint プラグインの build 呼び出しだけは、build の時点で残っていた dist を記録し、退避した dist を戻す。
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
chmod +x "$TMP/bin/pnpm"
: > "$PNPM_CALLS"
BUILD_RC=0
PECOTV_ESLINT_PLUGINS_DIR="$TMP/eslint-tree" PNPM_CALLS="$PNPM_CALLS" \
    ESLINT_TREE="$ESLINT_TREE" ESLINT_BACKUP="$ESLINT_BACKUP" ESLINT_DIST_AT_BUILD="$ESLINT_DIST_AT_BUILD" \
    ESLINT_PKGS="${ESLINT_PKGS[*]}" PATH="$TMP/bin:$PATH" \
    bash "$PUBLISH" --dry-run --out-dir="$TMP/dist-build" \
    > "$TMP/dryrun-build.log" 2>&1 || BUILD_RC=$?
bt_eq "build を伴う dry-run が正常終了する" "0" "$BUILD_RC"
# 古い dist が残ると、削除したソースに対応するモジュールが配布へ同梱される。build の前に消えていることを見る。
bt_eq "eslint プラグインの build の時点で、前回の dist が残っていない" "0" \
    "$(wc -l < "$ESLINT_DIST_AT_BUILD" 2> /dev/null | tr -d ' ')"
bt_eq "偽 build が dist を戻した後、写しの dist が揃っている" "${#ESLINT_PKGS[@]}" \
    "$(for pkg in "${ESLINT_PKGS[@]}"; do [ -f "$ESLINT_TREE/$pkg/dist/index.js" ] && echo "$pkg"; done | wc -l | tr -d ' ')"
if [ "$(eslint_source_fingerprint)" = "$ESLINT_SOURCE_BEFORE" ]; then
    bt_pass "build を伴う dry-run が、本体ツリーの eslint プラグインの dist に触らない"
else
    bt_fail "build を伴う dry-run が、本体ツリーの eslint プラグインの dist に触らない" "build を伴う dry-run が、本体ツリーの eslint プラグインの dist を変えた"
fi
bt_eq "1 回目の pnpm 呼び出しは frozen の install" "install --frozen-lockfile" \
    "$(sed -n '1p' "$PNPM_CALLS" | cut -f2)"
bt_eq "install の cwd はリポジトリルート" "$REPO_ROOT" \
    "$(sed -n '1p' "$PNPM_CALLS" | cut -f1)"
bt_eq "2 回目の pnpm 呼び出しは text-rules の build" "--filter @pecot/text-rules-src run build" \
    "$(sed -n '2p' "$PNPM_CALLS" | cut -f2)"
bt_eq "text-rules の build の cwd はリポジトリルート" "$REPO_ROOT" \
    "$(sed -n '2p' "$PNPM_CALLS" | cut -f1)"
bt_eq "3 回目の pnpm 呼び出しは cli の build" "--filter @pecot/pecotv-cli run build" \
    "$(sed -n '3p' "$PNPM_CALLS" | cut -f2)"
bt_eq "4 回目の pnpm 呼び出しは eslint プラグインを含む build" "--filter @pecot/slidev-assets-dev run build" \
    "$(sed -n '4p' "$PNPM_CALLS" | cut -f2)"
bt_eq "pnpm 呼び出しは 4 回だけ" "4" "$(wc -l < "$PNPM_CALLS" | tr -d ' ')"
TEXT_RULES_LINE="$(awk -F'\t' '$2 ~ /text-rules-src run build/ { print NR; exit }' "$PNPM_CALLS")"
CLI_LINE="$(awk -F'\t' '$2 ~ /pecotv-cli run build/ { print NR; exit }' "$PNPM_CALLS")"
if [ -n "$TEXT_RULES_LINE" ] && [ -n "$CLI_LINE" ] && [ "$TEXT_RULES_LINE" -lt "$CLI_LINE" ]; then
    bt_pass "text-rules の build は cli の build より前"
else
    bt_fail "text-rules の build は cli の build より前" "text-rules の build が cli の build より前にない (text-rules=$TEXT_RULES_LINE cli=$CLI_LINE)"
fi
bt_eq "PECOTV_SKIP_LIB_BUILD=1 は eslint プラグインの build の行だけ" "4" \
    "$(awk -F'\t' '$3 == "1" { print NR }' "$PNPM_CALLS" | paste -sd, -)"
bt_eq "それ以外の呼び出しでは PECOTV_SKIP_LIB_BUILD が unset" "1,2,3" \
    "$(awk -F'\t' '$3 == "unset" { print NR }' "$PNPM_CALLS" | paste -sd, -)"

# install が失敗したら build へ進まず止まる（進むと lockfile を無視した配布ツリーができる）。
echo "==> install の失敗で publish が止まることを検証（偽 pnpm）"
cat > "$TMP/bin/pnpm" << 'FAKE_PNPM_FAIL'
#!/bin/bash
printf '%s\t%s\t%s\n' "$PWD" "$*" "${PECOTV_SKIP_LIB_BUILD-unset}" >> "$PNPM_CALLS"
case "$*" in
    "install --frozen-lockfile") exit 1 ;;
esac
exit 0
FAKE_PNPM_FAIL
chmod +x "$TMP/bin/pnpm"
: > "$PNPM_CALLS"
INSTALL_FAIL_RC=0
PNPM_CALLS="$PNPM_CALLS" PATH="$TMP/bin:$PATH" \
    bash "$PUBLISH" --dry-run --out-dir="$TMP/dist-install-fail" \
    > "$TMP/dryrun-install-fail.log" 2>&1 || INSTALL_FAIL_RC=$?
if [ "$INSTALL_FAIL_RC" -ne 0 ]; then
    bt_pass "install が失敗すると publish が非ゼロ終了する"
else
    bt_fail "install が失敗すると publish が非ゼロ終了する" "install が失敗したのに publish が正常終了した"
fi
# 記録が空だと下の build 不在は自明に成立するため、install が実際に呼ばれた印を先に置く。
bt_eq "失敗ケースでも 1 回目は install" "install --frozen-lockfile" \
    "$(sed -n '1p' "$PNPM_CALLS" | cut -f2)"
bt_eq "install 失敗後に build を呼ばない" "0" \
    "$(grep -c 'run build' "$PNPM_CALLS" | tr -d ' ')"

# --- 2. 生成 package.json ---

read_manifest() {
    node -e "
const m = require('$DIST/package.json')
const q = process.argv[1]
if (q === 'version') process.stdout.write(m.version)
else if (q === 'name') process.stdout.write(m.name)
else if (q === 'license') process.stdout.write(m.license)
else if (q === 'repository') process.stdout.write(JSON.stringify(m.repository))
else if (q === 'bin') process.stdout.write(JSON.stringify(m.bin))
else if (q === 'engines') process.stdout.write(Object.keys(m.engines).sort().join(','))
else if (q === 'hasDevEngines') process.stdout.write(String('devEngines' in m))
else if (q === 'deps') process.stdout.write(Object.keys(m.dependencies).sort().join(','))
" "$1"
}

bt_eq "package.json の version がプラグイン版と一致" "$PLUGIN_VERSION" "$(read_manifest version)"
bt_eq "package.json の name が公開名" "@pecot/visual-mcp" "$(read_manifest name)"
bt_eq "package.json の bin が shim を指す" '{"pecot-visual-mcp":"bin/pecot-visual-mcp.mjs"}' "$(read_manifest bin)"
bt_eq "package.json の license が MIT" "MIT" "$(read_manifest license)"
bt_eq "package.json の repository" \
    '{"type":"git","url":"git+https://github.com/pecotcraft/pecot.git","directory":"plugins/pecot-visual"}' \
    "$(read_manifest repository)"
# engines は node のみ。
bt_eq "package.json の engines は node のみ" "node" "$(read_manifest engines)"
# devEngines に pnpm を写すと、npm が EBADDEVENGINES で止まり、npx 自身が起動しない。
bt_eq "package.json に devEngines キーが無い" "false" "$(read_manifest hasDevEngines)"

DIST_DEPS="$(read_manifest deps)"
# 期待値は、cli/package.json の dependencies から永続層 3 件（runtime_setup が入れる重量物）と text-rules（vendor で同梱）を除いた集合。
# 列挙で持つと drift を検出できないので、配布 package.json の cli 由来分と等値比較する。
runtime_dep_set() {
    node -e "
const cli = require('$PECOTV_ROOT/cli/package.json').dependencies
const dist = require('$DIST/package.json').dependencies
const persistent = new Set(['@slidev/cli', '@slidev/parser', 'dom-to-pptx'])
const set = process.argv[1] === 'expected'
  ? Object.keys(cli).filter((name) => !persistent.has(name) && name !== '@pecot/text-rules')
  : Object.keys(dist).filter((name) => name in cli)
process.stdout.write(set.sort().join(','))
" "$1"
}
bt_eq "起動層の依存が cli/package.json の dependencies − 永続層 3 件 − @pecot/text-rules と一致する" \
    "$(runtime_dep_set expected)" "$(runtime_dep_set actual)"

# 同梱する text-rules の依存は、libs/text-rules/package.json の宣言と範囲まで比べる（無い・範囲が違う名前を返す）。
text_rules_dep_gap() {
    node -e "
const textRules = require('$REPO_ROOT/libs/text-rules/package.json').dependencies
const dist = require('$DIST/package.json').dependencies
if (!textRules || Object.keys(textRules).length === 0) {
  process.stdout.write('TEXT_RULES_HAS_NO_DEPENDENCIES')
  process.exit(0)
}
const gap = Object.entries(textRules).filter(([name, range]) => dist[name] !== range).map(([name]) => name)
process.stdout.write(gap.sort().join(','))
"
}
bt_eq "配布 package.json が libs/text-rules/package.json の dependencies を範囲ごと全部含む" "" "$(text_rules_dep_gap)"

# eslint と @eslint/markdown は assets/slidev/package.json の由来なので、上の比較に現れない。
for dep in eslint @eslint/markdown js-yaml ajv synckit; do
    case ",$DIST_DEPS," in
        *",$dep,"*) bt_pass "lint 系の依存 $dep が宣言されている" ;;
        *) bt_fail "lint 系の依存 $dep が宣言されている" "package.json にない" ;;
    esac
done

LINT_RANGE_GAP="$(node -e "
const slidev = require('$PECOTV_ROOT/assets/slidev/package.json').devDependencies
const dist = require('$DIST/package.json').dependencies
process.stdout.write(['eslint', '@eslint/markdown'].filter((name) => dist[name] !== slidev[name]).join(','))
")"
bt_eq "lint 系の依存の範囲が assets/slidev/package.json の devDependencies と一致する" "" "$LINT_RANGE_GAP"
bt_eq "assets/slidev/package.json が配布ツリーに入る" "1" \
    "$([ -f "$DIST/assets/slidev/package.json" ] && echo 1 || echo 0)"

bt_eq "npm-shrinkwrap.json が lockfileVersion 3 で生成される" "3" \
    "$(node -e "process.stdout.write(String(require('$DIST/npm-shrinkwrap.json').lockfileVersion))" 2> /dev/null)"
bt_eq ".claude-plugin/plugin.json が実版を持つ" "$PLUGIN_VERSION" \
    "$(node -e "process.stdout.write(require('$DIST/.claude-plugin/plugin.json').version)" 2> /dev/null)"

# --- 2-2. README の登録例 ---

# 4 件 = 直接起動・PLUGIN_DATA 付き・WSL 経由・WSL で PLUGIN_DATA を渡す登録例（bash -lc の行は引用符が付かず対象外）。
bt_eq "README に未置換のプレースホルダ（__NAME__）が残っていない" "0" \
    "$(grep -cE '__[A-Za-z0-9_]+__' "$DIST/README.md" | tr -d ' ')"
bt_eq "README の登録例 4 件が公開名を指す" "4" \
    "$(grep -cF '"--prefix=/", "@pecot/visual-mcp"' "$DIST/README.md" | tr -d ' ')"
bt_eq "README の bash -lc の差し替え例が --prefix=/ を付ける" "1" \
    "$(grep -cF 'npx -y --prefix=/ @pecot/visual-mcp' "$DIST/README.md" | tr -d ' ')"
bt_eq "README の直接登録の例が bin 名 pecot-visual-mcp を使う" "1" \
    "$(grep -cF '"command": "pecot-visual-mcp"' "$DIST/README.md" | tr -d ' ')"
# --package= で渡すと子に npm_config_package が残り、子の npx が別のパッケージを実行する。
bt_eq "README の登録例が --package= で渡していない" "0" \
    "$(grep -cF -- '--package=@' "$DIST/README.md" | tr -d ' ')"
bt_eq "README に git の URL を指す登録例が残っていない" "0" \
    "$(grep -c 'git+' "$DIST/README.md" | tr -d ' ')"
bt_eq "README が版の固定を @<version> で案内する" "1" \
    "$(grep -cF '@pecot/visual-mcp@1.2.3' "$DIST/README.md" | tr -d ' ')"
bt_eq "配布ツリーに LICENSE が入り、HEAD のものと一致する" "$(git -C "$TEST_REPO" show HEAD:LICENSE | cksum)" \
    "$(cksum < "$DIST/LICENSE" 2> /dev/null || echo __NO_LICENSE__)"

# --- 3. .gitignore 除去と eslint プラグイン dist の同梱 ---

bt_eq "配布ツリーに .gitignore が残っていない" "0" \
    "$(find "$DIST" -name '.gitignore' | wc -l | tr -d ' ')"

DIST_ESLINT="$DIST/assets/slidev/scripts/eslint"
for pkg in _shared slidev-pages-lint text-constraints validate-references; do
    if [ -f "$DIST_ESLINT/$pkg/dist/index.js" ]; then
        bt_pass "eslint プラグイン $pkg の dist が同梱されている"
    else
        bt_fail "eslint プラグイン $pkg の dist が同梱されている" "eslint プラグイン $pkg の dist が配布ツリーに無い（.gitignore の dist/ に落とされた疑い）"
    fi
done

# icon カタログは drawio_export の既定 icons root（<dist>/assets/drawio-icons）の実体。
# 欠けると icon:// を解決できないまま別のハッシュが返る（§8 のハッシュ 3 点比較の前提）。
bt_eq "smoke で使う icon カタログが配布ツリーに同梱される" "2" \
    "$(ls "$DIST/assets/drawio-icons/science/brain-circuit.svg" "$DIST/assets/drawio-icons/weather/cloud.svg" \
        2> /dev/null | wc -l | tr -d ' ')"

# runtime の manifest は runtime_setup が実行時依存を入れる元。期待値は、ソースの manifest の vite だけを HEAD の catalog.vite に差し替えて作る。
# 被検証物と同じ出力を期待値にしないよう、実装の resolveCatalog と配布ツリー側は使わない。
DIST_RUNTIME="$DIST/assets/slidev/runtime"
HEAD_YAML="$TMP/head-pnpm-workspace.yaml"
git -C "$TEST_REPO" show HEAD:pnpm-workspace.yaml > "$HEAD_YAML" || exit 1
HEAD_VITE="$(node -e "
const { readDefaultCatalog } = require(process.argv[2])
process.stdout.write(readDefaultCatalog(require('node:fs').readFileSync(process.argv[3], 'utf8')).vite)
" _ "$RELEASE_DIR/catalog.mjs" "$HEAD_YAML")"
RUNTIME_DIFF="$(node -e "
const fs = require('node:fs')
const source = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const dist = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
source.dependencies.vite = process.argv[4]
process.stdout.write(JSON.stringify(source) === JSON.stringify(dist) ? 'same' : 'different')
" _ "$RUNTIME_SOURCE/package.json" "$DIST_RUNTIME/package.json" "$HEAD_VITE" 2> /dev/null || echo error)"
if [ -f "$DIST_RUNTIME/package.json" ] && [ "$RUNTIME_DIFF" = "same" ]; then
    bt_pass "runtime の manifest が catalog: の解決だけソースと違う内容で配布ツリーに同梱される"
else
    bt_fail "runtime の manifest が catalog: の解決だけソースと違う内容で配布ツリーに同梱される" "runtime の manifest が配布ツリーに無い、または catalog: の解決以外でソースと異なる ($RUNTIME_DIFF)"
fi
bt_eq "配布ツリーの runtime manifest に catalog: が残らない" "0" \
    "$(grep -c 'catalog:' "$DIST_RUNTIME/package.json" | tr -d ' ')"
DIST_VITE="$(node -e "process.stdout.write(require('$DIST_RUNTIME/package.json').dependencies.vite)" 2> /dev/null)"
bt_eq "配布ツリーの runtime manifest の vite が HEAD の catalog の範囲になる" "$HEAD_VITE" "$DIST_VITE"
bt_ne "配布ツリーの runtime manifest の vite が作業ツリーの catalog の値ではない" "$WORKTREE_VITE" "$DIST_VITE"

# pecot は証明書を同梱しない。プロキシの CA は利用者が NODE_EXTRA_CA_CERTS で渡す（§8 で受け渡しを見る）。
if [ ! -e "$DIST/assets/certs" ]; then
    bt_pass "配布ツリーに assets/certs が無い"
else
    bt_fail "配布ツリーに assets/certs が無い" "配布ツリーに assets/certs が入っている"
fi
# npm の配布物にソースマップを入れない（spec 018 US4）。
bt_eq "配布ツリーに *.map が無い" "" \
    "$(find "$DIST" -name '*.map' -type f | head -n 3)"
if [ -f "$DIST/assets/drawio-icons/LICENSE" ]; then
    bt_pass "assets/drawio-icons/LICENSE が配布ツリーにある"
else
    bt_fail "assets/drawio-icons/LICENSE が配布ツリーにある" "assets/drawio-icons/LICENSE が配布ツリーに無い"
fi

# --- 4. specifier 書き換え ---

# 該当ファイルの数を返す（file: 依存を持つ package.json・文字列を含む JS・正規表現に一致する JS）。
count_file_dependencies() {
    find "$1" -name 'package.json' -print0 | xargs -0 grep -l '"file:' 2> /dev/null | wc -l | tr -d ' '
}
count_js_containing() {
    grep -rl --include='*.js' --include='*.mjs' "$2" "$1" 2> /dev/null | wc -l | tr -d ' '
}
count_js_matching() {
    grep -rlE --include='*.js' --include='*.mjs' "$2" "$1" 2> /dev/null | wc -l | tr -d ' '
}
bt_eq "配布ツリーの package.json に file: 依存が無い" "0" "$(count_file_dependencies "$DIST")"
# 実行時に node が解決するのは .js だけなので、.d.ts と package.json の workspace: 宣言は書き換えの対象外。
bt_eq "eslint プラグイン dist の JS に @v-slidev の bare import が残っていない" "0" \
    "$(count_js_containing "$DIST_ESLINT" '@v-slidev/')"
bt_eq "eslint プラグイン dist の JS に @pecot/text-rules の bare import が残っていない" "0" \
    "$(count_js_containing "$DIST_ESLINT" '@pecot/text-rules')"
# 書き換え先の実体が同梱され、text-constraints dist がそれを相対パスで指すことを確かめる（import が消えただけの退行を拾う）。
if [ -f "$DIST/vendor/text-rules/dist/index.js" ]; then
    bt_pass "text-rules の dist が vendor/text-rules/dist に同梱されている"
else
    bt_fail "text-rules の dist が vendor/text-rules/dist に同梱されている" "text-rules の dist が配布ツリーに無い: vendor/text-rules/dist/index.js"
fi
# 絶対パスや別の場所への import ではなく、vendor への相対 import（../ で始まる）であることを見る。
if [ "$(count_js_matching "$DIST_ESLINT/text-constraints/dist" "from '(\\.\\./)+vendor/text-rules/dist/index\\.js'")" -gt 0 ]; then
    bt_pass "text-constraints dist が同梱の text-rules を相対パスで import する"
else
    bt_fail "text-constraints dist が同梱の text-rules を相対パスで import する" "text-constraints dist に vendor/text-rules/dist/index.js への相対 import が無い"
fi
# cli/dist の動的 import も同じ実体へ向く。bare import のままだと npx 起動の drawio_create などが text-lint-failed になる。
bt_eq "cli/dist の JS に @pecot/text-rules の bare import が残っていない" "0" \
    "$(count_js_containing "$DIST/cli/dist" '@pecot/text-rules')"
if [ "$(count_js_matching "$DIST/cli/dist" "import\\('(\\.\\./)+vendor/text-rules/dist/index\\.js'\\)")" -gt 0 ]; then
    bt_pass "cli/dist が同梱の text-rules を相対パスで動的 import する"
else
    bt_fail "cli/dist が同梱の text-rules を相対パスで動的 import する" "cli/dist に vendor/text-rules/dist/index.js への相対の動的 import が無い"
fi
bt_eq "cli/dist の JS に eslint-shared の実体（_shared/dist/index.js）への相対パスが無い" "0" \
    "$(count_js_containing "$DIST/cli/dist" '_shared/dist/index.js')"
# build は削除したソースに対応する dist を掃除しない。消したモジュールが配布へ残っていないことを見る。
bt_eq "配布の text-constraints dist に削除済みの textlint/rules.js が無い" "0" \
    "$(find "$DIST_ESLINT/text-constraints/dist/lib/textlint" -name 'rules.*' 2> /dev/null | wc -l | tr -d ' ')"
DECK_LINT_CONFIG="$DIST/assets/slidev/deck-lint.config.js"
bt_eq "deck-lint.config.js に @v-slidev の bare import が残っていない" "0" \
    "$(count_js_containing "$DECK_LINT_CONFIG" '@v-slidev/')"

# --- 5. 配布ツリーの node_modules を用意する ---
# npx が作る node_modules を symlink で再現し、ネットワーク無しで回す。
# node_modules を実際に辿り、複数版があれば npm と同じく宣言の範囲を満たす実体を選ぶ（無ければ最初の実体）。

MISSING_LINKS="$(node -e "
const fs = require('node:fs'), path = require('node:path')
const [dist, ...bases] = process.argv.slice(1)
const parseVersion = (text) => text.replace(/^[^0-9]*/, '').split('.').slice(0, 3).map(Number)
// 固定 pin は完全一致、caret 範囲は npm と同じく先頭の非ゼロ桁までを固定して判定する。
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
" "$DIST" "$RUNTIME_SOURCE" "$PECOTV_ROOT/cli")"
bt_eq "配布 package.json の依存がすべてローカルに実体を持つ" "" "$MISSING_LINKS"

# --- 6. lint 結果がプラグイン側の実行と一致する ---
# 既知違反（フロントマター内の余分な `---`）を同一入力でプラグインと配布ツリーの両方に流し、検出した rule ID を比べる。

FIXTURE_THEME="$TMP/lint-theme/$FIXTURE_THEME_NAME"

# talk-dir（$1）をテーマ参照の形にし、固定のテーマを node_modules へ symlink する（配布ツリーはテーマを持たない）。
link_dist_theme() {
    mkdir -p "$1/node_modules"
    ln -s "$FIXTURE_THEME" "$1/node_modules/$FIXTURE_THEME_NAME"
    printf '{"name":"lint-fixture","dependencies":{"%s":"file:%s"}}\n' "$FIXTURE_THEME_NAME" "$FIXTURE_THEME" > "$1/package.json"
    printf -- '---\ntheme: "%s"\n---\n\nsrc: ./pages/fixture.md\n' "$FIXTURE_THEME_NAME" > "$1/slides.md"
}

mkdir -p "$TMP/lint-theme"
cp -a "$FIXTURE_THEME_SOURCE" "$FIXTURE_THEME" || exit 1
jq '.lint.rules = {
    "slidev-pages-lint/no-triple-hyphen-in-frontmatter": "error",
    "text-constraints/textlint": "error"
}' "$FIXTURE_THEME_SOURCE/pecot-theme.json" > "$FIXTURE_THEME/pecot-theme.json" || exit 1

LINT_DIR="$TMP/lint"
mkdir -p "$LINT_DIR/pages"
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

ESLINT_BIN="$(node -e "
const path = require('node:path')
process.stdout.write(path.join(path.dirname(require.resolve('eslint/package.json', { paths: ['$PECOTV_ROOT'] })), 'bin/eslint.js'))
" 2> /dev/null)"

rule_ids() {
    # $1 = deck-lint.env.config.js、$2 = JSON レポート、$3 = talk-dir（省略時 $LINT_DIR）。rc は見ず、レポートの rule ID を返す。
    # 解釈済みの lint（PECOTV_DECK_LINT）は、設定と同じ配布ルートの CLI（slide theme --json）に作らせる。
    local talk="${3:-$LINT_DIR}" lint_json root
    root="$(cd "$(dirname "$1")/../.." && pwd)"
    lint_json="$(node "$root/cli/dist/cli.js" slide theme --dir "$talk" --json | jq -c .lint)"
    (cd "$talk" && PECOTV_DECK_LINT="$lint_json" node "$ESLINT_BIN" --no-config-lookup --config "$1" -f json 'pages/**/*.md' 'slides.md' > "$2" 2> "$2.err")
    node -e "
const fs = require('node:fs')
let report
try { report = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')) }
catch { process.stdout.write('PARSE_ERROR'); process.exit(0) }
process.stdout.write(report.flatMap((r) => r.messages.map((m) => m.ruleId ?? 'FATAL')).sort().join(','))
" "$2"
}

PLUGIN_RULES="$(rule_ids "$DECK_LINT_SOURCE" "$TMP/lint-plugin.json")"
DIST_RULES="$(rule_ids "$DIST/assets/slidev/deck-lint.env.config.js" "$TMP/lint-dist.json")"

bt_eq "プラグイン側の lint が既知違反を検出する" "slidev-pages-lint/no-triple-hyphen-in-frontmatter" "$PLUGIN_RULES"
if [ "$PLUGIN_RULES" = "$DIST_RULES" ]; then
    bt_pass "書き換え後の配布ツリーの lint 結果がプラグイン側と一致する"
else
    bt_fail "書き換え後の配布ツリーの lint 結果がプラグイン側と一致する" "lint 結果が不一致 (plugin='$PLUGIN_RULES' dist='$DIST_RULES'): $(log_tail lint-dist.json.err 3)"
fi

# 文面チェックは synckit worker で text-rules を呼ぶので、配布ツリーでは worker の解決と依存の宣言が揃って初めて動く。
TEXT_DIR="$TMP/lint-text"
mkdir -p "$TEXT_DIR/pages"
# 違反文は、このスクリプト自体が文章規則に当たらないよう、2 つに分けた語の連結で組み立てる。
HYPE_PHRASE="ゲーム""チェンジャー"
printf -- '---\nlayout: section\nheading: "基盤の話"\ndescription: "%sとなる基盤です。"\n---\n' \
    "$HYPE_PHRASE" > "$TEXT_DIR/pages/fixture.md"
link_dist_theme "$TEXT_DIR"

TEXT_PLUGIN_RULES="$(rule_ids "$DECK_LINT_SOURCE" "$TMP/lint-text-plugin.json" "$TEXT_DIR")"
TEXT_DIST_RULES="$(rule_ids "$DIST/assets/slidev/deck-lint.env.config.js" "$TMP/lint-text-dist.json" "$TEXT_DIR")"

bt_eq "プラグイン側が文面違反 (text-constraints/textlint) を検出する" "text-constraints/textlint" "$TEXT_PLUGIN_RULES"
bt_eq "配布ツリー側が文面違反 (text-constraints/textlint) を検出する" "text-constraints/textlint" "$TEXT_DIST_RULES"

# --- 7. 除外の検証 ---

bt_eq "スキル指示文 (SKILL.md) が配布ツリーに無い" "0" \
    "$(find "$DIST" -name 'SKILL.md' | wc -l | tr -d ' ')"
bt_eq "cli の TypeScript ソースが配布ツリーに無い" "0" \
    "$(find "$DIST/cli" -maxdepth 1 -name 'src' | wc -l | tr -d ' ')"
# eslint プラグインの tests/ は skills/ を逆参照するテストを含み、配布ツリーでは必ず落ちる。
bt_eq "eslint プラグインの tests/ が配布ツリーに無い" "0" \
    "$(find "$DIST_ESLINT" -type d -name 'tests' | wc -l | tr -d ' ')"

# --- 8. 配布ツリーの起動 smoke と drawio 系ツールの実呼び出し ---
# 登録例と同じ引数なしで起動し、drawio 系の tools/call まで往復させる。
# drawio_export の icons_dir の既定（同梱のカタログ）が読めていることは、ハッシュの 3 点比較で確かめる。

if [ -x "$DIST/bin/pecot-visual-mcp.mjs" ]; then
    bt_pass "bin shim に実行権がある"
else
    bt_fail "bin shim に実行権がある" "bin shim に実行権がない"
fi

cat > "$TMP/smoke.mjs" << 'SMOKE'
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

// 要約は判定に使う分だけ載せる（tools/list の JSON Schema 全文は落とす）。
const summarize = (message) => {
  // error は message を独立したキーに残す（呼び出し側が `<id>.error.message` で真因の
  // 文言をそのまま引ける）。code とその他のフィールドは raw に寄せて、要約行が
  // JSON Schema 級に太らないよう長さを切る。
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

# JSON-RPC 要求列を組み立てる。id は initialize が 1、以降の `<method> <params-json>` の対が 2, 3, 4, … で、判定行はこの番号に依存する。
# id を持たない通知を足すと以降の id がずれるので、足すなら別カウンタで採番し直す。
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

# 入力は配布ツリーの外（$TMP）に置き、出力も $TMP へ出す（配布ツリーに異物を残さない）。
SMOKE_FIXTURE="$TMP/icon-resolvable.drawio"
cp "$PECOTV_ROOT/cli/tests/fixtures/drawio/icon-resolvable.drawio" "$SMOKE_FIXTURE" || exit 1
EMPTY_ICONS="$TMP/empty-icons"
mkdir -p "$EMPTY_ICONS"
SMOKE_SVG="$TMP/smoke-export.svg"

# chromium ガードを実 DL 無しで通すため、Playwright に解かせた `chromium-<rev>` 配下へ INSTALLATION_COMPLETE だけを置く。
FAKE_BROWSERS="$TMP/ms-playwright"
mkdir -p "$FAKE_BROWSERS"
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
if place_fake_chromium_marker "$FAKE_BROWSERS" "$PECOTV_ROOT/cli" 2> "$TMP/fake-chromium.err"; then
    bt_pass "偽 chromium キャッシュを用意できる"
else
    bt_fail "偽 chromium キャッシュを用意できる" "偽 chromium キャッシュを用意できない ($(log_tail fake-chromium.err 2))"
fi

write_requests "$TMP/smoke-requests.json" \
    tools/list '{}' \
    tools/call "$(call_params drawio_export "{\"input_path\":\"$SMOKE_FIXTURE\",\"print_hash\":true}")" \
    tools/call "$(call_params drawio_export "{\"input_path\":\"$SMOKE_FIXTURE\",\"icons_dir\":\"$DIST/assets/drawio-icons\",\"print_hash\":true}")" \
    tools/call "$(call_params drawio_export "{\"input_path\":\"$SMOKE_FIXTURE\",\"icons_dir\":\"$EMPTY_ICONS\",\"print_hash\":true}")" \
    tools/call "$(call_params drawio_create "{\"input_path\":\"$SMOKE_FIXTURE\"}")" \
    tools/call "$(call_params drawio_export "{\"input_path\":\"$SMOKE_FIXTURE\",\"out_path\":\"$SMOKE_SVG\"}")" \
    tools/call "$(call_params slide_lint "{\"dir\":\"$TEXT_DIR\"}")" \
    || exit 1

# 実 export（id 7）は PECOTV_FORCE_SVG_FAIL=1 で embed への到達だけを落とす。
# 失敗理由が export-failed なら、icon の解決と chromium ガードを通過している。
SMOKE_JSON="$TMP/smoke.json"
# 開発者の実ホームの永続層が依存ルートの候補に入らないよう、HOME と置き場の変数は隔離する。
mkdir -p "$TMP/home-smoke"
env -u CLAUDE_PLUGIN_DATA -u PLUGIN_DATA -u XDG_DATA_HOME HOME="$TMP/home-smoke" \
    PLAYWRIGHT_BROWSERS_PATH="$FAKE_BROWSERS" PECOTV_FORCE_SVG_FAIL=1 \
    node "$TMP/smoke.mjs" "$TMP/smoke-requests.json" "$DIST/bin/pecot-visual-mcp.mjs" \
    > "$SMOKE_JSON" 2> "$TMP/smoke.err"

# 起動に失敗すると smoke_value が空を返し「非空なら PASS」の行が誤って通るので、起動できたときだけ応答の中身を見る。
SMOKE_OK=0
SMOKE_TITLE="配布ツリーが引数なしで起動し initialize / tools/list と drawio 系 5 本と slide_lint 1 本の tools/call に応答する"
case "$(head -c 5 "$SMOKE_JSON")" in
    FAIL:) bt_fail "$SMOKE_TITLE" "MCP サーバとして起動しない ($(log_cat smoke.json))" ;;
    '') bt_fail "$SMOKE_TITLE" "smoke が何も出力しなかった ($(log_tail smoke.err 3))" ;;
    # smoke.mjs は id を持つ全要求の応答が揃うまで待つので、ここへ来た時点で全要求に応答が返っている。
    *)
        bt_pass "$SMOKE_TITLE"
        SMOKE_OK=1
        ;;
esac

# 8-2 の直叩きと比べる対象。smoke が起動しなかったときは取れない。
HASH_EXPLICIT=""

if [ "$SMOKE_OK" = "0" ]; then
    echo "==> smoke が起動しなかったため応答内容の判定はスキップする"
else
    # 一部の系統が import 失敗で欠けたままの tools/list を拾うため、件数まで固定する。
    # 期待値 11 は allTools() が公開する数の写し（cli/tests/e2e/mcp-tools.test.ts の EXPECTED_TOOL_COUNT と同値）。
    EXPECTED_TOOL_COUNT=11
    SMOKE_TOOLS="$(smoke_value "$SMOKE_JSON" 2.tools)"
    SMOKE_TOOL_COUNT="$(smoke_value "$SMOKE_JSON" 2.toolCount)"
    LIST_TITLES=(
        "tools/list が $EXPECTED_TOOL_COUNT ツールを返す"
        "tools/list が runtime_setup を含む"
        "tools/list が slide_theme を含む"
    )
    # tools/list が JSON-RPC error を返したら、真因の error.message を理由に出す。
    SMOKE_TOOLS_ERROR="$(smoke_value "$SMOKE_JSON" 2.error.message)"
    if [ -n "$SMOKE_TOOLS_ERROR" ]; then
        for title in "${LIST_TITLES[@]}"; do
            bt_fail "$title" "tools/list がエラーを返した (error.message: $SMOKE_TOOLS_ERROR)"
        done
    else
        bt_eq "${LIST_TITLES[0]}" "$EXPECTED_TOOL_COUNT" "$SMOKE_TOOL_COUNT"
        bt_contains "${LIST_TITLES[1]}" '"runtime_setup"' "$SMOKE_TOOLS"
        bt_contains "${LIST_TITLES[2]}" '"slide_theme"' "$SMOKE_TOOLS"
    fi

    HASH_DEFAULT="$(smoke_value "$SMOKE_JSON" 3.call.data.sourceSha256)"
    HASH_EXPLICIT="$(smoke_value "$SMOKE_JSON" 4.call.data.sourceSha256)"
    HASH_EMPTY="$(smoke_value "$SMOKE_JSON" 5.call.data.sourceSha256)"

    if [ -n "$HASH_DEFAULT" ]; then
        bt_pass "icons_dir 省略の drawio_export が配布ツリーで成功する"
    else
        ICONS_DEFAULT_CALL="$(smoke_value "$SMOKE_JSON" 3)"
        bt_fail "icons_dir 省略の drawio_export が配布ツリーで成功する" "失敗した ($ICONS_DEFAULT_CALL)"
    fi
    bt_eq "省略時の既定 icons root が配布ツリー同梱のカタログと同じ解決結果になる" \
        "$HASH_EXPLICIT" "$HASH_DEFAULT"
    if [ -n "$HASH_EMPTY" ] && [ "$HASH_EMPTY" != "$HASH_DEFAULT" ]; then
        bt_pass "icons_dir を明示すると既定より優先される"
    else
        bt_fail "icons_dir を明示すると既定より優先される" "icons_dir の明示が既定を上書きしていない (empty='$HASH_EMPTY' default='$HASH_DEFAULT')"
    fi

    # ok（isError が無い）と warnings の無さは 1 件の判定にまとめる。warnings は、警告が無いと項目ごと入らない。
    bt_eq "drawio_create が配布ツリーで警告なしに成功する" "ok=true warnings=" \
        "ok=$(smoke_value "$SMOKE_JSON" 6.call.ok) warnings=$(smoke_value "$SMOKE_JSON" 6.call.data.warnings)"

    # 同梱した text-rules が配布ツリーで動き、slide_lint が文面違反を text-constraints/textlint で返す。
    bt_eq "slide_lint が配布ツリーで文面違反を返す" "true text-constraints/textlint" \
        "$(smoke_value "$SMOKE_JSON" 8.call.ok) $(smoke_value "$SMOKE_JSON" 8.call.data | grep -o 'text-constraints/textlint' | sort -u)"

    bt_eq "icons_dir 省略の実 export が icon 解決と chromium ガードを抜ける" \
        "export-failed" "$(smoke_value "$SMOKE_JSON" 7.call.data.kind)"
    # 偽 chromium にはバイナリが無く、注入が外れても export-failed になるので、detail で embed への到達を見る。
    SMOKE_EXPORT_DETAIL="$(smoke_value "$SMOKE_JSON" 7.call.data.detail)"
    case "$SMOKE_EXPORT_DETAIL" in
        *PECOTV_FORCE_SVG_FAIL*) bt_pass "実 export の失敗が embed 到達後の失敗注入に由来する" ;;
        *) bt_fail "実 export の失敗が embed 到達後の失敗注入に由来する" "embed 到達前に失敗している (detail: $SMOKE_EXPORT_DETAIL)" ;;
    esac
    # 失敗した export は成果物を残さない。部分的な SVG が、陳腐化の判定をすり抜けないようにする。
    if [ -e "$SMOKE_SVG" ]; then
        bt_fail "実 export が失敗したとき SVG を残さない" "実 export が失敗したのに $SMOKE_SVG が残っている"
    else
        bt_pass "実 export が失敗したとき SVG を残さない"
    fi
fi

# --- 8-2. CLAUDE_PLUGIN_ROOT が無い直叩き ---
# 配布ツリーでの source 相対の fallback は、shim を通さないこの直叩きでしか通らない。
write_requests "$TMP/direct-requests.json" \
    tools/call "$(call_params drawio_export "{\"input_path\":\"$SMOKE_FIXTURE\",\"print_hash\":true}")" \
    || exit 1
DIRECT_JSON="$TMP/direct.json"
env -u CLAUDE_PLUGIN_DATA -u PLUGIN_DATA -u XDG_DATA_HOME HOME="$TMP/home-smoke" CLAUDE_PLUGIN_ROOT= \
    node "$TMP/smoke.mjs" "$TMP/direct-requests.json" \
    "$DIST/cli/dist/cli.js" mcp > "$DIRECT_JSON" 2> "$TMP/direct.err"
DIRECT_TITLE="CLAUDE_PLUGIN_ROOT 無しの直叩きでも既定 icons root が配布ツリーを指す"
case "$(head -c 5 "$DIRECT_JSON")" in
    FAIL:) bt_fail "$DIRECT_TITLE" "MCP サーバとして起動しない ($(log_cat direct.json) :: $(log_tail direct.err 3))" ;;
    '') bt_fail "$DIRECT_TITLE" "smoke が何も出力しなかった ($(log_tail direct.err 3))" ;;
    *)
        if [ -n "$HASH_EXPLICIT" ]; then
            bt_eq "$DIRECT_TITLE" "$HASH_EXPLICIT" "$(smoke_value "$DIRECT_JSON" 2.call.data.sourceSha256)"
        else
            bt_fail "$DIRECT_TITLE" "比較対象（icons_dir 明示のハッシュ）が shim 経由の smoke から取れていない"
        fi
        ;;
esac

# --- 8-3. runtime_setup が利用者の NODE_EXTRA_CA_CERTS をそのまま取得プロセスへ渡す ---
# 取得は単体配布でだけ動く。npm の stub に受け取った値を記録させる。
# 未設定なら `<unset>` と記録する。実網からは取得しない。

# npm の代役は、--prefix 配下に RUNTIME_DEPENDENCY_PROBES（dependency-root.ts）を満たす最小の node_modules を作る。
mkdir -p "$TMP/bin"
cat > "$TMP/bin/npm" << 'STUB_NPM'
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

// runtime_setup は patch-package を起動しない（テーマの patch は slide sync が当てる）。
// 起動されたら記録が残るよう、index.js は呼び出しを追記する。
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
chmod +x "$TMP/bin/npm"

# chromium stage は必ず install を起動するので、install --dry-run が挙げる全エントリへ完了マーカーを置く。
# 件数は playwright の版で動くので、各 location にマーカーが在ることだけを見る（到達できない DOWNLOAD_HOST は保険）。
PLAYWRIGHT_BROWSERS_PATH="$FAKE_BROWSERS" node "$DIST/node_modules/playwright/cli.js" \
    install --dry-run chromium > "$TMP/dry-run.out" 2> "$TMP/dry-run.err"
sed -n 's/^ *Install location: *//p' "$TMP/dry-run.out" > "$TMP/dry-run-locations"
DRY_RUN_ENTRIES=0
MISSING_MARKERS=0
while read -r location; do
    DRY_RUN_ENTRIES=$((DRY_RUN_ENTRIES + 1))
    mkdir -p "$location" && : > "$location/INSTALLATION_COMPLETE"
    [ -f "$location/INSTALLATION_COMPLETE" ] || MISSING_MARKERS=$((MISSING_MARKERS + 1))
done < "$TMP/dry-run-locations"
if [ "$DRY_RUN_ENTRIES" -gt 0 ] && [ "$MISSING_MARKERS" -eq 0 ]; then
    bt_pass "chromium stage 用の完了マーカーを全エントリへ用意できる"
else
    MARKER_ERR="$(log_tail dry-run.err 2)"
    bt_fail "chromium stage 用の完了マーカーを全エントリへ用意できる" \
        "用意できない (entries=$DRY_RUN_ENTRIES missing=$MISSING_MARKERS): $MARKER_ERR"
fi

write_requests "$TMP/setup-requests.json" tools/call "$(call_params runtime_setup '{}')" || exit 1

# `runtime_setup` を 1 回起動する。HOME は毎回別にする（stamp が残ると 2 回目の runtime stage が skip される）。
# plugin_data を渡すと、PLUGIN_DATA をその値にして起動する。
run_setup_smoke() {
    local label="$1" extra_ca="$2" json="$3" env_out="$4" plugin_data="${5:-}"
    local home="$TMP/home-$label"
    mkdir -p "$home"
    (
        if [ -n "$extra_ca" ]; then
            export NODE_EXTRA_CA_CERTS="$extra_ca"
        else
            unset NODE_EXTRA_CA_CERTS
        fi
        export HOME="$home"
        # 置き場を既定の場所（$HOME/.local/share/pecot/pecot-visual）に固定する。呼び出し元の値を継承しない。
        unset CLAUDE_PLUGIN_DATA PLUGIN_DATA XDG_DATA_HOME
        if [ -n "$plugin_data" ]; then
            export PLUGIN_DATA="$plugin_data"
        fi
        export PATH="$TMP/bin:$PATH"
        export PECOTV_TEST_NPM_ENV_OUT="$env_out"
        # patch-package の代役（npm stub が置く）が起動のたびに 1 行追記する記録。runtime_setup では起動されない。
        export PECOTV_TEST_PATCH_RECORD="$TMP/patch-record-$label.jsonl"
        export PLAYWRIGHT_BROWSERS_PATH="$FAKE_BROWSERS"
        export PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1
        node "$TMP/smoke.mjs" "$TMP/setup-requests.json" "$DIST/bin/pecot-visual-mcp.mjs"
    ) > "$json" 2> "$TMP/setup-$label.err"
}

# patch-package の代役が残した記録の起動回数を返す。記録が無ければ 0。
patch_launch_count() {
    if [ -f "$1" ]; then
        grep -c . "$1" || true
    else
        echo 0
    fi
}

# 記録された cwd は子プロセスの process.cwd()（symlink 解決済み）なので、期待値も実体パスで持つ。
realpath_of() {
    node -p "require('node:fs').realpathSync(process.argv[1])" "$1" 2> /dev/null
}

# smoke が起動しなければ、理由を SETUP_BROKEN に入れ、続く題をまとめて失敗にして 0 を返す。$1 = ラベル、$2 以降 = 題。
setup_broken() {
    local label="$1" detail title
    shift
    SETUP_BROKEN=""
    case "$(head -c 5 "$TMP/setup-$label.json")" in
        FAIL:)
            detail="$(log_cat "setup-$label.json") :: $(log_tail "setup-$label.err" 3)"
            SETUP_BROKEN="runtime_setup の smoke が起動しない ($detail)"
            ;;
        '')
            detail="$(log_tail "setup-$label.err" 3)"
            SETUP_BROKEN="runtime_setup の smoke が何も出力しなかった ($detail)"
            ;;
    esac
    [ -n "$SETUP_BROKEN" ] || return 1
    for title in "$@"; do
        bt_fail "$title" "$SETUP_BROKEN"
    done
}

SETUP_JSON="$TMP/setup-unset.json"
run_setup_smoke unset "" "$SETUP_JSON" "$TMP/npm-env-unset"
UNSET_TITLES=(
    "配布ツリーの runtime_setup が実行時依存と chromium を揃えて成功する"
    "NODE_EXTRA_CA_CERTS 未設定なら取得プロセスも受け取らない"
    "runtime_setup が patch-package を起動しない"
    "runtime_setup が永続層ルートへ実行時依存を入れる"
)
if ! setup_broken unset "${UNSET_TITLES[@]}"; then
    bt_eq "${UNSET_TITLES[0]}" "ok=true event=setup.done" \
        "ok=$(smoke_value "$SETUP_JSON" 2.call.ok) event=$(smoke_value "$SETUP_JSON" 2.call.data.event)"
    bt_eq "${UNSET_TITLES[1]}" "<unset>" "$(cat "$TMP/npm-env-unset" 2> /dev/null)"
    # runtime_setup に patch 段は無い。npm の後に patch-package が起動されないことを固定する。
    bt_eq "${UNSET_TITLES[2]}" "0" "$(patch_launch_count "$TMP/patch-record-unset.jsonl")"
    bt_eq "${UNSET_TITLES[3]}" "1" \
        "$([ -f "$TMP/home-unset/.local/share/pecot/pecot-visual/mcp-dist/node_modules/@slidev/cli/package.json" ] && echo 1 || echo 0)"
fi

# 利用者が設定済みの NODE_EXTRA_CA_CERTS を、pecot は書き換えずに子へ渡す。
PRESET_CA="$TMP/preset-ca.pem"
printf '%s\n' 'test-ca-bundle' > "$PRESET_CA" || exit 1
PRESET_JSON="$TMP/setup-preset.json"
run_setup_smoke preset "$PRESET_CA" "$PRESET_JSON" "$TMP/npm-env-preset"
PRESET_TITLE="NODE_EXTRA_CA_CERTS 設定済みならその値のまま取得プロセスへ渡る"
if ! setup_broken preset "$PRESET_TITLE"; then
    bt_eq "$PRESET_TITLE" "$PRESET_CA" "$(cat "$TMP/npm-env-preset" 2> /dev/null)"
fi

# 単体配布の登録の `env` に PLUGIN_DATA を書けば、そこが置き場になる（既定の場所は作られない）。
PDATA_DIR="$TMP/sa-data"
PDATA_JSON="$TMP/setup-pdata.json"
run_setup_smoke pdata "" "$PDATA_JSON" "$TMP/npm-env-pdata" "$PDATA_DIR"
PDATA_TITLES=(
    "PLUGIN_DATA 指定でも runtime_setup が成功する"
    "PLUGIN_DATA 指定なら実行時依存が <PLUGIN_DATA>/mcp-dist に入る"
    "PLUGIN_DATA 指定なら既定の場所 \$HOME/.local/share は作られない"
)
if ! setup_broken pdata "${PDATA_TITLES[@]}"; then
    bt_eq "${PDATA_TITLES[0]}" "ok=true event=setup.done" \
        "ok=$(smoke_value "$PDATA_JSON" 2.call.ok) event=$(smoke_value "$PDATA_JSON" 2.call.data.event)"
    bt_eq "${PDATA_TITLES[1]}" "1" \
        "$([ -f "$PDATA_DIR/mcp-dist/node_modules/@slidev/cli/package.json" ] && echo 1 || echo 0)"
    if [ -e "$TMP/home-pdata/.local/share" ]; then
        bt_fail "${PDATA_TITLES[2]}" "既定の場所 \$HOME/.local/share が作られた"
    else
        bt_pass "${PDATA_TITLES[2]}"
    fi
fi

rm -rf "$DIST/node_modules"

# --- 9. 冪等性の確認 ---

# 9-1. HEAD に pecotv のリリースタグが無ければ、gh を一切呼ばずに終了する（$TEST_VERSION のタグは本体に無い）。
#      記録は pecot 単独リリースの実態に合わせて skipped を置く。冪等性の確認は監査記録の確認より先に働く。
write_skipped_audit_record "$REPO_HEAD"
GATE_TITLE="リリースタグが無いとき配布ツリーを作らず早期 return する"
if publish_real bash "$PUBLISH" --version="$TEST_VERSION" --skip-build \
    --out-dir="$TMP/dist-gate" > "$TMP/gate.log" 2>&1; then
    if grep -q "スキップ" "$TMP/gate.log" && [ ! -d "$TMP/dist-gate" ]; then
        bt_pass "$GATE_TITLE"
    else
        bt_fail "$GATE_TITLE" "リリースタグが無いのに処理が進んだ ($(log_tail gate.log 2))"
    fi
else
    bt_fail "$GATE_TITLE" "タグ無しの実行が非ゼロ終了した ($(log_tail gate.log 2))"
fi
bt_eq "タグ無しの実行は gh を呼ばない" "0" "$(gh_call_count)"

# 9-2. 監査記録の確認（#1059）。記録の素性が満たされない本実行は、gh を呼ばずに止まる。
#      いずれも pack / upload より前で止まる。
TEST_HEAD="$(git -C "$TEST_REPO" rev-parse HEAD)"
TEST_PARENT="$(git -C "$TEST_REPO" rev-parse HEAD^)"

reject_record() {
    local label="$1" needle="$2" outdir="$3" rc=0
    publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
        --out-dir="$outdir" > "$TMP/record-reject.log" 2>&1 || rc=$?
    if [ "$rc" -eq 0 ]; then
        bt_fail "$label で publish を拒否する" "publish が通った"
    elif grep -qF "$needle" "$TMP/record-reject.log"; then
        bt_pass "$label で publish を拒否する"
    else
        bt_fail "$label で publish を拒否する" "別の理由で失敗した ($(log_tail record-reject.log 2))"
    fi
    bt_eq "$label の実行は gh を呼ばない" "0" "$(gh_call_count)"
}

rm -f "$PECOTV_AUDIT_RECORD"
reject_record "監査記録なし" "監査記録がありません" "$TMP/dist-rec-none"

write_skipped_audit_record "$TEST_HEAD"
reject_record "監査スキップの記録" "監査がスキップされたリリース" "$TMP/dist-rec-skipped"

printf 'not json' > "$PECOTV_AUDIT_RECORD"
reject_record "破損した記録" "監査記録を読めません" "$TMP/dist-rec-broken"

write_legacy_audit_record "$DUMMY_FP" "$TEST_HEAD" 0
reject_record "旧形式の記録（runtime セクション無し）" "監査記録を読めません" "$TMP/dist-rec-legacy"

write_audit_record "$DUMMY_FP" "$UNRELATED_SHA" 0
reject_record "監査時 HEAD が現在の HEAD とも親とも一致しない記録" "対応しません" "$TMP/dist-rec-head"

# 9-2b. 親 commit を持たないリポでも、記録の HEAD を確かめられる。TEST_REPO はベース commit を持つので、別の使い捨てリポで通す。
#       publish は記録の確認で止まるので、起動に要る scripts/release とリリースタグだけを置く。
SOLO_REPO="$TMP/solo-repo"
mkdir -p "$SOLO_REPO/plugins/pecot-visual/scripts"
git init --quiet --initial-branch=main "$SOLO_REPO" || exit 1
cp -a "$PECOTV_ROOT/scripts/release" "$SOLO_REPO/plugins/pecot-visual/scripts/release" || exit 1
mkdir -p "$SOLO_REPO/.githooks/lib" || exit 1
cp -a "$REPO_ROOT/.githooks/lib/mcp-publish-common.sh" "$SOLO_REPO/.githooks/lib/" || exit 1
git -C "$SOLO_REPO" add -A > /dev/null 2>&1 || exit 1
git -C "$SOLO_REPO" commit --quiet -m "solo fixture" > /dev/null 2>&1 || exit 1
git -C "$SOLO_REPO" tag "$TEST_TAG" HEAD || exit 1
bt_eq "使い捨てリポが単一 commit（親が無い）" "" \
    "$(git -C "$SOLO_REPO" rev-parse -q --verify HEAD^ || true)"

SOLO_RC=0
write_audit_record "$DUMMY_FP" "$UNRELATED_SHA" 0
publish_real bash "$SOLO_REPO/plugins/pecot-visual/scripts/release/publish-mcp-dist.sh" --version="$TEST_VERSION" \
    --skip-build --out-dir="$TMP/dist-solo" > "$TMP/solo.log" 2>&1 || SOLO_RC=$?
bt_eq "親が無いリポで HEAD 不一致の記録は非ゼロ終了" "1" "$SOLO_RC"
if grep -qF "対応しません" "$TMP/solo.log"; then
    bt_pass "親が無いリポでも記録の HEAD 不一致を理由に出す"
else
    bt_fail "親が無いリポでも記録の HEAD 不一致を理由に出す" "親が無いリポの拒否が別の理由で失敗した ($(log_tail solo.log 2))"
fi
bt_eq "親が無いリポの拒否は gh を呼ばない" "0" "$(gh_call_count)"
if [ ! -d "$TMP/dist-solo" ]; then
    bt_pass "親が無いリポの拒否は配布ツリーを構築しない"
else
    bt_fail "親が無いリポの拒否は配布ツリーを構築しない" "親が無いリポの拒否で配布ツリーを構築した"
fi

write_audit_record "$DUMMY_FP" "$TEST_HEAD" 1
reject_record "high 以上を残した記録" "high 以上の脆弱性が残っています" "$TMP/dist-rec-high"

# blocking は両ツリーの合計。配布ツリー側が 0 でも、永続層側に high が残れば拒否する (#1071 F-05)。
write_audit_record "$DUMMY_FP" "$TEST_HEAD" 0 1
reject_record "永続層に high を残した記録" "high 以上の脆弱性が残っています" "$TMP/dist-rec-runtime-high"

# 9-3. 指紋が配布ツリーと異なれば配布しない。この実行が出力した指紋で記録を作り直し、陽性側（9-4）へ渡す。
MISMATCH_RC=0
write_audit_record "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" "$TEST_HEAD" 0
publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
    --out-dir="$TMP/dist-mismatch" > "$TMP/mismatch.log" 2>&1 || MISMATCH_RC=$?
bt_eq "指紋が一致しないと非ゼロ終了" "1" "$MISMATCH_RC"
if grep -qF "監査した依存ツリーと配布ツリーが一致しません" "$TMP/mismatch.log"; then
    bt_pass "指紋の不一致を理由に出す"
else
    bt_fail "指紋の不一致を理由に出す" "指紋の不一致を理由に出さない ($(log_tail mismatch.log 3))"
fi
bt_eq "指紋の不一致では gh を呼ばない" "0" "$(gh_call_count)"

TEST_FP="$(fingerprint_from_log "$TMP/mismatch.log")"
bt_eq "不一致でも配布ツリーの指紋を出力する" "1" \
    "$(printf '%s' "$TEST_FP" | grep -cE '^[0-9a-f]{64}$' | tr -d ' ')"

# 使い捨てリポ側で作った配布ツリーも HEAD の catalog を使う（作業ツリーの値と違うのを見られるのはここだけ）。
TAGGED_VITE="$(node -e "process.stdout.write(require('$TMP/dist-mismatch/assets/slidev/runtime/package.json').dependencies.vite)" 2> /dev/null)"
bt_eq "使い捨てリポ側の配布ツリーの vite が HEAD の catalog の範囲になる" "$HEAD_VITE" "$TAGGED_VITE"
bt_ne "使い捨てリポ側の配布ツリーの vite が作業ツリーの catalog の値ではない" "$WORKTREE_VITE" "$TAGGED_VITE"

# 9-4. 監査時 HEAD が現在の HEAD の親（nx が作る release commit の分）でも通る。
#      タグを立てた使い捨てリポ側のスクリプトを起動する（リポジトリ本体に ref を作らない）。
write_audit_record "$TEST_FP" "$TEST_PARENT" 0
if publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
    --out-dir="$TMP/dist-1" > "$TMP/publish1.log" 2>&1; then
    bt_pass "タグがあるとき publish が正常終了する"
else
    bt_fail "タグがあるとき publish が正常終了する" "publish が失敗した ($(log_tail publish1.log 3))"
fi
if grep -qF "監査記録と一致" "$TMP/publish1.log"; then
    bt_pass "監査時 HEAD が現在の HEAD の親でも突合が通る"
else
    bt_fail "監査時 HEAD が現在の HEAD の親でも突合が通る" "HEAD^ の記録で突合が通らない ($(log_tail publish1.log 3))"
fi
# gh の呼び出しは 3 つで、順序は view → upload → workflow run。-R は origin の URL から求めた値になる。
TEST_RELEASE_TAG="pecot-visual-v$TEST_VERSION"
TEST_TGZ_NAME="pecot-visual-mcp-$TEST_VERSION.tgz"
bt_eq "gh の呼び出しは 3 回" "3" "$(gh_call_count)"
bt_eq "1 回目の gh は Release の有無の確認" "release view $TEST_RELEASE_TAG -R $TEST_OWNER_REPO" \
    "$(sed -n '1p' "$GH_CALLS")"
UPLOAD_LINE="$(sed -n '2p' "$GH_CALLS")"
case "$UPLOAD_LINE" in
    "release upload $TEST_RELEASE_TAG /"*"/$TEST_TGZ_NAME --clobber -R $TEST_OWNER_REPO") bt_pass "2 回目の gh は tgz の添付（--clobber / -R つき）" ;;
    *) bt_fail "2 回目の gh は tgz の添付（--clobber / -R つき）" "添付の形でない ($UPLOAD_LINE)" ;;
esac
bt_eq "3 回目の gh はワークフローの起動（--ref でタグに固定）" \
    "workflow run publish-npm.yml -f tag=$TEST_RELEASE_TAG --ref $TEST_RELEASE_TAG -R $TEST_OWNER_REPO" \
    "$(sed -n '3p' "$GH_CALLS")"
if grep -qF "tgz: $TEST_TGZ_NAME" "$TMP/publish1.log"; then
    bt_pass "tgz の名前を出力する"
else
    bt_fail "tgz の名前を出力する" "tgz の名前を出力しない ($(log_tail publish1.log 4))"
fi

# 添付された tgz の中身。
UPLOADED_LIST="$TMP/uploaded-files.txt"
tar -tzf "$GH_UPLOAD_COPY" > "$UPLOADED_LIST" 2> /dev/null || : > "$UPLOADED_LIST"
bt_eq "添付された tgz の package.json の name" "@pecot/visual-mcp" \
    "$(tar -xzOf "$GH_UPLOAD_COPY" package/package.json 2> /dev/null | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0, 'utf8')).name)" 2> /dev/null)"
bt_eq "添付された tgz の package.json の version" "$TEST_VERSION" \
    "$(tar -xzOf "$GH_UPLOAD_COPY" package/package.json 2> /dev/null | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0, 'utf8')).version)" 2> /dev/null)"
bt_eq "添付された tgz に LICENSE が入り、HEAD のものと一致する" "$(git -C "$TEST_REPO" show HEAD:LICENSE | cksum)" \
    "$(tar -xzOf "$GH_UPLOAD_COPY" package/LICENSE 2> /dev/null | cksum)"
bt_eq "添付された tgz に shim が入る" "1" "$(grep -cx 'package/bin/pecot-visual-mcp.mjs' "$UPLOADED_LIST" | tr -d ' ')"
bt_eq "添付された tgz に npm-shrinkwrap.json が入る" "1" "$(grep -cx 'package/npm-shrinkwrap.json' "$UPLOADED_LIST" | tr -d ' ')"
bt_eq "添付された tgz に eslint プラグイン dist が入る" "1" \
    "$(grep -cx 'package/assets/slidev/scripts/eslint/_shared/dist/index.js' "$UPLOADED_LIST" | tr -d ' ')"
bt_eq "添付された tgz に .map を含むパスが無い" "0" "$(grep -c '\.map$' "$UPLOADED_LIST" | tr -d ' ')"
bt_eq "添付された tgz に証明書（certs 配下・.pem・.crt・.cer）が無い" "" \
    "$(grep -E '(^|/)certs?/|\.(pem|crt|cer)$' "$UPLOADED_LIST" | tr '\n' ' ')"

# 9-4b. 添付された tgz を、登録例と同じ npx で初回（cold）と 2 回目（warm）に起動し、同梱の text-rules が動くことを見る。
#       依存は PECOT_RELEASE_TEST_NPM_CACHE があればそのキャッシュを優先し、無ければ使い捨てのキャッシュでレジストリから取る。
NPX_CACHE="${PECOT_RELEASE_TEST_NPM_CACHE:-$TMP/npx-cache}"
# 絶対パスの import への退行を拾うため、配布ツリーの構築先は消してから起動する。
rm -rf "$TMP/dist-1"
# 前回の中断で opt-in のキャッシュに _npx が残ると、cold が warm になる。ループの前にも掃除する。
[ -n "${PECOT_RELEASE_TEST_NPM_CACHE:-}" ] && rm -rf "$NPX_CACHE/_npx"
NPX_FLAGS=(--yes "--cache=$NPX_CACHE")
[ -n "${PECOT_RELEASE_TEST_NPM_CACHE:-}" ] && NPX_FLAGS+=(--prefer-offline)
write_requests "$TMP/npx-requests.json" \
    tools/call "$(call_params slide_lint "{\"dir\":\"$TEXT_DIR\"}")" \
    || exit 1
mkdir -p "$TMP/home-npx"
# pnpm の devEngines を宣言した利用者のリポジトリを再現する。onFail は書かない（warn にすると退行を見逃す）。
printf '%s\n' '{"name":"devengines-repo","private":true,"devEngines":{"packageManager":{"name":"pnpm"}}}' \
    > "$TMP/home-npx/package.json"
# --prefix=/ が無ければ、この cwd の npx は EBADDEVENGINES で止まる。
if (cd "$TMP/home-npx" && env HOME="$TMP/home-npx" npx --yes "--cache=$NPX_CACHE" node -v) > "$TMP/npx-noprefix.out" 2>&1; then
    bt_fail "--prefix=/ 無しの npx が devEngines の cwd で EBADDEVENGINES になる" \
        "止まらなかった。npm が exec で devEngines を見なくなった可能性がある。--prefix=/ の要否を見直す ($(log_tail npx-noprefix.out 3))"
else
    bt_eq "--prefix=/ 無しの npx が devEngines の cwd で EBADDEVENGINES になる" "yes" \
        "$(grep -q EBADDEVENGINES "$TMP/npx-noprefix.out" && echo yes || echo no)"
    # 別の理由で止まったときは、原因が追えるように出力の末尾を出す。
    grep -q EBADDEVENGINES "$TMP/npx-noprefix.out" || echo "  npx-noprefix.out: $(log_tail npx-noprefix.out 3)"
fi
for run in cold warm; do
    NPX_JSON="$TMP/npx-$run.json"
    (cd "$TMP/home-npx" && env -u CLAUDE_PLUGIN_DATA -u PLUGIN_DATA -u XDG_DATA_HOME -u CLAUDE_PLUGIN_ROOT HOME="$TMP/home-npx" \
        SMOKE_BIN="$(command -v npx)" PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
        node "$TMP/smoke.mjs" "$TMP/npx-requests.json" "${NPX_FLAGS[@]}" --prefix=/ "file:$GH_UPLOAD_COPY") \
        > "$NPX_JSON" 2> "$TMP/npx-$run.err"
    NPX_INIT_TITLE="npx の $run 起動が initialize に応答する"
    NPX_LINT_TITLE="npx の $run 起動の slide_lint が文面違反を返す"
    NPX_BROKEN=""
    case "$(head -c 5 "$NPX_JSON")" in
        FAIL:)
            npx_detail="$(log_cat "npx-$run.json")"
            NPX_BROKEN="MCP サーバとして起動しない ($npx_detail)"
            ;;
        '')
            npx_detail="$(log_tail "npx-$run.err" 3)"
            NPX_BROKEN="smoke が何も出力しなかった ($npx_detail)"
            ;;
    esac
    if [ -n "$NPX_BROKEN" ]; then
        bt_fail "$NPX_INIT_TITLE" "$NPX_BROKEN"
        bt_fail "$NPX_LINT_TITLE" "$NPX_BROKEN"
    else
        bt_eq "$NPX_INIT_TITLE" "true" "$(smoke_value "$NPX_JSON" 1.ok)"
        bt_eq "$NPX_LINT_TITLE" "true text-constraints/textlint" \
            "$(smoke_value "$NPX_JSON" 2.call.ok) $(smoke_value "$NPX_JSON" 2.call.data | grep -o 'text-constraints/textlint' | sort -u)"
    fi
done
# opt-in のキャッシュに npx の作業ディレクトリを残さない。
[ -n "${PECOT_RELEASE_TEST_NPM_CACHE:-}" ] && rm -rf "$NPX_CACHE/_npx"

# 9-5. 同版で再実行しても同じ 3 つの呼び出しが通る（--clobber で上書きし、publish 済みの版はワークフローが飛ばす）。
write_audit_record "$TEST_FP" "$TEST_HEAD" 0
if publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
    --out-dir="$TMP/dist-2" > "$TMP/publish2.log" 2>&1; then
    bt_pass "同版の再実行が正常終了する"
else
    bt_fail "同版の再実行が正常終了する" "同版の再実行が失敗した ($(log_tail publish2.log 3))"
fi
bt_eq "再実行の gh の呼び出しは 3 回増える" "6" "$(gh_call_count)"
bt_eq "再実行も Release の確認から始まる" "$(sed -n '1p' "$GH_CALLS")" "$(sed -n '4p' "$GH_CALLS")"
bt_eq "再実行も同じワークフローを起動する" "$(sed -n '3p' "$GH_CALLS")" "$(sed -n '6p' "$GH_CALLS")"
bt_eq "テストはリポジトリ本体に検証用タグを残さない" "0" \
    "$(git -C "$REPO_ROOT" tag -l "$TEST_TAG" | wc -l | tr -d ' ')"

# 9-5b. Release が無いときは、添付もワークフローの起動もせずに止まる。
GH_BEFORE="$(gh_call_count)"
NORELEASE_RC=0
GH_VIEW_RC=1 publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
    --out-dir="$TMP/dist-norelease" > "$TMP/norelease.log" 2>&1 || NORELEASE_RC=$?
bt_eq "Release が無いと非ゼロ終了" "1" "$NORELEASE_RC"
if grep -qF "Release $TEST_RELEASE_TAG を確認できません" "$TMP/norelease.log"; then
    bt_pass "Release が無い理由を出す"
else
    bt_fail "Release が無い理由を出す" "Release が無い理由を出さない ($(log_tail norelease.log 3))"
fi
if grep -qF "release not found" "$TMP/norelease.log"; then
    bt_pass "gh release view の標準エラーを原因として添える"
else
    bt_fail "gh release view の標準エラーを原因として添える" "gh release view の標準エラーを添えない ($(log_tail norelease.log 3))"
fi
bt_eq "Release が無いときの gh は確認の 1 回だけ" "$((GH_BEFORE + 1))" "$(gh_call_count)"
bt_eq "Release が無いときの最後の gh は確認" "release view $TEST_RELEASE_TAG -R $TEST_OWNER_REPO" \
    "$(tail -1 "$GH_CALLS")"

# 9-6. 作業ツリーが HEAD と乖離しているときは publish しない（タグの指すコミットに対応しない配布物を防ぐ）。
GH_BEFORE="$(gh_call_count)"
printf '\ndirty\n' >> "$TEST_PECOTV/scripts/release/mcp-dist-README.md"
if publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
    --out-dir="$TMP/dist-dirty" > "$TMP/dirty.log" 2>&1; then
    bt_fail "作業ツリーが HEAD と乖離しているとき publish を拒否する" "乖離していても publish が通った"
elif grep -q "未コミットの変更" "$TMP/dirty.log"; then
    bt_pass "作業ツリーが HEAD と乖離しているとき publish を拒否する"
else
    bt_fail "作業ツリーが HEAD と乖離しているとき publish を拒否する" "乖離判定以外の理由で失敗した ($(log_tail dirty.log 2))"
fi
bt_eq "乖離時の実行は gh を呼ばない" "$GH_BEFORE" "$(gh_call_count)"
git -C "$TEST_REPO" checkout --quiet -- plugins/pecot-visual/scripts/release/mcp-dist-README.md

# --- 10. --out-dir ガード ---
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

# 廃止した --repo は未対応の引数として弾く。
if bash "$PUBLISH" --dry-run --skip-build --repo=owner/name --out-dir="$TMP/dist-oldflag" > "$TMP/oldflag.log" 2>&1; then
    bt_fail "廃止した --repo は未対応の引数として弾く" "受け付けた"
elif grep -qF "未対応の引数: --repo=owner/name" "$TMP/oldflag.log"; then
    bt_pass "廃止した --repo は未対応の引数として弾く"
else
    bt_fail "廃止した --repo は未対応の引数として弾く" "--repo の拒否が別の理由で失敗した ($(log_tail oldflag.log 2))"
fi

reject_out_dir "リポジトリ配下" "$REPO_ROOT/plugins/pecot-visual/scripts"
reject_out_dir "リポジトリルート" "$REPO_ROOT"
reject_out_dir "ルート /" "/"
mkdir -p "$TMP/nonempty/keep"
reject_out_dir "空でない既存ディレクトリ" "$TMP/nonempty"
# symlink を経由してリポジトリ配下を指す場合も、正規化して同じ扱いにする。
ln -s "$REPO_ROOT" "$TMP/repo-link"
reject_out_dir "symlink 経由でリポジトリ配下を指すパス" "$TMP/repo-link/docs"
bt_eq "ガードは対象ディレクトリを消さない" "1" \
    "$(ls -A "$TMP/nonempty" | wc -l | tr -d ' ')"

# --- 11. テストはリポジトリ本体の監査記録に触れない ---
# 指紋は本体の実監査と一致し得る (#1074) ので、本体の記録が由来の印（TEST_REGISTRY）を持たないことだけを見る。
bt_ne "リポジトリ本体の既定パスの記録が本テスト由来でない" \
    "$TEST_REGISTRY" "$(record_registry "$REAL_RECORD_FILE")"

bt_finish
