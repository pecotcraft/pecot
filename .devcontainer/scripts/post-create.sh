#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# CI のコンテナではフックと worktree が要らない。
if [ "${CI:-}" != "true" ]; then
  bash "$root/.devcontainer/scripts/install-git-hooks.sh"
fi
bash "$root/setup.sh"
# Chromium の依存パッケージは、イメージ（features/playwright-deps）に入っている。
(cd "$root/plugins/pecot-visual" && pnpm --filter @pecot/pecotv-cli exec playwright install chromium)
# pecot-visual の Playwright MCP は、端末の Google Chrome を使う（MCP の既定）。
# Playwright の Chrome 導入は、arm64 Linux と Ubuntu・Debian 以外で失敗する。x86_64 のときだけ入れる。
# CI の job は Chrome を使わないため、CI=true では入れない。
if [ "${CI:-}" = "true" ]; then
  echo "post-create: CI では Chrome の導入を飛ばします。" >&2
elif [ "$(uname -m)" = "x86_64" ]; then
  (cd "$root/plugins/pecot-visual" && pnpm --filter @pecot/pecotv-cli exec playwright install --with-deps chrome)
else
  echo "post-create: $(uname -m) では Chrome の導入を飛ばします。" >&2
  echo "post-create: Playwright MCP を Chromium で動かすには、環境変数 PLAYWRIGHT_MCP_BROWSER=chromium を設定します。" >&2
  echo "post-create: ブラウザは npx -y @playwright/mcp@0.0.83 install-browser chromium で取得します。" >&2
fi
if [ "${CI:-}" != "true" ]; then
  cd "$root"
  git worktree prune
  for _ in 1 2 3 4; do
    "$root/plugins/pecot-workflow/bin/pecot" worktree add -D "$root"
  done
fi
