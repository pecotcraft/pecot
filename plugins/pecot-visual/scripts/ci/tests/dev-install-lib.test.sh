#!/bin/bash
# dev-install-lib.sh の pecotv_dev_install を検証する (#1297)。
#
# pnpm 12 は、リンク越しのメンバーがあると frozen の判定を誤る。
# そのため開発環境では、`install --lockfile-only` で lock の最新を確かめる。
# そのあとに `install --prefer-frozen-lockfile --ignore-scripts` を実行する。
# pnpm の導入を始めたあとの失敗では、元の終了コードを返す前に npm ci で依存を戻す。
# lifecycle は導入の中で動かさず、npm で text-rules の依存を戻した後に、prepare を明示して実行する。
# 偽の pnpm を PATH に置き、呼び出しの順序と、lock がずれたときの復元を固定する。
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
# 退避ファイルは TMPDIR 側に作られる。ケースごとの残りを数えるため、専用の置き場にする。
export TMPDIR="$TMP/tmpdir"
mkdir -p "$TMPDIR"

# shellcheck source=../dev-install-lib.sh
. "$CI_DIR/dev-install-lib.sh"

# 偽 pnpm と偽 npm。ケースごとに作り直し、記録先と挙動を作る時点で埋め込む。
# 偽物は呼び出しを 1 行ずつ記録し、偽 npm は cwd も記録する。
#   $1 は記録先。
#   $2 は npm の cwd の記録先。
#   $3 が 1 のとき、--lockfile-only で lock を書き換える。lock が package.json とずれた状態を再現する。
#   $3 が 2 のとき、--prefer-frozen-lockfile で lock を書き換える。3 のとき、--lockfile-only の途中で TERM を受ける。
#   $4 の呼び出しのときだけ失敗する（pnpm は exit 1、npm は exit 7）。'|' 区切りで複数指定できる。空なら失敗しない。
write_fakes() {
    local calls_file="$1" cwd_file="$2" rewrite="$3" fail_on="$4"
    mkdir -p "$TMP/bin"
    cat > "$TMP/bin/pnpm" << FAKE_PNPM
#!/bin/bash
echo "pnpm \$*" >> "$calls_file"
if [ "\$*" = "install --lockfile-only --prefer-offline" ] && [ "$rewrite" = "1" ]; then
    echo "rewritten: true" >> pnpm-lock.yaml
fi
if [ "\$*" = "install --prefer-frozen-lockfile --ignore-scripts" ] && [ "$rewrite" = "2" ]; then
    echo "rewritten by prefer-frozen: true" >> pnpm-lock.yaml
fi
if [ "\$*" = "install --lockfile-only --prefer-offline" ] && [ "$rewrite" = "3" ]; then
    # Ctrl-C を模す。lock を書き換えたあと、テストが起動したシェル（pid は $calls_file.pid）へ TERM を送り、自分も終わる。
    echo "rewritten: true" >> pnpm-lock.yaml
    kill -TERM "\$(cat "$calls_file.pid")"
    exit 143
fi
case "|$fail_on|" in
    *"|pnpm \$*|"*) exit 1 ;;
esac
exit 0
FAKE_PNPM
    cat > "$TMP/bin/npm" << FAKE_NPM
#!/bin/bash
echo "npm \$*" >> "$calls_file"
pwd > "$cwd_file"
case "|$fail_on|" in
    *"|npm \$*|"*) exit 7 ;;
esac
exit 0
FAKE_NPM
    chmod +x "$TMP/bin/pnpm" "$TMP/bin/npm"
}

# $1 = ケース名、$2 = lock を書き換えるか（0 / 1）、$3 = 失敗させる呼び出し。
# 作業用のプラグインルートと lock を用意し、偽物を作る。
new_root() {
    REPO="$TMP/$1"
    ROOT="$REPO/plugins/pecot-visual"
    CALLS_FILE="$TMP/$1.calls"
    CWD_FILE="$TMP/$1.npm-cwd"
    mkdir -p "$ROOT"
    printf 'lockfileVersion: 9\noriginal: true\n' > "$ROOT/pnpm-lock.yaml"
    : > "$CALLS_FILE"
    write_fakes "$CALLS_FILE" "$CWD_FILE" "${2:-0}" "${3:-}"
}

