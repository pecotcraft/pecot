#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# CI のコンテナではフックと worktree が要らない。
if [ "${CI:-}" != "true" ]; then
  bash "$root/.devcontainer/scripts/install-git-hooks.sh"
fi
bash "$root/setup.sh"
(cd "$root/plugins/pecot-visual" && pnpm --filter @pecot/pecotv-cli exec playwright install --with-deps chromium)
if [ "${CI:-}" != "true" ]; then
  cd "$root"
  git worktree prune
  for _ in 1 2 3 4; do
    "$root/plugins/pecot-workflow/bin/pecot" worktree add -D "$root"
  done
fi
