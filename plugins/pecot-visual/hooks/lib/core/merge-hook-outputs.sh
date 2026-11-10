#!/bin/bash
# 複数サブスクリプトのフック出力を安全にマージする
#
# merge-output.sh の置換。SDK の全出力フィールドを正しく処理する。
# stderr を 2>/dev/null で隠蔽しない。
#
# 配置: .claude/hooks/pecot/lib/core/merge-hook-outputs.sh
#
# Usage: echo "$INPUT" | merge-hook-outputs.sh /path/to/script1.sh [/path/to/script2.sh ...]

INPUT=$(cat)

# hookEventName をINPUTから取得
HOOK_EVENT_NAME=$(echo "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)

# マージ結果の初期値
MERGED_ADDITIONAL_CONTEXT=""
MERGED_SYSTEM_MESSAGE=""
MERGED_CONTINUE="true"
MERGED_SUPPRESS="false"
MERGED_DECISION=""        # allow/ask/deny
MERGED_REASON=""
MERGED_UPDATED_INPUT=""

# decision 優先順位: deny(3) > ask(2) > allow(1)
decision_priority() {
    case "$1" in
        deny) echo 3 ;;
        ask)  echo 2 ;;
        allow) echo 1 ;;
        *) echo 0 ;;
    esac
}

for script in "$@"; do
    # stderr を隠蔽しない。非ゼロ終了でも出力があればマージに含める
    RESULT=$(echo "$INPUT" | "$script") || true
    [ -z "$RESULT" ] && continue

    # JSON 判定
    if echo "$RESULT" | jq empty 2>/dev/null; then
        # additionalContext 連結
        AC=$(echo "$RESULT" | jq -r '.hookSpecificOutput.additionalContext // empty')
        if [ -n "$AC" ]; then
            if [ -n "$MERGED_ADDITIONAL_CONTEXT" ]; then
                MERGED_ADDITIONAL_CONTEXT="${MERGED_ADDITIONAL_CONTEXT}
${AC}"
            else
                MERGED_ADDITIONAL_CONTEXT="$AC"
            fi
        fi

        # systemMessage 連結
        SM=$(echo "$RESULT" | jq -r '.systemMessage // empty')
        if [ -n "$SM" ]; then
            if [ -n "$MERGED_SYSTEM_MESSAGE" ]; then
                MERGED_SYSTEM_MESSAGE="${MERGED_SYSTEM_MESSAGE}
${SM}"
            else
                MERGED_SYSTEM_MESSAGE="$SM"
            fi
        fi

        # continue: いずれかが false なら false
        CONT=$(echo "$RESULT" | jq -r 'if has("continue") then .continue | tostring else empty end')
        [ "$CONT" = "false" ] && MERGED_CONTINUE="false"

        # suppressOutput: いずれかが true なら true
        SUPP=$(echo "$RESULT" | jq -r 'if has("suppressOutput") then .suppressOutput | tostring else empty end')
        [ "$SUPP" = "true" ] && MERGED_SUPPRESS="true"

        # permissionDecision: 最も厳しいものを採用
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

        # updatedInput: 最後のものを採用
        UI=$(echo "$RESULT" | jq -r '.hookSpecificOutput.updatedInput // empty')
        [ -n "$UI" ] && MERGED_UPDATED_INPUT="$UI"
    else
        # JSON 以外 → 素テキストとして additionalContext に追加
        if [ -n "$MERGED_ADDITIONAL_CONTEXT" ]; then
            MERGED_ADDITIONAL_CONTEXT="${MERGED_ADDITIONAL_CONTEXT}
${RESULT}"
        else
            MERGED_ADDITIONAL_CONTEXT="$RESULT"
        fi
    fi
done

# 連結後の合計を上限で切る。ライブラリを解決できなければ切らない。
CONTEXT_CAP_LIB="$(dirname "${BASH_SOURCE[0]}")/context-cap.sh"
if [ -n "$MERGED_ADDITIONAL_CONTEXT" ] && [ -f "$CONTEXT_CAP_LIB" ]; then
    # shellcheck source=context-cap.sh
    . "$CONTEXT_CAP_LIB"
    cap_context "$PECOTV_CONTEXT_MAX_TOTAL" '.' lines <<<"$MERGED_ADDITIONAL_CONTEXT"
    if [ -n "$CAP_NOTE" ]; then
        MERGED_ADDITIONAL_CONTEXT="$CAPPED_BODY
$CAP_NOTE"
    fi
fi

# マージ結果がなければ何も出力しない
if [ -z "$MERGED_ADDITIONAL_CONTEXT" ] && [ -z "$MERGED_SYSTEM_MESSAGE" ] \
   && [ "$MERGED_CONTINUE" = "true" ] && [ "$MERGED_SUPPRESS" = "false" ] \
   && [ -z "$MERGED_DECISION" ] && [ -z "$MERGED_UPDATED_INPUT" ]; then
    exit 0
fi

# hookSpecificOutput の構築
HSO=$(jq -n '{}')
[ -n "$HOOK_EVENT_NAME" ] && \
    HSO=$(echo "$HSO" | jq --arg v "$HOOK_EVENT_NAME" '.hookEventName = $v')
[ -n "$MERGED_ADDITIONAL_CONTEXT" ] && \
    HSO=$(echo "$HSO" | jq --arg v "$MERGED_ADDITIONAL_CONTEXT" '.additionalContext = $v')
[ -n "$MERGED_DECISION" ] && \
    HSO=$(echo "$HSO" | jq --arg v "$MERGED_DECISION" '.permissionDecision = $v')
[ -n "$MERGED_REASON" ] && \
    HSO=$(echo "$HSO" | jq --arg v "$MERGED_REASON" '.permissionDecisionReason = $v')
[ -n "$MERGED_UPDATED_INPUT" ] && \
    HSO=$(echo "$HSO" | jq --arg v "$MERGED_UPDATED_INPUT" '.updatedInput = $v')

# 最終 JSON 構築（値があるフィールドのみ）
FINAL=$(jq -n '{}')
if [ "$(echo "$HSO" | jq 'length')" -gt 0 ]; then
    FINAL=$(echo "$FINAL" | jq --argjson hso "$HSO" '.hookSpecificOutput = $hso')
fi
# SessionStart / PostToolUse の additionalContext はトップレベルにも並べる。
# Copilot CLI 1.0.103 は、この 2 イベントではトップレベルの additionalContext だけをモデルに渡す。
# hookSpecificOutput の additionalContext と素のテキストは、debug ログに残るだけ。
# PreToolUse の hookSpecificOutput は届く。
# Claude Code は hookSpecificOutput を読み、トップレベルの additionalContext は読まないので二重に入らない。
case "$HOOK_EVENT_NAME" in
    SessionStart | PostToolUse)
        [ -n "$MERGED_ADDITIONAL_CONTEXT" ] && \
            FINAL=$(echo "$FINAL" | jq --arg v "$MERGED_ADDITIONAL_CONTEXT" '.additionalContext = $v')
        ;;
esac
[ -n "$MERGED_SYSTEM_MESSAGE" ] && \
    FINAL=$(echo "$FINAL" | jq --arg v "$MERGED_SYSTEM_MESSAGE" '.systemMessage = $v')
[ "$MERGED_CONTINUE" = "false" ] && \
    FINAL=$(echo "$FINAL" | jq '.continue = false')
[ "$MERGED_SUPPRESS" = "true" ] && \
    FINAL=$(echo "$FINAL" | jq '.suppressOutput = true')

echo "$FINAL"
