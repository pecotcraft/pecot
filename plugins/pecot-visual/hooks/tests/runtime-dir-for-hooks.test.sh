#!/bin/bash
# bin/_lib.sh の plugin_runtime_dir_for_hooks のテスト（#1230）。
# hooks/lib/core/hook-paths.sh の resolve_slidev_assets_dir も対象にする。
# - 自分のバージョンのハッシュのミラーが完成していれば、それを優先する（`current` が別セッションの新バージョンを指していても）。
# - 自分のバージョンのミラーが無いときだけ `current`。
# - どちらも完成していなければ失敗する（hook は eslint の未実施の通知に倒す）。
# - 解決順は CLAUDE_PLUGIN_DATA → PLUGIN_DATA → 既定の場所（XDG_DATA_HOME → HOME）。
#   実在しない置き場は失敗する（作らない）。
# - 解決しても何も作らない（hook が既定の場所を作らない）
# - assets/slidev は物理パスで返す。symlink を跨ぐ argv では、validate-references の自己実行判定が外れる。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT_SRC="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (want [$2], got [$3])"; fi; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
TMP=$(CDPATH= cd -P "$TMP" && pwd -P)

# ハッシュを計算できる最小のプラグインルート
ROOT="$TMP/plugin"
mkdir -p "$ROOT/bin" "$ROOT/cli/src" "$ROOT/hooks/lib/core"
cp "$PLUGIN_ROOT_SRC/bin/_lib.sh" "$ROOT/bin/"
cp "$PLUGIN_ROOT_SRC/hooks/lib/core/hook-paths.sh" "$ROOT/hooks/lib/core/"
printf '{ "packageManager": "pnpm@12.15.0+sha512.aaaa" }\n' > "$ROOT/package.json"
printf 'lock\n' > "$ROOT/runtime-lock.yaml"
printf 'packages:\n  - cli\n' > "$ROOT/runtime-workspace.yaml"
printf '{}\n' > "$ROOT/cli/package.json"
printf 'v1\n' > "$ROOT/cli/src/index.ts"

DATA="$TMP/data"
mkdir -p "$DATA/runtime"

# shellcheck source=/dev/null
. "$ROOT/bin/_lib.sh"
NAME="$(plugin_runtime_name "$ROOT")"

make_mirror() {
    local name="$1"
    mkdir -p "$DATA/runtime/$name/cli/dist" "$DATA/runtime/$name/assets/slidev"
    : > "$DATA/runtime/$name/.complete"
    : > "$DATA/runtime/$name/cli/dist/cli.js"
}

# 子 shell で解決する（変数と関数の汚染を避ける）。
resolve() {
    (
        unset CLAUDE_PLUGIN_DATA PLUGIN_DATA
        eval "$1"
        . "$ROOT/bin/_lib.sh"
        plugin_runtime_dir_for_hooks "$ROOT"
    )
}
resolve_assets() {
    (
        unset CLAUDE_PLUGIN_DATA PLUGIN_DATA
        eval "$1"
        . "$ROOT/hooks/lib/core/hook-paths.sh"
        resolve_slidev_assets_dir "$ROOT" "$ROOT/bin/_lib.sh"
    )
}

# --- どちらも無い ---
resolve "export CLAUDE_PLUGIN_DATA='$DATA'" >/dev/null
assert_eq "完成したミラーが無い: 失敗する" 1 "$?"

# --- current だけ（別の版） ---
make_mirror "aaaaaaaaaaaa-bbbbbbbbbbbb"
ln -s "aaaaaaaaaaaa-bbbbbbbbbbbb" "$DATA/runtime/current"
assert_eq "自分の版のミラーが無い: current を使う" "$DATA/runtime/current" "$(resolve "export CLAUDE_PLUGIN_DATA='$DATA'")"

# --- 自分の版のミラーがある: current が別の版でも自分の版を優先する ---
make_mirror "$NAME"
assert_eq "自分の版のミラーが完成: current が別の版でも自分の版を優先する" "$DATA/runtime/$NAME" "$(resolve "export CLAUDE_PLUGIN_DATA='$DATA'")"

# --- 自分の版のミラーが未完成: current にフォールバックしない理由は無いので current を使う ---
rm -f "$DATA/runtime/$NAME/.complete"
assert_eq "自分の版のミラーが未完成（完成印なし）: current を使う" "$DATA/runtime/current" "$(resolve "export CLAUDE_PLUGIN_DATA='$DATA'")"
: > "$DATA/runtime/$NAME/.complete"

# --- 解決順: CLAUDE_PLUGIN_DATA → PLUGIN_DATA → 既定の場所 ---
OTHER="$TMP/other"
mkdir -p "$OTHER/runtime"
assert_eq "CLAUDE_PLUGIN_DATA があれば PLUGIN_DATA より優先（そちらに無ければ失敗）" "" \
    "$(resolve "export CLAUDE_PLUGIN_DATA='$OTHER'; export PLUGIN_DATA='$DATA'")"
