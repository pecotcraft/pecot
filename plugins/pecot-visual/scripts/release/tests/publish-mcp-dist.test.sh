#!/bin/bash
# publish-mcp-dist.sh（pecot-visual MCP サーバの tgz 作成と Release への添付）の検証 (#982)。
#
# 配布ツリーの構築結果、specifier 書き換え後の lint 同値性、起動、冪等性を固定する。
# 届け先の gh は PATH 先頭の偽 gh に差し替え、引数を記録する。GitHub にも npm の registry の公開先にも書き込まない。
# ただし npm-shrinkwrap.json の生成だけは、npm のメタデータ解決を伴う。
#
# 前提は、cli・eslint プラグイン・text-rules の dist が build 済みであること。
# build 自体は cli / slidev レーンと nx の text-rules:build が担当するので、本テストでは実行しない。
# publish は原則 --skip-build を付けて実行する。
# build を伴う場合（セクション 1-4）だけは、偽 pnpm と偽 npm を PATH に被せて、呼び出し順だけを検証する。
# run-tests.sh --scope=release が事前に build する。
#
# `set -e` は使わない。早期 return の検証で、非ゼロ終了を意図的に発生させる。
set -u

# git hook (pre-push の nx affected 等) から起動されると、git が GIT_DIR / GIT_INDEX_FILE を export する。
# その状態では `git -C <dir>` の -C が無視され、**リポジトリ本体の index** が書き換わる。
# 本テストは使い捨てリポと REPO_ROOT の双方へ git を発行する。
# そのため、継承した git env は先頭で必ず捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE
# nx release --dry-run の親から起動されると NX_DRY_RUN が届き、非 dry-run の検証まで dry-run になる。
# 本テストは dry-run の有無を引数で作り分けるので、継承した値は先頭で捨てる。
unset NX_DRY_RUN

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$RELEASE_DIR/../../../.." && pwd)"
PECOTV_ROOT="$REPO_ROOT/plugins/pecot-visual"
RUNTIME_SOURCE="$PECOTV_ROOT/assets/slidev/runtime"
# lint の同値性（セクション 6）で talk-dir が参照するテーマ。宣言つきの固定のテーマを元にする。
# 元の宣言は他のテストが固定しているので、複製して lint の rule だけを本テストの確認対象に差し替える。
FIXTURE_THEME_SOURCE="$PECOTV_ROOT/cli/tests/fixtures/themes/with-declaration"
FIXTURE_THEME_NAME="slidev-theme-pecotv-test-declared"
ESLINT_SOURCE="$PECOTV_ROOT/assets/slidev/scripts/eslint"
DECK_LINT_SOURCE="$PECOTV_ROOT/assets/slidev/deck-lint.env.config.js"
PUBLISH="$RELEASE_DIR/publish-mcp-dist.sh"
FINGERPRINT="$RELEASE_DIR/dist-fingerprint.mjs"

# 被テストスクリプトは、何も指定しなければリポジトリ本体の .nx/release-audit/ から記録を読む。
# PECOTV_AUDIT_RECORD の渡し忘れで、本体の記録に触れていないことを末尾で確かめる。
# 実行前後の一致では見られない。同じ checkout で並行して動く別のリリース系コマンドの書き込みを拾い、
# 偽の FAIL になる。そこで、テスト自身が書いたかどうかだけを見る。
REAL_RECORD_FILE="$REPO_ROOT/.nx/release-audit/pecotv-audit.json"
# 本テストが書く記録に載せる由来の印。実監査の既定 registry（https://registry.npmjs.org/）
# とは決して一致しない値を選ぶ（RFC 2606 の .invalid ドメイン）。
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

TMP=$(mktemp -d)
cleanup() {
    rm -rf "$TMP"
}
trap cleanup EXIT

# 配布ツリーのブランドの語の確認に渡す一覧。本テストの語は、実在の語ではなく人工の文字列にする。
# 配布ツリーはこの語を含まないので、確認は「一致 0 件」で通る。
TERMS_FILE="$TMP/brand-terms.txt"
printf '# synthetic terms for publish test\nzz-synthetic-brand-term\n' > "$TERMS_FILE"
export PECOT_BRAND_TERMS_FILE="$TERMS_FILE"

# 監査記録は publish が読む。テストは全呼び出しを $TMP 配下へ向ける。
export PECOTV_AUDIT_RECORD="$TMP/audit-record.json"

# 失敗の補足に使う。$TMP 配下のログについて、末尾 N 行・全体・指定文字列を含む行を 1 行にまとめて返す。
# 失敗メッセージの文字列に引用符入りの $(...) を入れず、引数は $TMP からの相対名で渡す。
log_tail() {
    tail -"$2" "$TMP/$1" | tr '\n' ' '
}
log_cat() {
    cat "$TMP/$1"
}
log_lines() {
    grep -F "$2" "$TMP/$1" | tr '\n' ' '
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
# 期待値と一致しないことを 1 行で判定する。
assert_ne() {
    local label="$1" unexpected="$2" actual="$3"
    if [ "$unexpected" != "$actual" ]; then
        pass "$label"
    else
        fail "$label (一致してはいけない値と一致した: '$actual')"
    fi
}

# 監査 pass の記録を書く。引数は配布ツリーの指紋、監査時 HEAD、両ツリーの high 件数になる。
# $4 の永続層 high は、省略すると 0 になる。
# JSON は audit-record.mjs を呼ばず手組みする。
# 読み手（publish）の消費者テストとして、書き手と独立に記録の契約を言い直す。
# registry には由来の印を載せる。記録は、監査した 2 ツリー分のセクションを持つ (#1071)。
# publish が突合するのは配布ツリー (dist) の指紋だけで、永続層 (runtime) は素性を確認する対象になる。
# high 件数は両ツリーへ独立に置ける。publish の blocking は、両ツリーの合計を見る。
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
# publish が出力した配布ツリーの指紋。期待値を外部から持ち込まないよう、突合の期待値は
# 常に実行結果から取る。上流の新版で解決結果が変わっても、比較は成り立つ。
fingerprint_from_log() {
    sed -n 's/^==> 配布ツリーの指紋: \([0-9a-f]\{64\}\)$/\1/p' "$1" | tail -1
}
# 記録の素性だけを見るケース（存在・skipped・HEAD・severity）で使う置き場所。
# これらは指紋の突合より前に止まるので、値そのものは判定に使われない。
DUMMY_FP="0000000000000000000000000000000000000000000000000000000000000000"
UNRELATED_SHA="1111111111111111111111111111111111111111"

REPO_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"

ESLINT_PKGS=(_shared slidev-pages-lint text-constraints validate-references)

# build 済み dist の存在を前提条件として先に確認する（無いまま進むと publish が
# 途中で落ち、原因が build 未実行だと分からない出力になる）。
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

# 届け先の gh は偽物に差し替える。呼び出しの引数を 1 行ずつ記録し、本物の GitHub には何も送らない。
#   release view   : GH_VIEW_RC（既定 0）で終了する。Release の有無を作り分ける。
#   release upload: 添付する tgz を GH_UPLOAD_COPY へ写す。publish は tgz を使い捨てのディレクトリに置き、終了時に消す。
# PATH の先頭に置くので、dry-run を含む全ての実行で本物の gh は呼ばれない。
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
# 依存解決を永続キャッシュで速くするため、PATH 先頭の偽 npm が install にだけキャッシュと --prefer-offline を足す。
# pack などは本物の npm にそのまま渡す。publish が渡す --cache は、後ろに足した --cache が上書きする。
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

# 冪等性の確認は、HEAD のリリースタグで判定する。
# tag は worktree 間で共有される ref なので、リポジトリ本体には作らない。
# 中断で残ると、`git push --follow-tags` に巻き込まれてしまう。
# 代わりに、publish が必要とする入力だけを持つ使い捨てリポを組み立て、タグはその中に立てる。
# 中身は HEAD ではなく作業ツリーから取る。未コミットの変更を、検証対象から漏らさない。
TEST_VERSION="0.0.0-test$$"
TEST_TAG="pecot-visual-v$TEST_VERSION"
TEST_REPO="$TMP/repo"
TEST_PECOTV="$TEST_REPO/plugins/pecot-visual"
mkdir -p "$TEST_REPO"
git init --quiet --initial-branch=main "$TEST_REPO" || exit 1
# gh の -R は origin の URL から求める。https 形式の使い捨ての URL を置く。
TEST_OWNER_REPO="test-owner/test-repo"
git -C "$TEST_REPO" remote add origin "https://github.com/$TEST_OWNER_REPO.git" || exit 1
# 監査記録の HEAD は、現在の HEAD かその親（nx が作る release commit の分）に一致すれば通る。
# 親が HEAD になる場合を再現できるよう、fixture commit の下にベース commit を 1 本置く。
git -C "$TEST_REPO" commit --quiet --allow-empty -m base > /dev/null 2>&1 || exit 1
# git 管理対象の入力は、git archive の対象ディレクトリ、manifest、スクリプト本体になる。
# libs/text-rules/package.json は、同梱する text-rules の dependencies を配布 package.json へ載せる元になる。
# ls-files で列挙するので、node_modules 等は自動的に外れる。
# plugins/pecot-visual/bin も同梱する。
# publish-mcp-dist.sh は pnpm を解決するために、bin/_lib.sh を source する。
# bin/_lib.sh は run-tests.sh と run-lint.sh も共通で使う。
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
    .githooks/pre-commit/check-brand-terms.sh \
    | tar --null -T - -cf -) | tar -xf - -C "$TEST_REPO" || exit 1
# scripts/release だけは、作業ツリーから丸ごと上書きする。
# git ls-files は未追跡ファイルを落とす。
# そのため、追加直後の新規スクリプト（publish が起動するモジュール等）が TEST_REPO に入らない。
# すると commit 前のテストだけが、原因不明のまま落ちる。
rm -rf "$TEST_PECOTV/scripts/release" || exit 1
cp -a "$PECOTV_ROOT/scripts/release" "$TEST_PECOTV/scripts/release" || exit 1
# 共通スクリプト（pack から gh まで）も同じ理由で作業ツリーから置く。
mkdir -p "$TEST_REPO/.githooks/scripts" || exit 1
cp -a "$REPO_ROOT/.githooks/scripts/attach-mcp-tgz.sh" "$REPO_ROOT/.githooks/scripts/origin-slug.mjs" "$TEST_REPO/.githooks/scripts/" || exit 1
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
TAGGED_PUBLISH="$TEST_PECOTV/scripts/release/publish-mcp-dist.sh"

# --- 1. dry-run: 監査記録の確認と配布ツリーの構築 ---

