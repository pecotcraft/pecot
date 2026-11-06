#!/bin/bash
# dev-install-lib.sh の pecotv_dev_install を検証する (#1297 / #113)。
#
# 偽の pnpm を PATH に置き、呼び出しの引数・cwd・終了コードを固定する。
#
# `set -e` は使わない: 失敗するケースの戻り値を握って評価を続けるため。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

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

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# shellcheck source=../dev-install-lib.sh
. "$CI_DIR/dev-install-lib.sh"

# 偽 pnpm。呼び出しの引数と cwd を記録する。$1=記録先 $2=cwd の記録先 $3=失敗させる終了コード（0 なら成功）
write_fake() {
    mkdir -p "$TMP/bin"
    cat > "$TMP/bin/pnpm" << FAKE_PNPM
#!/bin/bash
echo "pnpm \$*" >> "$1"
pwd > "$2"
exit $3
FAKE_PNPM
    chmod +x "$TMP/bin/pnpm"
}

# $1=ケース名 $2=偽 pnpm の終了コード。plugin root と記録先を用意する。
new_root() {
    REPO="$TMP/$1"
    ROOT="$REPO/plugins/pecot-visual"
    CALLS_FILE="$TMP/$1.calls"
    CWD_FILE="$TMP/$1.cwd"
    mkdir -p "$ROOT"
    : > "$CALLS_FILE"
    write_fake "$CALLS_FILE" "$CWD_FILE" "${2:-0}"
}

calls() {
    paste -sd '|' "$CALLS_FILE"
}

# --- ケース 1: repo root で frozen install を 1 回だけ実行する ---
new_root ok
PATH="$TMP/bin:$PATH" pecotv_dev_install "$ROOT" pnpm > "$TMP/ok.out" 2>&1
assert_eq "成功: 終了コードは 0" "0" "$?"
assert_eq "成功: install --frozen-lockfile の 1 回だけ" "pnpm install --frozen-lockfile" "$(calls)"
assert_eq "成功: cwd はリポジトリ root" "$REPO" "$(cat "$CWD_FILE")"

# --- ケース 2: install の失敗は終了コードをそのまま返す ---
new_root fail 7
PATH="$TMP/bin:$PATH" pecotv_dev_install "$ROOT" pnpm > "$TMP/fail.out" 2>&1
assert_eq "失敗: 元の終了コードを返す" "7" "$?"
assert_eq "失敗: 後続の呼び出しをしない" "pnpm install --frozen-lockfile" "$(calls)"

# --- ケース 3: 起動コマンドが 2 語でも、分割して実行できる ---
# 2 語の例は corepack pnpm。
new_root two-words
cat > "$TMP/bin/corepack" << 'FAKE_COREPACK'
#!/bin/bash
shift
exec pnpm "$@"
FAKE_COREPACK
chmod +x "$TMP/bin/corepack"
PATH="$TMP/bin:$PATH" pecotv_dev_install "$ROOT" "corepack pnpm" > "$TMP/two-words.out" 2>&1
assert_eq "起動コマンドが 2 語: 終了コードは 0" "0" "$?"
assert_eq "起動コマンドが 2 語: 呼び出しは同じ" "pnpm install --frozen-lockfile" "$(calls)"

# --- ケース 4: plugin root が無ければ非 0 で返る ---
PATH="$TMP/bin:$PATH" pecotv_dev_install "$TMP/missing/plugins/pecot-visual" pnpm > "$TMP/missing.out" 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then pass "plugin root が無い: 非 0 で返る"; else fail "plugin root が無い: 正常終了してしまった"; fi

echo
echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
