#!/bin/bash
# Claude Code が作る worktree（.claude/worktrees/<name>）で、worktree-config.json の setup_command を 1 回だけ流す。
# 公式の作成処理には setup の差し込み口が無いため。成功したら git の管理ディレクトリに印を置き、次からは流さない。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "worktree-setup" true || exit 0

[ "${PECOT_HOOK_SOURCE:-}" = "compact" ] && exit 0

WORKTREE="${CLAUDE_PROJECT_DIR:-}"
[ -n "$WORKTREE" ] || exit 0

WORKTREE_PARENT="${WORKTREE%/*}"
[ "${WORKTREE_PARENT##*/}" = "worktrees" ] || exit 0
WORKTREE_GRANDPARENT="${WORKTREE_PARENT%/*}"
[ "${WORKTREE_GRANDPARENT##*/}" = ".claude" ] || exit 0

GIT_DIR_PATH=$(git -C "$WORKTREE" rev-parse --path-format=absolute --git-dir 2>/dev/null) || exit 0
COMMON_DIR_PATH=$(git -C "$WORKTREE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
[ "$GIT_DIR_PATH" != "$COMMON_DIR_PATH" ] || exit 0

MARKER="$GIT_DIR_PATH/pecot-worktree-setup"
LOG="$GIT_DIR_PATH/pecot-worktree-setup.log"
[ -e "$MARKER" ] && exit 0

# worktree-config.json は main worktree のものを読む（worktree_add と同じ）。一覧の先頭が main worktree
MAIN_WORKTREE=$(git -C "$WORKTREE" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
[ -n "$MAIN_WORKTREE" ] || exit 0
CONFIG="$MAIN_WORKTREE/.pecot/config/worktree-config.json"
[ -f "$CONFIG" ] || exit 0
SETUP_COMMAND=$(jq -r '.setup_command // "" | strings' "$CONFIG" 2>/dev/null) || SETUP_COMMAND=""
[ -n "$SETUP_COMMAND" ] || exit 0
SETUP_TIMEOUT=$(jq -r '.setup_command_timeout // "" | numbers | floor | select(. > 0)' "$CONFIG" 2>/dev/null) || SETUP_TIMEOUT=""
# hooks.json の timeout（600）に達するとフックごと取り消され、warning が届かない。その手前で必ず打ち切る（変数はテスト用）
HOOK_LIMIT="${PECOT_WORKTREE_SETUP_LIMIT:-590}"
if [ -z "$SETUP_TIMEOUT" ] || [ "$SETUP_TIMEOUT" -gt "$HOOK_LIMIT" ]; then
    SETUP_TIMEOUT="$HOOK_LIMIT"
fi

RUNNER=(bash -c "$SETUP_COMMAND")
if command -v timeout >/dev/null 2>&1; then
    RUNNER=(timeout "$SETUP_TIMEOUT" "${RUNNER[@]}")
fi

(cd "$WORKTREE" && "${RUNNER[@]}") </dev/null >"$LOG" 2>&1
STATUS=$?

if [ "$STATUS" -eq 0 ]; then
    : >"$MARKER"
    hook_message note "ran the worktree setup command: $SETUP_COMMAND"
elif [ "$STATUS" -eq 124 ] && command -v timeout >/dev/null 2>&1; then
    hook_message warning "the worktree setup command timed out after ${SETUP_TIMEOUT} seconds: $SETUP_COMMAND
it runs again at the next session start
log: $LOG"
else
    hook_message warning "the worktree setup command failed (exit $STATUS): $SETUP_COMMAND
it runs again at the next session start
log: $LOG"
fi
exit 0