# 1-1. 監査記録が無ければ build にも入らず止まる（#1059）。
#      監査を経ていないツリーを配布させないための確認で、dry-run でも同じように働く。
NORECORD_RC=0
rm -f "$PECOTV_AUDIT_RECORD"
bash "$PUBLISH" --dry-run --skip-build --out-dir="$TMP/dist-norecord" \
    > "$TMP/norecord.log" 2>&1 || NORECORD_RC=$?
assert_eq "監査記録が無いと dry-run でも非ゼロ終了" "1" "$NORECORD_RC"
if grep -qF "監査記録がありません" "$TMP/norecord.log"; then
    pass "記録が無い理由を出す"
else
    fail "記録が無い理由を出さない ($(log_tail norecord.log 2))"
fi
if [ ! -d "$TMP/dist-norecord" ]; then
    pass "記録が無いときは配布ツリーを構築しない"
else
    fail "記録が無いのに配布ツリーを構築した"
fi

# 1-2. 監査スキップの記録（pecot 単独リリース）は dry-run では突合を省略して通る。
#      指紋の期待値はこの実行が出力した値から取る（外部から持ち込まない）。
echo "==> dry-run で配布ツリーを構築（監査スキップの記録）"
write_skipped_audit_record "$REPO_HEAD"
if bash "$PUBLISH" --dry-run --skip-build --out-dir="$TMP/dist-skipped" \
    > "$TMP/dryrun-skipped.log" 2>&1; then
    pass "監査スキップの記録で dry-run が正常終了する"
else
    fail "監査スキップの dry-run が失敗した (末尾ログ: $(log_tail dryrun-skipped.log 3))"
    echo "--- dry-run log ---"
    cat "$TMP/dryrun-skipped.log"
    echo "PASS: $PASS / FAIL: $FAIL"
    exit 1
fi
if grep -qF "突合を省略" "$TMP/dryrun-skipped.log"; then
    pass "監査スキップの dry-run は突合を省略する"
else
    fail "突合を省略した旨を出さない ($(log_tail dryrun-skipped.log 2))"
fi

DIST_FP="$(fingerprint_from_log "$TMP/dryrun-skipped.log")"
assert_eq "配布ツリーの指紋を 64 桁 hex で出力する" "1" \
    "$(printf '%s' "$DIST_FP" | grep -cE '^[0-9a-f]{64}$' | tr -d ' ')"
assert_eq "出力の指紋が生成された shrinkwrap の指紋と一致" \
    "$(node "$FINGERPRINT" "$TMP/dist-skipped/npm-shrinkwrap.json" 2> /dev/null || echo __NO_SHRINKWRAP__)" \
    "$DIST_FP"

# 1-3. 監査記録があれば指紋を突合して通る。以降のセクションはこの $DIST を検証する。
echo "==> dry-run で配布ツリーを構築（指紋の突合あり）"
write_audit_record "$DIST_FP" "$REPO_HEAD" 0
# セクション 11 の陽性側。印が書き出されなくなると 11 が常に pass する退行になるため、
# 印が実際に載っていることをここで固定する。
assert_eq "テストが書く記録は由来の印を持つ" "$TEST_REGISTRY" \
    "$(record_registry "$PECOTV_AUDIT_RECORD")"
if bash "$PUBLISH" --dry-run --skip-build --out-dir="$DIST" > "$TMP/dryrun.log" 2>&1; then
    pass "dry-run が正常終了する"
else
    fail "dry-run が失敗した (末尾ログ: $(log_tail dryrun.log 3))"
    echo "--- dry-run log ---"
    cat "$TMP/dryrun.log"
    echo "PASS: $PASS / FAIL: $FAIL"
    exit 1
fi
if grep -qF "配布ツリーの指紋: $DIST_FP" "$TMP/dryrun.log"; then
    pass "再構築しても配布ツリーの指紋が同じ"
else
    fail "再構築で配布ツリーの指紋が変わった ($(log_lines dryrun.log 配布ツリーの指紋))"
fi
if grep -qF "監査記録と一致" "$TMP/dryrun.log"; then
    pass "監査記録との一致を出力する"
else
    fail "監査記録との一致を出力しない ($(log_tail dryrun.log 2))"
fi

# dry-run は npm pack まで実行し、gh の 3 つは表示だけにする。
assert_eq "dry-run は gh を呼ばない" "0" "$(gh_call_count)"
# dry-run の表示は、タグの版が nx の上げる前の値であることを添える。
if grep -qF "版は version の段階より前の値です" "$TMP/dryrun.log"; then
    pass "dry-run が、表示するタグの版は本実行で変わり得ると注記する"
else
    fail "dry-run の表示に版の注記が無い ($(log_tail dryrun.log 3))"
fi
assert_eq "dry-run は tgz の名前を出力する" "1" \
    "$(grep -cxF "==> tgz: pecot-visual-mcp-$PLUGIN_VERSION.tgz" "$TMP/dryrun.log" | tr -d ' ')"
assert_eq "dry-run は tgz の中身に LICENSE を出力する" "1" \
    "$(grep -cxF '    LICENSE' "$TMP/dryrun.log" | tr -d ' ')"
assert_eq "dry-run は tgz の中身に shim を出力する" "1" \
    "$(grep -cxF '    bin/pecot-visual-mcp.mjs' "$TMP/dryrun.log" | tr -d ' ')"
assert_eq "dry-run の tgz の中身に .map を含むパスが無い" "0" \
    "$(grep -c '^    .*\.map$' "$TMP/dryrun.log" | tr -d ' ')"
# 証明書の同梱を見る。extra-ca-certs.js や certificate.svg のような、実装と icon の名前は対象外。
assert_eq "dry-run の tgz の中身に証明書（certs 配下・.pem・.crt・.cer）が無い" "" \
    "$(grep -E '^    (.*/)?certs?/|^    .*\.(pem|crt|cer)$' "$TMP/dryrun.log" | tr -d ' ' | tr '\n' ' ')"
# dry-run が表示する gh の 3 行。-R は origin の URL から求める。
for needle in "gh release view pecot-visual-v$PLUGIN_VERSION -R" \
    "gh release upload pecot-visual-v$PLUGIN_VERSION pecot-visual-mcp-$PLUGIN_VERSION.tgz --clobber -R" \
    "gh workflow run publish-npm.yml -f tag=pecot-visual-v$PLUGIN_VERSION --ref pecot-visual-v$PLUGIN_VERSION -R"; do
    if grep -qF "$needle" "$TMP/dryrun.log"; then
        pass "dry-run が実行予定の gh コマンドを表示する: ${needle%% -*}"
    else
        fail "dry-run が実行予定の gh コマンドを表示しない: $needle"
    fi
done

# 配布ツリーのブランドの語の確認。一覧を渡した上の実行は、確認の結果を出して通る。
if grep -qF "一致 0 件" "$TMP/dryrun.log"; then
    pass "配布ツリーの語の確認が「一致 0 件」を出力する"
else
    fail "配布ツリーの語の確認の結果が出ていない ($(log_tail dryrun.log 4))"
fi

# 一覧が無いときは build にも配布ツリーの構築にも入らず止まる。
NOTERMS_RC=0
env -u PECOT_BRAND_TERMS_FILE bash "$PUBLISH" --dry-run --skip-build \
    --out-dir="$TMP/dist-noterms" > "$TMP/noterms.log" 2>&1 || NOTERMS_RC=$?
assert_eq "語の一覧が無いと非ゼロ終了" "1" "$NOTERMS_RC"
if grep -qF "ブランドの語の一覧が無い" "$TMP/noterms.log"; then
    pass "語の一覧が無い理由を出す"
else
    fail "語の一覧が無い理由を出さない ($(log_tail noterms.log 2))"
fi
if [ ! -d "$TMP/dist-noterms" ]; then
    pass "語の一覧が無いときは配布ツリーを構築しない"
else
    fail "語の一覧が無いのに配布ツリーを構築した"
fi

# 配布ツリーに語が残っていれば、dry-run でも止まる。語は一覧に足して再現する（ツリーの側は変えない）。
MATCH_TERMS="$TMP/brand-terms-match.txt"
# 合成した語を使う。この語は package.json の bin の名前と shim のパスに入るので、配布ツリーから必ず見つかる。
printf 'pecot-visual-mcp\n' > "$MATCH_TERMS"
MATCH_RC=0
PECOT_BRAND_TERMS_FILE="$MATCH_TERMS" bash "$PUBLISH" --dry-run --skip-build \
    --out-dir="$TMP/dist-match" > "$TMP/match.log" 2>&1 || MATCH_RC=$?
assert_eq "配布ツリーに語が残っていると非ゼロ終了" "1" "$MATCH_RC"
if grep -qF "配布ツリーにブランドの語が残っている" "$TMP/match.log"; then
    pass "語が残っている理由を出す"
else
    fail "語が残っている理由を出さない ($(log_tail match.log 3))"
fi

# --- 1-4. build を伴う場合の pnpm 呼び出し順 ---
# publish は build を直接起動する。
# node_modules が lockfile と乖離した環境では、install を経ずに build が落ちる (#1087)。
# build の直前に、lock の確認と install が入ることを、呼び出しの順序と cwd で固定する。
# 実 build はレーンの担当なので、この 1 ケースだけ、PATH の先頭に偽 pnpm を被せて呼び出しを記録する。
# resolve_pnpm は `command -v pnpm` を最優先するので、shim が採られる。
# build は偽装するので、配布ツリーの cli/dist は既存の build 済みツリーがそのまま使われる。
echo "==> dry-run で pnpm 呼び出し順を検証（偽 pnpm）"
mkdir -p "$TMP/bin"
PNPM_CALLS="$TMP/pnpm-calls.txt"
# publish は eslint プラグインの build 前に、各パッケージの dist を消す。
# 本体ツリーの dist は、並行して動く別のレーン（test-cli の deck lint など）が読んでいる (#82)。
# そのため publish には PECOTV_ESLINT_PLUGINS_DIR で一時の写しを指させ、本体ツリーの dist には触らせない。
# 偽 pnpm は build をしないので、写しの dist を退避しておき、eslint の build 呼び出しで戻す。
# 戻す前に dist の有無を記録し、build の前に消えていたことを後で確かめる。
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
# 呼び出しごとに「cwd<TAB>引数」を 1 行追記する。build はしない。
# eslint プラグインの build 呼び出しだけは、build の時点で残っていた dist を記録し、退避した dist を戻す。
printf '%s\t%s\n' "$PWD" "$*" >> "$PNPM_CALLS"
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
# text-rules の build は npm --prefix で起動される。実行すると dist を作り直すため、
# --prefix 付きの呼び出しだけ記録して止め、依存解決など他の呼び出しは実体の npm へ渡す。
NPM_CALLS="$TMP/npm-calls.txt"
REAL_NPM="$(command -v npm)"
cat > "$TMP/bin/npm" << 'FAKE_NPM'
#!/bin/bash
case "$*" in
    --prefix*)
        printf '%s\t%s\n' "$PWD" "$*" >> "$NPM_CALLS"
        exit 0
        ;;
