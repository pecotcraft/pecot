#!/bin/bash
# pecotv-dir-init.sh の単体テスト。.pecotv 一式の作成・同期（mtime ガード）・.gitignore の生成を確かめる。
# 失敗の注入で、gitignore-ensure がコピーより先に終わること（untracked が残らない）も確かめる。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
# shellcheck source=../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
HOOK="$SCRIPT_DIR/../lib/core/pecotv-dir-init.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 親リポの GIT_DIR などが漏れると、一時リポの操作が親リポへ向き、フックの git ls-files も誤判定する。
# そのため git の操作もフックの起動も GIT_* を外して行う。
_GIT_ISOLATE=(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
    -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES)
_git() {
    "${_GIT_ISOLATE[@]}" git "$@"
}

# 偽プラグイン root（同期元）: PLUGIN_HOOKS で pecotv-dir-init.sh に注入する
FIXTURE="$TMP/fixture"
mkdir -p "$FIXTURE/hooks" "$FIXTURE/.claude-plugin"
echo "# fixture hooks README" > "$FIXTURE/hooks/README.md"
echo "# fixture CHANGELOG v1" > "$FIXTURE/CHANGELOG.md"
echo '{"version": "0.0.1"}' > "$FIXTURE/.claude-plugin/plugin.json"

# --- ケース1: 初回実行で .pecotv 一式（state/tmp/README/CHANGELOG/.gitignore/マーカー）が作られる ---
PROJ1="$TMP/proj1"
mkdir -p "$PROJ1"
"${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ1" PLUGIN_HOOKS="$FIXTURE/hooks" bash "$HOOK"
EXIT=$?
if [ $EXIT -eq 0 ] && [ -d "$PROJ1/.pecotv/work" ] && [ -f "$PROJ1/.pecotv/state/.plugin-sync-version" ] \
    && [ -f "$PROJ1/.pecotv/README.md" ] && [ -f "$PROJ1/.pecotv/CHANGELOG.md" ]; then
    bt_pass "初回実行: work, state/.plugin-sync-version, README.md, CHANGELOG.md が作成される"
else
    MSG_DETAIL_1="$(find "$PROJ1/.pecotv" 2>/dev/null | tr '\n' ' ')"
    bt_fail "初回実行: work, state/.plugin-sync-version, README.md, CHANGELOG.md が作成される" \
        "exit=$EXIT 生成物=$MSG_DETAIL_1"
fi

# --- ケース2: .gitignore が全部を除外する許可の一覧（`*`）で生成される ---
GI="$PROJ1/.pecotv/.gitignore"
if [ -f "$GI" ] && grep -qx '\*' "$GI"; then
    bt_pass ".pecotv/.gitignore に全部を除外する * が記載される"
else
    MSG_DETAIL_2="$(cat "$GI" 2>/dev/null)"
    bt_fail ".pecotv/.gitignore に全部を除外する * が記載される" "不在 or 未記載 (content='$MSG_DETAIL_2')"
fi

# --- ケース3: mtime ガード: マーカーが新しければ skip（README を消しても再コピーされない） ---
rm -f "$PROJ1/.pecotv/README.md"
"${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ1" PLUGIN_HOOKS="$FIXTURE/hooks" bash "$HOOK"
EXIT=$?
if [ $EXIT -eq 0 ] && [ ! -f "$PROJ1/.pecotv/README.md" ]; then
    bt_pass "mtime ガード: マーカーが plugin.json より新しければ同期を skip する"
else
    MSG_DETAIL_3="$( [ -f "$PROJ1/.pecotv/README.md" ] && echo yes || echo no )"
    bt_fail "mtime ガード: マーカーが plugin.json より新しければ同期を skip する" \
        "exit=$EXIT README 再コピー=$MSG_DETAIL_3"
fi

# --- ケース3b: plugin.json がマーカーより新しくなれば再同期される ---
touch "$FIXTURE/.claude-plugin/plugin.json"
echo "# fixture CHANGELOG v2" > "$FIXTURE/CHANGELOG.md"
"${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ1" PLUGIN_HOOKS="$FIXTURE/hooks" bash "$HOOK"
EXIT=$?
if [ $EXIT -eq 0 ] && [ -f "$PROJ1/.pecotv/README.md" ] \
    && grep -q "v2" "$PROJ1/.pecotv/CHANGELOG.md"; then
    bt_pass "mtime ガード: plugin.json 更新で README/CHANGELOG が再同期される"
else
    MSG_DETAIL_4="$( [ -f "$PROJ1/.pecotv/README.md" ] && echo yes || echo no )"
    MSG_DETAIL_5="$(cat "$PROJ1/.pecotv/CHANGELOG.md" 2>/dev/null)"
    bt_fail "mtime ガード: plugin.json 更新で README/CHANGELOG が再同期される" \
        "exit=$EXIT README=$MSG_DETAIL_4 CHANGELOG='$MSG_DETAIL_5'"
