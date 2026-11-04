#!/bin/bash
# session-start.sh の単体テスト。
# - .pecotv 不在のリポでは何も作らない（新規作成は利用検知側に一本化 #662/#676）
# - .pecotv 既存のリポでは、.gitignore が元の内容（pecotv-gitignore-ensure.sh）へ再生成される。
# - CLAUDE_PROJECT_DIR 末尾スラッシュ付きでも正しく動く

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/../session-start.sh"

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

# GIT_* 環境変数のリークを避けるため、env -u で除去して隔離する。
# pre-push フック下では、GIT_DIR が親リポを指してリークし、一時リポへの操作が親リポへ向く。
# 隔離のやり方は、pecot 側 pytest conftest の _isolate_git_env 相当。
# テストが直接打つ git は _git で、フックの起動は _run_hook で行う。
# フックは内部で git ls-files 等を実行する。どちらも、この隔離を通す。
_GIT_ISOLATE=(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
    -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES)
_git() {
    "${_GIT_ISOLATE[@]}" git "$@"
}
# フックを GIT_* 隔離下で起動する。VAR=val を引数前置きで渡せる（例: _run_hook CLAUDE_PROJECT_DIR=...）。
_run_hook() {
    "${_GIT_ISOLATE[@]}" "$@" bash "$HOOK"
}

# --- ケース1: .pecotv 不在 → 何も作らず exit 0 ---
PROJ1="$TMP/p1"
mkdir -p "$PROJ1"
_run_hook CLAUDE_PROJECT_DIR="$PROJ1"
EXIT=$?
if [ $EXIT -eq 0 ] && [ ! -e "$PROJ1/.pecotv" ]; then
    pass ".pecotv 不在: 何も作らず exit 0"
else
    MSG_DETAIL_1="$( [ -e "$PROJ1/.pecotv" ] && echo yes || echo no )"
    fail ".pecotv 不在: exit=$EXIT created=$MSG_DETAIL_1"
fi

# --- ケース2: .pecotv 既存 + .gitignore 汚染 → 元の内容へ再生成される ---
PROJ2="$TMP/p2"
mkdir -p "$PROJ2/.pecotv"
echo "汚染" > "$PROJ2/.pecotv/.gitignore"
_run_hook CLAUDE_PROJECT_DIR="$PROJ2"
EXIT=$?
if [ $EXIT -eq 0 ] && grep -qx "tmp/" "$PROJ2/.pecotv/.gitignore" \
    && grep -qx "state/" "$PROJ2/.pecotv/.gitignore" \
    && grep -qx "README.md" "$PROJ2/.pecotv/.gitignore" \
    && grep -qx "config/hooks-config.json" "$PROJ2/.pecotv/.gitignore" \
    && grep -qx "/.gitignore" "$PROJ2/.pecotv/.gitignore"; then
    pass ".pecotv 既存 + .gitignore 汚染: 元の内容へ再生成される"
else
    MSG_DETAIL_2="$(cat "$PROJ2/.pecotv/.gitignore" 2>/dev/null)"
    fail ".pecotv 既存 + 汚染: exit=$EXIT content='$MSG_DETAIL_2'"
fi

# --- ケース3: 非 git ディレクトリ（.pecotv 既存 + .gitignore 不在）→ 生成され、案内は出ない ---
PROJ3="$TMP/p3"
mkdir -p "$PROJ3/.pecotv"
OUT3=$(_run_hook CLAUDE_PROJECT_DIR="$PROJ3")
EXIT=$?
if [ $EXIT -eq 0 ] && [ -f "$PROJ3/.pecotv/.gitignore" ] \
    && ! printf '%s' "$OUT3" | grep -q 'git rm --cached'; then
    pass "非 git: .gitignore は再生成され、untrack 案内は出ない（exit 0）"
else
    MSG_DETAIL_3="$( [ -f "$PROJ3/.pecotv/.gitignore" ] && echo yes || echo no )"
    fail "非 git: exit=$EXIT gitignore=$MSG_DETAIL_3 out='$OUT3'"
fi

# --- ケース4: CLAUDE_PROJECT_DIR 末尾スラッシュ付きでも正しく動く ---
PROJ4="$TMP/p4"
mkdir -p "$PROJ4/.pecotv"
_run_hook CLAUDE_PROJECT_DIR="$PROJ4/"
EXIT=$?
if [ $EXIT -eq 0 ] && [ -f "$PROJ4/.pecotv/.gitignore" ]; then
    pass "末尾スラッシュ付き CLAUDE_PROJECT_DIR でも .gitignore が生成される"
