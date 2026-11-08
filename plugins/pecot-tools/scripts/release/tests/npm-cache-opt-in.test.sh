#!/bin/bash
# リリース系 test の npm 依存解決の永続キャッシュ opt-in（PECOT_RELEASE_TEST_NPM_CACHE）の検証 (#1225)。
#
# publish-mcp-dist.sh は、npm へ CLI フラグを渡す。
# 渡すのは --cache と --prefer-offline で、PATH 先頭の npm スタブで記録して固定する。
# レジストリへはアクセスしない。
# 環境変数ではなくフラグで渡すのは、npm が npm_config_* を大文字小文字の区別なく読むため。
# 環境に NPM_CONFIG_* があると、後から列挙された側を採用することがある。
# CLI フラグは常に環境変数に勝つ。
#   - 未設定（本番）は、従来どおり mktemp の使い捨てキャッシュで解決する。
#   - 設定時は、指定ディレクトリを npm cache にして、prefer-offline で解決する。
#     2 回目以降は、レジストリへアクセスしない。
#   - dry-run でない実行（実配布）では opt-in を拒否する。
#     pecot-tools の publish には指紋の突合が無く、古いメタデータのまま配布されても検出できないため。
#
# 拒否以外の検証は --dry-run --skip-build を付けて実行する。
# そのため cli/dist が build 済みであることが前提となる。
# run-tests.sh --scope=release の dependsOn が、これを用意する。
#
# `set -e` は使わない。拒否の検証で、非ゼロ終了を意図的に発生させる。
set -u

# git hook から起動されると、git が GIT_DIR 等を export する。
# すると被テストスクリプトの `git -C` が呼び出し元リポを巻き込む。
# そのため、継承した git env は先頭で必ず捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$RELEASE_DIR/../../../.." && pwd)"
TOOLS_ROOT="$REPO_ROOT/plugins/pecot-tools"
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
assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        pass "$label"
    else
        fail "$label (expected='$expected' actual='$actual')"
    fi
}
assert_ne() {
    local label="$1" unexpected="$2" actual="$3"
    if [ "$unexpected" != "$actual" ]; then
        pass "$label"
    else
        fail "$label (一致してはいけない値と一致した: '$actual')"
    fi
}

if [ ! -d "$TOOLS_ROOT/cli/dist" ]; then
    echo "ERROR: $TOOLS_ROOT/cli/dist がありません。build 済みの dist が前提です。" >&2
    echo "  bash plugins/pecot-tools/scripts/ci/run-tests.sh --scope=release" >&2
    exit 1
fi

TMP=$(mktemp -d)
cleanup() {
    rm -rf "$TMP"
}
trap cleanup EXIT

# 失敗の補足に使う。$TMP 配下のログの末尾 N 行を 1 行にまとめて返す。
# 失敗メッセージの文字列に引用符入りの $(...) を入れないため、ここへ切り出す。
log_tail() {
    tail -"$2" "$TMP/$1" | tr '\n' ' '
}

# --- npm スタブ ---
# 呼び出しごとに 1 行を NPM_STUB_LOG へ追記する。
# 形式は、サブコマンド・cache・prefer_offline・offline・cwd をキー付きで並べたもの。
# 値は npm の CLI フラグ（--cache=<dir> / --prefer-offline / --offline）から取り、無ければ unset。
# 環境変数は見ない（npm ではフラグが環境変数に勝つ）。
# install は publish が mv する package-lock.json を作る。pack は本物の npm へそのまま渡す。
# 本物の npm は PATH を替える前の絶対パスで呼ぶ。
mkdir -p "$TMP/bin"
REAL_NPM="$(command -v npm)"
export REAL_NPM
cat > "$TMP/bin/npm" << 'STUB_NPM'
#!/bin/bash
cache=unset
prefer_offline=unset
offline=unset
for arg in "$@"; do
    case "$arg" in
        --cache=*) cache="${arg#--cache=}" ;;
        --prefer-offline) prefer_offline=true ;;
        --prefer-offline=*) prefer_offline="${arg#--prefer-offline=}" ;;
        --offline) offline=true ;;
        --offline=*) offline="${arg#--offline=}" ;;
    esac
done
printf '%s cache=%s prefer_offline=%s offline=%s cwd=%s\n' \
    "$1" "$cache" "$prefer_offline" "$offline" "$(basename "$PWD")" >> "$NPM_STUB_LOG"
case "$1" in
    install)
        printf '{"name":"stub","lockfileVersion":3,"requires":true,"packages":{"":{"name":"stub"}}}\n' > package-lock.json
        ;;
    pack)
        exec "$REAL_NPM" "$@"
        ;;
esac
exit 0
STUB_NPM
# gh は呼ばれてはいけない。呼ばれたら記録する。
cat > "$TMP/bin/gh" << 'STUB_GH'
#!/bin/bash
printf '%s\n' "$*" >> "$GH_STUB_LOG"
exit 0
STUB_GH
chmod +x "$TMP/bin/npm" "$TMP/bin/gh"

export NPM_STUB_LOG="$TMP/npm-calls.log"
export GH_STUB_LOG="$TMP/gh-calls.log"
: > "$GH_STUB_LOG"

