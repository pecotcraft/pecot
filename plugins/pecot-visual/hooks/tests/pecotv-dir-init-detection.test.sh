#!/bin/bash
# pecotv-dir-init 起動の検知レイヤテスト。
# user-prompt-submit.sh と pre-tool-use-skill.sh が、`/pecot-v:` / `pecot-v:*` を正しく検知することを確認する。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$SCRIPT_DIR/.."
UPS_SCRIPT="$HOOKS_DIR/user-prompt-submit.sh"
PTUS_SCRIPT="$HOOKS_DIR/pre-tool-use-skill.sh"
PLUGIN_ROOT="$(cd "$HOOKS_DIR/.." && pwd)"

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
# リークとは、pre-push フックや GIT_DIR export 下で、一時リポへ向けたつもりの操作が親リポへ向くことを指す。
# config 書き込み等で、実リポを汚染する。
# 隔離のやり方は、pecotv-dir-init.test.sh の _git と同じ。
# フックの起動も同じ隔離を通す。フックは内部で git ls-files を打ち、親リポの GIT_DIR が漏れると
# このリポが追跡する .pecotv/.gitignore を、一時ディレクトリも追跡中と誤判定するためだ。
_GIT_ISOLATE=(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
    -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES)
_git() {
    "${_GIT_ISOLATE[@]}" git "$@"
}

# --- UserPromptSubmit ---

# ケース1: /pecot-v: で .pecotv/ が作られる
PROJ="$TMP/p1"
mkdir -p "$PROJ"
echo '{"prompt": "/pecot-v:v-drawio"}' | \
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$UPS_SCRIPT" >/dev/null 2>&1
if [ -d "$PROJ/.pecotv/work" ]; then
    pass "user-prompt-submit: /pecot-v: プロンプトで init が呼ばれる"
else
    fail "user-prompt-submit: /pecot-v: 検知できず .pecotv/ 未作成"
fi

# ケース2: 通常プロンプトでは init が呼ばれない
PROJ="$TMP/p2"
mkdir -p "$PROJ"
echo '{"prompt": "今日の天気は"}' | \
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$UPS_SCRIPT" >/dev/null 2>&1
if [ ! -d "$PROJ/.pecotv" ]; then
    pass "user-prompt-submit: 通常プロンプトでは init が呼ばれない"
else
    fail "user-prompt-submit: 通常プロンプトで誤検知 .pecotv/ 作成"
fi

# ケース3: コードブロック内の /pecot-v: は誤反応しない（^/pecot-v: 行頭限定）
PROJ="$TMP/p3"
mkdir -p "$PROJ"
echo '{"prompt": "説明: `/pecot-v:v-drawio`"}' | \
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$UPS_SCRIPT" >/dev/null 2>&1
if [ ! -d "$PROJ/.pecotv" ]; then
    pass "user-prompt-submit: 行頭でない /pecot-v: は誤反応しない"
else
    fail "user-prompt-submit: 行頭でない /pecot-v: で誤検知 .pecotv/ 作成"
fi

# ケース4: /pecot-w: は pecotv 側 hook ではスルー
PROJ="$TMP/p4"
mkdir -p "$PROJ"
echo '{"prompt": "/pecot-w:w-help"}' | \
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$UPS_SCRIPT" >/dev/null 2>&1
if [ ! -d "$PROJ/.pecotv" ]; then
    pass "user-prompt-submit: /pecot-w: は pecotv 側ではスルー"
else
    fail "user-prompt-submit: /pecot-w: を誤検知して .pecotv/ 作成"
fi

# --- PreToolUse(Skill) ---

# ケース5: pecot-v: スキルで .pecotv/ が作られる
PROJ="$TMP/p5"
mkdir -p "$PROJ"
echo '{"tool_input": {"skill": "pecot-v:v-drawio"}}' | \
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PTUS_SCRIPT" >/dev/null 2>&1
if [ -d "$PROJ/.pecotv/work" ]; then
    pass "pre-tool-use-skill: pecot-v: スキルで init が呼ばれる"
else
    fail "pre-tool-use-skill: pecot-v: 検知できず .pecotv/ 未作成"
fi