calls() {
    paste -sd '|' "$CALLS_FILE"
}

backup_count() {
    find "$TMPDIR" -maxdepth 1 -name 'pnpm-lock.backup.*' | wc -l | tr -d ' '
}

# --- ケース 1: lock が最新 → 確認してから install ---
new_root fresh
PATH="$TMP/bin:$PATH" pecotv_dev_install "$ROOT" pnpm > "$TMP/fresh.out" 2>&1
assert_eq "最新の lock: 終了コードは 0" "0" "$?"
assert_eq "最新の lock: lockfile-only、prefer-frozen の install、npm ci の順" \
    "pnpm install --lockfile-only --prefer-offline|pnpm install --prefer-frozen-lockfile --ignore-scripts|npm --prefix libs/text-rules ci|pnpm --filter @pecot/slidev-assets-dev run prepare" "$(calls)"
assert_eq "最新の lock: npm ci の cwd はリポジトリ root" "$REPO" "$(cat "$CWD_FILE")"
assert_eq "最新の lock: lock は変わらない" "$(printf 'lockfileVersion: 9\noriginal: true\n')" "$(cat "$ROOT/pnpm-lock.yaml")"
assert_eq "最新の lock: 退避ファイルを残さない" "0" "$(backup_count)"

# --- ケース 2: lock がずれている → 元に戻して止まる ---
new_root drift 1
PATH="$TMP/bin:$PATH" pecotv_dev_install "$ROOT" pnpm > "$TMP/drift.out" 2> "$TMP/drift.err"
rc=$?
if [ "$rc" -ne 0 ]; then pass "ずれた lock: 非 0 で返る"; else fail "ずれた lock: 正常終了してしまった"; fi
assert_eq "ずれた lock: 後続の呼び出しをしない" "pnpm install --lockfile-only --prefer-offline" "$(calls)"
assert_eq "ずれた lock: lock が元に戻る" "$(printf 'lockfileVersion: 9\noriginal: true\n')" "$(cat "$ROOT/pnpm-lock.yaml")"
if grep -q 'pnpm-lock.yaml が package.json とずれています' "$TMP/drift.err"; then
    pass "ずれた lock: 作り直しの案内を stderr に出す"
else
    fail "ずれた lock: 案内が stderr に無い"
fi
assert_eq "ずれた lock: 退避ファイルを残さない" "0" "$(backup_count)"

# --- ケース 2b: prefer-frozen が lock を書き換えた → 元に戻して止まる ---
new_root frozen-rewrite 2
PATH="$TMP/bin:$PATH" pecotv_dev_install "$ROOT" pnpm > "$TMP/frozen-rewrite.out" 2> "$TMP/frozen-rewrite.err"
rc=$?
if [ "$rc" -ne 0 ]; then pass "prefer-frozen が書き換えた lock: 非 0 で返る"; else fail "prefer-frozen が書き換えた lock: 正常終了してしまった"; fi
assert_eq "prefer-frozen が書き換えた lock: 依存を戻す npm ci を呼ぶ" \
    "pnpm install --lockfile-only --prefer-offline|pnpm install --prefer-frozen-lockfile --ignore-scripts|npm --prefix libs/text-rules ci" "$(calls)"
assert_eq "prefer-frozen が書き換えた lock: lock が元に戻る" "$(printf 'lockfileVersion: 9\noriginal: true\n')" "$(cat "$ROOT/pnpm-lock.yaml")"
if grep -q 'pnpm install が pnpm-lock.yaml を書き換えました' "$TMP/frozen-rewrite.err"; then
    pass "prefer-frozen が書き換えた lock: 案内を stderr に出す"
