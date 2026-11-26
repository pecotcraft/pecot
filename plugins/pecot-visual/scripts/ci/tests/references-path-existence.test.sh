#!/bin/bash
# v-drawio の配布ドキュメントに出る `references/...` が実在することを確かめる (#1043)。
# 対象は SKILL.md・v-diagram-creator.md・references/**/DESIGN.md。基準は v-drawio スキルディレクトリ。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$(cd "$SCRIPT_DIR/../../../../.." && pwd)/.githooks/scripts/test_report/bash-test.sh"
PECOTV_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SKILL_ROOT="$PECOTV_ROOT/skills/v-drawio"
AGENT_DOC="$PECOTV_ROOT/agents/v-diagram-creator.md"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

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
                MSG_DETAIL_1="$(basename "$file")"
                echo "$MSG_DETAIL_1: $path"
            fi
        done < <(extract_paths "$file")
    done
}

# --- 走査対象の収集 -----------------------------------------------------------

mapfile -t DESIGN_DOCS < <(find "$SKILL_ROOT/references" -name 'DESIGN.md' | LC_ALL=C sort)
TARGETS=("$SKILL_ROOT/SKILL.md" "$AGENT_DOC" "${DESIGN_DOCS[@]}")

missing_targets=()
for f in "${TARGETS[@]}"; do
    [ -f "$f" ] || missing_targets+=("$f")
done
bt_eq "走査対象ファイルがすべて実在する" "" "$(printf '%s\n' "${missing_targets[@]+"${missing_targets[@]}"}" | tr '\n' ' ' | sed 's/ *$//')"

# DESIGN.md が 1 件も拾えていないなら、find の起点か命名規約が崩れている。
if [ "${#DESIGN_DOCS[@]}" -ge 1 ]; then
    bt_pass "references/ 配下から DESIGN.md を 1 件以上検出する"
else
    bt_fail "references/ 配下から DESIGN.md を 1 件以上検出する" "1 件も無い (find の起点 or 命名規約の破損)"
fi

# --- 正例: 実プロダクトのパスがすべて実在する ---------------------------------

# 正規表現が崩れると違反 0 件で無条件に pass するため、抽出が空振りしていないことを先に固定する。
total_paths=0
for f in "${TARGETS[@]}"; do
    n=$(extract_paths "$f" | grep -c . || true)
    total_paths=$((total_paths + n))
done
if [ "$total_paths" -ge 10 ]; then
    bt_pass "references/ パスを 10 件以上抽出する (抽出の空振りなし)"
else
    bt_fail "references/ パスを 10 件以上抽出する (抽出の空振りなし)" "$total_paths 件しかない (正規表現の空振りの疑い)"
fi

bt_eq "ドキュメント中の references/ パスがすべて実在する" "" "$(collect_missing "$SKILL_ROOT" "${TARGETS[@]}")"

# --- 負例: 存在しないパスを混ぜた fixture が検出される -------------------------

cat > "$TMP/bad.md" << 'EOF'
| `poster/general` | `references/poster/general/DESIGN.md` |
| `poster/no-such-composition` | `references/poster/no-such-composition/DESIGN.md` |
EOF
bad_hits="$(collect_missing "$SKILL_ROOT" "$TMP/bad.md")"
bt_eq "負例 fixture の実在しないパスを 1 件検出する" \
    "bad.md: references/poster/no-such-composition/DESIGN.md" "$bad_hits"

# --- 対照: 実在するパスだけの fixture では検出しない ---------------------------

cat > "$TMP/good.md" << 'EOF'
`references/architecture/aws/DESIGN.md` と `references/poster/swimlane-flow/samples/` を参照する。
EOF
bt_eq "実在パスのみの fixture では違反を検出しない" "" \
    "$(collect_missing "$SKILL_ROOT" "$TMP/good.md")"

bt_finish
