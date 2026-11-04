#!/bin/bash
# 文面の違反で止まったときの直し方が、配布文書に書かれていることを検証する (#1284)。
#
# 確かめるのは目印の文字列だけにする。
# 文の書き換えでテストが落ちないようにするため。
# 目印は下の定数にまとめる。
#
# 対象ファイルは、check_markers を呼ぶ行に並べている。
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

# 目印の定数。ここだけを書き換えれば、確かめる語を変えられる。
KEEP_RULES='規則・除外は変えない'

# 1 ファイルに目印がすべてあるかを確かめる。
check_markers() {
    local rel="$1"
    shift
    local file="$PECOTV_ROOT/$rel"
    local marker
    if [ ! -f "$file" ]; then
        fail "$rel が無い"
        return
    fi
    for marker in "$@"; do
        if grep -qF -- "$marker" "$file"; then
            pass "$rel に「$marker」がある"
        else
            fail "$rel に「$marker」が無い"
        fi
    done
}

DRAWIO_MARKERS=('text-violation' 'violations[].item' 'text-lint-failed' "$KEEP_RULES")
EVIDENCE_MARKERS=('text-violation' 'text-lint-failed' 'violations[].item' "$KEEP_RULES")
SLIDEV_MARKERS=('本文 L<n>' '発表者ノート L<n>' 'text-constraints/textlint-body' "$KEEP_RULES")

check_markers skills/v-drawio/SKILL.md "${DRAWIO_MARKERS[@]}"
check_markers agents/v-diagram-creator.md "${DRAWIO_MARKERS[@]}"
check_markers skills/v-evidence/SKILL.md "${EVIDENCE_MARKERS[@]}"
check_markers skills/v-evidence/references/evidence-spec.md "${EVIDENCE_MARKERS[@]}"
check_markers skills/v-slidev/SKILL.md "${SLIDEV_MARKERS[@]}"

echo
echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
