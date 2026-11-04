#!/bin/bash
# plugins/pecot-visual/skills/**/{SKILL,README}.md に、次の表記が残っていないかを検証する。
# Python 直叩き (`python3? plugins/pecot-visual/skills/...py` / `python3? scripts/...py`)。
# `uv run` 表記。
# allow-list は持たない。

set -e

files=$(git ls-files 'plugins/pecot-visual/skills/**/SKILL.md' 'plugins/pecot-visual/skills/**/README.md' || true)

if [ -z "$files" ]; then
    exit 0
fi

pattern='(python3?[[:space:]]+plugins/pecot-visual/skills/[^[:space:]]+\.py|python3?[[:space:]]+scripts/[^[:space:]]+\.py|uv[[:space:]]+run\b)'

errors=()

for file in $files; do
    while IFS= read -r line; do
        [ -n "$line" ] && errors+=("$file:$line")
    done < <(grep -nE "$pattern" "$file" || true)
done

if [ ${#errors[@]} -gt 0 ]; then
    for line in "${errors[@]}"; do
        echo "$line" >&2
    done
    echo "" >&2
    echo "SKILL.md/README.md に直叩き表記を検出。allow-list 機構はありません。" >&2
    exit 1
fi

exit 0
