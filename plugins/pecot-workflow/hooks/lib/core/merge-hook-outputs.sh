#!/bin/bash
# 複数サブスクリプトのフック出力を安全にマージする。
#
# merge-output.sh の置換。SDK の全出力フィールドを正しく処理する。
# stderr を 2>/dev/null で隠蔽しない。
#
# 配置: hooks/lib/core/merge-hook-outputs.sh。
#
# Usage: echo "$INPUT" | merge-hook-outputs.sh /path/to/script1.sh [/path/to/script2.sh ...]

INPUT=$(cat)

# マージ結果の初期値。
MERGED_ADDITIONAL_CONTEXT=""
MERGED_SYSTEM_MESSAGE=""
MERGED_CONTINUE="true"
MERGED_SUPPRESS="false"
MERGED_DECISION=""        # allow/ask/deny
MERGED_REASON=""
MERGED_UPDATED_INPUT=""
# hookEventName は、入力 JSON の hook_event_name（PECOT_HOOK_EVENT）を初期値にする。
# PECOT_HOOK_EVENT は、エントリの project-root.sh が hook-input.sh で export 済み。
# サブスクリプトが JSON で hookEventName を返した場合は、最初の値で上書きされる。
# Claude Code は hookSpecificOutput.additionalContext を出すと、hookEventName が必須になる。
MERGED_HOOK_EVENT_NAME="${PECOT_HOOK_EVENT:-}"
MERGED_TERMINAL_SEQUENCE=""
# SessionStart / UserPromptSubmit のセッション名（Claude Code）
MERGED_SESSION_TITLE=""

# decision 優先順位: deny(3) > ask(2) > allow(1)。
decision_priority() {
    case "$1" in
        deny) echo 3 ;;
        ask)  echo 2 ;;
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

        # systemMessage 連結。
        SM=$(echo "$RESULT" | jq -r '.systemMessage // empty')
        if [ -n "$SM" ]; then
            if [ -n "$MERGED_SYSTEM_MESSAGE" ]; then
                MERGED_SYSTEM_MESSAGE="${MERGED_SYSTEM_MESSAGE}
${SM}"
            else
                MERGED_SYSTEM_MESSAGE="$SM"
            fi
        fi

        # continue: いずれかが false なら false。
        CONT=$(echo "$RESULT" | jq -r 'if has("continue") then .continue | tostring else empty end')
        [ "$CONT" = "false" ] && MERGED_CONTINUE="false"

        # suppressOutput: いずれかが true なら true。
        SUPP=$(echo "$RESULT" | jq -r 'if has("suppressOutput") then .suppressOutput | tostring else empty end')
        [ "$SUPP" = "true" ] && MERGED_SUPPRESS="true"

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

        # terminalSequence（トップレベル。Claude Code が端末へそのまま流す制御列）: 連結。
        TS=$(echo "$RESULT" | jq -r '.terminalSequence // empty')
        [ -n "$TS" ] && MERGED_TERMINAL_SEQUENCE="${MERGED_TERMINAL_SEQUENCE}${TS}"

        # updatedInput: 最後のものを採用。
        UI=$(echo "$RESULT" | jq -r '.hookSpecificOutput.updatedInput // empty')
        [ -n "$UI" ] && MERGED_UPDATED_INPUT="$UI"

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
if [ -z "$MERGED_ADDITIONAL_CONTEXT" ] && [ -z "$MERGED_SYSTEM_MESSAGE" ] \
   && [ "$MERGED_CONTINUE" = "true" ] && [ "$MERGED_SUPPRESS" = "false" ] \
   && [ -z "$MERGED_DECISION" ] && [ -z "$MERGED_UPDATED_INPUT" ] \
   && [ -z "$MERGED_TERMINAL_SEQUENCE" ] && [ -z "$MERGED_SESSION_TITLE" ]; then
    exit 0
fi

# hookSpecificOutput を構築する。
# hookEventName 以外の実フィールドを先に積む。
# 対象は、additionalContext / permissionDecision / reason / updatedInput / sessionTitle。
HSO=$(jq -n '{}')
[ -n "$MERGED_ADDITIONAL_CONTEXT" ] && \
    HSO=$(echo "$HSO" | jq --arg v "$MERGED_ADDITIONAL_CONTEXT" '.additionalContext = $v')
[ -n "$MERGED_DECISION" ] && \
    HSO=$(echo "$HSO" | jq --arg v "$MERGED_DECISION" '.permissionDecision = $v')
[ -n "$MERGED_REASON" ] && \
    HSO=$(echo "$HSO" | jq --arg v "$MERGED_REASON" '.permissionDecisionReason = $v')
[ -n "$MERGED_UPDATED_INPUT" ] && \
    HSO=$(echo "$HSO" | jq --arg v "$MERGED_UPDATED_INPUT" '.updatedInput = $v')
[ -n "$MERGED_SESSION_TITLE" ] && \
    HSO=$(echo "$HSO" | jq --arg v "$MERGED_SESSION_TITLE" '.sessionTitle = $v')
# hookEventName は実フィールドの随伴情報（Claude Code は additionalContext 等を
# 出力するとき hookEventName 必須）。実フィールドが 1 つも無い（systemMessage
# のみ等）ケースでは hookEventName だけの空 HSO を作らないよう、他フィールドが
# 存在する場合のみ付与する。
if [ -n "$MERGED_HOOK_EVENT_NAME" ] && [ "$(echo "$HSO" | jq 'length')" -gt 0 ]; then
    HSO=$(echo "$HSO" | jq --arg v "$MERGED_HOOK_EVENT_NAME" '.hookEventName = $v')
fi

# 最終 JSON 構築（値があるフィールドのみ）。
FINAL=$(jq -n '{}')
if [ "$(echo "$HSO" | jq 'length')" -gt 0 ]; then
    FINAL=$(echo "$FINAL" | jq --argjson hso "$HSO" '.hookSpecificOutput = $hso')
fi
# SessionStart / PostToolUse の additionalContext は、トップレベルにも並べる。
# Copilot CLI 1.0.103 は、この 2 イベントではトップレベルの additionalContext だけをモデルに渡す。
# hookSpecificOutput の additionalContext と素のテキストは、debug ログに残るだけ。PreToolUse の hookSpecificOutput は届く。
# Claude Code は hookSpecificOutput を読み、トップレベルの additionalContext は読まない。
# そのため、二重に入らない。
case "$MERGED_HOOK_EVENT_NAME" in
    SessionStart | PostToolUse)
        [ -n "$MERGED_ADDITIONAL_CONTEXT" ] && \
            FINAL=$(echo "$FINAL" | jq --arg v "$MERGED_ADDITIONAL_CONTEXT" '.additionalContext = $v')
        ;;
esac
[ -n "$MERGED_SYSTEM_MESSAGE" ] && \
    FINAL=$(echo "$FINAL" | jq --arg v "$MERGED_SYSTEM_MESSAGE" '.systemMessage = $v')
[ -n "$MERGED_TERMINAL_SEQUENCE" ] && \
    FINAL=$(echo "$FINAL" | jq --arg v "$MERGED_TERMINAL_SEQUENCE" '.terminalSequence = $v')
[ "$MERGED_CONTINUE" = "false" ] && \
    FINAL=$(echo "$FINAL" | jq '.continue = false')
[ "$MERGED_SUPPRESS" = "true" ] && \
    FINAL=$(echo "$FINAL" | jq '.suppressOutput = true')

echo "$FINAL"