else
    MSG_DETAIL_4="$( [ -f "$PROJ4/.pecotv/.gitignore" ] && echo yes || echo no )"
    fail "末尾スラッシュ: exit=$EXIT gitignore=$MSG_DETAIL_4"
fi

# --- ケース5: tracked な実 git リポ → untrack 案内が出る / index は不変 ---
PROJ5="$TMP/p5"
mkdir -p "$PROJ5/.pecotv"
_git -C "$PROJ5" init -q
_git -C "$PROJ5" config user.email t@t
_git -C "$PROJ5" config user.name t
# 旧内容（self-ignore 行なし）を tracked 状態で commit して再現
printf 'tmp/\n' > "$PROJ5/.pecotv/.gitignore"
_git -C "$PROJ5" add -f .pecotv/.gitignore
_git -C "$PROJ5" commit -q -m "track old gitignore"
LS_BEFORE=$(_git -C "$PROJ5" ls-files -- .pecotv/.gitignore)
OUT5=$(_run_hook CLAUDE_PROJECT_DIR="$PROJ5")
EXIT=$?
LS_AFTER=$(_git -C "$PROJ5" ls-files -- .pecotv/.gitignore)
if [ $EXIT -eq 0 ] \
    && printf '%s' "$OUT5" | grep -q 'git rm --cached .pecotv/.gitignore' \
    && [ "$LS_BEFORE" = ".pecotv/.gitignore" ] && [ "$LS_AFTER" = ".pecotv/.gitignore" ] \
    && grep -qx "/.gitignore" "$PROJ5/.pecotv/.gitignore"; then
    pass "tracked リポ: untrack 案内が出て index 不変・.gitignore は self-ignore 入りに再生成"
else
    fail "tracked リポ: exit=$EXIT out='$OUT5' before='$LS_BEFORE' after='$LS_AFTER'"
fi

# --- ケース5b: 出力は JSON 1 個 ---
# hookSpecificOutput とトップレベルの両方に、additionalContext が入る。
# Copilot CLI 1.0.103 は SessionStart では、トップレベルの additionalContext だけをモデルに渡す。
# Claude Code は hookSpecificOutput を読み、トップレベルは読まない。
# そのため、両方に出しても二重に入らない。
# 素のテキストのままだと Copilot ではモデルに届かない。
if printf '%s' "$OUT5" | jq -e '
        .hookSpecificOutput.hookEventName == "SessionStart"
        and (.hookSpecificOutput.additionalContext | contains("git rm --cached .pecotv/.gitignore"))
        and .additionalContext == .hookSpecificOutput.additionalContext
        and (has("systemMessage") | not)' >/dev/null 2>&1; then
    pass "SessionStart の出力は JSON 1 個（hookSpecificOutput とトップレベルの additionalContext が同じ）"
else
    fail "SessionStart の JSON 形式: out='$OUT5'"
fi

# --- ケース6: 案内に従い untrack + commit して再実行 → 無案内 / status clean ---
_git -C "$PROJ5" rm --cached -q .pecotv/.gitignore
_git -C "$PROJ5" commit -q -m "untrack gitignore"
OUT6=$(_run_hook CLAUDE_PROJECT_DIR="$PROJ5")
EXIT=$?
STATUS6=$(_git -C "$PROJ5" status --porcelain)
if [ $EXIT -eq 0 ] \
    && ! printf '%s' "$OUT6" | grep -q 'git rm --cached' \
    && [ -z "$STATUS6" ]; then
    pass "untrack 後: 案内は出ず status clean（self-ignore で再生成が dirty にならない）"
else
    fail "untrack 後: exit=$EXIT out='$OUT6' status='$STATUS6'"
fi

# --- ケース7: tracked リポ + hooks-config で無効化 ---
# 期待は、案内なしで exit 0。
# {"gitignore-untrack-notice": false} を PECOTV_HOOKS_CONFIG_PATH フィクスチャで渡す。
# すると、tracked でも案内ブロックが抑止される（pecot 側 config-dispatcher.sh と対称）。
PROJ7="$TMP/p7"
mkdir -p "$PROJ7/.pecotv"
_git -C "$PROJ7" init -q
_git -C "$PROJ7" config user.email t@t
_git -C "$PROJ7" config user.name t
printf 'tmp/\n' > "$PROJ7/.pecotv/.gitignore"
_git -C "$PROJ7" add -f .pecotv/.gitignore
_git -C "$PROJ7" commit -q -m "track old gitignore"
HOOKS_CFG7="$TMP/hooks-config-7.json"
printf '{"gitignore-untrack-notice": false}\n' > "$HOOKS_CFG7"
OUT7=$(_run_hook CLAUDE_PROJECT_DIR="$PROJ7" PECOTV_HOOKS_CONFIG_PATH="$HOOKS_CFG7")
EXIT=$?
if [ $EXIT -eq 0 ] && ! printf '%s' "$OUT7" | grep -q 'git rm --cached'; then
    pass "hooks-config 無効化: tracked でも untrack 案内が抑止される（exit 0）"