esac
exec "$REAL_NPM" "$@"
FAKE_NPM
chmod +x "$TMP/bin/npm"
: > "$PNPM_CALLS"
: > "$NPM_CALLS"
BUILD_RC=0
PECOTV_ESLINT_PLUGINS_DIR="$TMP/eslint-tree" NPM_CALLS="$NPM_CALLS" REAL_NPM="$REAL_NPM" PNPM_CALLS="$PNPM_CALLS" \
    ESLINT_TREE="$ESLINT_TREE" ESLINT_BACKUP="$ESLINT_BACKUP" ESLINT_DIST_AT_BUILD="$ESLINT_DIST_AT_BUILD" \
    ESLINT_PKGS="${ESLINT_PKGS[*]}" PATH="$TMP/bin:$PATH" \
    bash "$PUBLISH" --dry-run --out-dir="$TMP/dist-build" \
    > "$TMP/dryrun-build.log" 2>&1 || BUILD_RC=$?
assert_eq "build を伴う dry-run が正常終了する" "0" "$BUILD_RC"
# 古い dist が残ると、削除したソースに対応するモジュールが配布へ同梱される。build の前に消えていることを見る。
assert_eq "eslint プラグインの build の時点で、前回の dist が残っていない" "0" \
    "$(wc -l < "$ESLINT_DIST_AT_BUILD" 2> /dev/null | tr -d ' ')"
assert_eq "偽 build が dist を戻した後、写しの dist が揃っている" "${#ESLINT_PKGS[@]}" \
    "$(for pkg in "${ESLINT_PKGS[@]}"; do [ -f "$ESLINT_TREE/$pkg/dist/index.js" ] && echo "$pkg"; done | wc -l | tr -d ' ')"
if [ "$(eslint_source_fingerprint)" = "$ESLINT_SOURCE_BEFORE" ]; then
    pass "build を伴う dry-run が、本体ツリーの eslint プラグインの dist に触らない"
else
    fail "build を伴う dry-run が、本体ツリーの eslint プラグインの dist を変えた"
fi
assert_eq "1 回目の pnpm 呼び出しは lock の確認" "install --lockfile-only --prefer-offline" \
    "$(sed -n '1s/^[^\t]*\t//p' "$PNPM_CALLS")"
assert_eq "2 回目の pnpm 呼び出しは install（lifecycle は動かさない）" "install --prefer-frozen-lockfile --ignore-scripts" \
    "$(sed -n '2s/^[^\t]*\t//p' "$PNPM_CALLS")"
assert_eq "install の cwd は pecot-visual プラグインルート" "$PECOTV_ROOT" \
    "$(sed -n '2s/\t.*//p' "$PNPM_CALLS")"
# 導入のあと、text-rules の ci を挟んでから、assets/slidev の prepare を明示して動かす。
assert_eq "3 回目の pnpm 呼び出しは assets/slidev の prepare" "--filter @pecot/slidev-assets-dev run prepare" \
    "$(sed -n '3s/^[^\t]*\t//p' "$PNPM_CALLS")"
assert_eq "prepare の cwd は pecot-visual プラグインルート" "$PECOTV_ROOT" \
    "$(sed -n '3s/\t.*//p' "$PNPM_CALLS")"
assert_eq "4 回目の pnpm 呼び出しは cli の build" "--filter @pecot/pecotv-cli run build" \
    "$(sed -n '4s/^[^\t]*\t//p' "$PNPM_CALLS")"
assert_eq "5 回目の pnpm 呼び出しは eslint プラグインを含む build" "--filter @pecot/slidev-assets-dev run build" \
    "$(sed -n '5s/^[^\t]*\t//p' "$PNPM_CALLS")"
# 1 回目の ci は、開発環境の導入（pecotv_dev_install）の中で、prepare の前にある。
# pnpm が整理した libs/text-rules/node_modules を、npm で戻す。
# 配布ツリー用の text-rules の dist は、その ci を繰り返さず build だけで作る。これが 2 回目になる。
assert_eq "1 回目の npm --prefix 呼び出しは導入後の text-rules の ci" "--prefix libs/text-rules ci" \
    "$(sed -n '1s/^[^\t]*\t//p' "$NPM_CALLS")"
assert_eq "2 回目の npm --prefix 呼び出しは text-rules の build" "--prefix libs/text-rules run build" \
    "$(sed -n '2s/^[^\t]*\t//p' "$NPM_CALLS")"
assert_eq "npm --prefix 呼び出しは 2 回だけ" "2" "$(wc -l < "$NPM_CALLS" | tr -d ' ')"
assert_eq "text-rules の npm 呼び出しの cwd はリポジトリルート" "$REPO_ROOT" \
    "$(sed -n '1s/\t.*//p' "$NPM_CALLS")"

# install が失敗したときに build へ進まず非ゼロで止まることを固定する。
# install は lockfile と package.json の乖離でも落ちるため、そのまま build に進むと lockfile を
# 無視した配布ツリーができる。偽 pnpm の 2 ケース目は install のときだけ exit 1 する。
echo "==> install の失敗で publish が止まることを検証（偽 pnpm）"
cat > "$TMP/bin/pnpm" << 'FAKE_PNPM_FAIL'
#!/bin/bash
printf '%s\t%s\n' "$PWD" "$*" >> "$PNPM_CALLS"
case "$*" in
    "install --prefer-frozen-lockfile --ignore-scripts") exit 1 ;;
esac
exit 0
FAKE_PNPM_FAIL
chmod +x "$TMP/bin/pnpm"
: > "$PNPM_CALLS"
: > "$NPM_CALLS"
INSTALL_FAIL_RC=0
NPM_CALLS="$NPM_CALLS" REAL_NPM="$REAL_NPM" PNPM_CALLS="$PNPM_CALLS" PATH="$TMP/bin:$PATH" \
    bash "$PUBLISH" --dry-run --out-dir="$TMP/dist-install-fail" \
    > "$TMP/dryrun-install-fail.log" 2>&1 || INSTALL_FAIL_RC=$?
if [ "$INSTALL_FAIL_RC" -ne 0 ]; then
    pass "install が失敗すると publish が非ゼロ終了する"
else
    fail "install が失敗したのに publish が正常終了した"
fi
# 記録が空だと下の build 不在は自明に成立するため、install が実際に呼ばれた印を先に置く。
assert_eq "失敗ケースでも 2 回目は install" "install --prefer-frozen-lockfile --ignore-scripts" \
    "$(sed -n '2s/^[^\t]*\t//p' "$PNPM_CALLS")"
assert_eq "install 失敗後に build を呼ばない" "0" \
    "$(grep -c 'run build' "$PNPM_CALLS" | tr -d ' ')"
assert_eq "install 失敗後に text-rules の build も呼ばない" "0" \
    "$(grep -c 'run build' "$NPM_CALLS" | tr -d ' ')"
# pnpm が導入を始めた後の失敗なので、text-rules の依存は npm ci で 1 回だけ戻す。
assert_eq "install 失敗後に text-rules の依存を npm ci で戻す" "1" \
    "$(grep -c -- '--prefix libs/text-rules ci' "$NPM_CALLS" | tr -d ' ')"

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

assert_eq "package.json の version がプラグイン版と一致" "$PLUGIN_VERSION" "$(read_manifest version)"
assert_eq "package.json の name が公開名" "@pecot/visual-mcp" "$(read_manifest name)"
assert_eq "package.json の bin が shim を指す" '{"pecot-visual-mcp":"bin/pecot-visual-mcp.mjs"}' "$(read_manifest bin)"
assert_eq "package.json の license が MIT" "MIT" "$(read_manifest license)"
assert_eq "package.json の repository" \
    '{"type":"git","url":"git+https://github.com/pecotcraft/pecot.git","directory":"plugins/pecot-visual"}' \
    "$(read_manifest repository)"
# engines は node のみ。
assert_eq "package.json の engines は node のみ" "node" "$(read_manifest engines)"
# devEngines に pnpm を写すと、npm が EBADDEVENGINES で止まり、npx 自身が起動しない。
assert_eq "package.json に devEngines キーが無い" "false" "$(read_manifest hasDevEngines)"

DIST_DEPS="$(read_manifest deps)"
# 期待値を列挙で持つと、dist-manifest.mjs の RUNTIME_DEPS を人手で写しただけになる。
# 両方が同時に古くなり、drift を検出できない。
# そこで cli/package.json の dependencies から、永続層を除いた集合を作る。
# 永続層とは、setup ツールが置き場の mcp-dist/ へ入れる重量物を指す。
# この集合と、配布 package.json の cli 由来分を等値比較する。
# 重量物が起動層へ戻れば余剰として、cli に依存が増えれば欠落として、どちらも同じ比較で落ちる。
# 永続層の 3 件だけは意味境界そのものなので、ここで宣言する。
# npx は毎起動で node_modules を作り直す。これらを起動層に置くと、MCP_TIMEOUT を超える。
# workspace: 依存（text-rules）は npm に載せず、vendor/text-rules の実体を相対 import で指す。
# そのため配布 package.json には無く、expected 側から除く。
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
assert_eq "起動層の依存が cli/package.json の dependencies − 永続層 3 件 − @pecot/text-rules と一致する" \
    "$(runtime_dep_set expected)" "$(runtime_dep_set actual)"

# 同梱する text-rules の依存は libs/text-rules/package.json の dependencies そのもの。名前を列挙すると
# text-rules に依存が増えたときに写し忘れを検出できないため、その宣言と範囲まで比較する
# （配布 package.json に無い、または範囲が違う名前を列挙する）。
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
assert_eq "配布 package.json が libs/text-rules/package.json の dependencies を範囲ごと全部含む" "" "$(text_rules_dep_gap)"

# lint 系の eslint と @eslint/markdown は、cli ではなく assets/slidev/package.json の由来になる。
# そのため上の比較には現れない。
# textlint 系は libs/text-rules の dependencies に含まれ、上の比較が見る。ここには書かない。
for dep in eslint @eslint/markdown js-yaml ajv synckit; do
    case ",$DIST_DEPS," in
        *",$dep,"*) pass "lint 系の依存 $dep が宣言されている" ;;
        *) fail "lint 系の依存 $dep が package.json にない" ;;
    esac
done

LINT_RANGE_GAP="$(node -e "
const slidev = require('$PECOTV_ROOT/assets/slidev/package.json').devDependencies
const dist = require('$DIST/package.json').dependencies
process.stdout.write(['eslint', '@eslint/markdown'].filter((name) => dist[name] !== slidev[name]).join(','))
")"
assert_eq "lint 系の依存の範囲が assets/slidev/package.json の devDependencies と一致する" "" "$LINT_RANGE_GAP"
assert_eq "assets/slidev/package.json が配布ツリーに入る" "1" \
    "$([ -f "$DIST/assets/slidev/package.json" ] && echo 1 || echo 0)"

