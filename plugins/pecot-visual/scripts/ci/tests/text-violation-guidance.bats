# 文面の違反で止まったときの直し方が、配布文書に書かれていることを確かめる (#1284)。
# 文の書き換えで落ちないよう、確かめるのは下の定数の目印の文字列だけにする。

PECOTV_ROOT="$BATS_TEST_DIRNAME/../../.."

# 目印の定数。ここだけを書き換えれば、確かめる語を変えられる。
KEEP_RULES='規則・除外は変えない'

DRAWIO_MARKERS=('文章規則' 'violations[].item' '判定器' "$KEEP_RULES")
EVIDENCE_MARKERS=('文章規則' '判定器' 'violations[].item' "$KEEP_RULES")
SLIDEV_MARKERS=('body L<n>' 'speaker notes L<n>' 'text-constraints/textlint-body' "$KEEP_RULES")

setup() {
    bats_load_library pecot-bats
}

# 1 ファイルに目印がすべてあるかを確かめる。
# $1=文書の相対パス $2...=目印
expect_markers() {
    explains "配布文書に、文面の違反を直す手順の目印があるかを調べるテストです。文書があり、目印の語がすべて含まれることを確認します。"
    local rel="$1"
    shift
    local file="$PECOTV_ROOT/$rel"
    local marker
    [ -f "$file" ] || fail "$rel が無い"
    for marker in "$@"; do
        grep -qF -- "$marker" "$file" || fail "$rel に「$marker」が見つからない"
    done
}

bats_test_function --description "v-drawio の SKILL.md に、文面の違反の直し方の目印がある" -- expect_markers skills/v-drawio/SKILL.md "${DRAWIO_MARKERS[@]}"
bats_test_function --description "v-diagram-creator.md に、文面の違反の直し方の目印がある" -- expect_markers agents/v-diagram-creator.md "${DRAWIO_MARKERS[@]}"
bats_test_function --description "v-evidence の SKILL.md に、文面の違反の直し方の目印がある" -- expect_markers skills/v-evidence/SKILL.md "${EVIDENCE_MARKERS[@]}"
bats_test_function --description "evidence-spec.md に、文面の違反の直し方の目印がある" -- expect_markers skills/v-evidence/references/evidence-spec.md "${EVIDENCE_MARKERS[@]}"
bats_test_function --description "v-slidev の SKILL.md に、文面の違反の直し方の目印がある" -- expect_markers skills/v-slidev/SKILL.md "${SLIDEV_MARKERS[@]}"
