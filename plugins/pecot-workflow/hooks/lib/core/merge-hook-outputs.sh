#!/bin/bash
# 複数サブスクリプトのフック出力を 1 つの JSON にまとめる。stderr は隠さない。
# Usage: echo "$INPUT" | merge-hook-outputs.sh /path/to/script1.sh [/path/to/script2.sh ...]

INPUT=$(cat)

# マージ結果の初期値。
MERGED_ADDITIONAL_CONTEXT=""
MERGED_DECISION=""        # allow/deny
MERGED_REASON=""
# Claude Code は additionalContext に hookEventName を求める。初期値は入力の hook_event_name
MERGED_HOOK_EVENT_NAME="${PECOT_HOOK_EVENT:-}"
# SessionStart / UserPromptSubmit のセッション名（Claude Code）
MERGED_SESSION_TITLE=""

# decision 優先順位: deny(2) > allow(1)。
decision_priority() {
    case "$1" in
        deny) echo 2 ;;
        allow) echo 1 ;;
        *) echo 0 ;;
    esac
}

for script in "$@"; do
    # stderr を隠蔽しない。非ゼロ終了でも出力があればマージに含める。
    RESULT=$(echo "$INPUT" | "$script") || true
    [ -z "$RESULT" ] && continue

    # JSON 判定。
    if echo "$RESULT" | jq empty 2>/dev/null; then
        # additionalContext 連結。
        AC=$(echo "$RESULT" | jq -r '.hookSpecificOutput.additionalContext // empty')
        if [ -n "$AC" ]; then
            if [ -n "$MERGED_ADDITIONAL_CONTEXT" ]; then
                MERGED_ADDITIONAL_CONTEXT="${MERGED_ADDITIONAL_CONTEXT}
${AC}"
            else
                MERGED_ADDITIONAL_CONTEXT="$AC"
            fi
        fi

        # hookEventName: 最初の非空値を採用。
        if [ -z "$MERGED_HOOK_EVENT_NAME" ]; then
            HEN=$(echo "$RESULT" | jq -r '.hookSpecificOutput.hookEventName // empty')
            [ -n "$HEN" ] && MERGED_HOOK_EVENT_NAME="$HEN"
        fi

        # permissionDecision: 最も厳しいものを採用。
        DEC=$(echo "$RESULT" | jq -r '.hookSpecificOutput.permissionDecision // empty')
        if [ -n "$DEC" ]; then
            NEW_PRI=$(decision_priority "$DEC")
            CUR_PRI=$(decision_priority "$MERGED_DECISION")
            if [ "$NEW_PRI" -gt "$CUR_PRI" ]; then
                MERGED_DECISION="$DEC"
                RSN=$(echo "$RESULT" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty')
                MERGED_REASON="$RSN"
            fi
        fi

        # sessionTitle: 最後のものを採用。
        ST=$(echo "$RESULT" | jq -r '.hookSpecificOutput.sessionTitle // empty')
        [ -n "$ST" ] && MERGED_SESSION_TITLE="$ST"
    else
        # JSON 以外 → 素テキストとして additionalContext に追加。
        if [ -n "$MERGED_ADDITIONAL_CONTEXT" ]; then
            MERGED_ADDITIONAL_CONTEXT="${MERGED_ADDITIONAL_CONTEXT}
${RESULT}"
        else
            MERGED_ADDITIONAL_CONTEXT="$RESULT"
        fi
    fi
done

# マージ結果がなければ何も出力しない。
if [ -z "$MERGED_ADDITIONAL_CONTEXT" ] && [ -z "$MERGED_DECISION" ] \
   && [ -z "$MERGED_SESSION_TITLE" ]; then
    exit 0
fi

# hookSpecificOutput を構築する。
# hookEventName 以外の実フィールドを先に積む。
# 対象は、additionalContext / permissionDecision / reason / sessionTitle。
HSO=$(jq -n '{}')
[ -n "$MERGED_ADDITIONAL_CONTEXT" ] && \
    HSO=$(echo "$HSO" | jq --arg v "$MERGED_ADDITIONAL_CONTEXT" '.additionalContext = $v')
[ -n "$MERGED_DECISION" ] && \
    HSO=$(echo "$HSO" | jq --arg v "$MERGED_DECISION" '.permissionDecision = $v')
[ -n "$MERGED_REASON" ] && \
    HSO=$(echo "$HSO" | jq --arg v "$MERGED_REASON" '.permissionDecisionReason = $v')
[ -n "$MERGED_SESSION_TITLE" ] && \
    HSO=$(echo "$HSO" | jq --arg v "$MERGED_SESSION_TITLE" '.sessionTitle = $v')
# hookEventName は、ほかのフィールドがあるときだけ付ける（hookEventName だけの HSO を作らない）。
if [ -n "$MERGED_HOOK_EVENT_NAME" ] && [ "$(echo "$HSO" | jq 'length')" -gt 0 ]; then
    HSO=$(echo "$HSO" | jq --arg v "$MERGED_HOOK_EVENT_NAME" '.hookEventName = $v')
fi

# 最終 JSON 構築（値があるフィールドのみ）。
FINAL=$(jq -n '{}')
if [ "$(echo "$HSO" | jq 'length')" -gt 0 ]; then
    FINAL=$(echo "$FINAL" | jq --argjson hso "$HSO" '.hookSpecificOutput = $hso')
fi
# Copilot CLI 1.0.103 は SessionStart / PostToolUse でトップレベルの additionalContext だけを渡す。
# 出すのは SessionStart だけ（PostToolUse は Copilot 向けの定義に無い）。Claude Code は読まない。
case "$MERGED_HOOK_EVENT_NAME" in
    SessionStart)
        [ -n "$MERGED_ADDITIONAL_CONTEXT" ] && \
            FINAL=$(echo "$FINAL" | jq --arg v "$MERGED_ADDITIONAL_CONTEXT" '.additionalContext = $v')
        ;;
esac

echo "$FINAL"