assert_eq "npm-shrinkwrap.json が lockfileVersion 3 で生成される" "3" \
    "$(node -e "process.stdout.write(String(require('$DIST/npm-shrinkwrap.json').lockfileVersion))" 2> /dev/null)"
assert_eq ".claude-plugin/plugin.json が実版を持つ" "$PLUGIN_VERSION" \
    "$(node -e "process.stdout.write(require('$DIST/.claude-plugin/plugin.json').version)" 2> /dev/null)"

# --- 2-2. README の登録例 ---

# 4 件 = 直接起動・PLUGIN_DATA 付き・WSL 経由・WSL で PLUGIN_DATA を渡す登録例（bash -lc の行は引用符が付かず対象外）。
assert_eq "README に未置換のプレースホルダ（__NAME__）が残っていない" "0" \
    "$(grep -cE '__[A-Za-z0-9_]+__' "$DIST/README.md" | tr -d ' ')"
assert_eq "README の登録例 4 件が公開名を指す" "4" \
    "$(grep -cF '"@pecot/visual-mcp"' "$DIST/README.md" | tr -d ' ')"
assert_eq "README に git の URL を指す登録例が残っていない" "0" \
    "$(grep -c 'git+' "$DIST/README.md" | tr -d ' ')"
assert_eq "README が版の固定を @<version> で案内する" "1" \
    "$(grep -cF '@pecot/visual-mcp@1.2.3' "$DIST/README.md" | tr -d ' ')"
assert_eq "配布ツリーに LICENSE が入り、HEAD のものと一致する" "$(git -C "$TEST_REPO" show HEAD:LICENSE | cksum)" \
    "$(cksum < "$DIST/LICENSE" 2> /dev/null || echo __NO_LICENSE__)"

# --- 3. .gitignore 除去と eslint プラグイン dist の同梱 ---

assert_eq "配布ツリーに .gitignore が残っていない" "0" \
    "$(find "$DIST" -name '.gitignore' | wc -l | tr -d ' ')"

DIST_ESLINT="$DIST/assets/slidev/scripts/eslint"
for pkg in _shared slidev-pages-lint text-constraints validate-references; do
    if [ -f "$DIST_ESLINT/$pkg/dist/index.js" ]; then
        pass "eslint プラグイン $pkg の dist が同梱されている"
    else
        fail "eslint プラグイン $pkg の dist が配布ツリーに無い（.gitignore の dist/ に落とされた疑い）"
    fi
done

# icon カタログは drawio_export の既定 icons root（<dist>/assets/drawio-icons）の実体。
# 欠けると icon:// を解決できないまま別のハッシュが返る（§8 のハッシュ 3 点比較の前提）。
assert_eq "smoke で使う icon カタログが配布ツリーに同梱される" "2" \
    "$(ls "$DIST/assets/drawio-icons/science/brain-circuit.svg" "$DIST/assets/drawio-icons/weather/cloud.svg" \
        2> /dev/null | wc -l | tr -d ' ')"

# runtime の manifest は、setup が実行時依存を入れる元になる。
# 落ちると setup は依存の宣言を読めず、起動のたびに失敗する。
# 期待値はソースツリーの manifest から読む。
# 配布ツリー側から読むと、期待値と被検証物が同じ git archive の出力になり、比較として成り立たない。
DIST_RUNTIME="$DIST/assets/slidev/runtime"
if [ -f "$DIST_RUNTIME/package.json" ] && cmp -s "$RUNTIME_SOURCE/package.json" "$DIST_RUNTIME/package.json"; then
    pass "runtime の manifest がソースと同じ内容で配布ツリーに同梱される"
else
    fail "runtime の manifest が配布ツリーに無い、またはソースと異なる（git archive の対象から落ちた疑い）"
fi

# pecot は証明書を同梱しない。プロキシの CA は利用者が NODE_EXTRA_CA_CERTS で渡す（§8 で受け渡しを見る）。
if [ ! -e "$DIST/assets/certs" ]; then
    pass "配布ツリーに assets/certs が無い"
else
    fail "配布ツリーに assets/certs が入っている"
fi
# npm の配布物にソースマップを入れない（spec 018 US4）。
assert_eq "配布ツリーに *.map が無い" "" \
    "$(find "$DIST" -name '*.map' -type f | head -n 3)"
if [ -f "$DIST/assets/drawio-icons/LICENSE" ]; then
    pass "assets/drawio-icons/LICENSE が配布ツリーにある"
else
    fail "assets/drawio-icons/LICENSE が配布ツリーに無い"
fi

# --- 4. specifier 書き換え ---

# 該当ファイルの数を返す。引用符入りの $(...) を assert の引数に直接書かないよう、関数に切り出している。
# 前者は、file: で始まる依存を持つ package.json の数を数える。
count_file_dependencies() {
    find "$1" -name 'package.json' -print0 | xargs -0 grep -l '"file:' 2> /dev/null | wc -l | tr -d ' '
}
# 後者は、JS ファイルのうち指定した文字列を含むものの数を数える。
count_js_containing() {
    grep -rl --include='*.js' --include='*.mjs' "$2" "$1" 2> /dev/null | wc -l | tr -d ' '
}
# 後者の亜種で、拡張正規表現に一致する JS ファイルの数を数える。
count_js_matching() {
    grep -rlE --include='*.js' --include='*.mjs' "$2" "$1" 2> /dev/null | wc -l | tr -d ' '
}
assert_eq "配布ツリーの package.json に file: 依存が無い" "0" "$(count_file_dependencies "$DIST")"
# 実行時に node が解決するのは .js だけで、.d.ts と各 package.json の workspace: 宣言は配布ツリーでは解釈されない。
# そのため、これらは書き換えの対象外とする。
assert_eq "eslint プラグイン dist の JS に @v-slidev の bare import が残っていない" "0" \
    "$(count_js_containing "$DIST_ESLINT" '@v-slidev/')"
assert_eq "eslint プラグイン dist の JS に @pecot/text-rules の bare import が残っていない" "0" \
    "$(count_js_containing "$DIST_ESLINT" '@pecot/text-rules')"
# 書き換え先の実体が同梱され、text-constraints dist がそれを相対パスで指すことを確かめる。
# import が消えただけで何も指さなくなる退行を、見逃さないようにする。
if [ -f "$DIST/vendor/text-rules/dist/index.js" ]; then
    pass "text-rules の dist が vendor/text-rules/dist に同梱されている"
else
    fail "text-rules の dist が配布ツリーに無い: vendor/text-rules/dist/index.js"
fi
# 絶対パスや別の場所への import ではなく、vendor への相対 import（../ で始まる）であることを見る。
if [ "$(count_js_matching "$DIST_ESLINT/text-constraints/dist" "from '(\\.\\./)+vendor/text-rules/dist/index\\.js'")" -gt 0 ]; then
    pass "text-constraints dist が同梱の text-rules を相対パスで import する"
else
    fail "text-constraints dist に vendor/text-rules/dist/index.js への相対 import が無い"
fi
# cli/dist の動的 import も、同じ実体へ向く。
# 配布 package.json には text-rules が無い。bare import のまま残ると、
# npx 起動の drawio_create / evidence_create が text-lint-failed になる。
assert_eq "cli/dist の JS に @pecot/text-rules の bare import が残っていない" "0" \
    "$(count_js_containing "$DIST/cli/dist" '@pecot/text-rules')"
if [ "$(count_js_matching "$DIST/cli/dist" "import\\('(\\.\\./)+vendor/text-rules/dist/index\\.js'\\)")" -gt 0 ]; then
    pass "cli/dist が同梱の text-rules を相対パスで動的 import する"
else
    fail "cli/dist に vendor/text-rules/dist/index.js への相対の動的 import が無い"
fi
assert_eq "cli/dist の JS に eslint-shared の実体（_shared/dist/index.js）への相対パスが無い" "0" \
    "$(count_js_containing "$DIST/cli/dist" '_shared/dist/index.js')"
# build は削除したソースに対応する dist を掃除しない。消したモジュールが配布へ残っていないことを見る。
assert_eq "配布の text-constraints dist に削除済みの textlint/rules.js が無い" "0" \
    "$(find "$DIST_ESLINT/text-constraints/dist/lib/textlint" -name 'rules.*' 2> /dev/null | wc -l | tr -d ' ')"
DECK_LINT_CONFIG="$DIST/assets/slidev/deck-lint.config.js"
assert_eq "deck-lint.config.js に @v-slidev の bare import が残っていない" "0" \
    "$(count_js_containing "$DECK_LINT_CONFIG" '@v-slidev/')"

# --- 5. 配布ツリーの node_modules を用意する ---
# npx は配布ルートに node_modules を作る。
# 同じ形をローカルの実体への symlink で再現し、lint 同値性（セクション 5）と起動 smoke（セクション 7）を
# ネットワーク無しで実行する。
# 解決の起点は、runtime の manifest（lint 系）と cli（起動層）の両方となる。
# require.resolve は、root export を持たないパッケージ（exports がサブパスだけ）で落ちる。
# そのため node_modules を実際に辿り、package の実体ディレクトリを探し当てる。
# 同名パッケージが複数版 hoist されている場合は、宣言された caret 範囲を満たす実体を優先する。
# 例として、slidev 側の依存にある @xmldom/xmldom 0.8 と、cli の 0.9 が並ぶ場合を考える。
# この動きは、npm が配布 package.json の範囲から選ぶ動きと同じになる。
# 範囲を満たす実体が無い場合だけ、最初に見つかった実体を使う。

MISSING_LINKS="$(node -e "
const fs = require('node:fs'), path = require('node:path')
const [dist, ...bases] = process.argv.slice(1)
const parseVersion = (text) => text.replace(/^[^0-9]*/, '').split('.').slice(0, 3).map(Number)
// range が caret (^) で始まらない固定 pin（例: '1.1.10'）は caret 意味論を適用せず完全一致で
// 判定する。caret 範囲は want の先頭の非ゼロ桁（pivot）を固定し、それより右の桁は
// upper-compatible な上位互換のみ許容する（npm の caret range と同じ規則）。
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
assert_eq "配布 package.json の依存がすべてローカルに実体を持つ" "" "$MISSING_LINKS"

# --- 6. lint 結果がプラグイン側の実行と一致する ---
# 既知違反（フロントマター内の余分な `---`）を同一入力でプラグインと配布ツリーの両方に流し、検出した rule ID を比べる。

FIXTURE_THEME="$TMP/lint-theme/$FIXTURE_THEME_NAME"

