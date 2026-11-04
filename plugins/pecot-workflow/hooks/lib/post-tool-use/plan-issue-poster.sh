#!/bin/bash
# ExitPlanMode後に計画をIssueに自動投稿。
#
# stdin: PostToolUseフックJSON
# .pecot-activeのIssueに計画を投稿する。
# transcript_pathからslugを抽出し、~/.claude/plans/{slug}.mdから計画を読み取る。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
source "${SCRIPT_DIR%/*}/core/pecot-state-guard.sh"
source "${SCRIPT_DIR%/*}/core/plan-post-result.sh"
pecot_hook_enabled "plan-issue-poster" true || exit 0

STATE_DIR="${CLAUDE_PROJECT_DIR}/.pecot/state"
PECOT_FLAG="$STATE_DIR/.pecot-active"
PLAN_POST_FLAG="$STATE_DIR/.plan-post-pending"

# stdinから入力を読み取り。
INPUT=$(cat)

# tool 名ガード: ExitPlanMode 以外では何もしない。
# matcher は Claude Code・Copilot CLI（1.0.103 確認）のどちらでも守られるが、
# 単体で呼ばれても毎ツールでログを増やさないための防御として残す。
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
[ "$TOOL_NAME" = "ExitPlanMode" ] || exit 0

# .pecot 書き込みガードはここ 1 箇所に集約する（gitignore-before-write #666）。
# log_debug() 内でヘルパーを呼ぶと return 1 が関数の戻り値を汚染するため、関数外で先行判定する。
pecot_state_dir_ensure "${CLAUDE_PROJECT_DIR}/.pecot/tmp/debug" || exit 0

# クイックモード判定をクリア前に捕捉してから、フラグをクリア（プランモード終了でライフサイクル完了）。
IS_QUICK=0
[ -f "$STATE_DIR/.pecot-quick-mode" ] && IS_QUICK=1
rm -f "$STATE_DIR/.pecot-quick-mode"
DEBUG_LOG="$CLAUDE_PROJECT_DIR/.pecot/tmp/debug/plan-post-flow.log"

# デバッグログ出力関数（ディレクトリは上の pecot_state_dir_ensure で作成済み）。
log_debug() {
    echo "$1" >> "$DEBUG_LOG"
}

log_debug "$(date '+%Y-%m-%d %H:%M:%S') ExitPlanMode PostToolUse: start"

# transcript_pathからslugを抽出。
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
    log_debug "  SKIP: transcript_path not found or file missing: $TRANSCRIPT_PATH"
    exit 0
fi

SLUG=$(grep -m1 -oP '"slug":\s*"\K[^"]+' "$TRANSCRIPT_PATH" 2>/dev/null)

if [ -z "$SLUG" ]; then
    log_debug "  SKIP: slug not found in transcript"
    exit 0
fi

log_debug "  SLUG: $SLUG"

# プランファイルから計画を読み取り。
PLAN_FILE="$HOME/.claude/plans/${SLUG}.md"

if [ ! -f "$PLAN_FILE" ]; then
    log_debug "  SKIP: plan file not found: $PLAN_FILE"
    exit 0
fi

PLAN=$(cat "$PLAN_FILE")

if [ -z "$PLAN" ]; then
    log_debug "  SKIP: plan file is empty"
    exit 0
fi

log_debug "  PLAN_CONTENT_LENGTH: ${#PLAN}"

# 作業対象のIssue参照を取得。
ISSUE_REF=""
if [ -f "$PECOT_FLAG" ]; then
    ISSUE_REF=$(cat "$PECOT_FLAG" | tr -d '[:space:]')
fi
if [ -z "$ISSUE_REF" ]; then
    log_debug "  SKIP: ISSUE_REF is empty"
    exit 0
fi

# Issue番号を抽出（owner/repo/123 形式から）。
ISSUE_NUMBER=$(echo "$ISSUE_REF" | grep -oE '[0-9]+$')
log_debug "  ISSUE_REF: $ISSUE_REF (#$ISSUE_NUMBER)"

# 計画をIssueに投稿（frontmatter の template: plan で cli/templates/comment/plan.md の検証を通す）。
pecot_plan_post_submit "$ISSUE_REF" "$PLAN_FILE" "$SLUG"
POST_EXIT_CODE=$?
POST_OUTPUT="$PECOT_PLAN_POST_OUTPUT"

log_debug "  POST_EXIT_CODE: $POST_EXIT_CODE"

if [ $POST_EXIT_CODE -eq 0 ]; then
    # 投稿成功: plan-post-pendingフラグを消費（削除）。
    rm -f "$PLAN_POST_FLAG"

    # 投稿成功時のURLを抽出。
    POST_URL=$(echo "$POST_OUTPUT" | grep -E '^https?://' | head -1)
    if [ -n "$POST_URL" ]; then
        MESSAGE="計画をIssue #${ISSUE_NUMBER} に投稿しました: ${POST_URL}"
        log_debug "  SUCCESS: $POST_URL"
    else
        MESSAGE="計画をIssue #${ISSUE_NUMBER} に投稿しました"
        log_debug "  SUCCESS (no URL in output)"
    fi

elif pecot_plan_post_is_validation_failure "$POST_EXIT_CODE"; then
    # 検証失敗: 同じ計画で再試行しても通らないため、フラグを消して手動投稿だけを案内する。
    pecot_plan_post_clear_on_validation_failure "$PLAN_POST_FLAG"
    MESSAGE="【plan-issue-poster】$(pecot_plan_post_manual_message "$ISSUE_REF" "$ISSUE_NUMBER" "$POST_OUTPUT")"
    log_debug "  VALIDATION FAILED: $POST_OUTPUT"

else
    MESSAGE="【plan-issue-poster】計画のIssue #${ISSUE_NUMBER} への投稿に失敗しました: ${POST_OUTPUT}

理由: ExitPlanMode後に計画内容をIssueコメントとして自動投稿する処理が失敗しました。
Issue番号の不正、API認証エラー、ネットワーク問題等が考えられます。

対処方法:
  手動で計画を投稿してください。
  1. 次のコマンドで生成したファイルへ、計画を書く。
     \"${CLAUDE_PLUGIN_ROOT}/bin/pecot\" issue comment --prepare -t plan -i <owner/repo/${ISSUE_NUMBER}>

  2. 次のコマンドで投稿する。
     \"${CLAUDE_PLUGIN_ROOT}/bin/pecot\" issue comment <生成したファイル>"
    log_debug "  FAILED: $POST_OUTPUT"
fi

# クイックモードは main 直接実装で並列サブエージェントを使わないため、実装リマインダーは追加しない。
if [ "$IS_QUICK" -eq 0 ]; then
    # Agent 単発 spawn 前提の実装リマインダーを追加。
    # コミット責務の要点もこの 1 ファイルに統合済み。
    IMPLEMENTER_REMIND="${PLUGIN_HOOKS}/templates/exit-plan-implementer-remind.md"
    if [ -f "$IMPLEMENTER_REMIND" ]; then
        MESSAGE="${MESSAGE}

$(cat "$IMPLEMENTER_REMIND")"
    fi
fi

# additionalContextで結果を通知。
jq -n --arg msg "$MESSAGE" '{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": $msg
  }
}'
