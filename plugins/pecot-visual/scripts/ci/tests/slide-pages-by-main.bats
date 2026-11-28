# v-slidev のページを main が作り、サブエージェントに任せないことを確かめる (#444)。
# 確かめるのは目印の文字列だけにする（text-violation-guidance.bats と同じ）。

PECOTV_ROOT="$BATS_TEST_DIRNAME/../../.."

SKILL=skills/v-slidev/SKILL.md
GUIDE=skills/v-slidev/references/implementation-guide.md
BY_MAIN='サブエージェントには任せない'
REMOVED_AGENT='v-slide-creator'

setup() {
    bats_load_library pecot-bats
}

# $1=文書の相対パス $2...=あるべき目印
expect_markers() {
    local rel="$1"
    shift
    local marker
    for marker in "$@"; do
        grep -qF -- "$marker" "$PECOTV_ROOT/$rel" || fail "$rel に「$marker」が見つからない"
    done
}

# $1=文書の相対パス $2...=あってはならない目印
refute_markers() {
    local rel="$1"
    shift
    local marker
    for marker in "$@"; do
        ! grep -qF -- "$marker" "$PECOTV_ROOT/$rel" || fail "$rel に「$marker」が残っている"
    done
}

@test "SKILL.md は、ページを main が作り、図を v-diagram-creator に任せる" {
    explains "v-slidev の SKILL.md の目印を探すテストです。サブエージェントに任せない旨と図の委譲先があり、削除済みのエージェントが無いことを確認します。"
    expect_markers "$SKILL" "$BY_MAIN" 'v-diagram-creator'
    refute_markers "$SKILL" "$REMOVED_AGENT"
}

@test "implementation-guide.md は、ページを main が作り、slide_page の手順を持つ" {
    explains "v-slidev の implementation-guide.md の目印を探すテストです。サブエージェントに任せない旨と slide_page の手順があり、削除済みのエージェントが無いことを確認します。"
    expect_markers "$GUIDE" "$BY_MAIN" 'slide_page'
    refute_markers "$GUIDE" "$REMOVED_AGENT"
}

@test "削除済みの v-slide-creator のエージェント文書は、残っていない" {
    explains "agents ディレクトリの v-slide-creator.md を調べるテストです。削除済みのファイルが残っていないことを確認します。"
    [ ! -e "$PECOTV_ROOT/agents/$REMOVED_AGENT.md" ] || fail "agents/$REMOVED_AGENT.md が残っている"
}
