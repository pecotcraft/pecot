#!/bin/bash
# .githooks/lib/mcp-publish-common.sh（3 プラグインの publish-mcp-dist.sh が共有する関数）の検証。
# 各関数を子 bash で source して呼び、終了コードと出力を固定する。npm はスタブ、git は使い捨てリポで確かめる。
#
# `set -e` は使わない。失敗の検証で、非ゼロ終了を意図的に発生させるため。
# shellcheck disable=SC2016
set -u

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE
unset NX_DRY_RUN PECOT_RELEASE_TEST_NPM_CACHE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="$SCRIPT_DIR/../../lib/mcp-publish-common.sh"

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
assert_contains() {
    local label="$1" needle="$2" haystack="$3"
    case "$haystack" in
        *"$needle"*) pass "$label" ;;
        *) fail "$label (needle='$needle' actual='$haystack')" ;;
    esac
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 子 bash で lib を source してコードを実行する。終了コードは RC、標準出力と標準エラーは OUT に入る。
run_lib() {
    OUT="$(bash -c "set -euo pipefail; . '$LIB'; $1" 2>&1)"
    RC=$?
}

# --- sanitize_env ---
run_lib 'export GIT_DIR=/x FORCE_COLOR=1; mcp_publish_sanitize_env; echo "[${GIT_DIR:-}][${FORCE_COLOR:-}]"'
assert_eq "sanitize_env が GIT_DIR と FORCE_COLOR を捨てる" "[][]" "$OUT"

# --- defaults / parse_arg ---
run_lib 'mcp_publish_defaults; echo "$DRY_RUN $SKIP_BUILD [$VERSION] [$OUT_DIR]"'
assert_eq "defaults は dry-run なし・build あり" "false false [] []" "$OUT"
run_lib 'NX_DRY_RUN=1; mcp_publish_defaults; echo "$DRY_RUN"'
assert_eq "NX_DRY_RUN=1 で dry-run になる" "true" "$OUT"
run_lib 'NX_DRY_RUN=false; mcp_publish_defaults; echo "$DRY_RUN"'
assert_eq "NX_DRY_RUN=false は dry-run にしない" "false" "$OUT"
run_lib 'mcp_publish_defaults; for a in --version=1.2.3 --out-dir=/x/y --dry-run --skip-build; do mcp_publish_parse_arg "$a"; done; echo "$VERSION $OUT_DIR $DRY_RUN $SKIP_BUILD"'
assert_eq "共通の 4 引数を解釈する" "1.2.3 /x/y true true" "$OUT"
run_lib 'mcp_publish_defaults; if mcp_publish_parse_arg --audit-record=x; then echo consumed; else echo passthrough; fi'
assert_eq "共通でない引数は 1 を返して呼び出し側に回す" "passthrough" "$OUT"
run_lib 'mcp_publish_unknown_arg --repo=o/n "|--audit-record=<path>"'
assert_eq "未対応の引数は exit 1" "1" "$RC"
assert_contains "未対応の引数の文に引数名と固有の引数が出る" "未対応の引数: --repo=o/n (使用可能: --version=<ver>|--out-dir=<dir>|--dry-run|--skip-build|--audit-record=<path>)" "$OUT"

# --- check_npm_cache_opt_in ---
run_lib 'DRY_RUN=false; mcp_publish_check_npm_cache_opt_in; echo "[$NPM_CACHE_OPT_IN]"'
assert_eq "opt-in なしは通る" "[]" "$OUT"
PECOT_RELEASE_TEST_NPM_CACHE=relative/path run_lib 'DRY_RUN=true; mcp_publish_check_npm_cache_opt_in'
assert_eq "相対パスの opt-in は exit 1" "1" "$RC"
assert_contains "相対パスの拒否は変数名を出す" "PECOT_RELEASE_TEST_NPM_CACHE は絶対パスで指定してください" "$OUT"
PECOT_RELEASE_TEST_NPM_CACHE=/abs/cache run_lib 'DRY_RUN=false; mcp_publish_check_npm_cache_opt_in'
assert_eq "実配布での opt-in は exit 1" "1" "$RC"
assert_contains "実配布の拒否は検証用と書く" "検証用です" "$OUT"
PECOT_RELEASE_TEST_NPM_CACHE=/abs/cache run_lib 'DRY_RUN=true; mcp_publish_check_npm_cache_opt_in; echo "$NPM_CACHE_OPT_IN"'
assert_eq "dry-run での絶対パスの opt-in は通る" "/abs/cache" "$OUT"

