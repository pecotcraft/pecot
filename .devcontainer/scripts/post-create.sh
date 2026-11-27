#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# CI のコンテナではフックと worktree が要らない。
if [ "${CI:-}" != "true" ]; then
  bash "$root/.devcontainer/scripts/install-git-hooks.sh"
fi
bash "$root/setup.sh"
# Chromium の依存パッケージは、イメージ（features/playwright-deps）に入っている。
# CI では、Chromium を使うレーンだけが取得する。その条件（PECOT_CI_BROWSER=1）は ci.yml と test-report.yml にある。
if [ "${CI:-}" != "true" ] || [ "${PECOT_CI_BROWSER:-}" = "1" ]; then
  (cd "$root/plugins/pecot-visual" && pnpm --filter @pecot/pecotv-cli exec playwright install chromium)
fi
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
  pnpm --filter @pecot/workflow-core-src run build
  pnpm --filter @pecot/pecot-workflow-cli run build
  # build した pecot-workflow のサーバの worktree_add を呼ぶ。--prefix はリポの devEngines で npx が止まらないようにする。
  args="{\"directory\":\"$root\"}"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    npx --prefix="$HOME/.cache/pecot-inspector" -y @modelcontextprotocol/inspector@2.5.0 --cli \
      node "$root/plugins/pecot-workflow/cli/dist/main.js" \
      --method tools/call --tool-name worktree_add --tool-args-json "$args" --format json
  done
fi