# talk-dir をテーマ参照の形にする。slide_lint は talk-dir の package.json と node_modules からテーマを引く。
# テーマは固定のテーマ（宣言つき）を node_modules へ symlink する。配布ツリーはテーマを持たない。
# $1 = talk-dir（pages/fixture.md を持つ）
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
    # eslint は違反検出時に rc 1 を返すため、rc は判定に使わず JSON レポートだけを見る。
    # $1 は deck-lint.env.config.js、$2 は JSON レポートの出力先。
    # $3 は lint する talk ディレクトリで、省略時は $LINT_DIR になる（link_dist_theme でテーマを張った形）。
    # 設定は宣言を読まず、解釈済みの lint を環境変数 PECOTV_DECK_LINT の JSON で受ける。
    # その JSON は、設定と同じ配布ルートの CLI（slide theme --json）に作らせる。
    # CLI の合成が変わったら、このテストも追従して検知する。
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

assert_eq "プラグイン側の lint が既知違反を検出する" "slidev-pages-lint/no-triple-hyphen-in-frontmatter" "$PLUGIN_RULES"
if [ "$PLUGIN_RULES" = "$DIST_RULES" ]; then
    pass "書き換え後の配布ツリーの lint 結果がプラグイン側と一致する"
else
    fail "lint 結果が不一致 (plugin='$PLUGIN_RULES' dist='$DIST_RULES'): $(log_tail lint-dist.json.err 3)"
fi

# 文面チェック (text-constraints/textlint) は、synckit worker で text-rules の lintText を呼ぶ。
# 配布ツリーでは、worker の解決と textlint 依存の宣言が揃って初めて動く。
# section レイアウトの説明文に AI 臭い表現を置いた fixture で、両方が同じ rule ID を返すことを見る。
TEXT_DIR="$TMP/lint-text"
mkdir -p "$TEXT_DIR/pages"
# 違反文は、このスクリプト自体が文章規則に当たらないよう、2 つに分けた語の連結で組み立てる。
HYPE_PHRASE="ゲーム""チェンジャー"
printf -- '---\nlayout: section\nheading: "基盤の話"\ndescription: "%sとなる基盤です。"\n---\n' \
    "$HYPE_PHRASE" > "$TEXT_DIR/pages/fixture.md"
link_dist_theme "$TEXT_DIR"

TEXT_PLUGIN_RULES="$(rule_ids "$DECK_LINT_SOURCE" "$TMP/lint-text-plugin.json" "$TEXT_DIR")"
TEXT_DIST_RULES="$(rule_ids "$DIST/assets/slidev/deck-lint.env.config.js" "$TMP/lint-text-dist.json" "$TEXT_DIR")"

assert_eq "プラグイン側が文面違反 (text-constraints/textlint) を検出する" "text-constraints/textlint" "$TEXT_PLUGIN_RULES"
assert_eq "配布ツリー側が文面違反 (text-constraints/textlint) を検出する" "text-constraints/textlint" "$TEXT_DIST_RULES"

# --- 7. 除外の検証 ---

assert_eq "スキル指示文 (SKILL.md) が配布ツリーに無い" "0" \
    "$(find "$DIST" -name 'SKILL.md' | wc -l | tr -d ' ')"
assert_eq "cli の TypeScript ソースが配布ツリーに無い" "0" \
    "$(find "$DIST/cli" -maxdepth 1 -name 'src' | wc -l | tr -d ' ')"
# eslint プラグインの tests/ は skills/ を 8 階層上へ逆参照する parity テストを含み、
# 配布ツリー内で実行すると必ず落ちる。
assert_eq "eslint プラグインの tests/ が配布ツリーに無い" "0" \
    "$(find "$DIST_ESLINT" -type d -name 'tests' | wc -l | tr -d ' ')"

# --- 8. 配布ツリーの起動 smoke と drawio 系ツールの実呼び出し ---
#
# shim の文字列一致（main() 呼び出し・argv への mcp 注入）では、「起動して MCP として応答する」ことを担保できない。
# 構築した配布ツリーをそのまま、登録例と同じ引数なしで起動する。
# 確認するのは、initialize と tools/list に加えて、drawio 系ツールの tools/call までとなる。
# 配布ツリーの drawio_export は icons_dir を省略でき、既定は配布ツリー同梱のカタログ
# （<dist>/assets/drawio-icons）になる。ここではその既定が実際に読めていることを
# ハッシュの 3 点比較で確かめる（icons 件数は字面カウントで解決可否と無関係）。

if [ -x "$DIST/bin/pecot-visual-mcp.mjs" ]; then
    pass "bin shim に実行権がある"
else
    fail "bin shim に実行権がない"
fi

cat > "$TMP/smoke.mjs" << 'SMOKE'
// MCP サーバを stdio で起動し、要求ファイル（JSON-RPC メッセージの配列）を流して
// id を持つ全要求の応答が揃うまで待つ。
//
// 起動できたときは id ごとの結果要約を 1 行 JSON で返す（どの call が落ちたかを
// 呼び出し側で判別するため、応答単位で ok / error を残す）。起動そのものに失敗した
// ときだけ `FAIL: <理由>` を返す。
//
// 使い方: node smoke.mjs <requests.json> <script> [args...]  （script は node で起動する）
// 環境変数 SMOKE_BIN があれば node の代わりにその実行ファイルを起動する（npx 経由の起動用）。
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
      ok: payload.structuredContent.ok,
      exitCode: payload.structuredContent.exitCode,
      data: payload.structuredContent.data
    }
  }
  return summary
}
process.stdout.write(JSON.stringify(Object.fromEntries(expected.map((id) => [id, summarize(seen.get(id))]))))
SMOKE

# JSON-RPC 要求列を組み立てる。initialize / notifications/initialized を先頭に固定し、
# 以降は `<method> <params-json>` の対を id 2 から順に並べる。
#
# 応答は id で引く（smoke_value "$JSON" <id>....）。
# id は、initialize が 1、以降の `<method> <params-json>` の対が並び順どおり 2, 3, 4, … と固定する。
# 呼び出し側の判定行は、この番号に直接依存している。
# id を持たない通知を notifications/initialized 以外に足すと、以降の id が気付かないままずれる。
# そのため追加しないこと。通知を増やすなら、id は messages.length ではなく別カウンタで採番し直す。
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

# chromium ガードを実 DL 無しで通すための、偽の browsers root を用意する。
# 判定は、Playwright 自身が解く `chromium-<rev>` 配下の INSTALLATION_COMPLETE で行われる。
# そこで場所は Playwright に解かせ、マーカーだけを置く。
# 判定基準は cli/tests/_helpers/chromium-cache.ts と同じになる。
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
    pass "偽 chromium キャッシュを用意できる"
else
    fail "偽 chromium キャッシュを用意できない ($(log_tail fake-chromium.err 2))"
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

# 実 export（id 7）は、ネットワークの直前まで通す。
# PECOTV_FORCE_SVG_FAIL=1 を付けると、embed への到達だけを落とせる。
# そのため、失敗理由が export-failed なら、全 icon が既定 root で解決済みで、chromium ガードも通過したことを意味する。
# icon-unresolved なら、既定 root が働いていない。
SMOKE_JSON="$TMP/smoke.json"
# 開発者の実ホームの永続層が依存ルートの候補に入らないよう、HOME と置き場の変数は隔離する。
mkdir -p "$TMP/home-smoke"
env -u CLAUDE_PLUGIN_DATA -u PLUGIN_DATA -u XDG_DATA_HOME HOME="$TMP/home-smoke" \
    PLAYWRIGHT_BROWSERS_PATH="$FAKE_BROWSERS" PECOTV_FORCE_SVG_FAIL=1 \
    node "$TMP/smoke.mjs" "$TMP/smoke-requests.json" "$DIST/bin/pecot-visual-mcp.mjs" \
    > "$SMOKE_JSON" 2> "$TMP/smoke.err"

# 起動に失敗した実行では smoke_value が全キーで PARSE_ERROR / 空を返す。以降の判定には
# 「値が非空なら PASS」の行があり、そのままだと起動失敗が成功として集計される。
# 起動できたときだけ応答の中身を見る。
SMOKE_OK=0
case "$(head -c 5 "$SMOKE_JSON")" in
    FAIL:) fail "配布ツリーが MCP サーバとして起動しない ($(log_cat smoke.json))" ;;
    '') fail "smoke が何も出力しなかった ($(log_tail smoke.err 3))" ;;
    # smoke.mjs は id を持つ全要求の応答が揃うまで待つ。
    # ここへ来た時点で、tools/list と drawio 系 5 本と slide_lint 1 本の tools/call すべてに応答が返っている。
    *)
        pass "配布ツリーが引数なしで起動し initialize / tools/list と drawio 系 5 本と slide_lint 1 本の tools/call に応答する"
        SMOKE_OK=1
        ;;
esac

# 8-2 の直叩きと比べる対象。smoke が起動しなかったときは取れない。
HASH_EXPLICIT=""

if [ "$SMOKE_OK" = "0" ]; then
    echo "==> smoke が起動しなかったため応答内容の判定はスキップする"