# --- validate_out_dir ---
FAKE_REPO="$TMP/repo"
mkdir -p "$FAKE_REPO/inner" "$TMP/outside-full" "$TMP/real-parent"
touch "$TMP/outside-full/keep" "$TMP/a-file"
ln -s "$TMP/real-parent" "$TMP/link-parent"
FAKE_REPO="$(cd "$FAKE_REPO" && pwd -P)"

check_out_dir() {
    run_lib "REPO_ROOT='$FAKE_REPO'; OUT_DIR='$1'; mcp_publish_validate_out_dir; echo \"\$OUT_DIR\""
}
check_out_dir ""
assert_eq "--out-dir なしは何もしない" "0 " "$RC $OUT"
check_out_dir "$FAKE_REPO/inner"
assert_eq "リポ配下は exit 1" "1" "$RC"
assert_contains "リポ配下の拒否文" "リポジトリ ($FAKE_REPO) の外を指定してください" "$OUT"
check_out_dir "$FAKE_REPO"
assert_eq "リポのルート自身は exit 1" "1" "$RC"
check_out_dir "$TMP/outside-full"
assert_eq "中身のあるディレクトリは exit 1" "1" "$RC"
assert_contains "中身ありの拒否文" "不在か空のディレクトリのみ" "$OUT"
check_out_dir "$TMP/a-file"
assert_eq "ファイルは exit 1" "1" "$RC"
assert_contains "ファイルの拒否文" "ディレクトリではありません" "$OUT"
check_out_dir "$TMP/no-such-parent/child"
assert_eq "親が不在は exit 1" "1" "$RC"
assert_contains "親不在の拒否文" "親ディレクトリがありません" "$OUT"
check_out_dir "$TMP/link-parent/new-dist"
assert_eq "symlink の親を実体解決して通す" "0 $(cd "$TMP/real-parent" && pwd -P)/new-dist" "$RC $OUT"
mkdir -p "$TMP/empty-dir"
check_out_dir "$TMP/empty-dir"
assert_eq "空のディレクトリは通る" "0 $(cd "$TMP/empty-dir" && pwd -P)" "$RC $OUT"
ln -s "$FAKE_REPO/inner" "$TMP/link-into-repo"
check_out_dir "$TMP/link-into-repo"
assert_eq "リポ内を指す symlink は実体で判定して exit 1" "1" "$RC"

# --- require_release_head ---
GIT_REPO="$TMP/git-repo"
export GIT_AUTHOR_NAME="mcp-publish-common test" GIT_AUTHOR_EMAIL="mcp-publish-common-test@example.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
mkdir -p "$GIT_REPO/plugins/p"
git init --quiet --initial-branch=main "$GIT_REPO" || exit 1
echo a > "$GIT_REPO/plugins/p/f"
git -C "$GIT_REPO" add -A > /dev/null 2>&1
git -C "$GIT_REPO" commit --quiet -m init > /dev/null 2>&1 || exit 1