assert_eq "CLAUDE_PLUGIN_DATA が無効なら PLUGIN_DATA を使う" "$DATA/runtime/$NAME" \
    "$(resolve "export CLAUDE_PLUGIN_DATA='\${CLAUDE_PLUGIN_DATA}'; export PLUGIN_DATA='$DATA'")"
assert_eq "PLUGIN_DATA だけでも解決する" "$DATA/runtime/$NAME" "$(resolve "export PLUGIN_DATA='$DATA'")"

# 既定の場所: ${XDG_DATA_HOME}/pecot/pecot-visual（絶対パスでなければ未設定として ${HOME}/.local/share/pecot/pecot-visual）
XDG="$TMP/xdg"
FAKE_HOME="$TMP/home"
for place in "$XDG/pecot/pecot-visual" "$FAKE_HOME/.local/share/pecot/pecot-visual"; do
    mkdir -p "$place/runtime/$NAME/cli/dist" "$place/runtime/$NAME/assets/slidev"
    : > "$place/runtime/$NAME/.complete"
    : > "$place/runtime/$NAME/cli/dist/cli.js"
done
assert_eq "既定の場所: 有効な XDG_DATA_HOME を使う" "$XDG/pecot/pecot-visual/runtime/$NAME" \
    "$(resolve "export XDG_DATA_HOME='$XDG'; export HOME='$FAKE_HOME'")"
assert_eq "既定の場所: XDG_DATA_HOME が相対パスなら HOME の .local/share を使う" "$FAKE_HOME/.local/share/pecot/pecot-visual/runtime/$NAME" \
    "$(resolve "export XDG_DATA_HOME='relative/share'; export HOME='$FAKE_HOME'")"
assert_eq "既定の場所: XDG_DATA_HOME が空なら HOME の .local/share を使う" "$FAKE_HOME/.local/share/pecot/pecot-visual/runtime/$NAME" \
    "$(resolve "export XDG_DATA_HOME=''; export HOME='$FAKE_HOME'")"

# --- 解決できない / 置き場が無い: 失敗し、何も作らない ---
resolve "export XDG_DATA_HOME=''; export HOME=''" >/dev/null
assert_eq "有効な HOME と XDG_DATA_HOME が無い: 失敗する" 1 "$?"
resolve "export CLAUDE_PLUGIN_DATA='\${CLAUDE_PLUGIN_DATA}'; export XDG_DATA_HOME=''; export HOME=''" >/dev/null
assert_eq "クライアントの値が未展開で HOME も無い: 失敗する" 1 "$?"
NO_PLACE="$TMP/no-place"
resolve "export CLAUDE_PLUGIN_DATA='$NO_PLACE/client'" >/dev/null
assert_eq "実在しない置き場: 失敗する" 1 "$?"
resolve "export XDG_DATA_HOME='$NO_PLACE/xdg'; export HOME='$NO_PLACE/home'" >/dev/null
assert_eq "既定の場所が実在しない: 失敗する" 1 "$?"
assert_eq "解決しても何も作らない" no "$([ -e "$NO_PLACE" ] && echo yes || echo no)"

# --- resolve_slidev_assets_dir: 物理パスで返す ---
assert_eq "resolve_slidev_assets_dir: 自分の版のミラーの assets/slidev を返す" \
    "$DATA/runtime/$NAME/assets/slidev" "$(resolve_assets "export CLAUDE_PLUGIN_DATA='$DATA'")"
rm -rf "$DATA/runtime/$NAME"
make_mirror "$NAME"
rm -rf "$DATA/runtime/$NAME/assets"
mkdir -p "$TMP/real-assets/slidev"
ln -s "$TMP/real-assets" "$DATA/runtime/$NAME/assets"
assert_eq "resolve_slidev_assets_dir: symlink を解決した物理パスを返す" \
    "$TMP/real-assets/slidev" "$(resolve_assets "export CLAUDE_PLUGIN_DATA='$DATA'")"
rm -rf "$DATA/runtime/$NAME/assets" "$DATA/runtime/aaaaaaaaaaaa-bbbbbbbbbbbb/assets"
assert_eq "resolve_slidev_assets_dir: assets/slidev が無ければ組み立てたパスを返す（不在を伝えるため）" \
    "$DATA/runtime/$NAME/assets/slidev" "$(resolve_assets "export CLAUDE_PLUGIN_DATA='$DATA'")"
resolve_assets "export CLAUDE_PLUGIN_DATA='\${CLAUDE_PLUGIN_DATA}'; export XDG_DATA_HOME=''; export HOME=''" >/dev/null
assert_eq "resolve_slidev_assets_dir: ミラーを解決できなければ失敗する" 1 "$?"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