else
    # ツール登録まで到達していることの確認（応答が返るだけなら server 側の分岐で成立し得る）。
    # setup の有無だけでは、一部の系統が import 失敗で欠けたまま tools/list が成立する退行を
    # 見逃す。件数まで固定して「全系統が載っている」ところを判定にする。
    #
    # 期待値 11 は cli/src/mcp/tools/index.ts の allTools() が公開する数のハードコード。
    # 配布ツリーに TS ソースは含まれずここから参照できないため写している。allTools() を
    # 増減したら本値も直す（cli/tests/e2e/mcp-tools.test.ts の EXPECTED_TOOL_COUNT と同値）。
    EXPECTED_TOOL_COUNT=11
    SMOKE_TOOLS="$(smoke_value "$SMOKE_JSON" 2.tools)"
    SMOKE_TOOL_COUNT="$(smoke_value "$SMOKE_JSON" 2.toolCount)"
    # tools/list が JSON-RPC error を返すと、tools と toolCount の両方が空になる。
    # すると件数不一致と setup 不在の 2 件が、真因を伏せたまま並んでしまう。
    # そこで error.message を原文のまま出し、1 件にまとめる。
    SMOKE_TOOLS_ERROR="$(smoke_value "$SMOKE_JSON" 2.error.message)"
    if [ -n "$SMOKE_TOOLS_ERROR" ]; then
        fail "tools/list がエラーを返した (error.message: $SMOKE_TOOLS_ERROR)"
    else
        assert_eq "tools/list が $EXPECTED_TOOL_COUNT ツールを返す" \
            "$EXPECTED_TOOL_COUNT" "$SMOKE_TOOL_COUNT"
        case "$SMOKE_TOOLS" in
            *'"setup"'*) pass "tools/list が setup を含む" ;;
            *) fail "tools/list に setup が無い (取得: $SMOKE_TOOLS)" ;;
        esac
        case "$SMOKE_TOOLS" in
            *'"slide_theme"'*) pass "tools/list が slide_theme を含む" ;;
            *) fail "tools/list に slide_theme が無い (取得: $SMOKE_TOOLS)" ;;
        esac
    fi

    HASH_DEFAULT="$(smoke_value "$SMOKE_JSON" 3.call.data.sourceSha256)"
    HASH_EXPLICIT="$(smoke_value "$SMOKE_JSON" 4.call.data.sourceSha256)"
    HASH_EMPTY="$(smoke_value "$SMOKE_JSON" 5.call.data.sourceSha256)"

    if [ -n "$HASH_DEFAULT" ]; then
        pass "icons_dir 省略の drawio_export が配布ツリーで成功する"
    else
        ICONS_DEFAULT_CALL="$(smoke_value "$SMOKE_JSON" 3)"
        fail "icons_dir 省略の drawio_export が失敗した ($ICONS_DEFAULT_CALL)"
    fi
    assert_eq "省略時の既定 icons root が配布ツリー同梱のカタログと同じ解決結果になる" \
        "$HASH_EXPLICIT" "$HASH_DEFAULT"
    if [ -n "$HASH_EMPTY" ] && [ "$HASH_EMPTY" != "$HASH_DEFAULT" ]; then
        pass "icons_dir を明示すると既定より優先される"
    else
        fail "icons_dir の明示が既定を上書きしていない (empty='$HASH_EMPTY' default='$HASH_DEFAULT')"
    fi

    # ok と warnings は 1 件の判定にまとめる（ok だけを見ると「警告なしに」の部分が空文になる）。
    assert_eq "drawio_create が配布ツリーで警告なしに成功する" "ok=true warnings=0" \
        "ok=$(smoke_value "$SMOKE_JSON" 6.call.ok) warnings=$(smoke_value "$SMOKE_JSON" 6.call.data.warnings)"

    # 同梱した text-rules が配布ツリーで動き、slide_lint が文面違反を text-constraints/textlint で返す。
    assert_eq "slide_lint が配布ツリーで文面違反を返す" "true text-constraints/textlint" \
        "$(smoke_value "$SMOKE_JSON" 8.call.ok) $(smoke_value "$SMOKE_JSON" 8.call.data | grep -o 'text-constraints/textlint' | sort -u)"

    assert_eq "icons_dir 省略の実 export が icon 解決と chromium ガードを抜ける" \
        "export-failed" "$(smoke_value "$SMOKE_JSON" 7.call.data.reason)"
    # reason だけでは、到達点を特定できない。
    # 偽 chromium キャッシュにはバイナリが無い。
    # PECOTV_FORCE_SVG_FAIL が外れると、`browserType.launch: Executable doesn't exist` でも、
    # 同じ export-failed になる。
    # そこで、失敗注入に由来することまで detail で見て、embed に到達したかを判別する。
    SMOKE_EXPORT_DETAIL="$(smoke_value "$SMOKE_JSON" 7.call.data.detail)"
    case "$SMOKE_EXPORT_DETAIL" in
        *PECOTV_FORCE_SVG_FAIL*) pass "実 export の失敗が embed 到達後の失敗注入に由来する" ;;
        *) fail "実 export が embed 到達前に失敗している (detail: $SMOKE_EXPORT_DETAIL)" ;;
    esac
    # 失敗した export は成果物を残さない。部分的な SVG が、陳腐化の判定をすり抜けないようにする。
    if [ -e "$SMOKE_SVG" ]; then
        fail "実 export が失敗したのに $SMOKE_SVG が残っている"
    else
        pass "実 export が失敗したとき SVG を残さない"
    fi
fi

# --- 8-2. CLAUDE_PLUGIN_ROOT が無い直叩き ---
#
# shim 経由では env が必ず立つ。
# 配布ツリーでの source 相対 fallback（<dist>/cli/dist/infra/_shared/plugin-root.js から <dist>）は、
# この直叩きでしか通らない。
write_requests "$TMP/direct-requests.json" \
    tools/call "$(call_params drawio_export "{\"input_path\":\"$SMOKE_FIXTURE\",\"print_hash\":true}")" \
    || exit 1
DIRECT_JSON="$TMP/direct.json"
env -u CLAUDE_PLUGIN_DATA -u PLUGIN_DATA -u XDG_DATA_HOME HOME="$TMP/home-smoke" CLAUDE_PLUGIN_ROOT= \
    node "$TMP/smoke.mjs" "$TMP/direct-requests.json" \
    "$DIST/cli/dist/cli.js" mcp > "$DIRECT_JSON" 2> "$TMP/direct.err"
case "$(head -c 5 "$DIRECT_JSON")" in
    FAIL:) fail "直叩きの起動が MCP サーバとして起動しない ($(log_cat direct.json) :: $(log_tail direct.err 3))" ;;
    '') fail "直叩きの smoke が何も出力しなかった ($(log_tail direct.err 3))" ;;
    *)
        if [ -n "$HASH_EXPLICIT" ]; then
            assert_eq "CLAUDE_PLUGIN_ROOT 無しの直叩きでも既定 icons root が配布ツリーを指す" \
                "$HASH_EXPLICIT" "$(smoke_value "$DIRECT_JSON" 2.call.data.sourceSha256)"
        else
            fail "直叩きの比較対象（icons_dir 明示のハッシュ）が shim 経由の smoke から取れていない"
        fi
        ;;
esac

# --- 8-3. setup が利用者の NODE_EXTRA_CA_CERTS をそのまま取得プロセスへ渡す ---
#
# 実行時依存の取得（npm）は、単体配布のときだけ動く。
# そのため、実プロセスで観測できる場所は、この配布ツリー smoke しかない。
# npm は PATH 先頭の stub で差し替え、受け取った NODE_EXTRA_CA_CERTS を記録させる。
# 未設定なら取得プロセスも受け取らず（記録は `<unset>`）、設定済みならその値のまま届くことを見る。
# 実ネットワークからは取得しないので、本節が示すのは「CA の受け渡しに pecot が手を加えないこと」までになる。
# 実網での取得の成否は含まない。
#
# 要求 id は、初期化の 2 本に続けて 2 から採番される（write_requests のコメントを参照）。
# 本節は setup 1 本だけを流すので、id 2 を見る。

# npm の代役を置く。--prefix 配下に、RUNTIME_DEPENDENCY_PROBES を満たす最小の node_modules を作る。
# RUNTIME_DEPENDENCY_PROBES は cli/src/infra/_shared/dependency-root.ts にある。
# 作り終えたら、受け取った CA を書き出す（未設定なら `<unset>`）。
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

// setup は patch-package を起動しない（テーマの patch は slide sync が当てる）。
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

# chromium stage は必ず install を起動する。
# 取得済みでも、Playwright 側が冪等に skip する設計のため、早期 return しない。
# install --dry-run が挙げる全エントリへ完了マーカーを置き、実ダウンロードを始めさせない。
# 到達できない DOWNLOAD_HOST は保険として置く。
# マーカーが働かなくなったときに、120MB を取得せず、その場で落とす。
PLAYWRIGHT_BROWSERS_PATH="$FAKE_BROWSERS" node "$DIST/node_modules/playwright/cli.js" \
    install --dry-run chromium > "$TMP/dry-run.out" 2> "$TMP/dry-run.err"
# 手元の確認では、Chrome for Testing、FFmpeg、Chrome Headless Shell の 3 エントリが挙がる。
# 件数は playwright の版で動くので、dry-run が挙げた各 location にマーカーが在ることだけを見る。
# $FAKE_BROWSERS 配下の全数と比べる形にすると、§8 が先に置いた偽 chromium のマーカーを巻き込む。
# その置き先が dry-run の掲載から外れる版では、偽の FAIL になってしまう。
sed -n 's/^ *Install location: *//p' "$TMP/dry-run.out" > "$TMP/dry-run-locations"
DRY_RUN_ENTRIES=0
MISSING_MARKERS=0
while read -r location; do
    DRY_RUN_ENTRIES=$((DRY_RUN_ENTRIES + 1))
    mkdir -p "$location" && : > "$location/INSTALLATION_COMPLETE"
    [ -f "$location/INSTALLATION_COMPLETE" ] || MISSING_MARKERS=$((MISSING_MARKERS + 1))
done < "$TMP/dry-run-locations"
if [ "$DRY_RUN_ENTRIES" -gt 0 ] && [ "$MISSING_MARKERS" -eq 0 ]; then
    pass "chromium stage 用の完了マーカーを全エントリへ用意できる"
else
    fail "chromium stage 用の完了マーカーを用意できない (entries=$DRY_RUN_ENTRIES missing=$MISSING_MARKERS)"
    log_tail dry-run.err 2
fi

write_requests "$TMP/setup-requests.json" tools/call "$(call_params setup '{}')" || exit 1

# `setup` を 1 回起動し、記録された NODE_EXTRA_CA_CERTS を標準出力へ返す。
# HOME は毎回別にする（永続層の stamp が残ると 2 回目の runtime stage が skip される）。
# plugin_data を渡すと、登録の `env` に書く想定の PLUGIN_DATA としてその値で起動する。
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
        # patch-package の代役（npm stub が置く）が起動のたびに 1 行追記する記録。setup では起動されない。
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

SETUP_JSON="$TMP/setup-unset.json"
run_setup_smoke unset "" "$SETUP_JSON" "$TMP/npm-env-unset"
case "$(head -c 5 "$SETUP_JSON")" in
    FAIL:) fail "setup の smoke が起動しない ($(log_cat setup-unset.json) :: $(log_tail setup-unset.err 3))" ;;
    '') fail "setup の smoke が何も出力しなかった ($(log_tail setup-unset.err 3))" ;;
    *)
        assert_eq "配布ツリーの setup が実行時依存と chromium を揃えて成功する" "ok=true event=setup.done" \
            "ok=$(smoke_value "$SETUP_JSON" 2.call.ok) event=$(smoke_value "$SETUP_JSON" 2.call.data.event)"
        assert_eq "NODE_EXTRA_CA_CERTS 未設定なら取得プロセスも受け取らない" \
            "<unset>" "$(cat "$TMP/npm-env-unset" 2> /dev/null)"

        # setup に patch 段は無い。npm の後に patch-package が起動されないことを固定する。
        assert_eq "setup が patch-package を起動しない" "0" \
            "$(patch_launch_count "$TMP/patch-record-unset.jsonl")"
        # 依存は永続層ルートの node_modules に入る。
        assert_eq "setup が永続層ルートへ実行時依存を入れる" "1" \
            "$([ -f "$TMP/home-unset/.local/share/pecot/pecot-visual/mcp-dist/node_modules/@slidev/cli/package.json" ] && echo 1 || echo 0)"
        ;;
esac