else
    fail "prefer-frozen が書き換えた lock: stderr に案内が出ない"
fi
assert_eq "prefer-frozen が書き換えた lock: 退避ファイルを残さない" "0" "$(backup_count)"

# --- ケース 2c: lock に触る区間で TERM を受ける → lock を戻し、退避ファイルを消し、143 で終わる ---
new_root interrupted 3
PATH="$TMP/bin:$PATH" bash -c 'echo $$ > "$3"; . "$1"; pecotv_dev_install "$2" pnpm' _ "$CI_DIR/dev-install-lib.sh" "$ROOT" "$CALLS_FILE.pid" > "$TMP/interrupted.out" 2>&1
assert_eq "TERM を受けた: 終了コードは 143" "143" "$?"
assert_eq "TERM を受けた: 後続の呼び出しをしない" "pnpm install --lockfile-only --prefer-offline" "$(calls)"
assert_eq "TERM を受けた: lock が元に戻る" "$(printf 'lockfileVersion: 9\noriginal: true\n')" "$(cat "$ROOT/pnpm-lock.yaml")"
assert_eq "TERM を受けた: 退避ファイルを残さない" "0" "$(backup_count)"

# --- ケース 2d: 呼び出し元の trap は、終わったあとも残る ---
new_root keep-trap
trap_out="$(PATH="$TMP/bin:$PATH" bash -c '. "$1"; trap "echo caller" TERM; pecotv_dev_install "$2" pnpm >/dev/null 2>&1; trap -p TERM' _ "$CI_DIR/dev-install-lib.sh" "$ROOT")"
assert_eq "呼び出し元の trap: 戻る" "trap -- 'echo caller' SIGTERM" "$trap_out"

# --- ケース 2e: nx の install は npm ci まで行い、prepare は行わない。---
# env の取り出し元は、project.json の install target の command。
# command の先頭にある VAR=value の代入を使う。
NX_ENV="$(node -e '
const c = require(process.argv[1]).targets.install.options.command;
const m = c.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/);
if (!m) process.exit(1);
console.log(m[0].trim());
' "$CI_DIR/../../project.json")"
nx_env_rc=$?
if [ "$nx_env_rc" -eq 0 ] && [ -n "$NX_ENV" ]; then
    pass "nx の install: project.json の command から env を取り出せる ($NX_ENV)"
else
    fail "nx の install: project.json の command から env を取り出せない"
    NX_ENV="PECOTV_SKIP_SLIDEV_PREPARE=1"
fi
new_root nx-install
(
    # shellcheck disable=SC2086
    export ${NX_ENV?}
    PATH="$TMP/bin:$PATH" pecotv_dev_install "$ROOT" pnpm > "$TMP/nx-install.out" 2>&1
)
assert_eq "nx の install: 終了コードは 0" "0" "$?"
assert_eq "nx の install: npm ci まで呼び、prepare は呼ばない" \
    "pnpm install --lockfile-only --prefer-offline|pnpm install --prefer-frozen-lockfile --ignore-scripts|npm --prefix libs/text-rules ci" "$(calls)"

# --- ケース 3: lockfile-only が失敗 → 元に戻し、終了コードを返す ---
new_root lockonly-fail 1 "pnpm install --lockfile-only --prefer-offline"
PATH="$TMP/bin:$PATH" pecotv_dev_install "$ROOT" pnpm > "$TMP/lockonly-fail.out" 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then pass "lockfile-only の失敗: 非 0 で返る"; else fail "lockfile-only の失敗: 正常終了してしまった"; fi
assert_eq "lockfile-only の失敗: 後続の呼び出しをしない" "pnpm install --lockfile-only --prefer-offline" "$(calls)"
assert_eq "lockfile-only の失敗: lock が元に戻る" "$(printf 'lockfileVersion: 9\noriginal: true\n')" "$(cat "$ROOT/pnpm-lock.yaml")"
assert_eq "lockfile-only の失敗: 退避ファイルを残さない" "0" "$(backup_count)"

