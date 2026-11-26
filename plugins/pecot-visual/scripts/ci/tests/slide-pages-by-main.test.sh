#!/bin/bash
# v-slidev のページを main が作り、サブエージェントに任せないことを確かめる (#444)。
# 確かめるのは目印の文字列だけにする（text-violation-guidance.test.sh と同じ）。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$(cd "$SCRIPT_DIR/../../../../.." && pwd)/.githooks/scripts/test_report/bash-test.sh"
PECOTV_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SKILL=skills/v-slidev/SKILL.md
GUIDE=skills/v-slidev/references/implementation-guide.md
BY_MAIN='サブエージェントには任せない'
REMOVED_AGENT='v-slide-creator'

for rel in "$SKILL" "$GUIDE"; do
    if grep -qF -- "$BY_MAIN" "$PECOTV_ROOT/$rel"; then
        bt_pass "$rel に「$BY_MAIN」がある"
    else
        bt_fail "$rel に「$BY_MAIN」がある" "見つからない"
    fi
    if grep -qF -- "$REMOVED_AGENT" "$PECOTV_ROOT/$rel"; then
        bt_fail "$rel に $REMOVED_AGENT が無い" "残っている"
    else
        bt_pass "$rel に $REMOVED_AGENT が無い"
    fi
done

if grep -qF -- 'slide_page' "$PECOTV_ROOT/$GUIDE"; then
    bt_pass "$GUIDE に slide_page の手順がある"
else
    bt_fail "$GUIDE に slide_page の手順がある" "slide_page が見つからない"
fi

if [ -e "$PECOTV_ROOT/agents/$REMOVED_AGENT.md" ]; then
    bt_fail "agents/$REMOVED_AGENT.md が無い" "残っている"
else
    bt_pass "agents/$REMOVED_AGENT.md が無い"
fi

if grep -qF -- 'v-diagram-creator' "$PECOTV_ROOT/$SKILL"; then
    bt_pass "$SKILL が図を v-diagram-creator に任せている"
else
    bt_fail "$SKILL が図を v-diagram-creator に任せている" "v-diagram-creator が見つからない"
fi

bt_finish