# 利用者が設定済みの値を、pecot は書き換えない。
# setup が子へ渡す NODE_EXTRA_CA_CERTS は、利用者の値のままであることを確かめる。
PRESET_CA="$TMP/preset-ca.pem"
printf '%s\n' 'test-ca-bundle' > "$PRESET_CA" || exit 1
PRESET_JSON="$TMP/setup-preset.json"
run_setup_smoke preset "$PRESET_CA" "$PRESET_JSON" "$TMP/npm-env-preset"
case "$(head -c 5 "$PRESET_JSON")" in
    FAIL:|'') fail "設定済み NODE_EXTRA_CA_CERTS での setup smoke が起動しない ($(log_tail setup-preset.err 3))" ;;
    *)
        assert_eq "NODE_EXTRA_CA_CERTS 設定済みならその値のまま取得プロセスへ渡る" \
            "$PRESET_CA" "$(cat "$TMP/npm-env-preset" 2> /dev/null)"
        ;;
esac

# 単体配布の登録の `env` に PLUGIN_DATA を書けば、そこが置き場になる（既定の場所は作られない）。
PDATA_DIR="$TMP/sa-data"
PDATA_JSON="$TMP/setup-pdata.json"
run_setup_smoke pdata "" "$PDATA_JSON" "$TMP/npm-env-pdata" "$PDATA_DIR"
case "$(head -c 5 "$PDATA_JSON")" in
    FAIL:|'') fail "PLUGIN_DATA 指定での setup smoke が起動しない ($(log_tail setup-pdata.err 3))" ;;
    *)
        assert_eq "PLUGIN_DATA 指定でも setup が成功する" "ok=true event=setup.done" \
            "ok=$(smoke_value "$PDATA_JSON" 2.call.ok) event=$(smoke_value "$PDATA_JSON" 2.call.data.event)"
        assert_eq "PLUGIN_DATA 指定なら実行時依存が <PLUGIN_DATA>/mcp-dist に入る" "1" \
            "$([ -f "$PDATA_DIR/mcp-dist/node_modules/@slidev/cli/package.json" ] && echo 1 || echo 0)"
        if [ -e "$TMP/home-pdata/.local/share" ]; then
            fail "PLUGIN_DATA 指定なのに既定の場所 \$HOME/.local/share が作られた"
        else
            pass "PLUGIN_DATA 指定なら既定の場所 \$HOME/.local/share は作られない"
        fi
        ;;
esac

rm -rf "$DIST/node_modules"

# --- 9. 冪等性の確認 ---

# 9-1. HEAD に pecotv のリリースタグが無ければ、gh を一切呼ばずに終了する。
#      pecot 単独のリリースで、GitHub への到達性と認証がリリースの成否に結びつかないことを確かめる。
#      $TEST_VERSION のタグはリポジトリ本体には存在しないので、本体側で検証できる。
#      記録は pecot 単独リリースの実態に合わせて skipped を置く。この組み合わせは実運用で必ず起きる。
#      冪等性の確認は、監査記録の確認より先に働くので、skipped でも止まらない。
write_skipped_audit_record "$REPO_HEAD"
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
assert_eq "タグ無しの実行は gh を呼ばない" "0" "$(gh_call_count)"

# 9-2. 監査記録の確認（#1059）。記録の素性が満たされない本実行は、gh を呼ばずに止まる。
#      いずれも pack / upload より前で止まる。
TEST_HEAD="$(git -C "$TEST_REPO" rev-parse HEAD)"
TEST_PARENT="$(git -C "$TEST_REPO" rev-parse HEAD^)"

reject_record() {
    local label="$1" needle="$2" outdir="$3" rc=0
    publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
        --out-dir="$outdir" > "$TMP/record-reject.log" 2>&1 || rc=$?
    if [ "$rc" -eq 0 ]; then
        fail "$label で publish が通った"
    elif grep -qF "$needle" "$TMP/record-reject.log"; then
        pass "$label で publish を拒否する"
    else
        fail "$label が別の理由で失敗した ($(log_tail record-reject.log 2))"
    fi
    assert_eq "$label の実行は gh を呼ばない" "0" "$(gh_call_count)"
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

# 9-2b. 親 commit を持たないリポ（`git rev-parse -q --verify HEAD^` が空）でも、記録の HEAD を確かめられる。
#       TEST_REPO は親が HEAD になる場合を再現するため、ベース commit を持つ。
#       そのため、この分岐は別の使い捨てリポでしか通らない。
#       publish は記録の確認で止まるので、リポには起動に必要な scripts/release とリリースタグだけを置く。
SOLO_REPO="$TMP/solo-repo"
mkdir -p "$SOLO_REPO/plugins/pecot-visual/scripts"
git init --quiet --initial-branch=main "$SOLO_REPO" || exit 1
cp -a "$PECOTV_ROOT/scripts/release" "$SOLO_REPO/plugins/pecot-visual/scripts/release" || exit 1
git -C "$SOLO_REPO" add -A > /dev/null 2>&1 || exit 1
git -C "$SOLO_REPO" commit --quiet -m "solo fixture" > /dev/null 2>&1 || exit 1
git -C "$SOLO_REPO" tag "$TEST_TAG" HEAD || exit 1
assert_eq "使い捨てリポが単一 commit（親が無い）" "" \
    "$(git -C "$SOLO_REPO" rev-parse -q --verify HEAD^ || true)"

SOLO_RC=0
write_audit_record "$DUMMY_FP" "$UNRELATED_SHA" 0
publish_real bash "$SOLO_REPO/plugins/pecot-visual/scripts/release/publish-mcp-dist.sh" --version="$TEST_VERSION" \
    --skip-build --out-dir="$TMP/dist-solo" > "$TMP/solo.log" 2>&1 || SOLO_RC=$?
assert_eq "親が無いリポで HEAD 不一致の記録は非ゼロ終了" "1" "$SOLO_RC"
if grep -qF "対応しません" "$TMP/solo.log"; then
    pass "親が無いリポでも記録の HEAD 不一致を理由に出す"
else
    fail "親が無いリポの拒否が別の理由で失敗した ($(log_tail solo.log 2))"
fi
assert_eq "親が無いリポの拒否は gh を呼ばない" "0" "$(gh_call_count)"
if [ ! -d "$TMP/dist-solo" ]; then
    pass "親が無いリポの拒否は配布ツリーを構築しない"
else
    fail "親が無いリポの拒否で配布ツリーを構築した"
fi

write_audit_record "$DUMMY_FP" "$TEST_HEAD" 1
reject_record "high 以上を残した記録" "high 以上の脆弱性が残っています" "$TMP/dist-rec-high"

# blocking は両ツリー合計。配布ツリー側が 0 でも永続層側に high が残っていれば拒否する
# ことを固定する（合計を dist 単独へ退行させても他のケースは pass してしまう）(#1071 F-05)。
write_audit_record "$DUMMY_FP" "$TEST_HEAD" 0 1
reject_record "永続層に high を残した記録" "high 以上の脆弱性が残っています" "$TMP/dist-rec-runtime-high"

# 9-3. 指紋が配布ツリーと異なれば配布しない。期待値を外部から持ち込まないため、
#      この実行が出力した指紋で記録を作り直して陽性側（9-4）へ渡す。
MISMATCH_RC=0
write_audit_record "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" "$TEST_HEAD" 0
publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
    --out-dir="$TMP/dist-mismatch" > "$TMP/mismatch.log" 2>&1 || MISMATCH_RC=$?
assert_eq "指紋が一致しないと非ゼロ終了" "1" "$MISMATCH_RC"
if grep -qF "監査した依存ツリーと配布ツリーが一致しません" "$TMP/mismatch.log"; then
    pass "指紋の不一致を理由に出す"
else
    fail "指紋の不一致を理由に出さない ($(log_tail mismatch.log 3))"
fi
assert_eq "指紋の不一致では gh を呼ばない" "0" "$(gh_call_count)"

TEST_FP="$(fingerprint_from_log "$TMP/mismatch.log")"
assert_eq "不一致でも配布ツリーの指紋を出力する" "1" \
    "$(printf '%s' "$TEST_FP" | grep -cE '^[0-9a-f]{64}$' | tr -d ' ')"

# 9-4. 監査時 HEAD が現在の HEAD の親（nx が作る release commit の分）でも通る。
#      タグを立てた使い捨てリポ側のスクリプトを起動する（リポジトリ本体に ref を作らない）。
write_audit_record "$TEST_FP" "$TEST_PARENT" 0
if publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
    --out-dir="$TMP/dist-1" > "$TMP/publish1.log" 2>&1; then
    pass "タグがあるとき publish が正常終了する"
else
    fail "publish が失敗した ($(log_tail publish1.log 3))"
fi
if grep -qF "監査記録と一致" "$TMP/publish1.log"; then
    pass "監査時 HEAD が現在の HEAD の親でも突合が通る"
else
    fail "HEAD^ の記録で突合が通らない ($(log_tail publish1.log 3))"
fi
# gh の呼び出しは 3 つで、順序は view → upload → workflow run。-R は origin の URL から求めた値になる。
TEST_RELEASE_TAG="pecot-visual-v$TEST_VERSION"
TEST_TGZ_NAME="pecot-visual-mcp-$TEST_VERSION.tgz"
assert_eq "gh の呼び出しは 3 回" "3" "$(gh_call_count)"
assert_eq "1 回目の gh は Release の有無の確認" "release view $TEST_RELEASE_TAG -R $TEST_OWNER_REPO" \
    "$(sed -n '1p' "$GH_CALLS")"
UPLOAD_LINE="$(sed -n '2p' "$GH_CALLS")"
case "$UPLOAD_LINE" in
    "release upload $TEST_RELEASE_TAG /"*"/$TEST_TGZ_NAME --clobber -R $TEST_OWNER_REPO") pass "2 回目の gh は tgz の添付（--clobber / -R つき）" ;;
    *) fail "2 回目の gh が添付の形でない ($UPLOAD_LINE)" ;;
esac
assert_eq "3 回目の gh はワークフローの起動（--ref でタグに固定）" \
    "workflow run publish-npm.yml -f tag=$TEST_RELEASE_TAG --ref $TEST_RELEASE_TAG -R $TEST_OWNER_REPO" \
    "$(sed -n '3p' "$GH_CALLS")"
if grep -qF "tgz: $TEST_TGZ_NAME" "$TMP/publish1.log"; then
    pass "tgz の名前を出力する"
else
    fail "tgz の名前を出力しない ($(log_tail publish1.log 4))"
fi

# 添付された tgz の中身。
UPLOADED_LIST="$TMP/uploaded-files.txt"
tar -tzf "$GH_UPLOAD_COPY" > "$UPLOADED_LIST" 2> /dev/null || : > "$UPLOADED_LIST"
assert_eq "添付された tgz の package.json の name" "@pecot/visual-mcp" \
    "$(tar -xzOf "$GH_UPLOAD_COPY" package/package.json 2> /dev/null | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0, 'utf8')).name)" 2> /dev/null)"