head_check() {
    run_lib "REPO_ROOT='$GIT_REPO'; DRY_RUN=$1; mcp_publish_require_release_head p-v1 p plugins/p; echo continued"
}
head_check false
assert_eq "タグが無ければ exit 0 で終える" "0" "$RC"
assert_contains "タグ無しはスキップを表示する" "スキップ: HEAD に p-v1 が無いため p のリリースではありません" "$OUT"
case "$OUT" in *continued*) fail "タグ無しで続きが実行された" ;; *) pass "タグ無しは続きを実行しない" ;; esac
head_check true
assert_eq "dry-run はタグが無くても続ける" "0 continued" "$RC $OUT"
git -C "$GIT_REPO" tag p-v1
head_check false
assert_eq "タグがあり差分も無ければ続ける" "0 continued" "$RC $OUT"
echo b >> "$GIT_REPO/plugins/p/f"
head_check false
assert_eq "対象パスに差分があれば exit 1" "1" "$RC"
assert_contains "差分ありの拒否文" "plugins/p に未コミットの変更があります" "$OUT"
head_check true
assert_eq "dry-run は差分があっても続ける" "0 continued" "$RC $OUT"
git -C "$GIT_REPO" checkout --quiet -- plugins/p/f
echo c > "$GIT_REPO/unrelated"
head_check false
assert_eq "対象外のパスの差分は見ない" "0 continued" "$RC $OUT"

# --- make_dist ---
run_lib "OUT_DIR='$TMP/dist-out'; mkdir -p \"\$OUT_DIR\"; echo old > \"\$OUT_DIR/old\"; mcp_publish_make_dist; echo \"\$DIST \$(ls -A \"\$DIST\" | wc -l | tr -d ' ')\""
assert_eq "--out-dir を空にして DIST にする" "0 $TMP/dist-out 0" "$RC $OUT"
assert_eq "--out-dir は終了後も残る" "yes" "$([ -d "$TMP/dist-out" ] && echo yes || echo no)"
run_lib "OUT_DIR=''; mcp_publish_make_dist; echo \"\$DIST\" > '$TMP/auto-dist-path'"
AUTO_DIST="$(cat "$TMP/auto-dist-path")"
assert_eq "--out-dir なしの DIST は終了時に消える" "0 no" "$RC $([ -e "$AUTO_DIST" ] && echo yes || echo no)"
run_lib "OUT_DIR=''; mcp_publish_make_dist; exit 7"
assert_eq "cleanup は元の終了コードを保つ" "7" "$RC"

# --- write_shrinkwrap ---
mkdir -p "$TMP/bin" "$TMP/sw-dist"
cat > "$TMP/bin/npm" << 'STUB_NPM'
#!/bin/bash
printf '%s\n' "$*" > "$NPM_STUB_LOG"
echo '{"lockfileVersion":3}' > package-lock.json
STUB_NPM
chmod +x "$TMP/bin/npm"
export NPM_STUB_LOG="$TMP/npm.log"
PATH="$TMP/bin:$PATH" run_lib "NPM_CACHE_OPT_IN=''; mcp_publish_write_shrinkwrap '$TMP/sw-dist'"
assert_eq "shrinkwrap が作られる" "0 yes" "$RC $([ -f "$TMP/sw-dist/npm-shrinkwrap.json" ] && echo yes || echo no)"
assert_eq "package-lock.json は残らない" "no" "$([ -f "$TMP/sw-dist/package-lock.json" ] && echo yes || echo no)"
NPM_ARGS="$(cat "$NPM_STUB_LOG")"
assert_contains "npm にタイムアウトと再試行を渡す" "--fetch-timeout=30000 --fetch-retries=1" "$NPM_ARGS"
assert_contains "npm に --package-lock-only を渡す" "install --package-lock-only --ignore-scripts" "$NPM_ARGS"
case "$NPM_ARGS" in *--prefer-offline*) fail "opt-in なしで prefer-offline が付いた" ;; *) pass "opt-in なしは prefer-offline を付けない" ;; esac
rm -f "$TMP/sw-dist/npm-shrinkwrap.json"
PATH="$TMP/bin:$PATH" run_lib "NPM_CACHE_OPT_IN='$TMP/persist-cache'; mcp_publish_write_shrinkwrap '$TMP/sw-dist'"
NPM_ARGS="$(cat "$NPM_STUB_LOG")"
assert_contains "opt-in があれば prefer-offline と指定のキャッシュを渡す" "--cache=$TMP/persist-cache --prefer-offline" "$NPM_ARGS"

echo
echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
