#!/bin/bash
# lib/core/merge-hook-outputs.sh の単体テスト（#1229）。
# SessionStart / PostToolUse でだけ additionalContext をトップレベルにも出す（Copilot CLI 1.0.103 が読む所）。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
# shellcheck source=../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
MERGE="$SCRIPT_DIR/../lib/core/merge-hook-outputs.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

SUB_CTX="$TMP/ctx.sh"
printf '#!/bin/bash\ncat >/dev/null\necho %s\n' "'{\"hookSpecificOutput\":{\"additionalContext\":\"hello\"}}'" > "$SUB_CTX"
SUB_EMPTY="$TMP/empty.sh"
printf '#!/bin/bash\ncat >/dev/null\n' > "$SUB_EMPTY"
SUB_MSG="$TMP/msg.sh"
printf '#!/bin/bash\ncat >/dev/null\necho %s\n' "'{\"systemMessage\":\"only message\"}'" > "$SUB_MSG"
chmod +x "$SUB_CTX" "$SUB_EMPTY" "$SUB_MSG"

for EVENT in SessionStart PostToolUse; do
    OUT=$(printf '{"hook_event_name":"%s"}' "$EVENT" | bash "$MERGE" "$SUB_CTX")
    if printf '%s' "$OUT" | jq -e '.additionalContext == "hello" and .hookSpecificOutput.additionalContext == "hello" and .hookSpecificOutput.hookEventName == "'"$EVENT"'"' >/dev/null 2>&1; then
        bt_pass "$EVENT: additionalContext がトップレベルにも出る"
    else
        bt_fail "$EVENT: additionalContext がトップレベルにも出る" "out='$OUT'"
    fi
done

for EVENT in PreToolUse UserPromptSubmit Stop; do
    OUT=$(printf '{"hook_event_name":"%s"}' "$EVENT" | bash "$MERGE" "$SUB_CTX")
    if printf '%s' "$OUT" | jq -e 'has("additionalContext") | not' >/dev/null 2>&1 \
        && printf '%s' "$OUT" | jq -e '.hookSpecificOutput.additionalContext == "hello"' >/dev/null 2>&1; then
        bt_pass "$EVENT: トップレベルの additionalContext は出さない"
    else
        bt_fail "$EVENT: トップレベルの additionalContext は出さない" "out='$OUT'"
    fi
done

OUT=$(printf '{"hook_event_name":"SessionStart"}' | bash "$MERGE" "$SUB_EMPTY")
if [ -z "$OUT" ]; then
    bt_pass "空の出力なら何も出さない"
else
    bt_fail "空の出力なら何も出さない" "out='$OUT'"
fi

OUT=$(printf '{"hook_event_name":"PostToolUse"}' | bash "$MERGE" "$SUB_MSG")
if printf '%s' "$OUT" | jq -e '(has("additionalContext") | not) and .systemMessage == "only message"' >/dev/null 2>&1; then
    bt_pass "additionalContext が空ならトップレベルにも出さない（systemMessage のみ）"
else
    bt_fail "additionalContext が空ならトップレベルにも出さない（systemMessage のみ）" "out='$OUT'"
fi

SUB_DENY="$TMP/deny.sh"
printf '#!/bin/bash\ncat >/dev/null\necho %s\n' "'{\"hookSpecificOutput\":{\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"blocked because\"}}'" > "$SUB_DENY"
chmod +x "$SUB_DENY"
OUT=$(printf '{"hook_event_name":"PreToolUse"}' | bash "$MERGE" "$SUB_DENY")
if printf '%s' "$OUT" | jq -e '.hookSpecificOutput.permissionDecision == "deny" and .hookSpecificOutput.permissionDecisionReason == "blocked because" and (.hookSpecificOutput | has("reason") | not)' >/dev/null 2>&1; then
    bt_pass "deny と理由（permissionDecisionReason）が引き継がれる"
else
    bt_fail "deny と理由（permissionDecisionReason）が引き継がれる" "out='$OUT'"
fi

# 合計の上限を超える文脈は、末尾を切って Truncated の行を付ける
for n in 1 2; do
    printf '#!/bin/bash\ncat >/dev/null\njq -n --arg c "$(for i in $(seq 1 120); do echo "line %s-$i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done)" %s\n' "$n" "'{hookSpecificOutput:{additionalContext:\$c}}'" > "$TMP/big$n.sh"
    chmod +x "$TMP/big$n.sh"
done
OUT=$(printf '{"hook_event_name":"PostToolUse"}' | bash "$MERGE" "$TMP/big1.sh" "$TMP/big2.sh")
if printf '%s' "$OUT" | jq -e '(.additionalContext | utf8bytelength) <= 8100 and .additionalContext == .hookSpecificOutput.additionalContext and (.additionalContext | split("\n") | last | test("^Truncated at 8000 bytes: [0-9]+ more lines not shown\\.$"))' >/dev/null 2>&1; then
    bt_pass "合計の上限を超えると切って最後の行が Truncated になる"
else
    bt_fail "合計の上限を超えると切って最後の行が Truncated になる" "out='${OUT:0:300}'"
fi

bt_finish
