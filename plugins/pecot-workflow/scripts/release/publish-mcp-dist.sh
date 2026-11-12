#!/usr/bin/env bash
# pecot-workflow MCP サーバの配布ツリーを作り、tgz にして GitHub Release に添える (#352)。
#
# nx release の publish phase から `pecot-workflow:nx-release-publish` target 経由で起動される。
# npm への publish は、添えた後に起動する publish-npm.yml が行う。
#
#   --version=<ver>  配布する版。既定は plugins/pecot-workflow/.claude-plugin/plugin.json の版。
#   --out-dir=<dir>  配布ツリーの構築先。既定は mktemp -d で、実行後に破棄する。
#   --dry-run        npm pack までを実施し、gh release view / upload / workflow run は表示だけにする。
#   --skip-build     cli の build を省略する。既に build 済みの場合に使う。
#
# 環境変数 NX_DRY_RUN=true|1 でも dry-run になる。nx release --dry-run からの伝播を受ける。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# --out-dir の前方一致のため、REPO_ROOT も物理パス (pwd -P) にそろえる。
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd -P)"
WORKFLOW_ROOT="$REPO_ROOT/plugins/pecot-workflow"
# shellcheck source=../../../../.githooks/lib/mcp-publish-common.sh
. "$REPO_ROOT/.githooks/lib/mcp-publish-common.sh"
mcp_publish_sanitize_env

mcp_publish_defaults

for arg in "$@"; do
    mcp_publish_parse_arg "$arg" || mcp_publish_unknown_arg "$arg"
done

mcp_publish_check_npm_cache_opt_in
mcp_publish_validate_out_dir

if [ -z "$VERSION" ]; then
    VERSION="$(node -e "process.stdout.write(require('$WORKFLOW_ROOT/.claude-plugin/plugin.json').version)")"
fi
RELEASE_TAG="pecot-workflow-v$VERSION"

# --- 1. 冪等性の確認 ---
mcp_publish_require_release_head "$RELEASE_TAG" pecot-workflow plugins/pecot-workflow

echo "==> @pecot/workflow-mcp 配布ツリーを構築 (version=$VERSION / dry-run=$DRY_RUN)"

# --- 2. build ---
# shellcheck source=../../bin/_lib.sh
. "$WORKFLOW_ROOT/bin/_lib.sh"

if [ "$SKIP_BUILD" = false ]; then
    PNPM="$(resolve_pnpm "$WORKFLOW_ROOT")"
    if [ -z "$PNPM" ]; then
        echo "ERROR: pnpm / corepack / npx not found. Install Node.js 24.22.1+ in the 24.x line or 26.12.1+ (npm and npx are bundled) and retry." >&2
        HINT="$(pnpm_resolution_hint "$WORKFLOW_ROOT")"
        [ -n "$HINT" ] && echo "  $HINT" >&2
        exit 1
    fi
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    # publish は build を直接起動するので、build の直前に repo root で install を固定する。
    echo "==> $PNPM install --frozen-lockfile (cwd=$REPO_ROOT)"
    # shellcheck disable=SC2086
    (cd "$REPO_ROOT" && $PNPM install --frozen-lockfile)
    echo "==> $PNPM --filter @pecot/pecot-workflow-cli run build"
    # shellcheck disable=SC2086
    (cd "$WORKFLOW_ROOT" && $PNPM --filter @pecot/pecot-workflow-cli run build)
fi

if [ ! -d "$WORKFLOW_ROOT/cli/dist" ]; then
    echo "ERROR: $WORKFLOW_ROOT/cli/dist がありません（--skip-build の指定誤り、または build 失敗）。" >&2
    exit 1
fi

# --- 3. 配布ツリーの構築 ---
mcp_publish_make_dist

# 階層はプラグインツリーと同じに保つ（cli/dist/version.js の ../.. が配布ルート）。ソースマップは配布しない。
mkdir -p "$DIST/cli" "$DIST/hooks/lib/core"
cp -a "$WORKFLOW_ROOT/cli/dist" "$DIST/cli/dist"
cp -a "$WORKFLOW_ROOT/cli/templates" "$DIST/cli/templates"
cp "$WORKFLOW_ROOT/hooks/lib/core/pecot-gitignore-ensure.sh" "$DIST/hooks/lib/core/pecot-gitignore-ensure.sh"
find "$DIST" -name '*.map' -type f -delete

cp "$SCRIPT_DIR/mcp-dist-README.md" "$DIST/README.md"

# MIT は許諾表示の同梱を条件にする。ルートの LICENSE を HEAD から写す。
git -C "$REPO_ROOT" archive HEAD LICENSE | tar -x -C "$DIST"

node "$SCRIPT_DIR/finalize-dist.mjs" "$DIST" "$VERSION" "$WORKFLOW_ROOT"

# bin shim。cli.js は import だけでは動かないので main() を呼び、引数なしの起動だけ `mcp` を足す。
# 残ったプラグインのルートはテンプレートと対象のリポの判定をプラグイン側に引くので、import の前に消す。
mkdir -p "$DIST/bin"
cat > "$DIST/bin/pecot-workflow-mcp.mjs" << 'BIN_SHIM'
#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
for (const name of ['CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT', 'COPILOT_PLUGIN_ROOT']) delete process.env[name]
if (process.argv.length === 2) process.argv.push('mcp')
// 絶対パスの動的 import は Windows で ERR_UNSUPPORTED_ESM_URL_SCHEME になるため file URL を通す。
const { main } = await import(pathToFileURL(path.join(root, 'cli/dist/cli.js')).href)
main()
BIN_SHIM
chmod +x "$DIST/bin/pecot-workflow-mcp.mjs"

mcp_publish_write_shrinkwrap "$DIST"

DIST_SIZE="$(du -sh "$DIST" | cut -f1)" || DIST_SIZE=""
echo "==> 配布ツリー: $DIST ($DIST_SIZE)"

# --- 4. 固めて、届ける ---
mcp_publish_attach "@pecot/workflow-mcp"
