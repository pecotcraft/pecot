#!/bin/bash
# plugins/pecot-visual/ 配下の package.json で engines.node が
# 単一の真実源 EXPECTED_ENGINES_NODE と完全一致しているかを検証する。
# allow-list は持たない。揺らぎは 1 文字単位で違反扱い。

set -e

if ! command -v uv &> /dev/null; then
    echo "ERROR: engines.node drift 検証に uv が必要です (pre-commit フック pecotv engines.node drift)。" >&2
    echo "  インストール: https://docs.astral.sh/uv/getting-started/installation/" >&2
    exit 1
fi

EXPECTED_ENGINES_NODE="^24.22.1 || >=26.12.1"

files=$(git ls-files 'plugins/pecot-visual/**/package.json' | grep -v '/node_modules/' || true)

if [ -z "$files" ]; then
    exit 0
fi

errors=()

for file in $files; do
    actual=$(uv run --no-project --python 3.12 python -c "
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
except Exception:
    print('__PARSE_ERROR__')
    sys.exit(0)
engines = data.get('engines') or {}
node = engines.get('node')
if node is None:
    print('__MISSING__')
else:
    print(node)
" "$file")

    if [ "$actual" = "__MISSING__" ] || [ "$actual" = "__PARSE_ERROR__" ]; then
        errors+=("$file: missing engines.node (expected \"$EXPECTED_ENGINES_NODE\")")
    elif [ "$actual" != "$EXPECTED_ENGINES_NODE" ]; then
        errors+=("$file: expected \"$EXPECTED_ENGINES_NODE\", got \"$actual\"")
    fi
done

if [ ${#errors[@]} -gt 0 ]; then
    for line in "${errors[@]}"; do
        echo "$line" >&2
    done
    echo "" >&2
    echo "engines.node drift detected. allow-list 機構はありません。" >&2
    exit 1
fi

exit 0
