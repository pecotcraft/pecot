#!/bin/bash
# pecotv-dir-init 起動の検知レイヤテスト。
# user-prompt-submit.sh と pre-tool-use-skill.sh が、`/pecot-v:` / `pecot-v:*` を正しく検知することを確認する。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
# shellcheck source=../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
HOOKS_DIR="$SCRIPT_DIR/.."
UPS_SCRIPT="$HOOKS_DIR/user-prompt-submit.sh"
PTUS_SCRIPT="$HOOKS_DIR/pre-tool-use-skill.sh"
PLUGIN_ROOT="$(cd "$HOOKS_DIR/.." && pwd)"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 親リポの GIT_DIR などが漏れると、一時リポの操作が親リポへ向き、フックの git ls-files も誤判定する。
# そのため git の操作もフックの起動も GIT_* を外して行う（pecotv-dir-init.test.sh の _git と同じ）。
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
    bt_pass "user-prompt-submit: /pecot-v: プロンプトで init が呼ばれる"
else
    bt_fail "user-prompt-submit: /pecot-v: プロンプトで init が呼ばれる" "検知できず .pecotv/ 未作成"
fi

# ケース2: 通常プロンプトでは init が呼ばれない
PROJ="$TMP/p2"
mkdir -p "$PROJ"
echo '{"prompt": "今日の天気は"}' | \
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$UPS_SCRIPT" >/dev/null 2>&1
if [ ! -d "$PROJ/.pecotv" ]; then
    bt_pass "user-prompt-submit: 通常プロンプトでは init が呼ばれない"
else
    bt_fail "user-prompt-submit: 通常プロンプトでは init が呼ばれない" "誤検知して .pecotv/ 作成"
fi

# ケース3: コードブロック内の /pecot-v: は誤反応しない（^/pecot-v: 行頭限定）
PROJ="$TMP/p3"
mkdir -p "$PROJ"
echo '{"prompt": "説明: `/pecot-v:v-drawio`"}' | \
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$UPS_SCRIPT" >/dev/null 2>&1
if [ ! -d "$PROJ/.pecotv" ]; then
    bt_pass "user-prompt-submit: 行頭でない /pecot-v: は誤反応しない"
else
    bt_fail "user-prompt-submit: 行頭でない /pecot-v: は誤反応しない" "誤検知して .pecotv/ 作成"
fi

# ケース4: /pecot-w: は pecotv 側 hook ではスルー
PROJ="$TMP/p4"
mkdir -p "$PROJ"
echo '{"prompt": "/pecot-w:w-help"}' | \
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$UPS_SCRIPT" >/dev/null 2>&1
if [ ! -d "$PROJ/.pecotv" ]; then
    bt_pass "user-prompt-submit: /pecot-w: は pecotv 側ではスルー"
else
    bt_fail "user-prompt-submit: /pecot-w: は pecotv 側ではスルー" "誤検知して .pecotv/ 作成"
fi

# --- PreToolUse(Skill) ---

# ケース5: pecot-v: スキルで .pecotv/ が作られる
PROJ="$TMP/p5"
mkdir -p "$PROJ"
echo '{"tool_input": {"skill": "pecot-v:v-drawio"}}' | \
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PTUS_SCRIPT" >/dev/null 2>&1
if [ -d "$PROJ/.pecotv/work" ]; then
    bt_pass "pre-tool-use-skill: pecot-v: スキルで init が呼ばれる"
else
    bt_fail "pre-tool-use-skill: pecot-v: スキルで init が呼ばれる" "検知できず .pecotv/ 未作成"
fi

# ケース6: 非 pecotv スキル (pecot-w:) では init が呼ばれない
PROJ="$TMP/p6"
mkdir -p "$PROJ"
echo '{"tool_input": {"skill": "pecot-w:w-help"}}' | \
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PTUS_SCRIPT" >/dev/null 2>&1
if [ ! -d "$PROJ/.pecotv" ]; then
    bt_pass "pre-tool-use-skill: pecot-w: スキルは pecotv 側ではスルー"
else
    bt_fail "pre-tool-use-skill: pecot-w: スキルは pecotv 側ではスルー" "誤検知して .pecotv/ 作成"
fi

# ケース7: 非 pecotv スキルでは stdout が空
OUT=$(echo '{"tool_input": {"skill": "claude-code-guide"}}' | \
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$TMP/p7" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PTUS_SCRIPT" 2>/dev/null)
bt_eq "pre-tool-use-skill: 非 pecotv スキルで stdout 空" "" "$OUT"

