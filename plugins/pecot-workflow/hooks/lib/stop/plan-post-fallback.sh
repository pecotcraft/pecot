#!/bin/bash
# Stop (Claude Code): コンテキストクリア後のフォールバック投稿。
#
# ExitPlanMode でコンテキストクリアを選ぶと PostToolUse が動かない。
# 旧セッションの PreToolUse(ExitPlanMode) が、.plan-post-pending に計画ファイルのパスを残している。
# 残すのは lib/pre-tool-use/plan-path-recorder.sh。
# そこで、新セッションの最初の Stop で、そのパスの計画を投稿する。
#
# 「クリアが計画の承認から来た」ことは、新セッションの transcript の先頭付近にあるユーザーメッセージで確かめる。
# メッセージは「Implement the following plan:」。
# Claude Code 2.1.310 は、クリア付きの承認を旧セッション側では ExitPlanMode の deny として扱う。
# そのため、却下とも単なる /clear とも、旧 transcript の末尾では区別できない。
# 新セッションの最初のメッセージは、承認のときだけ自動で投げられる。
# SessionStart(clear) の時点ではまだ新しい transcript が無いので、判定は Stop で行う。
# 先頭にこのメッセージが無ければ（単なる /clear・却下後の /clear・無関係なセッション）、投稿せずフラグを消す。
#
# フラグの形式: 1 行目 <session_id>:<owner/repo/number>、2 行目 <計画ファイルの絶対パス>。
# 2 行目が無いときは新セッションの transcript の slug から ~/.claude/plans/<slug>.md を解決する。
# ※フラグはmvでアトミックに取得（重複投稿防止）。
#
# 入力は、hook-input.sh が export 済みの PECOT_HOOK_SESSION_ID / PECOT_HOOK_TRANSCRIPT_PATH。
# 出力は、手動投稿の案内を systemMessage で返す（Stop は hookSpecificOutput.additionalContext を持たない）。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
source "${SCRIPT_DIR%/*}/core/plan-post-result.sh"
pecot_hook_enabled "plan-post-fallback" true || exit 0

STATE_DIR="${CLAUDE_PROJECT_DIR}/.pecot/state"
PLAN_POST_FLAG="$STATE_DIR/.plan-post-pending"

LOCK_FILE="${PLAN_POST_FLAG}.processing"
DEBUG_LOG="$CLAUDE_PROJECT_DIR/.pecot/tmp/debug/plan-post-flow.log"

# フラグが存在しなければ何もしない。
[ ! -f "$PLAN_POST_FLAG" ] && exit 0

# アトミックなロック取得: mvで排他制御（失敗=別プロセスが処理中）。
if ! mv "$PLAN_POST_FLAG" "$LOCK_FILE" 2>/dev/null; then
    exit 0
fi

# フラグからセッションID・Issue参照・計画ファイルのパスを取得。
FLAG_CONTENT=$(head -n1 "$LOCK_FILE" | tr -d '[:space:]')
PLAN_FILE=$(sed -n '2p' "$LOCK_FILE")
FLAG_SESSION_ID=$(echo "$FLAG_CONTENT" | cut -d: -f1)
ISSUE_REF=$(echo "$FLAG_CONTENT" | cut -d: -f2-)

# Issue参照がなければロック解放して終了。
if [ -z "$ISSUE_REF" ]; then
    rm -f "$LOCK_FILE"
    rm -f "$STATE_DIR/.pecot-quick-mode"
    exit 0
fi

CURRENT_SESSION_ID="${PECOT_HOOK_SESSION_ID:-}"

# 同じセッションなら元に戻して終了（PostToolUse ExitPlanModeが処理する）。
if [ "$FLAG_SESSION_ID" = "$CURRENT_SESSION_ID" ]; then
    mv "$LOCK_FILE" "$PLAN_POST_FLAG" 2>/dev/null
    exit 0
fi

# 異なるセッション: 計画の承認でクリアしたセッションかを transcript の先頭で確かめる。

# gitignore-before-write: .plan-post-pending がある時点で .pecot は存在する。
pecot_state_dir_ensure "$CLAUDE_PROJECT_DIR/.pecot/tmp/debug" || true
log_debug() {
    echo "$1" >> "$DEBUG_LOG" 2>/dev/null
}

