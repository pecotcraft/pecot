#!/bin/bash
# pecotv-gitignore-ensure.sh の単体テスト。
# - --print は書かずに定義を出す（CLAUDE_PROJECT_DIR 不要・cwd に .pecotv/ を作らない）
# - ファイルが無ければ --print と同じ中身を書く
# - 追跡していない旧い中身は書き換える
# - 追跡しているファイルは書き換えない
# - git 外のディレクトリでも書く
# - 実 git で、生成物と設定が除外される

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENSURE="$SCRIPT_DIR/../lib/core/pecotv-gitignore-ensure.sh"

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
trap 'rm -rf "$TMP"' EXIT

# pre-push フック下では、GIT_DIR が親リポを指してリークする。
# このリポは .pecotv/.gitignore を追跡するため、一時ディレクトリも追跡中と判定されてしまう。
# そのため git の操作もスクリプトの起動も、GIT_* を外して行う。
_GIT_ISOLATE=(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
    -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES)
_git() {
    "${_GIT_ISOLATE[@]}" git "$@"
}
_run_ensure() {
    "${_GIT_ISOLATE[@]}" "$@" bash "$ENSURE"
}

DEFINITION="$("${_GIT_ISOLATE[@]}" bash "$ENSURE" --print)"

# --- ケース1: --print は書かずに定義を出す ---
CWD1="$TMP/c1"
mkdir -p "$CWD1"
OUT1=$(cd "$CWD1" && "${_GIT_ISOLATE[@]}" -u CLAUDE_PROJECT_DIR bash "$ENSURE" --print)
EXIT=$?
if [ $EXIT -eq 0 ] && [ "$OUT1" = "$DEFINITION" ] && printf '%s\n' "$OUT1" | grep -qx '\*' \
    && [ -z "$(ls -A "$CWD1")" ]; then
    pass "--print: CLAUDE_PROJECT_DIR なしで定義を出し、何も作らない"
else
    fail "--print: exit=$EXIT out='$OUT1' cwd='$(ls -A "$CWD1")'"
fi

# --- ケース2: CLAUDE_PROJECT_DIR 未設定 → 何もせず exit 0 ---
CWD2="$TMP/c2"
mkdir -p "$CWD2"
( cd "$CWD2" && "${_GIT_ISOLATE[@]}" -u CLAUDE_PROJECT_DIR bash "$ENSURE" )
EXIT=$?
if [ $EXIT -eq 0 ] && [ -z "$(ls -A "$CWD2")" ]; then
    pass "CLAUDE_PROJECT_DIR 未設定: 何もせず exit 0"
else
    DETAIL="$(ls -A "$CWD2")"
    fail "CLAUDE_PROJECT_DIR 未設定: exit=$EXIT cwd='$DETAIL'"
fi

# --- ケース3: ファイルが無ければ --print と同じ中身を書く（git 外） ---
P3="$TMP/p3"
mkdir -p "$P3"
_run_ensure CLAUDE_PROJECT_DIR="$P3" GIT_CEILING_DIRECTORIES="$TMP"
EXIT=$?
if [ $EXIT -eq 0 ] && [ "$(cat "$P3/.pecotv/.gitignore")" = "$DEFINITION" ] \
    && [ "$(find "$P3/.pecotv" -mindepth 1 | wc -l)" -eq 1 ]; then
    pass "ファイル無し・git 外: --print と同じ中身を書く（一時ファイルは残らない）"
else
    DETAIL="$(cat "$P3/.pecotv/.gitignore" 2>/dev/null)"
    fail "ファイル無し・git 外: exit=$EXIT content='$DETAIL'"
fi

# --- ケース4: 追跡していない旧い中身は書き換える ---
P4="$TMP/p4"
mkdir -p "$P4/.pecotv"
_git -C "$P4" init -q
printf 'state/\ntmp/\n/.gitignore\n' > "$P4/.pecotv/.gitignore"
_run_ensure CLAUDE_PROJECT_DIR="$P4"
EXIT=$?
if [ $EXIT -eq 0 ] && [ "$(cat "$P4/.pecotv/.gitignore")" = "$DEFINITION" ]; then
    pass "追跡していない旧い中身: 定義へ書き換える"
else
    DETAIL="$(cat "$P4/.pecotv/.gitignore")"
    fail "追跡していない旧い中身: exit=$EXIT content='$DETAIL'"
fi

# --- ケース5: 追跡しているファイルは書き換えない ---
P5="$TMP/p5"
mkdir -p "$P5/.pecotv"
_git -C "$P5" init -q
_git -C "$P5" config user.email t@t
_git -C "$P5" config user.name t
printf '# local\n' > "$P5/.pecotv/.gitignore"
_git -C "$P5" add -f .pecotv/.gitignore
_git -C "$P5" commit -q -m "track"
_run_ensure CLAUDE_PROJECT_DIR="$P5"
EXIT=$?
if [ $EXIT -eq 0 ] && [ "$(cat "$P5/.pecotv/.gitignore")" = "# local" ] && _git -C "$P5" diff --quiet; then
    pass "追跡しているファイル: 書き換えない"
else
    DETAIL="$(cat "$P5/.pecotv/.gitignore")"
    fail "追跡しているファイル: exit=$EXIT content='$DETAIL'"
fi

# --- ケース6: 実 git で生成物と設定が除外される ---
P6="$TMP/p6"
mkdir -p "$P6"
_git -C "$P6" init -q
_run_ensure CLAUDE_PROJECT_DIR="$P6"
mkdir -p "$P6/.pecotv/work/drawio" "$P6/.pecotv/work/evidence" "$P6/.pecotv/state" "$P6/.pecotv/tmp" "$P6/.pecotv/config"
for f in work/drawio/x.drawio work/evidence/x.xlsx state/s.json tmp/t README.md CHANGELOG.md config/hooks-config.json; do
    touch "$P6/.pecotv/$f"
done
STATUS6=$(_git -C "$P6" status --porcelain -uall)
IGNORED_OK=1
for f in work/drawio/x.drawio work/evidence/x.xlsx state/ tmp/ README.md CHANGELOG.md config/hooks-config.json .gitignore; do
    _git -C "$P6" check-ignore -q -- ".pecotv/$f" || { IGNORED_OK=0; echo "  not ignored: $f"; }
done
if [ -z "$STATUS6" ] && [ $IGNORED_OK -eq 1 ]; then
    pass "実 git: 生成物・設定・.gitignore 自身が除外され status が空"
else
    fail "実 git: status='$STATUS6'"
fi

echo
echo "==================================="
echo "Passed: $PASS / Failed: $FAIL"
echo "==================================="
[ $FAIL -eq 0 ]
