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

# git hook から起動されると git が GIT_DIR 等を export し、`git -C` が無視されて呼び出し元の index を書き換える。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE
# nx run-commands が注入する FORCE_COLOR は、nx 経由と直接実行で挙動を割るので除く。
unset FORCE_COLOR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# --out-dir の前方一致のため、REPO_ROOT も物理パス (pwd -P) にそろえる。
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd -P)"
WORKFLOW_ROOT="$REPO_ROOT/plugins/pecot-workflow"

VERSION=""
OUT_DIR=""
DRY_RUN=false
SKIP_BUILD=false

case "${NX_DRY_RUN:-}" in
    true | 1) DRY_RUN=true ;;
esac

for arg in "$@"; do
    case "$arg" in
        --version=*) VERSION="${arg#--version=}" ;;
        --out-dir=*) OUT_DIR="${arg#--out-dir=}" ;;
        --dry-run) DRY_RUN=true ;;
        --skip-build) SKIP_BUILD=true ;;
        *)
            echo "ERROR: 未対応の引数: $arg (使用可能: --version=<ver>|--out-dir=<dir>|--dry-run|--skip-build)" >&2
            exit 1
            ;;
    esac
done

# 検証用の opt-in。依存解決の npm キャッシュを永続化し、2 回目以降をレジストリに出さない。
# 古い packument のまま shrinkwrap を解決して配布しかねないので、dry-run でない実行では拒否する。
NPM_CACHE_OPT_IN="${PECOT_RELEASE_TEST_NPM_CACHE:-}"
if [ -n "$NPM_CACHE_OPT_IN" ]; then
    case "$NPM_CACHE_OPT_IN" in
        /*) ;;
        *)
            echo "ERROR: PECOT_RELEASE_TEST_NPM_CACHE は絶対パスで指定してください: $NPM_CACHE_OPT_IN" >&2
            echo "       依存解決は配布ツリーへ cd してから実行するため、相対パスだと別の場所を指します。" >&2
            exit 1
            ;;
    esac
    if [ "$DRY_RUN" = false ]; then
        echo "ERROR: PECOT_RELEASE_TEST_NPM_CACHE は検証用です。dry-run でない実行（実配布）では使えません。unset して再実行してください。" >&2
        exit 1
    fi
fi

# --out-dir は構築の直前に rm -rf する。build を待たずに弾くため、引数解釈の直後に正規化して確かめる。
#   (a) REPO_ROOT の外であること。
#   (b) 不在または空であること。`/` や $HOME のように中身のある場所を消さない。
if [ -n "$OUT_DIR" ]; then
    if [ -e "$OUT_DIR" ] && [ ! -d "$OUT_DIR" ]; then
        echo "ERROR: --out-dir がディレクトリではありません: $OUT_DIR" >&2
        exit 1
    fi
    if [ -d "$OUT_DIR" ]; then
        OUT_DIR="$(cd "$OUT_DIR" && pwd -P)"
    else
        # 未作成の path は、親を実体解決してから結合する。symlink・相対・.. はここで解消する。
        OUT_PARENT="$(cd "$(dirname "$OUT_DIR")" 2> /dev/null && pwd -P)" || OUT_PARENT=""
        if [ -z "$OUT_PARENT" ]; then
            OUT_PARENT_MISSING="$(dirname "$OUT_DIR")" || true
            echo "ERROR: --out-dir の親ディレクトリがありません: $OUT_PARENT_MISSING" >&2
            exit 1
        fi
        OUT_DIR="${OUT_PARENT%/}/$(basename "$OUT_DIR")"
    fi
    case "$OUT_DIR" in
        "$REPO_ROOT" | "$REPO_ROOT"/*)
            echo "ERROR: --out-dir はリポジトリ ($REPO_ROOT) の外を指定してください: $OUT_DIR" >&2
            exit 1
            ;;
    esac
    if [ -d "$OUT_DIR" ] && [ -n "$(ls -A "$OUT_DIR")" ]; then
        echo "ERROR: --out-dir は不在か空のディレクトリのみ指定できます（構築前に全消去するため）: $OUT_DIR" >&2
        exit 1
    fi
fi

if [ -z "$VERSION" ]; then
    VERSION="$(node -e "process.stdout.write(require('$WORKFLOW_ROOT/.claude-plugin/plugin.json').version)")"
fi
RELEASE_TAG="pecot-workflow-v$VERSION"

# --- 1. 冪等性の確認 ---
# dry-run 判定より前には置けない（nx release --dry-run はタグを作らず、配布ツリーの構築を検証できなくなる）。
# ローカルのタグで判定するので、オフラインでも成立し、他プラグインだけのリリースが GitHub の到達性に結びつかない。
if [ "$DRY_RUN" = false ]; then
    # 否定付きの `cmd | grep` は cmd の失敗を errexit の対象外にするので、git の失敗と「タグが無い」を分ける。
    HEAD_TAGS="$(git -C "$REPO_ROOT" tag --points-at HEAD)"
    if ! printf '%s\n' "$HEAD_TAGS" | grep -Fxq "$RELEASE_TAG"; then
        echo "==> スキップ: HEAD に $RELEASE_TAG が無いため pecot-workflow のリリースではありません"
        exit 0
    fi
    # 配布ツリーは作業ツリーから組む。タグと配布物の対応は、タグの指すコミットと作業ツリーの一致だけが根拠。
    # gitignore 対象の dist はここでは見えないが、節 2 の build が作り直す。
    DIRTY="$(git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-workflow)"
    if [ -n "$DIRTY" ]; then
        echo "ERROR: plugins/pecot-workflow に未コミットの変更があります。配布ツリーは作業ツリーから" >&2
        echo "       組み立てるため、$RELEASE_TAG が指すコミットと作業ツリーが一致した状態でのみ" >&2
        echo "       publish できます:" >&2
        echo "$DIRTY" >&2
        exit 1
    fi
fi

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
    # publish は build を直接起動するので、依存が未導入だと失敗する。build の直前に install を固定する。
    # 依存は repo root の 1 つの pnpm workspace が持つので、install は repo root で行う。
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
CLEANUP_DIRS=()
# EXIT trap は最後のコマンドの非ゼロが終了コードになるので、元の rc を退避して明示 exit する。
cleanup() {
    local rc=$?
    if [ "${#CLEANUP_DIRS[@]}" -gt 0 ]; then
        rm -rf "${CLEANUP_DIRS[@]}"
    fi
    exit "$rc"
}
trap cleanup EXIT

if [ -n "$OUT_DIR" ]; then
    DIST="$OUT_DIR"
    rm -rf "$DIST"
else
    DIST="$(mktemp -d)"
    CLEANUP_DIRS+=("$DIST")
fi
mkdir -p "$DIST"

# 配布ルートからの階層はプラグインツリーと同じに保つ（cli/dist/version.js の ../.. が配布ルート）。
# サーバが実行時に読む dist の外のファイル（テンプレートと gitignore 補完）も同じ相対パスに置く。
# ソースマップ（*.map）だけは写した後に消す（spec 018 US4）。
mkdir -p "$DIST/cli" "$DIST/hooks/lib/core"
cp -a "$WORKFLOW_ROOT/cli/dist" "$DIST/cli/dist"
cp -a "$WORKFLOW_ROOT/cli/templates" "$DIST/cli/templates"
cp "$WORKFLOW_ROOT/hooks/lib/core/pecot-gitignore-ensure.sh" "$DIST/hooks/lib/core/pecot-gitignore-ensure.sh"
find "$DIST" -name '*.map' -type f -delete

cp "$SCRIPT_DIR/mcp-dist-README.md" "$DIST/README.md"

# MIT は許諾表示の同梱を条件にする。ルートの LICENSE を HEAD から写す。
git -C "$REPO_ROOT" archive HEAD LICENSE | tar -x -C "$DIST"

node "$SCRIPT_DIR/finalize-dist.mjs" "$DIST" "$VERSION" "$WORKFLOW_ROOT"

# bin shim。cli.js は import しただけでは何も実行しないので、main() を明示して呼ぶ。
# 引数なしの起動だけ argv に `mcp` を足す（--version / --help は commander に渡す）。
# 環境に残ったプラグインのルートは、テンプレートの置き場と対象のリポの判定をプラグイン側に引くので、import の前に消す。
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

echo "==> npm-shrinkwrap.json を生成"
# 依存解決は使い捨てキャッシュに閉じ、共有キャッシュの古いメタデータで結果がずれるのを防ぐ。
# opt-in があるときだけ（冒頭で実配布を拒否済み）そのキャッシュを prefer-offline で使う。
# 設定は環境変数でなく CLI フラグで渡す（フラグは環境の NPM_CONFIG_* に勝つ）。
NPM_FLAGS=()
if [ -n "$NPM_CACHE_OPT_IN" ]; then
    NPM_CACHE="$NPM_CACHE_OPT_IN"
    NPM_FLAGS+=(--prefer-offline)
else
    NPM_CACHE="$(mktemp -d)"
    CLEANUP_DIRS+=("$NPM_CACHE")
fi
echo "==> npm レジストリへ依存を解決中"
# レジストリ不達で無出力のまま分単位で止まらないよう、タイムアウトと再試行を短く固定する。
(cd "$DIST" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund \
    --fetch-timeout=30000 --fetch-retries=1 \
    --cache="$NPM_CACHE" ${NPM_FLAGS[@]+"${NPM_FLAGS[@]}"} > /dev/null)
mv "$DIST/package-lock.json" "$DIST/npm-shrinkwrap.json"

DIST_SIZE="$(du -sh "$DIST" | cut -f1)" || DIST_SIZE=""
echo "==> 配布ツリー: $DIST ($DIST_SIZE)"

# --- 4. 固めて、届ける ---
# pack から gh の呼び出しまでは、ルートの共通スクリプトが担う（pecot-tools・pecot-visual と共通）。
ATTACH_ARGS=(--dist="$DIST" --tag="$RELEASE_TAG" --package="@pecot/workflow-mcp" --version="$VERSION" --repo-root="$REPO_ROOT")
if [ "$DRY_RUN" = true ]; then
    ATTACH_ARGS+=(--dry-run)
fi
"$REPO_ROOT/.githooks/scripts/attach-mcp-tgz.sh" "${ATTACH_ARGS[@]}"