assert_eq "添付された tgz の package.json の version" "$TEST_VERSION" \
    "$(tar -xzOf "$GH_UPLOAD_COPY" package/package.json 2> /dev/null | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0, 'utf8')).version)" 2> /dev/null)"
assert_eq "添付された tgz に LICENSE が入り、HEAD のものと一致する" "$(git -C "$TEST_REPO" show HEAD:LICENSE | cksum)" \
    "$(tar -xzOf "$GH_UPLOAD_COPY" package/LICENSE 2> /dev/null | cksum)"
assert_eq "添付された tgz に shim が入る" "1" "$(grep -cx 'package/bin/pecot-visual-mcp.mjs' "$UPLOADED_LIST" | tr -d ' ')"
assert_eq "添付された tgz に npm-shrinkwrap.json が入る" "1" "$(grep -cx 'package/npm-shrinkwrap.json' "$UPLOADED_LIST" | tr -d ' ')"
assert_eq "添付された tgz に eslint プラグイン dist が入る" "1" \
    "$(grep -cx 'package/assets/slidev/scripts/eslint/_shared/dist/index.js' "$UPLOADED_LIST" | tr -d ' ')"
assert_eq "添付された tgz に .map を含むパスが無い" "0" "$(grep -c '\.map$' "$UPLOADED_LIST" | tr -d ' ')"
assert_eq "添付された tgz に証明書（certs 配下・.pem・.crt・.cer）が無い" "" \
    "$(grep -E '(^|/)certs?/|\.(pem|crt|cer)$' "$UPLOADED_LIST" | tr '\n' ' ')"

# 9-4b. 添付された tgz を npx でそのまま起動する。
#       npm に出る tgz と同じ物を、利用者の登録例（npx -y <パッケージ>）と同じ npx で動かす。
#       同梱した text-rules が、npm の依存解決を経た木で動くことを、初回（cold）と 2 回目（warm）の両方で見る。
#       npx は起動のたびに node_modules を作り直すので、2 回目は初回と違う動きになる。
#       依存の取得は、PECOT_RELEASE_TEST_NPM_CACHE があればそのキャッシュを優先して使う。
#       無ければ使い捨てのキャッシュを使い、レジストリへアクセスする。
NPX_CACHE="${PECOT_RELEASE_TEST_NPM_CACHE:-$TMP/npx-cache}"
# 配布ツリーの構築先は、clone 以外から実体を取れないよう消してから起動する。
# 絶対パスの import に退行していても、構築先が残っていれば実行系の検証が通ってしまう。
rm -rf "$TMP/dist-1"
# 前回の中断で opt-in のキャッシュに _npx が残ると、cold が warm になる。ループの前にも掃除する。
[ -n "${PECOT_RELEASE_TEST_NPM_CACHE:-}" ] && rm -rf "$NPX_CACHE/_npx"
NPX_FLAGS=(--yes "--cache=$NPX_CACHE")
[ -n "${PECOT_RELEASE_TEST_NPM_CACHE:-}" ] && NPX_FLAGS+=(--prefer-offline)
write_requests "$TMP/npx-requests.json" \
    tools/call "$(call_params slide_lint "{\"dir\":\"$TEXT_DIR\"}")" \
    || exit 1
mkdir -p "$TMP/home-npx"
for run in cold warm; do
    NPX_JSON="$TMP/npx-$run.json"
    # 利用者は自分の dir で npx を打つ。nx はこのテストを plugin の dir から起動するため、cwd を plugin の外へ移す。
    # plugin の dir のままだと、package.json の devEngines（pnpm）を見た npm が EBADDEVENGINES を出して止まる。
    (cd "$TMP/home-npx" && env -u CLAUDE_PLUGIN_DATA -u PLUGIN_DATA -u XDG_DATA_HOME -u CLAUDE_PLUGIN_ROOT HOME="$TMP/home-npx" \
        SMOKE_BIN="$(command -v npx)" PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
        node "$TMP/smoke.mjs" "$TMP/npx-requests.json" "${NPX_FLAGS[@]}" "--package=$GH_UPLOAD_COPY" pecot-visual-mcp) \
        > "$NPX_JSON" 2> "$TMP/npx-$run.err"
    case "$(head -c 5 "$NPX_JSON")" in
        FAIL:) fail "npx の $run 起動が MCP サーバとして起動しない ($(log_cat npx-$run.json))" ;;
        '') fail "npx の $run 起動の smoke が何も出力しなかった ($(log_tail npx-$run.err 3))" ;;
        *)
            assert_eq "npx の $run 起動が initialize に応答する" "true" "$(smoke_value "$NPX_JSON" 1.ok)"
            assert_eq "npx の $run 起動の slide_lint が文面違反を返す" "true text-constraints/textlint" \
                "$(smoke_value "$NPX_JSON" 2.call.ok) $(smoke_value "$NPX_JSON" 2.call.data | grep -o 'text-constraints/textlint' | sort -u)"
            ;;
    esac
done
# opt-in のキャッシュに npx の作業ディレクトリを残さない。
[ -n "${PECOT_RELEASE_TEST_NPM_CACHE:-}" ] && rm -rf "$NPX_CACHE/_npx"

# 9-5. 同版で再実行しても同じ 3 つの呼び出しが通る（--clobber で上書きし、publish 済みの版はワークフローが飛ばす）。
write_audit_record "$TEST_FP" "$TEST_HEAD" 0
if publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
    --out-dir="$TMP/dist-2" > "$TMP/publish2.log" 2>&1; then
    pass "同版の再実行が正常終了する"
else
    fail "同版の再実行が失敗した ($(log_tail publish2.log 3))"
fi
assert_eq "再実行の gh の呼び出しは 3 回増える" "6" "$(gh_call_count)"
assert_eq "再実行も Release の確認から始まる" "$(sed -n '1p' "$GH_CALLS")" "$(sed -n '4p' "$GH_CALLS")"
assert_eq "再実行も同じワークフローを起動する" "$(sed -n '3p' "$GH_CALLS")" "$(sed -n '6p' "$GH_CALLS")"
assert_eq "テストはリポジトリ本体に検証用タグを残さない" "0" \
    "$(git -C "$REPO_ROOT" tag -l "$TEST_TAG" | wc -l | tr -d ' ')"

# 9-5b. Release が無いときは、添付もワークフローの起動もせずに止まる。
GH_BEFORE="$(gh_call_count)"
NORELEASE_RC=0
GH_VIEW_RC=1 publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
    --out-dir="$TMP/dist-norelease" > "$TMP/norelease.log" 2>&1 || NORELEASE_RC=$?
assert_eq "Release が無いと非ゼロ終了" "1" "$NORELEASE_RC"
if grep -qF "Release $TEST_RELEASE_TAG を確認できません" "$TMP/norelease.log"; then
    pass "Release が無い理由を出す"
else
    fail "Release が無い理由を出さない ($(log_tail norelease.log 3))"
fi
if grep -qF "release not found" "$TMP/norelease.log"; then
    pass "gh release view の標準エラーを原因として添える"
else
    fail "gh release view の標準エラーを添えない ($(log_tail norelease.log 3))"
fi
assert_eq "Release が無いときの gh は確認の 1 回だけ" "$((GH_BEFORE + 1))" "$(gh_call_count)"
assert_eq "Release が無いときの最後の gh は確認" "release view $TEST_RELEASE_TAG -R $TEST_OWNER_REPO" \
    "$(tail -1 "$GH_CALLS")"

# 9-6. 作業ツリーが HEAD と乖離しているときは publish しない。配布ツリーは HEAD 由来の
#      テンプレートと作業ツリー由来の cli/dist を混ぜるため、乖離したまま流すとタグの
#      指すコミットに対応しない配布物ができる。
GH_BEFORE="$(gh_call_count)"
printf '\ndirty\n' >> "$TEST_PECOTV/scripts/release/mcp-dist-README.md"
if publish_real bash "$TAGGED_PUBLISH" --version="$TEST_VERSION" --skip-build \
    --out-dir="$TMP/dist-dirty" > "$TMP/dirty.log" 2>&1; then
    fail "作業ツリーが HEAD と乖離していても publish が通った"
elif grep -q "未コミットの変更" "$TMP/dirty.log"; then
    pass "作業ツリーが HEAD と乖離しているとき publish を拒否する"
else
    fail "乖離判定以外の理由で失敗した ($(log_tail dirty.log 2))"
fi
assert_eq "乖離時の実行は gh を呼ばない" "$GH_BEFORE" "$(gh_call_count)"
git -C "$TEST_REPO" checkout --quiet -- plugins/pecot-visual/scripts/release/mcp-dist-README.md

# --- 10. --out-dir ガード ---
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

# 廃止した --repo は未対応の引数として弾く。
if bash "$PUBLISH" --dry-run --skip-build --repo=owner/name --out-dir="$TMP/dist-oldflag" > "$TMP/oldflag.log" 2>&1; then
    fail "廃止した --repo を受け付けた"
elif grep -qF "未対応の引数: --repo=owner/name" "$TMP/oldflag.log"; then
    pass "廃止した --repo は未対応の引数として弾く"
else
    fail "--repo の拒否が別の理由で失敗した ($(log_tail oldflag.log 2))"
fi

reject_out_dir "リポジトリ配下" "$REPO_ROOT/plugins/pecot-visual/scripts"
reject_out_dir "リポジトリルート" "$REPO_ROOT"
reject_out_dir "ルート /" "/"
mkdir -p "$TMP/nonempty/keep"
reject_out_dir "空でない既存ディレクトリ" "$TMP/nonempty"
# symlink を経由してリポジトリ配下を指す場合も、正規化して同じ扱いにする。
ln -s "$REPO_ROOT" "$TMP/repo-link"
reject_out_dir "symlink 経由でリポジトリ配下を指すパス" "$TMP/repo-link/docs"
assert_eq "ガードは対象ディレクトリを消さない" "1" \
    "$(ls -A "$TMP/nonempty" | wc -l | tr -d ' ')"

# --- 11. テストはリポジトリ本体の監査記録に触れない ---
# 本テストが書く記録は、registry に TEST_REGISTRY を持つ。本体の記録がその値を持たないことだけを見る。
# 指紋では判別できない。
# 本体の実監査と本テストの publish は同じ manifest から依存を解決するので、依存が同一なら指紋は必ず一致する (#1074)。
# 記録が無い場合、skipped の場合、破損している場合は、空が返って pass する。
assert_ne "リポジトリ本体の既定パスの記録が本テスト由来でない" \
    "$TEST_REGISTRY" "$(record_registry "$REAL_RECORD_FILE")"

echo
echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