fi

# --- ケース4: CLAUDE_PROJECT_DIR 未定義 → 何もせず exit 0 ---
PROJ2="$TMP/proj2"
mkdir -p "$PROJ2"
( cd "$PROJ2" && unset CLAUDE_PROJECT_DIR && PLUGIN_HOOKS="$FIXTURE/hooks" bash "$HOOK" )
EXIT=$?
if [ $EXIT -eq 0 ] && [ ! -d "$PROJ2/.pecotv" ]; then
    bt_pass "CLAUDE_PROJECT_DIR 未定義: 何もせず exit 0"
else
    MSG_DETAIL_6="$( [ -d "$PROJ2/.pecotv" ] && echo yes || echo no )"
    bt_fail "CLAUDE_PROJECT_DIR 未定義: 何もせず exit 0" "exit=$EXIT created=$MSG_DETAIL_6"
fi

# --- ケース5: 移行: 旧 .gitignore（tmp/ のみ）のリポで、同期物と .gitignore 自身が untracked に出ない ---
# 最終状態の確認で、旧順序でも通る。コピーより先に gitignore を終える順序は、ケース6・7 が固定する。
PROJ3="$TMP/proj3"
mkdir -p "$PROJ3/.pecotv"
_git -C "$PROJ3" init -q
_git -C "$PROJ3" config user.email t@t
_git -C "$PROJ3" config user.name t
printf '# 実行時生成ファイル (git管理外)\ntmp/\n' > "$PROJ3/.pecotv/.gitignore"
"${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ3" PLUGIN_HOOKS="$FIXTURE/hooks" bash "$HOOK"
UNTRACKED=$(_git -C "$PROJ3" status --porcelain -uall -- .pecotv/)
bt_eq "移行: 旧 .gitignore リポでも同期物・.gitignore 自身が untracked に出ない（self-ignore + gitignore 先行更新）" \
    "" "$UNTRACKED"

# --- ケース6: 最初のコピー対象（README.md）で失敗しても untracked が残らない ---
# README.md を dangling symlink にして cp を失敗させる。非 0 終了で注入が働いたことを、順序は untracked の空で見る。
PROJ6="$TMP/proj6"
mkdir -p "$PROJ6/.pecotv"
_git -C "$PROJ6" init -q
_git -C "$PROJ6" config user.email t@t
_git -C "$PROJ6" config user.name t
printf '# 実行時生成ファイル (git管理外)\ntmp/\n' > "$PROJ6/.pecotv/.gitignore"
ln -s "$TMP/nonexistent/target" "$PROJ6/.pecotv/README.md"
"${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ6" PLUGIN_HOOKS="$FIXTURE/hooks" bash "$HOOK"
EXIT=$?
UNTRACKED=$(_git -C "$PROJ6" status --porcelain -uall -- .pecotv/)
if [ $EXIT -ne 0 ] && [ -z "$UNTRACKED" ]; then
    bt_pass "失敗注入: 最初のコピー（README.md）失敗時も untracked が残らない（gitignore が全コピーに先行）"
else
    bt_fail "失敗注入: 最初のコピー（README.md）失敗時も untracked が残らない（gitignore が全コピーに先行）" \
        "exit=$EXIT untracked='$UNTRACKED'"
fi

# --- ケース7: コピー途中（CHANGELOG.md）で失敗しても untracked が残らない ---
# README.md はコピー済みの時点で失敗させる。ケース6 と同じく、非 0 終了かつ untracked が空を確かめる。
PROJ7="$TMP/proj7"
mkdir -p "$PROJ7/.pecotv"
_git -C "$PROJ7" init -q
_git -C "$PROJ7" config user.email t@t
_git -C "$PROJ7" config user.name t
printf '# 実行時生成ファイル (git管理外)\ntmp/\n' > "$PROJ7/.pecotv/.gitignore"
ln -s "$TMP/nonexistent/target" "$PROJ7/.pecotv/CHANGELOG.md"
"${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ7" PLUGIN_HOOKS="$FIXTURE/hooks" bash "$HOOK"
EXIT=$?
UNTRACKED=$(_git -C "$PROJ7" status --porcelain -uall -- .pecotv/)
if [ $EXIT -ne 0 ] && [ -z "$UNTRACKED" ]; then
    bt_pass "失敗注入: コピー途中（CHANGELOG.md）失敗時も untracked が残らない（gitignore がコピーに先行）"
else
    bt_fail "失敗注入: コピー途中（CHANGELOG.md）失敗時も untracked が残らない（gitignore がコピーに先行）" \
        "exit=$EXIT untracked='$UNTRACKED'"
fi

bt_finish
