#!/usr/bin/env bash
# pnpm を探して引数をそのまま渡す。pnpm、corepack、npx の順に使う。
# npx では、版を root の package.json の packageManager から読む。
set -euo pipefail

if command -v pnpm >/dev/null 2>&1; then
    exec pnpm "$@"
elif command -v corepack >/dev/null 2>&1; then
    exec corepack pnpm "$@"
elif command -v npx >/dev/null 2>&1; then
    root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    version="$(sed -n 's/.*"packageManager": *"pnpm@\([^+"]*\).*/\1/p' "$root/package.json" | head -n 1)"
    if [ -z "$version" ]; then
        echo "ERROR: $root/package.json の packageManager から pnpm の版を読めません" >&2
        exit 127
    fi
    # npm 11 は devEngines の pnpm があると npx を止めるため、cwd を / にして --dir で対象を指す。
    dir="$PWD"
    cd /
    exec npx --yes "pnpm@$version" --dir "$dir" "$@"
fi
echo "ERROR: pnpm・corepack・npx のどれも見つかりません。Node.js を入れ直してください" >&2
exit 127
