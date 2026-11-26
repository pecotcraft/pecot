#!/bin/bash
# session-start.sh の単体テスト。.pecotv が無いリポでは何も作らず（#662/#676）、あるリポでは .gitignore を
# 定義へ書き直し（追跡中は書き換えない）、追跡の手順や直す手順を案内することを確かめる。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
# shellcheck source=../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
HOOK="$SCRIPT_DIR/../session-start.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 親リポの GIT_DIR などが漏れると、一時リポの操作が親リポへ向く。
# そのためテストの git（_git）もフックの起動（_run_hook）も GIT_* を外して行う。
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
    bt_pass ".pecotv 不在: 何も作らず exit 0"
else
    MSG_DETAIL_1="$( [ -e "$PROJ1/.pecotv" ] && echo yes || echo no )"
    bt_fail ".pecotv 不在: 何も作らず exit 0" "exit=$EXIT created=$MSG_DETAIL_1"
fi

# 期待する定義。ensure の --print を単一の出所とする。
DEFINITION="$(bash "$SCRIPT_DIR/../lib/core/pecotv-gitignore-ensure.sh" --print)"

# --- ケース2: .pecotv 既存 + 追跡していない汚染 → 定義へ書き直される ---
PROJ2="$TMP/p2"
mkdir -p "$PROJ2/.pecotv"
echo "汚染" > "$PROJ2/.pecotv/.gitignore"
_run_hook CLAUDE_PROJECT_DIR="$PROJ2"
EXIT=$?
if [ $EXIT -eq 0 ] && [ "$(cat "$PROJ2/.pecotv/.gitignore")" = "$DEFINITION" ]; then
    bt_pass ".pecotv 既存 + 追跡していない汚染: 定義へ書き直される"
else
    MSG_DETAIL_2="$(cat "$PROJ2/.pecotv/.gitignore" 2>/dev/null)"
    bt_fail ".pecotv 既存 + 追跡していない汚染: 定義へ書き直される" "exit=$EXIT content='$MSG_DETAIL_2'"
fi

# --- ケース2b: 追跡している .gitignore は書き換えられない ---
PROJ2B="$TMP/p2b"
mkdir -p "$PROJ2B/.pecotv"
_git -C "$PROJ2B" init -q
_git -C "$PROJ2B" config user.email t@t
_git -C "$PROJ2B" config user.name t
printf '*\n# local\n' > "$PROJ2B/.pecotv/.gitignore"
_git -C "$PROJ2B" add -f .pecotv/.gitignore
_git -C "$PROJ2B" commit -q -m "track gitignore"
_run_hook CLAUDE_PROJECT_DIR="$PROJ2B" >/dev/null
EXIT=$?
if [ $EXIT -eq 0 ] && [ "$(cat "$PROJ2B/.pecotv/.gitignore")" = "$(printf '*\n# local')" ] \
    && _git -C "$PROJ2B" diff --quiet; then
    bt_pass "追跡している .gitignore: 書き換えられない（diff なし）"
else
    DETAIL_2B="$(cat "$PROJ2B/.pecotv/.gitignore")"
    bt_fail "追跡している .gitignore: 書き換えられない（diff なし）" "exit=$EXIT content='$DETAIL_2B'"
fi

# --- ケース3: 非 git で .gitignore が無ければ書かれ、案内は出ない ---
# 親ディレクトリの git を拾わないよう GIT_CEILING_DIRECTORIES を付ける。
PROJ3="$TMP/p3"
mkdir -p "$PROJ3/.pecotv"
OUT3=$(_run_hook CLAUDE_PROJECT_DIR="$PROJ3" GIT_CEILING_DIRECTORIES="$TMP")
EXIT=$?
if [ $EXIT -eq 0 ] && [ -f "$PROJ3/.pecotv/.gitignore" ] \
    && ! printf '%s' "$OUT3" | grep -q 'git add -f .pecotv/.gitignore'; then
    bt_pass "非 git: .gitignore は書かれ、追跡の案内は出ない（exit 0）"
else
    MSG_DETAIL_3="$( [ -f "$PROJ3/.pecotv/.gitignore" ] && echo yes || echo no )"
    bt_fail "非 git: .gitignore は書かれ、追跡の案内は出ない（exit 0）" "exit=$EXIT gitignore=$MSG_DETAIL_3 out='$OUT3'"
fi

