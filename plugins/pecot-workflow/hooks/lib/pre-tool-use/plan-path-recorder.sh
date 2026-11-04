#!/bin/bash
# PreToolUse (ExitPlanMode): 計画ファイルのパスを .plan-post-pending に記録する。
#
# ExitPlanMode でコンテキストクリアを選ぶと PostToolUse が動かない。クリア後の新セッションの
# Stop で plan-post-fallback が投稿できるよう、旧セッションの側（まだ transcript と計画が
# 分かるこの時点）で計画ファイルのパスを残す。投稿するかどうかは新セッションの transcript の
# 先頭（Implement the following plan:）で plan-post-fallback が決めるので、ここは記録だけ行う。
#
# first-block が deny する呼び出しでは記録しない（まだ承認ダイアログに届いていない計画のため）。
# first-block は pre-tool-use-exit-plan-mode.sh で本スクリプトより後に動き、deny するときに
# .exit-plan-confirmed を作る。そのため、この時点で first-block が通す条件
# （無効化済み・クイックモード・.exit-plan-confirmed あり）のどれかを満たすときだけ記録する。
#
# フラグの形式は次のとおり。1 行目は EnterPlanMode の plan-flag-setter が書く。
#   1 行目: <session_id>:<owner/repo/number>。
#   2 行目: <計画ファイルの絶対パス>（ここで追記する）。
# フラグが無い（active な Issue が無い）ときは何もしない。
#
# 計画ファイルのパスは tool_input.planFilePath（PECOT_HOOK_PLAN_PATH）。無いときは
# plan-issue-poster と同じく transcript の slug から ~/.claude/plans/<slug>.md を解決する。
# 何度呼ばれても最後の計画のパスで上書きする。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "plan-flag-setter" true || exit 0

STATE_DIR="${CLAUDE_PROJECT_DIR}/.pecot/state"
PLAN_POST_FLAG="$STATE_DIR/.plan-post-pending"
[ -f "$PLAN_POST_FLAG" ] || exit 0

# first-block が deny する呼び出し（有効・クイックモードでない・.exit-plan-confirmed なし）では記録しない。
if pecot_hook_enabled "exit-plan-mode-first-block" true \
    && [ ! -f "$STATE_DIR/.pecot-quick-mode" ] \
    && [ ! -f "$STATE_DIR/.exit-plan-confirmed" ]; then
    exit 0
fi

PLAN_FILE="${PECOT_HOOK_PLAN_PATH:-}"
if [ -z "$PLAN_FILE" ] && [ -f "${PECOT_HOOK_TRANSCRIPT_PATH:-}" ]; then
    SLUG=$(grep -m1 -oP '"slug":\s*"\K[^"]+' "$PECOT_HOOK_TRANSCRIPT_PATH" 2>/dev/null)
    [ -n "$SLUG" ] && PLAN_FILE="$HOME/.claude/plans/${SLUG}.md"
fi
[ -n "$PLAN_FILE" ] || exit 0

HEAD_LINE=$(head -n1 "$PLAN_POST_FLAG")
[ -n "$HEAD_LINE" ] || exit 0

# 同一ディレクトリの一時ファイルへ書いて mv（fallback の mv によるロック取得と競合しても欠けた内容を見せない）。
TMP_FLAG="${PLAN_POST_FLAG}.tmp.$$"
printf '%s\n%s\n' "$HEAD_LINE" "$PLAN_FILE" > "$TMP_FLAG" && mv -f "$TMP_FLAG" "$PLAN_POST_FLAG"
exit 0