# --- ケース 4: install が失敗 → 終了コードをそのまま返す ---
new_root install-fail 0 "pnpm install --prefer-frozen-lockfile --ignore-scripts"
PATH="$TMP/bin:$PATH" pecotv_dev_install "$ROOT" pnpm > "$TMP/install-fail.out" 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then pass "install の失敗: 非 0 で返る"; else fail "install の失敗: 正常終了してしまった"; fi
assert_eq "install の失敗: 元の終了コードを返す" "1" "$rc"
assert_eq "install の失敗: 依存を戻す npm ci を呼ぶ" "pnpm install --lockfile-only --prefer-offline|pnpm install --prefer-frozen-lockfile --ignore-scripts|npm --prefix libs/text-rules ci" "$(calls)"
assert_eq "install の失敗: npm ci の cwd はリポジトリ root" "$REPO" "$(cat "$CWD_FILE")"
assert_eq "install の失敗: 退避ファイルを残さない" "0" "$(backup_count)"

# --- ケース 4d: install が失敗し、戻す npm ci も失敗 → 元の終了コードを返す ---
new_root install-and-npm-fail 0 "pnpm install --prefer-frozen-lockfile --ignore-scripts|npm --prefix libs/text-rules ci"
PATH="$TMP/bin:$PATH" pecotv_dev_install "$ROOT" pnpm > "$TMP/install-and-npm-fail.out" 2>&1
assert_eq "install と戻しの失敗: 元の終了コード 1 を返す（npm の 7 で隠さない）" "1" "$?"

# --- ケース 4c: prepare が失敗 → 非 0 で返る ---
new_root prepare-fail 0 "pnpm --filter @pecot/slidev-assets-dev run prepare"
PATH="$TMP/bin:$PATH" pecotv_dev_install "$ROOT" pnpm > "$TMP/prepare-fail.out" 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then pass "prepare の失敗: 非 0 で返る"; else fail "prepare の失敗: 正常終了してしまった"; fi

# --- ケース 4b: npm ci が失敗 → 非 0 で返る ---
new_root npm-fail 0 "npm --prefix libs/text-rules ci"
PATH="$TMP/bin:$PATH" pecotv_dev_install "$ROOT" pnpm > "$TMP/npm-fail.out" 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then pass "npm ci の失敗: 非 0 で返る"; else fail "npm ci の失敗: 正常終了してしまった"; fi

# --- ケース 4e: nx の install（env 付き）で npm ci が失敗 → 非 0 で返り、prepare は呼ばない ---
new_root npm-fail-nx 0 "npm --prefix libs/text-rules ci"
(
    # shellcheck disable=SC2086
    export ${NX_ENV?}
    PATH="$TMP/bin:$PATH" pecotv_dev_install "$ROOT" pnpm > "$TMP/npm-fail-nx.out" 2>&1
)
rc=$?
if [ "$rc" -ne 0 ]; then pass "env 付きの npm ci の失敗: 非 0 で返る"; else fail "env 付きの npm ci の失敗: 正常終了してしまった"; fi
assert_eq "env 付きの npm ci の失敗: prepare を呼ばない" \
    "pnpm install --lockfile-only --prefer-offline|pnpm install --prefer-frozen-lockfile --ignore-scripts|npm --prefix libs/text-rules ci" "$(calls)"

# --- ケース 5: 起動コマンドが 2 語でも、分割して実行できる ---
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
assert_eq "起動コマンドが 2 語: 呼び出し順は同じ" \
    "pnpm install --lockfile-only --prefer-offline|pnpm install --prefer-frozen-lockfile --ignore-scripts|npm --prefix libs/text-rules ci|pnpm --filter @pecot/slidev-assets-dev run prepare" "$(calls)"

echo
echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
