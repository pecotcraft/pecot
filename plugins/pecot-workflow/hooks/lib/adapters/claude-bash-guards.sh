#!/bin/bash
# Bashガード統合ロジック（Claude Code / Copilot CLI 共通）。
#
# PECOT_HOOK_*（エントリの project-root.sh が hook-input.sh で export）→ 環境変数設定 →
# コア順次実行 → 結果変換。stdin の JSON は読まない。
# Copilot CLI も、PascalCase の定義では snake_case の tool_input.command を送る。
# そのため、入力形式の分岐は無い（#1229）。
# camelCase の toolName / toolArgs は届かない。
#
# 実行順序は次のとおり。
#   1. git-checkout-check.sh         → 警告のみ（exit 0）
#   2. gh-command-check.sh           → exit 1ならdeny JSON出力して終了
#   3. git-worktree-branch-check.sh  → exit 1ならdeny JSON出力して終了
#   4. git-no-verify-check.sh        → exit 1ならdeny JSON出力して終了
#   5. external-post-check.sh       → exit 11ならask JSON出力して終了
#   6. tech-advisor-clone-allow.sh   → exit 10ならallow JSON出力して終了。
#      （全deny/askガード通過後のみ実行。deny/ask > allow の不変条件を維持）。
#   7. 保持していた警告があれば出力
#
# deny は hookSpecificOutput.permissionDecision で返す。
# トップレベルの decision:block は使わない。
# Copilot CLI はトップレベルの decision を無視するため、deny が働かない。
# 常にexit 0（フックの規約）。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "claude-bash-guards" true || exit 0

# deny JSON を出力するヘルパー関数。
output_block_json() {
    jq -n --arg reason "$1" '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": $reason}}'
}

# 大きすぎるコマンドは、PECOT_HOOK_COMMAND が export されず、内容を確認できない。
# 環境変数 1 個が 128KiB を超えると、子プロセスの execve が失敗し、コアのガードが動かないまま素通しになるため。
# 素通しにせず、利用者の確認に回す（fail-closed）。
if [ "${PECOT_HOOK_COMMAND_OVERSIZE:-}" = "1" ]; then
    OVERSIZE_MSG=$(hook_message warning "the Bash command exceeds ${PECOT_HOOK_COMMAND_MAX_BYTES} bytes, so the guards cannot inspect it. Review the command before allowing it.")
    jq -n --arg reason "$OVERSIZE_MSG" '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": $reason}}'
    exit 0
fi

# Bashツールのcommand（hook-input.sh が export 済み）。
COMMAND="${PECOT_HOOK_COMMAND:-}"

# コマンドが空なら何もしない。
if [ -z "$COMMAND" ]; then
    exit 0
fi

# 必須環境変数の検証。
if [ -z "$CLAUDE_PROJECT_DIR" ]; then
    hook_message error "CLAUDE_PROJECT_DIR is not set" >&2
    exit 0
fi

# コアスクリプトのディレクトリ。
CORE_DIR="${PLUGIN_HOOKS}/lib/core"

if [ ! -d "$CORE_DIR" ]; then
    hook_message error "core script directory not found: $CORE_DIR" >&2
    exit 0
fi

# 環境変数を設定（コアスクリプトが参照する）。
export HOOK_COMMAND="$COMMAND"
export HOOK_WORKING_DIR="${CLAUDE_PROJECT_DIR}"
# Claude Code の hook 入力 `cwd` は hook 起動時点の作業ディレクトリで、Bash ツールの
# `cd` に追随する。ただし PreToolUse は当該コマンドの実行前に発火するため、コマンド
# 自身に含まれる `cd` は反映されない（そちらは core がコマンド文字列から解釈する）。
export HOOK_TOOL_CWD="${PECOT_HOOK_CWD:-}"

# --- 1. git-checkout-check（警告のみ、ブロックしない）---
CHECKOUT_WARNING=$("$CORE_DIR/git-checkout-check.sh" 2>/dev/null)

# --- 2. gh-command-check（exit 1 = ブロック）---
GH_OUTPUT=$("$CORE_DIR/gh-command-check.sh" 2>/dev/null)
GH_EXIT=$?

if [ "$GH_EXIT" -eq 1 ]; then
    output_block_json "$GH_OUTPUT"
    exit 0
fi

# --- 3. git-worktree-branch-check（exit 1 = ブロック）---
WT_OUTPUT=$("$CORE_DIR/git-worktree-branch-check.sh" 2>/dev/null)
WT_EXIT=$?
if [ "$WT_EXIT" -eq 1 ]; then
    output_block_json "$WT_OUTPUT"
    exit 0
fi

# --- 4. git-no-verify-check（exit 1 = ブロック）---
NOVERIFY_OUTPUT=$("$CORE_DIR/git-no-verify-check.sh" 2>/dev/null)
NOVERIFY_EXIT=$?

if [ "$NOVERIFY_EXIT" -eq 1 ]; then
    output_block_json "$NOVERIFY_OUTPUT"
    exit 0
fi

# --- 5. external-post-check（exit 11 = ask）---
# 11 以外の非ゼロ終了（コアスクリプトの内部エラー等）は素通しになる（fail-open）。
# ガードの誤動作で正当な操作を止め続けるより素通しを選ぶ意図的な設計。
EXTERNAL_POST_OUTPUT=$("$CORE_DIR/external-post-check.sh" 2>/dev/null)
EXTERNAL_POST_EXIT=$?

if [ "$EXTERNAL_POST_EXIT" -eq 11 ]; then
    jq -n --arg reason "$EXTERNAL_POST_OUTPUT" '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": $reason}}'
    exit 0
fi

# --- 6. tech-advisor-clone-allow（exit 10 = 自動許可）---
ALLOW_OUTPUT=$("$CORE_DIR/tech-advisor-clone-allow.sh" 2>/dev/null)
ALLOW_EXIT=$?

if [ "$ALLOW_EXIT" -eq 10 ]; then
    jq -n --arg reason "$ALLOW_OUTPUT" '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "permissionDecisionReason": $reason}}'
    exit 0
fi

# --- 7. 警告出力（ブロックなし）---
if [ -n "$CHECKOUT_WARNING" ]; then
    echo "$CHECKOUT_WARNING"
fi

exit 0
