#!/bin/bash
# Validate .nx/version-plans/*.md files format.
#
# Enforces CHANGELOG-ready plan shape.
# This makes the Nx Release default renderer produce clean, short bullets.
# The bullets stay under markdownlint MD013 (200 chars) after Nx appends PR refs.
#
# Reject conditions (per plan file):
#   1. Body contains a blank line (multi-paragraph).
#      Nx wraps body as a single bullet, so multiple paragraphs produce awkward
#      continuation formatting.
#   2. Any body line exceeds MAX_LINE_CHARS (default 100).
#      Nx appends PR/Issue refs to the first body line.
#      A ref list looks like ` ([#159](url), [#166](url), ...)`.
#      It is often 80-150 chars of tail text.
#      Keeping plan lines ≤ 100 chars leaves headroom.
#      The line then stays within 200 chars after refs.
#   3. Body contains `- ` bullets (starts with hyphen-space).
#      Nx already wraps the body as one bullet; nested bullets render as `- -` clutter.
#   4. Body contains `#` headings.
#      Nx auto-injects category headings based on bump type.
#      The headings are ### 🚀 Features / 🩹 Fixes / 🔥 Breaking Changes.
#   5. Body has more than MAX_BODY_LINES non-empty lines (default 3).
#      A plan is a CHANGELOG bullet.
#      WHY/HOW belongs in the PR description, not here.
#   6. Body exceeds MAX_BODY_CHARS total characters (default 200). Same rationale.
#   7. Frontmatter key is not a `release.groups` key of nx.json.
#      A stale key (e.g. the pre-rename group name) otherwise passes here.
#      It then fails only at `nx release` time with "project does not exist".
#
# Invoked by pre-commit with `files: ^\.nx/version-plans/.*\.md$`.
# Only plan files matching the path are passed as arguments.
#
# Env vars override the defaults.
# Line length: PECOT_PLAN_MAX_LINE_CHARS. Body lines: PECOT_PLAN_MAX_BODY_LINES.
# Body chars: PECOT_PLAN_MAX_BODY_CHARS.

set -e

# UTF-8 locale を明示し、${#var} が byte ではなく character 数を返すようにする。
# 日本語 plan 本文を byte で数えると 3 倍になり、100 char ≒ 300 byte になってしまう。
# en_US.UTF-8 を優先（macOS デフォルト）、fallback で C.UTF-8（glibc / devcontainer）。
if locale -a 2>/dev/null | grep -qi "^en_US.utf-\?8$"; then
    export LC_ALL=en_US.UTF-8
else
    export LC_ALL=C.UTF-8
fi

MAX_LINE_CHARS="${PECOT_PLAN_MAX_LINE_CHARS:-100}"
MAX_BODY_LINES="${PECOT_PLAN_MAX_BODY_LINES:-3}"
MAX_BODY_CHARS="${PECOT_PLAN_MAX_BODY_CHARS:-200}"

violations=()

# nx.json の release.groups のキー（改行区切り）。node は nx の実行に必須のため追加依存にならない。
NX_JSON="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/nx.json"
if ! GROUP_KEYS=$(node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).release.groups).join("\n"))' "$NX_JSON"); then
    echo "ERROR: $NX_JSON から release.groups を読めません" >&2
    exit 1
fi

