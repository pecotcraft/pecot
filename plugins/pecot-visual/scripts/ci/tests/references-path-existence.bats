# v-drawio の配布ドキュメントに出る `references/...` が実在することを確かめる (#1043)。
# 対象は SKILL.md・v-diagram-creator.md・references/**/DESIGN.md。基準は v-drawio スキルディレクトリ。

PECOTV_ROOT="$BATS_TEST_DIRNAME/../../.."
SKILL_ROOT="$PECOTV_ROOT/skills/v-drawio"
AGENT_DOC="$PECOTV_ROOT/agents/v-diagram-creator.md"

setup() {
    bats_load_library pecot-bats
}

# 1 ファイルから `references/...` 形式の相対パスを重複なく列挙する。
# 文字クラスに日本語・バッククォートを含めないため、地の文や `` で囲われた記述からパス部分だけが切り出される。
extract_paths() {
    grep -oE 'references/[A-Za-z0-9_./-]*' "$1" | LC_ALL=C sort -u
}

# base を基準に解決して実在しないパスを "<file>: <path>" 形式で出力する。末尾スラッシュは落としてから -e で判定する。
collect_missing() {
    local base="$1"
    shift
    local file path stripped
    for file in "$@"; do
        while IFS= read -r path; do
            stripped="${path%/}"
            [ -z "$stripped" ] && continue
            if [ ! -e "$base/$stripped" ]; then
                echo "$(basename "$file"): $path"
            fi
        done < <(extract_paths "$file")
    done
}

# 走査対象（SKILL.md・エージェント文書・DESIGN.md）を TARGETS と DESIGN_DOCS に集める。
collect_targets() {
    mapfile -t DESIGN_DOCS < <(find "$SKILL_ROOT/references" -name 'DESIGN.md' | LC_ALL=C sort)
    TARGETS=("$SKILL_ROOT/SKILL.md" "$AGENT_DOC" "${DESIGN_DOCS[@]}")
}

@test "走査対象のファイルは、すべて実在する" {
    explains "v-drawio の配布文書のうち、パスを走査する対象のファイルを調べるテストです。すべて実在することを確認します。"
    collect_targets
    local f
    for f in "${TARGETS[@]}"; do
        [ -f "$f" ] || fail "走査対象が実在しない: $f"
    done
}

@test "references 配下に DESIGN.md が 1 件以上ある" {
    explains "references 配下の DESIGN.md を find で集めるテストです。1 件以上検出できることを確認します。"
    collect_targets
    # 1 件も拾えていないなら、find の起点か命名規約が崩れている。
    [ "${#DESIGN_DOCS[@]}" -ge 1 ] || fail "DESIGN.md が 1 件も無い (find の起点 or 命名規約の破損)"
}

@test "配布文書から references のパスを 10 件以上抽出する" {
    explains "走査対象の文書から references のパスを抽出するテストです。10 件以上取れ、正規表現が空振りしていないことを確認します。"
    collect_targets
    # 正規表現が崩れると違反 0 件で無条件に pass するため、抽出が空振りしていないことを先に固定する。
    local f n total_paths=0
    for f in "${TARGETS[@]}"; do
        n=$(extract_paths "$f" | grep -c . || true)
        total_paths=$((total_paths + n))
    done
    [ "$total_paths" -ge 10 ] || fail "$total_paths 件しかない (正規表現の空振りの疑い)"
}

@test "配布文書の references のパスは、すべて実在する" {
    explains "走査対象の文書に出る references のパスを、v-drawio のディレクトリを基準に解決するテストです。実在しないパスが 0 件であることを確認します。"
    collect_targets
    run collect_missing "$SKILL_ROOT" "${TARGETS[@]}"
    assert_output ""
}

@test "実在しないパスを混ぜた fixture では、そのパスを 1 件検出する" {
    explains "実在しないパスを混ぜた文書で、パス検出の関数を動かすテストです。実在しないパスだけが 1 件報告されることを確認します。"
    cat > "$BATS_TEST_TMPDIR/bad.md" << 'EOF'
| `poster/general` | `references/poster/general/DESIGN.md` |
| `poster/no-such-composition` | `references/poster/no-such-composition/DESIGN.md` |
EOF
    run collect_missing "$SKILL_ROOT" "$BATS_TEST_TMPDIR/bad.md"
    assert_output "bad.md: references/poster/no-such-composition/DESIGN.md"
}

@test "実在するパスだけの fixture では、違反を検出しない" {
    explains "実在するパスだけを書いた文書で、パス検出の関数を動かすテストです。1 件も報告されないことを確認します。"
    cat > "$BATS_TEST_TMPDIR/good.md" << 'EOF'
`references/architecture/aws/DESIGN.md` と `references/poster/swimlane-flow/samples/` を参照する。
EOF
    run collect_missing "$SKILL_ROOT" "$BATS_TEST_TMPDIR/good.md"
    assert_output ""
}
