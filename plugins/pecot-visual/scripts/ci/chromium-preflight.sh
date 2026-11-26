#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PECOTV_PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Chromium を使うレーンの前に、headless Chromium の起動を 1 回だけ試す (#1217)。OS のライブラリが足りなければ入れる。
# cli/dist は nx では pecot-visual:build-cli (dependsOn) が用意する。手動実行で無いときだけここで作る。

# shellcheck source=pnpm-lib.sh
. "$SCRIPT_DIR/pnpm-lib.sh"

if [ ! -f "$PECOTV_PLUGIN_ROOT/cli/dist/infra/playwright/host-dependencies.js" ]; then
    PNPM="$(resolve_pnpm "$PECOTV_PLUGIN_ROOT")"
    if [ -z "$PNPM" ]; then
        echo "ERROR: pnpm / corepack / npx not found. Install Node.js 24.22.1+ in the 24.x line or 26.12.1+ (npm and npx are bundled) and retry." >&2
        HINT="$(pnpm_resolution_hint "$PECOTV_PLUGIN_ROOT")"
        [ -n "$HINT" ] && echo "  $HINT" >&2
        exit 1
    fi
    echo "==> $PNPM --filter @pecot/pecotv-cli run build (chromium-preflight 用)"
    # shellcheck disable=SC2086
    ( cd "$PECOTV_PLUGIN_ROOT" && $PNPM --filter @pecot/pecotv-cli run build )
fi

echo "==> node scripts/ci/chromium-preflight.mjs"
if ! node "$SCRIPT_DIR/chromium-preflight.mjs"; then
    echo "ERROR: Chromium を起動できないため、Chromium を使うテストを始めずに止めます (上の案内を参照)。" >&2
    exit 1
fi
echo "  OK: headless Chromium を起動できる"