check_plan() {
    local file="$1"
    [ ! -f "$file" ] && return 0

    # Rule 0: ファイル名は `<番号>-<slug>.md` 形式（連続/末尾ハイフン・大文字を禁止）
    local base
    base=$(basename -- "$file")
    if ! [[ "$base" =~ ^[0-9]+-[a-z0-9]+(-[a-z0-9]+)*\.md$ ]]; then
        violations+=("$file: ファイル名は <番号>-<slug>.md 形式にしてください（例: 227-version-plan-naming.md）")
    fi

    # Rule 7: frontmatter keys must be release group names in nx.json.
    local key
    while IFS= read -r key; do
        [ -z "$key" ] && continue
        if ! grep -qxF -- "$key" <<< "$GROUP_KEYS"; then
            local valid_keys
            valid_keys="$(echo "$GROUP_KEYS" | paste -sd, - || true)"
            violations+=("$file: frontmatter のキー '$key' は nx.json の release.groups にありません。有効なキー: ${valid_keys}")
        fi
    done < <(awk 'BEGIN{c=0} /^---$/{c++; next} c==1 && /^[^ #][^:]*:/{sub(/:.*/, ""); gsub(/["'"'"']/, ""); print}' "$file")

    # Extract body (lines after the second `---`).
    local body
    body=$(awk 'BEGIN{c=0} /^---$/{c++; next} c>=2' "$file")

    # Rule 1: no blank lines within body (single paragraph).
    # Walk lines: flag if a blank line is followed by a non-blank line.
    local seen_content=0
    local flagged_blank=0
    while IFS= read -r line; do
        if [ -n "$line" ]; then
            if [ "$flagged_blank" = "1" ] && [ "$seen_content" = "1" ]; then
                violations+=("$file: 本文に空行があります（1 段落に収めてください）")
                break
            fi
            seen_content=1
            flagged_blank=0
        else
            if [ "$seen_content" = "1" ]; then
                flagged_blank=1
            fi
        fi
    done <<< "$body"

    # Rule 2: each non-empty line ≤ MAX_LINE_CHARS.
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        local len=${#line}
        if [ "$len" -gt "$MAX_LINE_CHARS" ]; then
            local preview="${line:0:60}"
            violations+=("$file: 行長 $len > $MAX_LINE_CHARS chars: '${preview}...'")
        fi
    done <<< "$body"

    # Rule 3: no `- ` bullets.
    if echo "$body" | grep -qE "^- "; then
        violations+=("$file: '- ' 箇条書きが含まれています（Nx が bullet で包むので禁止）")
    fi

    # Rule 4: no `#` headings.
    if echo "$body" | grep -qE "^#+ "; then
        violations+=("$file: '#' 見出しが含まれています（Nx が自動で付けるので禁止）")
    fi

    # Rule 5: non-empty body line count ≤ MAX_BODY_LINES.
    local nonempty_lines=0
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        nonempty_lines=$((nonempty_lines + 1))
    done <<< "$body"
    if [ "$nonempty_lines" -gt "$MAX_BODY_LINES" ]; then
        violations+=("$file: 本文が $nonempty_lines 行 > $MAX_BODY_LINES 行です。CHANGELOG bullet 用の短文にしてください。WHY/HOW は PR description に書いてください")
    fi

    # Rule 6: total body char count ≤ MAX_BODY_CHARS (newlines excluded).
    local body_stripped
    body_stripped=$(echo "$body" | tr -d '\n')
    local body_chars=${#body_stripped}
    if [ "$body_chars" -gt "$MAX_BODY_CHARS" ]; then
        violations+=("$file: 本文が $body_chars chars > $MAX_BODY_CHARS chars です。CHANGELOG bullet 用の短文にしてください。WHY/HOW は PR description に書いてください")
    fi
}

for file in "$@"; do
    check_plan "$file"
done

if [ "${#violations[@]}" -gt 0 ]; then
    echo ""
    echo "=========================================="
    echo "❌ version plan の形式違反があります:"
    echo "=========================================="
    for v in "${violations[@]}"; do
        echo "  - $v"
    done
    echo ""
    echo "📋 plan 本文ルール（CHANGELOG bullet として転記される 1 文）:"
    echo "  - 1 段落の短文（空行なし）"
    echo "  - 各行 ≤ $MAX_LINE_CHARS chars（PR refs が行末に付く余白）"
    echo "  - 非空行数 ≤ $MAX_BODY_LINES（WHAT のみ。WHY/HOW は PR description に書く）"
    echo "  - 総文字数 ≤ $MAX_BODY_CHARS chars"
    echo "  - '- ' 箇条書き禁止（Nx が bullet で包むため）"
    echo "  - '#' 見出し禁止（Nx が自動付与するため）"
    echo ""
    echo "📋 ファイル名規則: <番号>-<slug>.md（例: 227-version-plan-naming.md）"
    echo "  - <番号>: 紐づく Issue 番号を優先、Issue が無い場合は PR 番号"
    echo "  - <slug>: kebab-case 英字＋数字（連続ハイフン・末尾ハイフン・大文字不可）"
    echo ""
    echo "テンプレート: .nx/nx-release/version-plan-template.md"
    echo "=========================================="
    echo ""
    exit 1
fi

exit 0