# ケース8: pecot-v: ヒット時も stdout は空（init 起動が副作用のみであることを担保）
PROJ="$TMP/p8"
mkdir -p "$PROJ"
OUT=$(echo '{"tool_input": {"skill": "pecot-v:v-drawio"}}' | \
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PTUS_SCRIPT" 2>/dev/null)
if [ -z "$OUT" ] && [ -d "$PROJ/.pecotv/work" ]; then
    bt_pass "pre-tool-use-skill: pecot-v: ヒット時も stdout は空（init は副作用のみ）"
else
    PECOTV_DIR_EXISTS=no
    [ -d "$PROJ/.pecotv/work" ] && PECOTV_DIR_EXISTS=yes
    bt_fail "pre-tool-use-skill: pecot-v: ヒット時も stdout は空（init は副作用のみ）" \
        "stdout='$OUT' / .pecotv dir=$PECOTV_DIR_EXISTS"
fi

# ケース8b: Copilot CLI は名前空間なしのスキル名（v-drawio）で届く。自プラグインの skills/ に実在する
# 名前なら pecotv 側のスキルとして init が呼ばれる（T050 追加の観測: 同名が複数あるときだけ接頭辞付き）
PROJ="$TMP/p8b"
mkdir -p "$PROJ"
OUT=$(echo '{"tool_name": "skill", "tool_input": {"skill": "v-drawio"}}' | \
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PTUS_SCRIPT" 2>/dev/null)
if [ -z "$OUT" ] && [ -d "$PROJ/.pecotv/work" ]; then
    bt_pass "pre-tool-use-skill: 名前空間なしの自プラグインのスキル（Copilot）で init が呼ばれる"
else
    bt_fail "pre-tool-use-skill: 名前空間なしの自プラグインのスキル（Copilot）で init が呼ばれる" \
        "init 未起動 (stdout='$OUT')"
fi

# ケース8c: 名前空間なしでも自プラグインに実在しない名前（pecot-workflow の w-help・遡上・空）は init を呼ばない
for SKILL in "w-help" "v-no-such-skill" "../hooks" ""; do
    PROJ="$TMP/p8c"
    rm -rf "$PROJ"
    mkdir -p "$PROJ"
    printf '{"tool_name": "skill", "tool_input": {"skill": "%s"}}' "$SKILL" | \
        "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$PTUS_SCRIPT" >/dev/null 2>&1
    if [ ! -d "$PROJ/.pecotv" ]; then
        bt_pass "pre-tool-use-skill: 自プラグインのスキルでない名前 '$SKILL' はスルー"
    else
        bt_fail "pre-tool-use-skill: 自プラグインのスキルでない名前 '$SKILL' はスルー" "誤検知して .pecotv/ 作成"
    fi
done

# ケース9: SessionStart は存在し session-start.sh（既存リポの .pecotv/.gitignore の追跡を案内するのみ）を指す（#676）。
# 「.pecotv の新規作成をしない」という #662 の本質は session-start.test.sh のケース1 で保護する。
HOOKS_JSON="$PLUGIN_ROOT/hooks/hooks.json"
if jq -e '[.hooks.SessionStart[].hooks[].command] | any(test("session-start\\.sh$"))' "$HOOKS_JSON" >/dev/null 2>&1; then
    bt_pass "hooks.json: SessionStart が session-start.sh を指す（既存リポの追跡案内 #676）"
else
    bt_fail "hooks.json: SessionStart が session-start.sh を指す（既存リポの追跡案内 #676）" \
        "未配線（既存リポの .pecotv/.gitignore の追跡案内が働かない）"
fi

# ケース9b: Copilot の hooks の command 配列が hooks.json と一致する（#662/#676）。
HOOKS_COPILOT_JSON="$PLUGIN_ROOT/com.github.copilot/hooks/hooks.json"
SS_COMMANDS_ORIG=$(jq -c '[.hooks.SessionStart[].hooks[].command] | sort' "$HOOKS_JSON")
SS_COMMANDS_COPILOT=$(jq -c '[.hooks.SessionStart[].hooks[].command] | sort' "$HOOKS_COPILOT_JSON")
bt_eq "com.github.copilot/hooks/hooks.json: SessionStart の command 配列が hooks.json と一致する" \
    "$SS_COMMANDS_ORIG" "$SS_COMMANDS_COPILOT"

UPS_COMMANDS_ORIG=$(jq -c '[.hooks.UserPromptSubmit[].hooks[].command] | sort' "$HOOKS_JSON")
UPS_COMMANDS_COPILOT=$(jq -c '[.hooks.UserPromptSubmit[].hooks[].command] | sort' "$HOOKS_COPILOT_JSON")
bt_eq "com.github.copilot/hooks/hooks.json: UserPromptSubmit の command 配列が hooks.json と一致する" \
    "$UPS_COMMANDS_ORIG" "$UPS_COMMANDS_COPILOT"

# Copilot のツール名は小文字の skill で Claude 名に写されないため、matcher は Skill|skill（全体一致）
PTUS_COMMANDS_ORIG=$(jq -c '[.hooks.PreToolUse[] | select(.matcher == "Skill") | .hooks[].command] | sort' "$HOOKS_JSON")
PTUS_COMMANDS_COPILOT=$(jq -c '[.hooks.PreToolUse[] | select(.matcher == "Skill|skill") | .hooks[].command] | sort' "$HOOKS_COPILOT_JSON")
bt_eq "com.github.copilot/hooks/hooks.json: PreToolUse(Skill) の command 配列が hooks.json と一致する" \
    "$PTUS_COMMANDS_ORIG" "$PTUS_COMMANDS_COPILOT"

# ケース10: 利用者プロジェクトの実 git で .pecotv/tmp/ 配下が ignore される（CUJ）
PROJ="$TMP/p10-gitrepo"
mkdir -p "$PROJ"
( cd "$PROJ" && _git init -q && _git config user.email t@t && _git config user.name t )
"${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$PROJ" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "$PLUGIN_ROOT/hooks/lib/core/pecotv-dir-init.sh"
mkdir -p "$PROJ/.pecotv/work/drawio"
touch "$PROJ/.pecotv/work/drawio/dummy.drawio"
UNTRACKED=$(cd "$PROJ" && _git status --porcelain -- .pecotv/work/drawio/dummy.drawio)
bt_eq "実 git: .pecotv/work/drawio/dummy.drawio が ignore されコミット候補に出ない" "" "$UNTRACKED"

bt_finish
