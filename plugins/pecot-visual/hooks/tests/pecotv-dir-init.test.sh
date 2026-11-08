#!/bin/bash
# pecotv-dir-init.sh の単体テスト。
# - CLAUDE_PROJECT_DIR が指す場所に .pecotv/{state,work} が作られる
# - README.md / CHANGELOG.md がプラグイン（PLUGIN_HOOKS で偽装）から同期される
# - .pecotv/.gitignore が全部を除外する許可の一覧（*）で生成される
# - mtime ガード: 同期マーカーが plugin.json より新しければ skip、plugin.json 更新で再同期
# - CLAUDE_PROJECT_DIR 未定義時は何もせず exit 0（pecot-dir-init.sh と同じガード仕様）
# - 移行: 旧 .gitignore（tmp/ のみ）の実 git リポで README/CHANGELOG が untracked に出ない
# - 失敗注入: 最初のコピー対象（README.md）が dangling symlink で失敗しても untracked が残らない
# - 失敗注入: コピー途中（CHANGELOG.md）で失敗しても untracked が残らない（gitignore がコピーに先行）

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/../lib/core/pecotv-dir-init.sh"

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

# 一時リポへの git 操作は、GIT_* 環境変数のリークを避けるため、env -u で除去して隔離する。
# pre-push フック下では、GIT_DIR が親リポを指してリークし、一時リポの操作が親リポへ向く。
# 隔離のやり方は、pecot 側 pytest conftest の _isolate_git_env 相当。
# フックの起動も同じ隔離を通す。フックは内部で git ls-files を打ち、親リポの GIT_DIR が漏れると
# このリポが追跡する .pecotv/.gitignore を、一時ディレクトリも追跡中と誤判定するためだ。
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
    pass "初回実行: work, state/.plugin-sync-version, README.md, CHANGELOG.md が作成される"
else
    MSG_DETAIL_1="$(find "$PROJ1/.pecotv" 2>/dev/null | tr '\n' ' ')"
    fail "初回実行: exit=$EXIT 生成物=$MSG_DETAIL_1"
fi

# --- ケース2: .gitignore が全部を除外する許可の一覧（`*`）で生成される ---
GI="$PROJ1/.pecotv/.gitignore"
if [ -f "$GI" ] && grep -qx '\*' "$GI"; then
    pass ".pecotv/.gitignore に全部を除外する * が記載される"
else
    MSG_DETAIL_2="$(cat "$GI" 2>/dev/null)"
    fail ".pecotv/.gitignore 不在 or 未記載 (content='$MSG_DETAIL_2')"
fi

# --- ケース3: mtime ガード: マーカーが新しければ skip（README を消しても再コピーされない） ---
rm -f "$PROJ1/.pecotv/README.md"
"${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ1" PLUGIN_HOOKS="$FIXTURE/hooks" bash "$HOOK"
EXIT=$?
if [ $EXIT -eq 0 ] && [ ! -f "$PROJ1/.pecotv/README.md" ]; then
    pass "mtime ガード: マーカーが plugin.json より新しければ同期を skip する"
else
    MSG_DETAIL_3="$( [ -f "$PROJ1/.pecotv/README.md" ] && echo yes || echo no )"
    fail "mtime ガード skip: exit=$EXIT README 再コピー=$MSG_DETAIL_3"
fi

# --- ケース3b: plugin.json がマーカーより新しくなれば再同期される ---
touch "$FIXTURE/.claude-plugin/plugin.json"
echo "# fixture CHANGELOG v2" > "$FIXTURE/CHANGELOG.md"
"${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ1" PLUGIN_HOOKS="$FIXTURE/hooks" bash "$HOOK"
EXIT=$?
if [ $EXIT -eq 0 ] && [ -f "$PROJ1/.pecotv/README.md" ] \
    && grep -q "v2" "$PROJ1/.pecotv/CHANGELOG.md"; then
    pass "mtime ガード: plugin.json 更新で README/CHANGELOG が再同期される"
else
    MSG_DETAIL_4="$( [ -f "$PROJ1/.pecotv/README.md" ] && echo yes || echo no )"
    MSG_DETAIL_5="$(cat "$PROJ1/.pecotv/CHANGELOG.md" 2>/dev/null)"
    fail "mtime ガード再同期: exit=$EXIT README=$MSG_DETAIL_4 CHANGELOG='$MSG_DETAIL_5'"
fi

# --- ケース4: CLAUDE_PROJECT_DIR 未定義 → 何もせず exit 0 ---
PROJ2="$TMP/proj2"
mkdir -p "$PROJ2"
( cd "$PROJ2" && unset CLAUDE_PROJECT_DIR && PLUGIN_HOOKS="$FIXTURE/hooks" bash "$HOOK" )
EXIT=$?
if [ $EXIT -eq 0 ] && [ ! -d "$PROJ2/.pecotv" ]; then
    pass "CLAUDE_PROJECT_DIR 未定義: 何もせず exit 0"