# --- ケース4: CLAUDE_PROJECT_DIR 末尾スラッシュ付きでも正しく動く ---
PROJ4="$TMP/p4"
mkdir -p "$PROJ4/.pecotv"
_run_hook CLAUDE_PROJECT_DIR="$PROJ4/"
EXIT=$?
if [ $EXIT -eq 0 ] && [ -f "$PROJ4/.pecotv/.gitignore" ]; then
    bt_pass "末尾スラッシュ付き CLAUDE_PROJECT_DIR でも .gitignore が生成される"
else
    MSG_DETAIL_4="$( [ -f "$PROJ4/.pecotv/.gitignore" ] && echo yes || echo no )"
    bt_fail "末尾スラッシュ付き CLAUDE_PROJECT_DIR でも .gitignore が生成される" "exit=$EXIT gitignore=$MSG_DETAIL_4"
fi

# --- ケース5: 追跡していて `*` が欠けた実 git リポでは、直す手順が案内される ---
# index と中身は変わらない。
PROJ5="$TMP/p5"
mkdir -p "$PROJ5/.pecotv"
_git -C "$PROJ5" init -q
_git -C "$PROJ5" config user.email t@t
_git -C "$PROJ5" config user.name t
# 旧内容（`*` なし）を追跡状態で commit して再現
printf 'tmp/\n' > "$PROJ5/.pecotv/.gitignore"
_git -C "$PROJ5" add -f .pecotv/.gitignore
_git -C "$PROJ5" commit -q -m "track old gitignore"
LS_BEFORE=$(_git -C "$PROJ5" ls-files -- .pecotv/.gitignore)
OUT5=$(_run_hook CLAUDE_PROJECT_DIR="$PROJ5")
EXIT=$?
LS_AFTER=$(_git -C "$PROJ5" ls-files -- .pecotv/.gitignore)
if [ $EXIT -eq 0 ] \
    && printf '%s' "$OUT5" | grep -q -e '--print' \
    && printf '%s' "$OUT5" | grep -q 'note: The tracked' \
    && ! printf '%s' "$OUT5" | grep -q 'git add -f .pecotv/.gitignore' \
    && [ "$LS_BEFORE" = ".pecotv/.gitignore" ] && [ "$LS_AFTER" = ".pecotv/.gitignore" ] \
    && [ "$(cat "$PROJ5/.pecotv/.gitignore")" = "tmp/" ]; then
    bt_pass "追跡して * が欠けたリポ: 直す手順を案内し、index と中身は不変"
else
    bt_fail "追跡して * が欠けたリポ: 直す手順を案内し、index と中身は不変" \
        "exit=$EXIT out='$OUT5' before='$LS_BEFORE' after='$LS_AFTER'"
fi

# --- ケース5b: 出力は JSON 1 個 ---
# hookSpecificOutput とトップレベルに同じ additionalContext を入れる。
# Copilot CLI 1.0.103 はトップレベルだけを、Claude Code は hookSpecificOutput だけを読む。
if printf '%s' "$OUT5" | jq -e '
        .hookSpecificOutput.hookEventName == "SessionStart"
        and (.hookSpecificOutput.additionalContext | contains("--print"))
        and .additionalContext == .hookSpecificOutput.additionalContext
        and (has("systemMessage") | not)' >/dev/null 2>&1; then
    bt_pass "SessionStart の出力は JSON 1 個（hookSpecificOutput とトップレベルの additionalContext が同じ）"
else
    bt_fail "SessionStart の出力は JSON 1 個（hookSpecificOutput とトップレベルの additionalContext が同じ）" "out='$OUT5'"
fi

# --- ケース6: 追跡していないリポ → 追跡の手順が案内され、従うと案内は消える ---
PROJ6="$TMP/p6"
mkdir -p "$PROJ6/.pecotv"
_git -C "$PROJ6" init -q
_git -C "$PROJ6" config user.email t@t
_git -C "$PROJ6" config user.name t
OUT6A=$(_run_hook CLAUDE_PROJECT_DIR="$PROJ6")
EXIT=$?
if [ $EXIT -eq 0 ] \
    && printf '%s' "$OUT6A" | grep -q 'note: `.pecotv/.gitignore` is not tracked' \
    && printf '%s' "$OUT6A" | grep -q 'git add -f .pecotv/.gitignore' \
    && [ -z "$(_git -C "$PROJ6" ls-files -- .pecotv/.gitignore)" ]; then
    bt_pass "追跡していないリポ: git add -f の案内が出て index は不変"
else
    bt_fail "追跡していないリポ: git add -f の案内が出て index は不変" "exit=$EXIT out='$OUT6A'"
