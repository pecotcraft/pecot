#!/bin/bash
# Check entry point scripts for logic violations.
# Entry points must be pure dispatchers - logic belongs in lib/ scripts.
#
# Usage:
#   check-entry-point-logic.sh              # Check all entry points.
#   check-entry-point-logic.sh file1 file2  # Check specified files only.
#
# Exit codes:
#   0 = All files pass
#   1 = Violations found

set -euo pipefail

# --- Entry point file list (R-006) ---
# plugins/pecot-workflow/hooks/*.sh の実ファイル集合と一致させる。
# 一覧のドリフトは plugins/pecot-workflow/hooks/lib/tests/test_entry_point_linter.py が双方向で検知する。
CLAUDE_ENTRY_POINTS=(
    "plugins/pecot-workflow/hooks/pre-tool-use.sh"
    "plugins/pecot-workflow/hooks/pre-tool-use-bash.sh"
    "plugins/pecot-workflow/hooks/pre-tool-use-mcp.sh"
    "plugins/pecot-workflow/hooks/pre-tool-use-skill.sh"
    "plugins/pecot-workflow/hooks/pre-tool-use-websearch.sh"
    "plugins/pecot-workflow/hooks/post-tool-use-bash.sh"
    "plugins/pecot-workflow/hooks/post-tool-use-exit-plan-mode.sh"
    "plugins/pecot-workflow/hooks/post-tool-use-skill.sh"
    "plugins/pecot-workflow/hooks/user-prompt-submit.sh"
    "plugins/pecot-workflow/hooks/user-prompt-submit-title.sh"
    "plugins/pecot-workflow/hooks/stop.sh"
    "plugins/pecot-workflow/hooks/stop-copilot.sh"
    "plugins/pecot-workflow/hooks/notification.sh"
    "plugins/pecot-workflow/hooks/session-start.sh"
)

ALL_ENTRY_POINTS=("${CLAUDE_ENTRY_POINTS[@]}")

# --- Whitelist patterns (ERE) ---
#
# Each line of an entry point script must match at least one of these patterns.
# Patterns are based on contracts/entry-point-contract.md.
WHITELIST_PATTERNS=(
    # 1. Empty lines and comments
    '^[[:space:]]*$'
    '^[[:space:]]*#'

    # 2. Shebang
    '^#!/bin/bash'

    # 3. Strict mode
    '^set -[eu]+o pipefail$'

    # 4. SCRIPT_DIR definition (canonical form)
    '^SCRIPT_DIR="\$\(cd "\$\(dirname "\$0"\)" && pwd\)"$'

    # 5. Variable definition.
    # Static string or variable expansion, no command substitution.
    # Matches: VAR="string", VAR="$OTHER/path", VAR="${OTHER}/path".
    # Does NOT match lines containing command substitution.

    # 6. Variable definition (allowed command substitutions only)
    # INPUT=$(cat)
    '^[A-Z_]+[A-Z_0-9]*=\$\(cat\)$'
    # VAR=$(echo "$X" | jq -r '...')
    '^[A-Z_]+[A-Z_0-9]*=\$\(echo "\$[A-Z_]+[A-Z_0-9]*" \| jq -r '
    # VAR=$("$LIB/..." ...)
    '^[A-Z_]+[A-Z_0-9]*=\$\("\$[A-Z_]+[A-Z_0-9]*/'

    # 7. source / .
    '^[[:space:]]*(source|\.) '

    # 8. Early return.
    # `[ -z "$VAR" ] && exit N`, `[ "$VAR" != "..." ] && exit N`
    '^\[ -z "\$[A-Z_]+[A-Z_0-9]*" \] && exit [0-9]+$'
    '^\[ "\$[A-Z_]+[A-Z_0-9]*" != ".*" \] && exit [0-9]+$'
    '^\[ "\$[A-Z_]+[A-Z_0-9]*" = ".*" \] && exit [0-9]+$'

    # 9. export
    '^export '

    # 10. Script invocation
    # "$VAR/..." (direct execution)
    '^"\$[A-Z_]+[A-Z_0-9]*/'
    # echo "$X" | "$VAR/..." (pipe execution)
    '^echo "\$[A-Z_]+[A-Z_0-9]*" \| "\$[A-Z_]+[A-Z_0-9]*/'

    # 11. Exit code check (1-level if)
    '^if \[ \$\? -eq [0-9]+ \]; then$'
    '^[[:space:]]+echo "\$[A-Z_]+[A-Z_0-9]*"$'
    '^[[:space:]]+exit [0-9]+$'
    '^fi$'

    # 12. Exit
    '^exit [0-9]+$'
)

# --- Functions ---

# Check if a line matches any whitelist pattern
is_allowed_line() {
    local line="$1"

    # Check static variable definition (no command substitution).
    # Pattern: VAR="..." where value does not contain `$(`.
    if [[ "$line" =~ ^[A-Z_]+[A-Z_0-9]*=\"[^\"]*\"$ ]]; then
        # Reject if it contains command substitution
        if [[ "$line" != *'$('* ]]; then
            return 0
        fi
    fi

    # Check each whitelist ERE pattern
    local pattern
    for pattern in "${WHITELIST_PATTERNS[@]}"; do
        if echo "$line" | grep -qE "$pattern"; then
            return 0
        fi
    done

    return 1
}

# Check a single file for violations
check_file() {
    local filepath="$1"
    local violations=()
    local line_num=0

    if [ ! -f "$filepath" ]; then
        echo "WARNING: File not found: $filepath"
        return 0
    fi

    while IFS= read -r line || [ -n "$line" ]; do
        line_num=$((line_num + 1))

        if ! is_allowed_line "$line"; then
            violations+=("  L${line_num}: ${line}")
        fi
    done < "$filepath"

    if [ ${#violations[@]} -gt 0 ]; then
        echo "VIOLATION: $filepath"
        for v in "${violations[@]}"; do
            echo "$v"
        done
        echo "  [${#violations[@]} violations]"
        echo ""
        echo "  理由: エントリポイントスクリプトは3層アーキテクチャのディスパッチャー層です。"
        echo "  ロジックをエントリポイントに書くと、テスト困難・再利用不可・保守コスト増大を招きます。"
        echo "  ルール: エントリポイントでは以下のみ許可されます:"
        echo "    - source/. によるライブラリ読み込み"
        echo "    - 変数定義（静的文字列、コマンド置換なし）"
        echo "    - 外部スクリプト呼び出し（\"\$LIB/...\"形式）"
        echo "    - 早期リターン（[ -z \"\$VAR\" ] && exit N）"
        echo "  修正方法: 違反行のロジックを lib/ 配下のスクリプトに移動してください。"
        echo "  ロジックとは、ループ、条件分岐、関数定義等です。"
        echo ""
        return 1
    else
        echo "PASS: $filepath"
        return 0
    fi
}

# --- Main ---

# Determine target files
target_files=()
if [ $# -gt 0 ]; then
    target_files=("$@")
else
    target_files=("${ALL_ENTRY_POINTS[@]}")
fi

# Check each file
violation_count=0
clean_count=0

for filepath in "${target_files[@]}"; do
    if check_file "$filepath"; then
        clean_count=$((clean_count + 1))
    else
        violation_count=$((violation_count + 1))
    fi
done

# Summary
echo "=== Summary ==="
echo "${violation_count} files with violations, ${clean_count} files clean"

if [ "$violation_count" -gt 0 ]; then
    exit 1
fi

exit 0