# ケース6: 非 pecotv スキル (pecot-w:) では init が呼ばれない
PROJ="$TMP/p6"
mkdir -p "$PROJ"
echo '{"tool_input": {"skill": "pecot-w:w-help"}}' | \
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PTUS_SCRIPT" >/dev/null 2>&1
if [ ! -d "$PROJ/.pecotv" ]; then
    pass "pre-tool-use-skill: pecot-w: スキルは pecotv 側ではスルー"
else
    fail "pre-tool-use-skill: pecot-w: を誤検知して .pecotv/ 作成"
fi

# ケース7: 非 pecotv スキルでは stdout が空
OUT=$(echo '{"tool_input": {"skill": "claude-code-guide"}}' | \
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$TMP/p7" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PTUS_SCRIPT" 2>/dev/null)
if [ -z "$OUT" ]; then
    pass "pre-tool-use-skill: 非 pecotv スキルで stdout 空"
else
    fail "pre-tool-use-skill: 非 pecotv スキルで stdout='$OUT'"
fi

# ケース8: pecot-v: ヒット時も stdout は空（init 起動が副作用のみであることを担保）
PROJ="$TMP/p8"
mkdir -p "$PROJ"
OUT=$(echo '{"tool_input": {"skill": "pecot-v:v-drawio"}}' | \
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PTUS_SCRIPT" 2>/dev/null)
if [ -z "$OUT" ] && [ -d "$PROJ/.pecotv/work" ]; then
    pass "pre-tool-use-skill: pecot-v: ヒット時も stdout は空（init は副作用のみ）"
else
    PECOTV_DIR_EXISTS=no
    [ -d "$PROJ/.pecotv/work" ] && PECOTV_DIR_EXISTS=yes
    fail "pre-tool-use-skill: pecot-v: ヒット時 stdout='$OUT' / .pecotv dir=$PECOTV_DIR_EXISTS"
fi

# ケース8b: Copilot CLI は名前空間なしのスキル名（v-drawio）で届く。自プラグインの skills/ に実在する
# 名前なら pecotv 側のスキルとして init が呼ばれる（T050 追加の観測: 同名が複数あるときだけ接頭辞付き）
PROJ="$TMP/p8b"
mkdir -p "$PROJ"
OUT=$(echo '{"tool_name": "skill", "tool_input": {"skill": "v-drawio"}}' | \
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PTUS_SCRIPT" 2>/dev/null)
if [ -z "$OUT" ] && [ -d "$PROJ/.pecotv/work" ]; then
    pass "pre-tool-use-skill: 名前空間なしの自プラグインのスキル（Copilot）で init が呼ばれる"
else
    fail "pre-tool-use-skill: 名前空間なしの自プラグインのスキルで init 未起動 (stdout='$OUT')"
fi

# ケース8c: 名前空間なしでも自プラグインに実在しない名前（pecot-workflow の w-help・遡上・空）は init を呼ばない
for SKILL in "w-help" "v-no-such-skill" "../hooks" ""; do
    PROJ="$TMP/p8c"
    rm -rf "$PROJ"
    mkdir -p "$PROJ"
    printf '{"tool_name": "skill", "tool_input": {"skill": "%s"}}' "$SKILL" | \
        "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PTUS_SCRIPT" >/dev/null 2>&1
    if [ ! -d "$PROJ/.pecotv" ]; then
        pass "pre-tool-use-skill: 自プラグインのスキルでない名前 '$SKILL' はスルー"
    else
        fail "pre-tool-use-skill: 自プラグインのスキルでない名前 '$SKILL' を誤検知して .pecotv/ 作成"
    fi
done

# ケース9: SessionStart は存在し session-start.sh（既存リポの .pecotv/.gitignore の追跡を案内するのみ）を指す（#676）。
# 「.pecotv の新規作成をしない」という #662 の本質は session-start.test.sh のケース1 で保護する。
HOOKS_JSON="$PLUGIN_ROOT/hooks/hooks.json"
if jq -e '[.hooks.SessionStart[].hooks[].command] | any(test("session-start\\.sh$"))' "$HOOKS_JSON" >/dev/null 2>&1; then
    pass "hooks.json: SessionStart が session-start.sh を指す（既存リポの追跡案内 #676）"
else
    fail "hooks.json: SessionStart が未配線（既存リポの .pecotv/.gitignore の追跡案内が働かない）"
fi

# ケース9b: Copilot の hooks も、hooks.json と同じ hook 構成を持つ（Copilot CLI パリティ #662/#676）。
# Copilot の hooks は、Agent Plugins 1.0 形式の com.github.copilot/hooks/hooks.json を使う。
# SessionStart / UserPromptSubmit / PreToolUse:Skill の command 配列が、hooks.json と一致することを等価比較する。
HOOKS_COPILOT_JSON="$PLUGIN_ROOT/com.github.copilot/hooks/hooks.json"
SS_COMMANDS_ORIG=$(jq -c '[.hooks.SessionStart[].hooks[].command] | sort' "$HOOKS_JSON")
SS_COMMANDS_COPILOT=$(jq -c '[.hooks.SessionStart[].hooks[].command] | sort' "$HOOKS_COPILOT_JSON")
if [ "$SS_COMMANDS_ORIG" = "$SS_COMMANDS_COPILOT" ]; then
    pass "com.github.copilot/hooks/hooks.json: SessionStart の command 配列が hooks.json と一致する"
else
    fail "copilot hooks.json: SessionStart の command 配列が不一致"
    echo "  copilot=$SS_COMMANDS_COPILOT orig=$SS_COMMANDS_ORIG"
fi

# UserPromptSubmit の command 配列が hooks.json と一致するか等価比較する
UPS_COMMANDS_ORIG=$(jq -c '[.hooks.UserPromptSubmit[].hooks[].command] | sort' "$HOOKS_JSON")
UPS_COMMANDS_COPILOT=$(jq -c '[.hooks.UserPromptSubmit[].hooks[].command] | sort' "$HOOKS_COPILOT_JSON")
if [ "$UPS_COMMANDS_ORIG" = "$UPS_COMMANDS_COPILOT" ]; then
    pass "com.github.copilot/hooks/hooks.json: UserPromptSubmit の command 配列が hooks.json と一致する"
else
    fail "copilot hooks.json: UserPromptSubmit の command 配列が不一致"
    echo "  copilot=$UPS_COMMANDS_COPILOT orig=$UPS_COMMANDS_ORIG"
fi

# PreToolUse(Skill) の command 配列が hooks.json と一致するか等価比較する。
# Copilot のツール名は小文字の skill で Claude 名に写されないため、matcher は Skill|skill（全体一致）
PTUS_COMMANDS_ORIG=$(jq -c '[.hooks.PreToolUse[] | select(.matcher == "Skill") | .hooks[].command] | sort' "$HOOKS_JSON")
PTUS_COMMANDS_COPILOT=$(jq -c '[.hooks.PreToolUse[] | select(.matcher == "Skill|skill") | .hooks[].command] | sort' "$HOOKS_COPILOT_JSON")
if [ "$PTUS_COMMANDS_ORIG" = "$PTUS_COMMANDS_COPILOT" ]; then
    pass "com.github.copilot/hooks/hooks.json: PreToolUse(Skill) の command 配列が hooks.json と一致する"
else
    fail "copilot hooks.json: PreToolUse Skill の command 配列が不一致"
    echo "  copilot=$PTUS_COMMANDS_COPILOT orig=$PTUS_COMMANDS_ORIG"
fi

# ケース10: 利用者プロジェクトの実 git で .pecotv/tmp/ 配下が ignore される（CUJ）
PROJ="$TMP/p10-gitrepo"
mkdir -p "$PROJ"
( cd "$PROJ" && _git init -q && _git config user.email t@t && _git config user.name t )
"${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "$PLUGIN_ROOT/hooks/lib/core/pecotv-dir-init.sh"
mkdir -p "$PROJ/.pecotv/work/drawio"
touch "$PROJ/.pecotv/work/drawio/dummy.drawio"
UNTRACKED=$(cd "$PROJ" && _git status --porcelain -- .pecotv/work/drawio/dummy.drawio)
if [ -z "$UNTRACKED" ]; then
    pass "実 git: .pecotv/work/drawio/dummy.drawio が ignore されコミット候補に出ない"
else
    fail "実 git: .pecotv/work/drawio/dummy.drawio が untracked として残る (status='$UNTRACKED')"
fi

echo
echo "==================================="
echo "Passed: $PASS / Failed: $FAIL"
echo "==================================="
[ $FAIL -eq 0 ]
