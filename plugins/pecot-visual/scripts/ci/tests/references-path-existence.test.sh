#!/bin/bash
# v-drawio の配布ドキュメントに現れる `references/...` 相対パスが実在することを検証する (#1043)。
#
# 対象ファイルは次の 3 つ。
#   - skills/v-drawio/SKILL.md（スタイル名 → DESIGN.md パスの対応表）。
#   - agents/v-diagram-creator.md（スタイル別の追加リファレンス）
#   - skills/v-drawio/references/**/DESIGN.md（サンプル置き場・レイアウト間の相互参照）。
#
# パスの解決基準は、v-drawio スキルディレクトリ。
# v-diagram-creator.md 冒頭の「以下のパスは v-drawio スキルディレクトリからの相対」と同じ規約。
#
# 狙いは、レイアウトの追加・リネーム・ディレクトリ再編で、ドキュメント側のパスだけが古くなる状態を止めること。
# 読み込み先が消えても、エージェントは何も言わずに読めないだけで、テストが無いと誰も気づかない。
#
# `set -e` は使わない。
# 負例（存在しないパスを含む fixture）で、検出関数が違反を返すことを assert する。
# そのため、非ゼロ相当の結果を握って評価を続ける必要がある。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PECOTV_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SKILL_ROOT="$PECOTV_ROOT/skills/v-drawio"
AGENT_DOC="$PECOTV_ROOT/agents/v-diagram-creator.md"

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
assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        pass "$label"
    else
        fail "$label (expected='$expected' actual='$actual')"
    fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1 ファイルから `references/...` 形式の相対パスを重複なく列挙する。
# 文字クラスに日本語・バッククォートを含めないため、地の文や `` で囲われた記述から
# パス部分だけが自然に切り出される。
extract_paths() {
    grep -oE 'references/[A-Za-z0-9_./-]*' "$1" | LC_ALL=C sort -u
}

# base を基準に解決して実在しないパスを "<file>: <path>" 形式で出力する。
# 末尾スラッシュはディレクトリ指定の意図なので落としてから -e で判定する。
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
assert_eq "走査対象ファイルがすべて実在する" "" "$(printf '%s\n' "${missing_targets[@]+"${missing_targets[@]}"}" | tr '\n' ' ' | sed 's/ *$//')"

# DESIGN.md が 1 件も拾えていないなら、find の起点か命名規約が崩れている。
if [ "${#DESIGN_DOCS[@]}" -ge 1 ]; then
    pass "references/ 配下から DESIGN.md を ${#DESIGN_DOCS[@]} 件検出した"
else
    fail "references/ 配下に DESIGN.md が 1 件も無い (find の起点 or 命名規約の破損)"
fi

# --- 正例: 実プロダクトのパスがすべて実在する ---------------------------------

# 抽出が空振りしていないことを先に固定する。
# 正規表現が崩れると、違反 0 件で無条件に pass するためだ。
total_paths=0
for f in "${TARGETS[@]}"; do
    n=$(extract_paths "$f" | grep -c . || true)
    total_paths=$((total_paths + n))
done
if [ "$total_paths" -ge 10 ]; then
    pass "references/ パスを $total_paths 件抽出した (抽出の空振りなし)"
else
    fail "抽出できた references/ パスが $total_paths 件しかない (正規表現の空振りの疑い)"
fi

missing="$(collect_missing "$SKILL_ROOT" "${TARGETS[@]}")"
if [ -z "$missing" ]; then
    pass "ドキュメント中の references/ パスがすべて実在する"
else
    fail "実在しない references/ パスがある:"
    while IFS= read -r line; do echo "       $line"; done <<< "$missing"
fi

# --- 負例: 存在しないパスを混ぜた fixture が検出される -------------------------

cat > "$TMP/bad.md" << 'EOF'
| `poster/general` | `references/poster/general/DESIGN.md` |
| `poster/no-such-composition` | `references/poster/no-such-composition/DESIGN.md` |
EOF
bad_hits="$(collect_missing "$SKILL_ROOT" "$TMP/bad.md")"
assert_eq "負例 fixture の実在しないパスを 1 件検出する" \
    "bad.md: references/poster/no-such-composition/DESIGN.md" "$bad_hits"

# --- 対照: 実在するパスだけの fixture では検出しない ---------------------------

cat > "$TMP/good.md" << 'EOF'
`references/architecture/aws/DESIGN.md` と `references/poster/swimlane-flow/samples/` を参照する。
EOF
assert_eq "実在パスのみの fixture では違反を検出しない" "" \
    "$(collect_missing "$SKILL_ROOT" "$TMP/good.md")"

echo
echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