else
    MSG_DETAIL_6="$( [ -d "$PROJ2/.pecotv" ] && echo yes || echo no )"
    fail "CLAUDE_PROJECT_DIR 未定義: exit=$EXIT created=$MSG_DETAIL_6"
fi

# --- ケース5: 移行 ---
# 旧 .gitignore（tmp/ のみ）の実 git リポで、README/CHANGELOG が untracked に出ない。
# これは正常系の最終状態確認であり、順序の回帰ガードではない。
# gitignore-ensure を末尾で呼ぶ旧順序でも、正常終了すれば最終的に .gitignore が更新される。
# コピー物は ignore されるため、このテストは旧順序でも pass する。
# 順序（コピーより前に gitignore が完了）の固定は、失敗注入テスト（ケース6・7）側で行う。
# pecot 側 test_pecot_dir_init.py の gitignore-ensure 先行化ケースと対称。
PROJ3="$TMP/proj3"
mkdir -p "$PROJ3/.pecotv"
_git -C "$PROJ3" init -q
_git -C "$PROJ3" config user.email t@t
_git -C "$PROJ3" config user.name t
printf '# 実行時生成ファイル (git管理外)\ntmp/\n' > "$PROJ3/.pecotv/.gitignore"
"${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ3" PLUGIN_HOOKS="$FIXTURE/hooks" bash "$HOOK"
# .pecotv/.gitignore 自身も、self-ignore 行（/.gitignore）で ignore 対象にする設計。
# pecot 側と同じで、フックが自動再生成するため git 管理外とする（#680）。
# よって untracked な新規リポでは、README/CHANGELOG/state/tmp に加え、.gitignore 自身も untracked に出ない。
# -uall で .pecotv/ 配下を個別ファイル単位に確認する（除外フィルタは不要）。
UNTRACKED=$(_git -C "$PROJ3" status --porcelain -uall -- .pecotv/)
if [ -z "$UNTRACKED" ]; then
    pass "移行: 旧 .gitignore リポでも同期物・.gitignore 自身が untracked に出ない（self-ignore + gitignore 先行更新）"
else
    fail "移行: untracked が残る (status='$UNTRACKED')"
fi

# --- ケース6: 最初のコピー対象（README.md）で失敗しても untracked が残らない ---
# 失敗ポイントを最初のコピー対象（README.md）に置く。
# 「いかなるコピーよりも前に gitignore-ensure が完了している」境界を固定するためだ。
# .pecotv/README.md を、実在しないパスへの dangling symlink にする。
# すると cp が「not writing through dangling symlink」で非 0 終了する。
# GNU coreutils の cp は、この動作を保証する。pecot 側 pytest も同じ前提で、動作を確認済み。
# gitignore-ensure がこの最初のコピーより前に動いていれば、失敗時点で .pecotv/ 配下に untracked は無い。
# コピー物がまだ 1 件も生成されていないためだ。
# 既存ケースとは終了コードの期待値が反転する（非 0 終了を期待）。
# EXIT 判定（$EXIT -ne 0）は、失敗注入が実際に働いていることの sanity check。
# 旧順序でも、失敗注入で非 0 終了する。
# 順序固定（gitignore がコピーに先行）の弁別は、untracked 空判定（-z "$UNTRACKED"）が担う。
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
    pass "失敗注入: 最初のコピー（README.md）失敗時も untracked が残らない（gitignore が全コピーに先行）"
else
    fail "失敗注入(README.md): exit=$EXIT untracked='$UNTRACKED'"
fi

# --- ケース7: コピー途中（CHANGELOG.md）で失敗しても untracked が残らない ---
# 失敗ポイントを 2 番目のコピー対象（CHANGELOG.md）に置く。
# 失敗時点で、README.md は実体がコピー済み。
# フック本体のコピー順は README → CHANGELOG で、FIXTURE に hooks/README.md が存在する。
# そのため、ケース6 とは異なり README コピーは成功する。
# gitignore-ensure がコピーより前に動き、README.md を ignore 対象に含めている。
# よって untracked には出ない。
# ケース6 と同じ論理積（非 0 終了 かつ untracked 空）で assert する。
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
    pass "失敗注入: コピー途中（CHANGELOG.md）失敗時も untracked が残らない（gitignore がコピーに先行）"
else
    fail "失敗注入(CHANGELOG.md): exit=$EXIT untracked='$UNTRACKED'"
fi

echo
echo "==================================="
echo "Passed: $PASS / Failed: $FAIL"
echo "==================================="
[ $FAIL -eq 0 ]
