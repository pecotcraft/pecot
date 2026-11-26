#!/bin/bash
# pecotv-gitignore-ensure.sh の単体テスト。--print・無いときの書き込み・旧い中身の書き換え・
# 追跡中のファイルを書き換えないこと・git 外の書き込み・実 git の除外を確かめる。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
# shellcheck source=../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
ENSURE="$SCRIPT_DIR/../lib/core/pecotv-gitignore-ensure.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 親リポの GIT_DIR が漏れると、このリポが追跡する .pecotv/.gitignore を一時ディレクトリも追跡中と判定する。
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
    bt_pass "--print: CLAUDE_PROJECT_DIR なしで定義を出し、何も作らない"
else
    DETAIL="$(ls -A "$CWD1")"
    bt_fail "--print: CLAUDE_PROJECT_DIR なしで定義を出し、何も作らない" "exit=$EXIT out='$OUT1' cwd='$DETAIL'"
fi

# --- ケース2: CLAUDE_PROJECT_DIR 未設定 → 何もせず exit 0 ---
CWD2="$TMP/c2"
mkdir -p "$CWD2"
( cd "$CWD2" && "${_GIT_ISOLATE[@]}" -u CLAUDE_PROJECT_DIR bash "$ENSURE" )
EXIT=$?
if [ $EXIT -eq 0 ] && [ -z "$(ls -A "$CWD2")" ]; then
    bt_pass "CLAUDE_PROJECT_DIR 未設定: 何もせず exit 0"
else
    DETAIL="$(ls -A "$CWD2")"
    bt_fail "CLAUDE_PROJECT_DIR 未設定: 何もせず exit 0" "exit=$EXIT cwd='$DETAIL'"
fi

# --- ケース3: ファイルが無ければ --print と同じ中身を書く（git 外） ---
P3="$TMP/p3"
mkdir -p "$P3"
_run_ensure CLAUDE_PROJECT_DIR="$P3" GIT_CEILING_DIRECTORIES="$TMP"
EXIT=$?
if [ $EXIT -eq 0 ] && [ "$(cat "$P3/.pecotv/.gitignore")" = "$DEFINITION" ] \
    && [ "$(find "$P3/.pecotv" -mindepth 1 | wc -l)" -eq 1 ]; then
    bt_pass "ファイル無し・git 外: --print と同じ中身を書く（一時ファイルは残らない）"
else
    DETAIL="$(cat "$P3/.pecotv/.gitignore" 2>/dev/null)"
    bt_fail "ファイル無し・git 外: --print と同じ中身を書く（一時ファイルは残らない）" "exit=$EXIT content='$DETAIL'"
fi

# --- ケース4: 追跡していない旧い中身は書き換える ---
P4="$TMP/p4"
mkdir -p "$P4/.pecotv"
_git -C "$P4" init -q
printf 'state/\ntmp/\n/.gitignore\n' > "$P4/.pecotv/.gitignore"
_run_ensure CLAUDE_PROJECT_DIR="$P4"
EXIT=$?
if [ $EXIT -eq 0 ] && [ "$(cat "$P4/.pecotv/.gitignore")" = "$DEFINITION" ]; then
    bt_pass "追跡していない旧い中身: 定義へ書き換える"
else
    DETAIL="$(cat "$P4/.pecotv/.gitignore")"
    bt_fail "追跡していない旧い中身: 定義へ書き換える" "exit=$EXIT content='$DETAIL'"
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
    bt_pass "追跡しているファイル: 書き換えない"
else
    DETAIL="$(cat "$P5/.pecotv/.gitignore")"
    bt_fail "追跡しているファイル: 書き換えない" "exit=$EXIT content='$DETAIL'"
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
NOT_IGNORED=""
for f in work/drawio/x.drawio work/evidence/x.xlsx state/ tmp/ README.md CHANGELOG.md config/hooks-config.json .gitignore; do
    _git -C "$P6" check-ignore -q -- ".pecotv/$f" || NOT_IGNORED="$NOT_IGNORED $f"
done
if [ -z "$STATUS6" ] && [ -z "$NOT_IGNORED" ]; then
    bt_pass "実 git: 生成物・設定・.gitignore 自身が除外され status が空"
else
    bt_fail "実 git: 生成物・設定・.gitignore 自身が除外され status が空" \
        "status='$STATUS6' not ignored:${NOT_IGNORED}"
fi

bt_finish
