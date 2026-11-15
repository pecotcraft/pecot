#!/bin/bash
# v-slidev のページを main が作り、サブエージェントに任せないことを検証する (#444)。
# 確かめるのは目印の文字列だけにする（text-violation-guidance.test.sh と同じ）。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PECOTV_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PASS=0
FAIL=0
fail() {
    echo "FAIL: $1"
    FAIL=$((FAIL + 1))
}
pass() {
    echo "PASS: $1"
    PASS=$((PASS + 1))
}

SKILL=skills/v-slidev/SKILL.md
GUIDE=skills/v-slidev/references/implementation-guide.md
BY_MAIN='サブエージェントには任せない'
REMOVED_AGENT='v-slide-creator'

for rel in "$SKILL" "$GUIDE"; do
    if grep -qF -- "$BY_MAIN" "$PECOTV_ROOT/$rel"; then
        pass "$rel に「$BY_MAIN」がある"
    else
        fail "$rel に「$BY_MAIN」が無い"
    fi
    if grep -qF -- "$REMOVED_AGENT" "$PECOTV_ROOT/$rel"; then
        fail "$rel に $REMOVED_AGENT が残っている"
    else
        pass "$rel に $REMOVED_AGENT が無い"
    fi
done

if grep -qF -- 'slide_page' "$PECOTV_ROOT/$GUIDE"; then
    pass "$GUIDE に slide_page の手順がある"
else
    fail "$GUIDE に slide_page の手順が無い"
fi

if [ -e "$PECOTV_ROOT/agents/$REMOVED_AGENT.md" ]; then
    fail "agents/$REMOVED_AGENT.md が残っている"
else
    pass "agents/$REMOVED_AGENT.md が無い"
fi

if grep -qF -- 'v-diagram-creator' "$PECOTV_ROOT/$SKILL"; then
    pass "$SKILL が図を v-diagram-creator に任せている"
else
    fail "$SKILL に v-diagram-creator が無い"
fi

echo
echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