# 呼び出し元の npm 設定に結果を左右させない。
unset npm_config_cache npm_config_prefer_offline npm_config_offline \
    NPM_CONFIG_CACHE NPM_CONFIG_PREFER_OFFLINE NPM_CONFIG_OFFLINE PECOT_RELEASE_TEST_NPM_CACHE
unset NX_DRY_RUN

PERSISTENT="$TMP/persistent-npm-cache"

# 記録から 1 フィールドを取り出す（複数行なら 1 行目）。
log_field() {
    local field="$1"
    head -n 1 "$NPM_STUB_LOG" | tr ' ' '\n' | sed -n "s/^${field}=//p"
}

run_publish() {
    local label="$1"
    shift
    : > "$NPM_STUB_LOG"
    PUBLISH_RC=0
    PATH="$TMP/bin:$PATH" bash "$PUBLISH" "$@" > "$TMP/publish-$label.out" 2> "$TMP/publish-$label.err" || PUBLISH_RC=$?
}

# --- 1. publish: 未設定なら mktemp の使い捨てキャッシュ ---
run_publish unset --dry-run --skip-build --out-dir="$TMP/dist-unset"
assert_eq "publish 未設定: 成功する" "0" "$PUBLISH_RC"
assert_eq "publish 未設定: npm install を 1 回呼ぶ" "1" "$(grep -c '^install ' "$NPM_STUB_LOG")"
assert_ne "publish 未設定: 永続キャッシュは使わない" "$PERSISTENT" "$(log_field cache)"
assert_ne "publish 未設定: キャッシュは mktemp 配下" "unset" "$(log_field cache)"
assert_eq "publish 未設定: prefer-offline を渡さない" "unset" "$(log_field prefer_offline)"

# --- 2. publish: 設定時は指定ディレクトリと prefer-offline ---
export PECOT_RELEASE_TEST_NPM_CACHE="$PERSISTENT"
run_publish optin --dry-run --skip-build --out-dir="$TMP/dist-optin"
assert_eq "publish opt-in: 成功する" "0" "$PUBLISH_RC"
assert_eq "publish opt-in: 指定ディレクトリを npm cache にする" "$PERSISTENT" "$(log_field cache)"
assert_eq "publish opt-in: prefer-offline で解決する" "true" "$(log_field prefer_offline)"

# 2 回目も同じディレクトリで、掃除で消えない。
run_publish optin2 --dry-run --skip-build --out-dir="$TMP/dist-optin2"
assert_eq "publish opt-in 2 回目: 同じディレクトリを使う" "$PERSISTENT" "$(log_field cache)"
mkdir -p "$PERSISTENT" && : > "$PERSISTENT/marker"
run_publish optin3 --dry-run --skip-build --out-dir="$TMP/dist-optin3"
if [ -f "$PERSISTENT/marker" ]; then
    pass "publish opt-in: 終了時に永続キャッシュを消さない"
else
    fail "publish opt-in: 終了時に永続キャッシュが消えた"
fi

# 絶対パス以外は npm が cd 後の cwd で解決して別の場所を使う。そのため、通知なしでは通さない。
PECOT_RELEASE_TEST_NPM_CACHE="relative/cache" run_publish relative --dry-run --skip-build --out-dir="$TMP/dist-relative"
assert_ne "publish opt-in: 相対パスは拒否する" "0" "$PUBLISH_RC"
assert_eq "publish opt-in: 相対パスなら npm を呼ばない" "0" "$(wc -l < "$NPM_STUB_LOG" | tr -d ' ')"

# --- 3. publish: 実配布では opt-in を拒否する ---
# 実配布とは、dry-run でない実行を指す。
# 拒否が働かなかった場合に本物の GitHub へ触れないよう、gh は PATH 先頭のスタブにしてある。
run_publish real --skip-build
assert_ne "publish 実配布 + opt-in: 拒否する" "0" "$PUBLISH_RC"
if grep -q 'PECOT_RELEASE_TEST_NPM_CACHE' "$TMP/publish-real.err"; then
    pass "publish 実配布 + opt-in: 拒否の理由に変数名が出る"
else
    fail "publish 実配布 + opt-in: 変数名が出ない: $(log_tail publish-real.err 3)"
fi
assert_eq "publish 実配布 + opt-in: npm を呼ぶ前に止まる" "0" "$(wc -l < "$NPM_STUB_LOG" | tr -d ' ')"
assert_eq "publish 実配布 + opt-in: gh を呼ばない" "0" "$(wc -l < "$GH_STUB_LOG" | tr -d ' ')"

# 絶対パス以外は、dry-run でなくても先に絶対パスの確認で止まる。どちらでも拒否される。
PECOT_RELEASE_TEST_NPM_CACHE="relative/cache" run_publish realrelative --skip-build
assert_ne "publish 実配布 + 相対パスの opt-in: 拒否する" "0" "$PUBLISH_RC"

# NX_DRY_RUN による dry-run は実配布ではない。opt-in を拒否しない。
NX_DRY_RUN=1 run_publish nxdry --skip-build --out-dir="$TMP/dist-nxdry"
assert_eq "publish NX_DRY_RUN + opt-in: 拒否しない" "0" "$PUBLISH_RC"
assert_eq "publish NX_DRY_RUN + opt-in: gh を呼ばない" "0" "$(wc -l < "$GH_STUB_LOG" | tr -d ' ')"

echo
echo "npm-cache-opt-in (pecot-tools): PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