# 投稿しないと決めたときの後始末（フラグを残さない）。
drop_flag() {
    log_debug "  DROP FLAG: $1"
    rm -f "$LOCK_FILE"
    rm -f "$STATE_DIR/.pecot-quick-mode"
    exit 0
}

log_debug "$(date '+%Y-%m-%d %H:%M:%S') Stop: fallback plan-post start"
log_debug "  FLAG_SESSION_ID: $FLAG_SESSION_ID"
log_debug "  CURRENT_SESSION_ID: $CURRENT_SESSION_ID"
log_debug "  ISSUE_REF: $ISSUE_REF"
log_debug "  PLAN_FILE: $PLAN_FILE"

TRANSCRIPT_PATH="${PECOT_HOOK_TRANSCRIPT_PATH:-}"
if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
    drop_flag "transcript not found: $TRANSCRIPT_PATH"
fi

# 先頭付近のユーザーメッセージに「Implement the following plan:」があるかを確かめる。
# content は、文字列でも [{"type":"text","text":...}] の配列でもよい。
FIRST_LINES=$(head -n 10 "$TRANSCRIPT_PATH" 2>/dev/null)
CONTINUATION=$(printf '%s\n' "$FIRST_LINES" | jq -r '
    select(type == "object" and .type == "user")
    | (.message.content // "")
    | if type == "string" then .
      elif type == "array" then map(.text? // "") | join("")
      else "" end
    | select(test("^\\s*Implement the following plan:"))
    | "yes"' 2>/dev/null | head -n 1)
if [ "$CONTINUATION" != "yes" ]; then
    drop_flag "not a plan-continuation session"
fi

if [ -z "$PLAN_FILE" ]; then
    SLUG=$(printf '%s\n' "$FIRST_LINES" | grep -m1 -oP '"slug":\s*"\K[^"]+')
    [ -n "$SLUG" ] && PLAN_FILE="$HOME/.claude/plans/${SLUG}.md"
    log_debug "  PLAN_FILE (from slug): $PLAN_FILE"
fi
if [ -z "$PLAN_FILE" ] || [ ! -s "$PLAN_FILE" ]; then
    drop_flag "plan file path missing, not found or empty"
fi

SLUG=$(basename "$PLAN_FILE" .md)
log_debug "  SLUG: $SLUG"

# Issue番号を抽出。
ISSUE_NUMBER=$(echo "$ISSUE_REF" | grep -oE '[0-9]+$')
log_debug "  ISSUE_NUMBER: $ISSUE_NUMBER"

# 計画をIssueに投稿（frontmatter の template: plan で cli/templates/comment/plan.md の検証を通す）。
pecot_plan_post_submit "$ISSUE_REF" "$PLAN_FILE" "$SLUG"
POST_EXIT_CODE=$?
POST_OUTPUT="$PECOT_PLAN_POST_OUTPUT"
log_debug "  POST_EXIT_CODE: $POST_EXIT_CODE"

if [ $POST_EXIT_CODE -eq 0 ]; then
    POST_URL=$(echo "$POST_OUTPUT" | grep -E '^https?://' | head -1)
    log_debug "  SUCCESS: ${POST_URL:-no URL}"
    rm -f "$LOCK_FILE"
    rm -f "$STATE_DIR/.pecot-quick-mode"
elif pecot_plan_post_is_validation_failure "$POST_EXIT_CODE"; then
    # 検証失敗: 同じ計画で再試行しても通らないため、フラグを戻さず手動投稿だけを案内する。
    log_debug "  VALIDATION FAILED: $POST_OUTPUT"
    pecot_plan_post_clear_on_validation_failure "$LOCK_FILE"
    MESSAGE="【plan-post-fallback】$(pecot_plan_post_manual_message "$ISSUE_REF" "$ISSUE_NUMBER" "$POST_OUTPUT")"
    jq -n --arg msg "$MESSAGE" '{"systemMessage": $msg}'
else
    log_debug "  FAILED: $POST_OUTPUT"
    # 投稿失敗: フラグを元に戻して次回リトライ。
    mv "$LOCK_FILE" "$PLAN_POST_FLAG" 2>/dev/null
    rm -f "$STATE_DIR/.pecot-quick-mode"
fi
