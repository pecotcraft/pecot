#!/bin/bash
# 文面の違反で止まったときの直し方が、配布文書に書かれていることを確かめる (#1284)。
# 文の書き換えで落ちないよう、確かめるのは下の定数の目印の文字列だけにする。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$(cd "$SCRIPT_DIR/../../../../.." && pwd)/.githooks/scripts/test_report/bash-test.sh"
PECOTV_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# 目印の定数。ここだけを書き換えれば、確かめる語を変えられる。
KEEP_RULES='規則・除外は変えない'

# 1 ファイルに目印がすべてあるかを確かめる。
expect_markers() {
    local rel="$1"
    shift
    local file="$PECOTV_ROOT/$rel"
    local marker
    if [ ! -f "$file" ]; then
        bt_fail "$rel がある" "ファイルが無い"
        return
    fi
    for marker in "$@"; do
        if grep -qF -- "$marker" "$file"; then
            bt_pass "$rel に「$marker」がある"
        else
            bt_fail "$rel に「$marker」がある" "見つからない"
        fi
    done
}

DRAWIO_MARKERS=('文章規則' 'violations[].item' '判定器' "$KEEP_RULES")
EVIDENCE_MARKERS=('文章規則' '判定器' 'violations[].item' "$KEEP_RULES")
SLIDEV_MARKERS=('body L<n>' 'speaker notes L<n>' 'text-constraints/textlint-body' "$KEEP_RULES")

expect_markers skills/v-drawio/SKILL.md "${DRAWIO_MARKERS[@]}"
expect_markers agents/v-diagram-creator.md "${DRAWIO_MARKERS[@]}"
expect_markers skills/v-evidence/SKILL.md "${EVIDENCE_MARKERS[@]}"
expect_markers skills/v-evidence/references/evidence-spec.md "${EVIDENCE_MARKERS[@]}"
expect_markers skills/v-slidev/SKILL.md "${SLIDEV_MARKERS[@]}"

bt_finish