else
    fail "hooks-config 無効化: exit=$EXIT out='$OUT7'"
fi

# --- ケース8: node-runtime-notice ---
# 古い node では、JSON で利用者とエージェントの両方へ案内する。
# node は PATH 先頭のスタブで差し替える。
# checkNodeRuntime の判定そのものは、cli 側のテストが担う。
STUB_BLOCK="$TMP/stub-block"
mkdir -p "$STUB_BLOCK"
printf '#!/bin/sh\n' > "$STUB_BLOCK/node"
printf 'printf "%%s" "Node.js 0.0.0 は起動しません。"\n' >> "$STUB_BLOCK/node"
chmod +x "$STUB_BLOCK/node"
STUB_OK="$TMP/stub-ok"
mkdir -p "$STUB_OK"
printf '#!/bin/sh\nexit 0\n' > "$STUB_OK/node"
chmod +x "$STUB_OK/node"

PROJ8="$TMP/p8"
mkdir -p "$PROJ8"
OUT8=$(_run_hook CLAUDE_PROJECT_DIR="$PROJ8" PATH="$STUB_BLOCK:$PATH")
EXIT=$?
if [ $EXIT -eq 0 ] \
    && [ "$(printf '%s' "$OUT8" | jq -r '.additionalContext')" = "pecotv: Node.js 0.0.0 は起動しません。" ] \
    && [ "$(printf '%s' "$OUT8" | jq -r '.systemMessage')" = "pecotv: Node.js 0.0.0 は起動しません。" ] \
    && [ "$(printf '%s' "$OUT8" | jq -r '.hookSpecificOutput.hookEventName')" = "SessionStart" ] \
    && [ "$(printf '%s' "$OUT8" | jq -r '.hookSpecificOutput.additionalContext')" = "pecotv: Node.js 0.0.0 は起動しません。" ]; then
    pass "node-runtime-notice: 古い node で systemMessage と additionalContext に案内が出る（exit 0）"
else
    fail "node-runtime-notice: exit=$EXIT out='$OUT8'"
fi

# 他ブロックの stdout（tracked 案内）は additionalContext に畳まれ、出力全体が JSON 1 個のまま。
PROJ8B="$TMP/p8b"
mkdir -p "$PROJ8B/.pecotv"
_git -C "$PROJ8B" init -q
echo "x" > "$PROJ8B/.pecotv/.gitignore"
_git -C "$PROJ8B" add -f .pecotv/.gitignore
OUT8B=$(_run_hook CLAUDE_PROJECT_DIR="$PROJ8B" PATH="$STUB_BLOCK:$PATH")
if printf '%s' "$OUT8B" | jq -e '.hookSpecificOutput.additionalContext | contains("git rm --cached") and contains("Node.js 0.0.0")' >/dev/null 2>&1; then
    pass "node-runtime-notice: 他ブロックの stdout と束ねても JSON 1 個を保つ"
else
    fail "node-runtime-notice: 束ね out='$OUT8B'"
fi

# 許可する版（スタブが何も出さない）では何も出力しない。
OUT8C=$(_run_hook CLAUDE_PROJECT_DIR="$PROJ8" PATH="$STUB_OK:$PATH")
EXIT=$?
if [ $EXIT -eq 0 ] && [ -z "$OUT8C" ]; then
    pass "node-runtime-notice: 許可する版では何も出さず exit 0"
else
    fail "node-runtime-notice: 許可版 exit=$EXIT out='$OUT8C'"
fi

# hooks-config で node-runtime-notice を false にすると抑止される。
HOOKS_CFG8="$TMP/hooks-config-8.json"
printf '{"node-runtime-notice": false}\n' > "$HOOKS_CFG8"
OUT8D=$(_run_hook CLAUDE_PROJECT_DIR="$PROJ8" PECOTV_HOOKS_CONFIG_PATH="$HOOKS_CFG8" PATH="$STUB_BLOCK:$PATH")
EXIT=$?
if [ $EXIT -eq 0 ] && [ -z "$OUT8D" ]; then
    pass "node-runtime-notice: hooks-config 無効化で抑止される（exit 0）"
else
    fail "node-runtime-notice: 無効化 exit=$EXIT out='$OUT8D'"
fi

echo
echo "==================================="
echo "Passed: $PASS / Failed: $FAIL"
echo "==================================="
[ $FAIL -eq 0 ]
