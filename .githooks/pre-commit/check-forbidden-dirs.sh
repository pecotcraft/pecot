#!/bin/bash
# Prevent files in forbidden directories from being committed.
# These directories are for local work only and must never be pushed.
#
# Why this exists:
# - .gitignore prevents normal 'git add' from staging these files.
# - But 'git add -f' can bypass .gitignore.
# - This hook catches both cases and blocks the commit.

set -e

# Forbidden directory patterns (relative to repo root)
FORBIDDEN_DIRS=(
    "work/"
    "tmp/"
)

staged_files=$(git diff --cached --name-only)

if [ -z "$staged_files" ]; then
    exit 0
fi

errors=()

for file in $staged_files; do
    for dir in "${FORBIDDEN_DIRS[@]}"; do
        if [[ "$file" == "$dir"* ]]; then
            errors+=("$file")
            break
        fi
    done
done

if [ ${#errors[@]} -gt 0 ]; then
    echo "ERROR: Attempting to commit files in forbidden directories"
    echo ""
    echo "The following files are in directories that must never be committed:"
    for file in "${errors[@]}"; do
        echo "  - $file"
    done
    echo ""
    echo "These directories are for local work only:"
    for dir in "${FORBIDDEN_DIRS[@]}"; do
        echo "  - $dir"
    done
    echo ""
    echo "To unstage these files:"
    echo "  git reset HEAD <file>"
    echo ""
    echo "Or unstage all forbidden files:"
    echo "  git reset HEAD work/ tmp/"
    exit 1
fi

exit 0