fi
_git -C "$PROJ6" add -f .pecotv/.gitignore
_git -C "$PROJ6" commit -q -m "track gitignore"
OUT6=$(_run_hook CLAUDE_PROJECT_DIR="$PROJ6")
EXIT=$?
STATUS6=$(_git -C "$PROJ6" status --porcelain)
if [ $EXIT -eq 0 ] && [ -z "$OUT6" ] && [ -z "$STATUS6" ]; then
    bt_pass "追跡後: 案内は出ず status clean"
else
    bt_fail "追跡後: 案内は出ず status clean" "exit=$EXIT out='$OUT6' status='$STATUS6'"
fi

# --- ケース7: 未追跡リポ + hooks-config で無効化 → 案内なしで exit 0（設定なしなら出る） ---
PROJ7="$TMP/p7"
mkdir -p "$PROJ7/.pecotv"
_git -C "$PROJ7" init -q
HOOKS_CFG7="$TMP/hooks-config-7.json"
printf '{"gitignore-track-notice": false}\n' > "$HOOKS_CFG7"
OUT7=$(_run_hook CLAUDE_PROJECT_DIR="$PROJ7" PECOTV_HOOKS_CONFIG_PATH="$HOOKS_CFG7")
EXIT=$?
OUT7_ON=$(_run_hook CLAUDE_PROJECT_DIR="$PROJ7")
if [ $EXIT -eq 0 ] && [ -z "$OUT7" ] \
    && printf '%s' "$OUT7_ON" | grep -q 'git add -f .pecotv/.gitignore'; then
    bt_pass "hooks-config 無効化: 未追跡でも追跡の案内が抑止される（設定なしなら出る、exit 0）"
else
    bt_fail "hooks-config 無効化: 未追跡でも追跡の案内が抑止される（設定なしなら出る、exit 0）" "exit=$EXIT out='$OUT7' on='$OUT7_ON'"
fi

# --- ケース8: node-runtime-notice: 古い node では JSON で利用者とエージェントの両方へ案内する ---
# node は PATH 先頭のスタブで差し替える。checkNodeRuntime の判定そのものは cli 側のテストが担う。
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
    bt_pass "node-runtime-notice: 古い node で systemMessage と additionalContext に案内が出る（exit 0）"
else
    bt_fail "node-runtime-notice: 古い node で systemMessage と additionalContext に案内が出る（exit 0）" \
        "exit=$EXIT out='$OUT8'"
fi

# 他ブロックの stdout（追跡の案内）は additionalContext に畳まれ、出力全体が JSON 1 個のまま。
PROJ8B="$TMP/p8b"
mkdir -p "$PROJ8B/.pecotv"
_git -C "$PROJ8B" init -q
OUT8B=$(_run_hook CLAUDE_PROJECT_DIR="$PROJ8B" PATH="$STUB_BLOCK:$PATH")
if printf '%s' "$OUT8B" | jq -e '.hookSpecificOutput.additionalContext | contains("git add -f .pecotv/.gitignore") and contains("Node.js 0.0.0")' >/dev/null 2>&1; then
    bt_pass "node-runtime-notice: 他ブロックの stdout と束ねても JSON 1 個を保つ"
else
    bt_fail "node-runtime-notice: 他ブロックの stdout と束ねても JSON 1 個を保つ" "束ね out='$OUT8B'"
fi

# 許可する版（スタブが何も出さない）では何も出力しない。
OUT8C=$(_run_hook CLAUDE_PROJECT_DIR="$PROJ8" PATH="$STUB_OK:$PATH")
EXIT=$?
if [ $EXIT -eq 0 ] && [ -z "$OUT8C" ]; then
    bt_pass "node-runtime-notice: 許可する版では何も出さず exit 0"
else
    bt_fail "node-runtime-notice: 許可する版では何も出さず exit 0" "許可版 exit=$EXIT out='$OUT8C'"
fi

# hooks-config で node-runtime-notice を false にすると抑止される。
HOOKS_CFG8="$TMP/hooks-config-8.json"
printf '{"node-runtime-notice": false}\n' > "$HOOKS_CFG8"
OUT8D=$(_run_hook CLAUDE_PROJECT_DIR="$PROJ8" PECOTV_HOOKS_CONFIG_PATH="$HOOKS_CFG8" PATH="$STUB_BLOCK:$PATH")
EXIT=$?
if [ $EXIT -eq 0 ] && [ -z "$OUT8D" ]; then
    bt_pass "node-runtime-notice: hooks-config 無効化で抑止される（exit 0）"
else
    bt_fail "node-runtime-notice: hooks-config 無効化で抑止される（exit 0）" "無効化 exit=$EXIT out='$OUT8D'"
fi

bt_finish
