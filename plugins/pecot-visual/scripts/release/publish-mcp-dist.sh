#!/usr/bin/env bash
# pecot-visual MCP サーバを npm へ出す準備をする (#982)。
#
# nx release の publish phase から `pecot-visual:nx-release-publish` target 経由で起動される。
# ビルド済みの配布ツリーを `npm pack` で tgz に固め、GitHub Release に添える。
# npm への publish は、添えた後に起動する publish-npm.yml が行う。
#
#   --version=<ver>  配布する版。既定は plugins/pecot-visual/.claude-plugin/plugin.json の版。
#   --out-dir=<dir>  配布ツリーの構築先。既定は mktemp -d で、実行後に破棄する。
#   --dry-run        npm pack までを実施し、gh release view / upload / workflow run は表示だけにする。
#   --skip-build     cli / eslint プラグイン / text-rules の build を省略する。既に build 済みの場合に使う。
#   --audit-record=<path>
#                    監査記録の読み込み元。既定は <repo>/.nx/release-audit/pecotv-audit.json。
#                    env PECOTV_AUDIT_RECORD でも指定できる。audit-mcp-dist.sh が version 作成前に書く。
#
# 環境変数 NX_DRY_RUN=true|1 でも dry-run になる。nx release --dry-run からの伝播を受ける。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# --out-dir の前方一致のため、REPO_ROOT も物理パス (pwd -P) にそろえる。
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd -P)"
PECOTV_ROOT="$REPO_ROOT/plugins/pecot-visual"
# shellcheck source=../../../../.githooks/lib/mcp-publish-common.sh
. "$REPO_ROOT/.githooks/lib/mcp-publish-common.sh"
mcp_publish_sanitize_env
# eslint プラグインの置き場所。テストは一時の写しを指し、並行するテストが読む実ツリーの dist を消さない。
ESLINT_PLUGINS_DIR="${PECOTV_ESLINT_PLUGINS_DIR:-$PECOTV_ROOT/assets/slidev/scripts/eslint}"

mcp_publish_defaults
AUDIT_RECORD="${PECOTV_AUDIT_RECORD:-$REPO_ROOT/.nx/release-audit/pecotv-audit.json}"

for arg in "$@"; do
    mcp_publish_parse_arg "$arg" && continue
    case "$arg" in
        --audit-record=*) AUDIT_RECORD="${arg#--audit-record=}" ;;
        *) mcp_publish_unknown_arg "$arg" "|--audit-record=<path>" ;;
    esac
done

mcp_publish_check_npm_cache_opt_in
mcp_publish_validate_out_dir

if [ -z "$VERSION" ]; then
    VERSION="$(node -e "process.stdout.write(require('$PECOTV_ROOT/.claude-plugin/plugin.json').version)")"
fi
RELEASE_TAG="pecot-visual-v$VERSION"

# --- 1. 冪等性の確認 ---
# 配布ツリーは HEAD 由来のテンプレートと作業ツリー由来の dist を混ぜるので、両者の一致を publish の前提にする。
mcp_publish_require_release_head "$RELEASE_TAG" pecot-visual plugins/pecot-visual libs/text-rules

# --- 2. 監査記録の確認 ---
# 存在しない・読めない・スキーマを満たさない記録は通さない (fail-closed, #1059)。
# タブ区切りの read は空フィールドを畳むため、1 フィールド 1 行の出力を mapfile で読む。
mapfile -t RECORD_FIELDS < <(node "$SCRIPT_DIR/audit-record.mjs" read "$AUDIT_RECORD")
RECORD_STATUS="${RECORD_FIELDS[0]:-}"
RECORD_FP="${RECORD_FIELDS[1]:-}"
RECORD_HEAD="${RECORD_FIELDS[2]:-}"
RECORD_BLOCKING="${RECORD_FIELDS[3]:-0}"

# 監査スキップ（pecot-visual 非対象）のリリース。dry-run は突合なしで続行し、本実行は配布しない。
AUDIT_SKIPPED=false
case "$RECORD_STATUS" in
    OK) ;;
    MISSING)
        echo "ERROR: 監査記録がありません: $AUDIT_RECORD" >&2
        echo "       release commit 上で次を実行して、記録を作り直してください。" >&2
        echo "       bash plugins/pecot-visual/scripts/release/audit-mcp-dist.sh" >&2
        exit 1
        ;;
    SKIPPED)
        if [ "$DRY_RUN" = false ]; then
            echo "ERROR: 監査がスキップされたリリースで pecot-visual の配布はできません: $AUDIT_RECORD" >&2
            exit 1
        fi
        echo "==> 監査スキップのリリース（pecot-visual 非対象）のため突合を省略"
        AUDIT_SKIPPED=true
        ;;
    *)
        echo "ERROR: 監査記録を読めません: $AUDIT_RECORD" >&2
        exit 1
        ;;
esac

if [ "$AUDIT_SKIPPED" = false ]; then
    # nx は監査と publish の間に release commit を 1 つだけ作る（作らないこともある）。
    # よって監査時 HEAD は現在の HEAD かその親のどちらかになる。
    HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    PARENT_SHA="$(git -C "$REPO_ROOT" rev-parse -q --verify HEAD^ || true)"
    if [ "$RECORD_HEAD" != "$HEAD_SHA" ] \
        && { [ -z "$PARENT_SHA" ] || [ "$RECORD_HEAD" != "$PARENT_SHA" ]; }; then
        echo "ERROR: 監査記録の HEAD ($RECORD_HEAD) が現在の HEAD と対応しません" >&2
        echo "       release commit を checkout して、audit-mcp-dist.sh を再実行してください" >&2
        exit 1
    fi
    if [ "$RECORD_BLOCKING" -gt 0 ]; then
        echo "ERROR: 監査記録に high 以上の脆弱性が残っています ($RECORD_BLOCKING 件)" >&2
        exit 1
    fi
fi

echo "==> @pecot/visual-mcp 配布ツリーを構築 (version=$VERSION / dry-run=$DRY_RUN)"

# --- 3. build ---
# shellcheck source=../../bin/_lib.sh
. "$PECOTV_ROOT/bin/_lib.sh"

# playwright のブラウザ DL を抑止する。--skip-build でも env を揃えるため、if の外に置く。
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

if [ "$SKIP_BUILD" = false ]; then
    PNPM="$(resolve_pnpm "$PECOTV_ROOT")"
    if [ -z "$PNPM" ]; then
        echo "ERROR: pnpm / corepack / npx not found. Install Node.js 24.22.1+ in the 24.x line or 26.12.1+ (npm and npx are bundled) and retry." >&2
        HINT="$(pnpm_resolution_hint "$PECOTV_ROOT")"
        [ -n "$HINT" ] && echo "  $HINT" >&2
        exit 1
    fi
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    # build の直前に install を固定する (#1087)。導入の手順は scripts/ci/dev-install-lib.sh。
    # shellcheck source=../ci/dev-install-lib.sh
    . "$PECOTV_ROOT/scripts/ci/dev-install-lib.sh"
    pecotv_dev_install "$PECOTV_ROOT" "$PNPM"
    # cli の tsc は libs/text-rules/dist の型を読むので、text-rules を cli より先に build する (#245)。
    echo "==> $PNPM --filter @pecot/text-rules-src run build"
    # shellcheck disable=SC2086
    (cd "$REPO_ROOT" && $PNPM --filter @pecot/text-rules-src run build)
    echo "==> $PNPM --filter @pecot/pecotv-cli run build"
    # shellcheck disable=SC2086
    (cd "$PECOTV_ROOT" && $PNPM --filter @pecot/pecotv-cli run build)
    # tsc -b は削除したソースの dist を掃除しないので、dist ごと消す（tsbuildinfo も dist の中にある）。
    rm -rf "${ESLINT_PLUGINS_DIR:?}"/*/dist
    echo "==> $PNPM --filter @pecot/slidev-assets-dev run build (eslint プラグイン dist を含む)"
    # shellcheck disable=SC2086
    (cd "$PECOTV_ROOT" && PECOTV_SKIP_LIB_BUILD=1 $PNPM --filter @pecot/slidev-assets-dev run build)
fi

if [ ! -d "$PECOTV_ROOT/cli/dist" ]; then
    echo "ERROR: $PECOTV_ROOT/cli/dist がありません（--skip-build の指定誤り、または build 失敗）。" >&2
    exit 1
fi

if [ ! -d "$REPO_ROOT/libs/text-rules/dist" ]; then
    echo "ERROR: $REPO_ROOT/libs/text-rules/dist がありません（--skip-build の指定誤り、または build 失敗）。" >&2
    exit 1
fi

# --- 4. 配布ツリーの構築 ---
mcp_publish_make_dist

# working tree の生成物を混ぜないよう HEAD を起点にし、--strip-components=2 でプラグインツリーと同じ深さにする。
git -C "$REPO_ROOT" archive HEAD \
    plugins/pecot-visual/assets/drawio-icons \
    plugins/pecot-visual/assets/slidev/runtime \
    plugins/pecot-visual/assets/slidev/package.json \
    plugins/pecot-visual/assets/slidev/deck-lint.config.js \
    plugins/pecot-visual/assets/slidev/deck-lint.env.config.js \
    plugins/pecot-visual/assets/slidev/scripts/eslint/_shared \
    plugins/pecot-visual/assets/slidev/scripts/eslint/slidev-pages-lint \
    plugins/pecot-visual/assets/slidev/scripts/eslint/text-constraints \
    plugins/pecot-visual/assets/slidev/scripts/eslint/validate-references \
    | tar -x -C "$DIST" --strip-components=2

# 単体配布の npm install は catalog: を解決できない。配布ツリーと同じ HEAD の catalog で範囲へ置き換える。
git -C "$REPO_ROOT" show HEAD:pnpm-workspace.yaml \
    | node "$SCRIPT_DIR/catalog.mjs" "$DIST/assets/slidev/runtime/package.json" -

# eslint プラグインの dist は git 管理外のため実体をコピーする。
for pkg in _shared slidev-pages-lint text-constraints validate-references; do
    src="$ESLINT_PLUGINS_DIR/$pkg/dist"
    dst="$DIST/assets/slidev/scripts/eslint/$pkg/dist"
    if [ ! -d "$src" ]; then
        echo "ERROR: $src がありません（eslint プラグインの build 未実行）。" >&2
        exit 1
    fi
    mkdir -p "$(dirname "$dst")"
    cp -a "$src" "$dst"
done

# eslint プラグインの tests/ は skills/ を逆参照する parity テストを含み、配布ツリー内では落ちるので同梱しない。
find "$DIST/assets/slidev/scripts/eslint" -type d -name tests -prune -exec rm -rf {} +

# .gitignore の `dist/` などが npm の除外規則として働き、eslint プラグイン dist が tgz から落ちる。
find "$DIST" -name '.gitignore' -delete

mkdir -p "$DIST/cli"
cp -a "$PECOTV_ROOT/cli/dist" "$DIST/cli/dist"

# finalize-dist.mjs が text-constraints dist の import をこの実体への相対パスへ書き換える。
mkdir -p "$DIST/vendor/text-rules"
cp -a "$REPO_ROOT/libs/text-rules/dist" "$DIST/vendor/text-rules/dist"

# ソースマップは配布しない。finalize-dist.mjs が配布ツリーを書き換える前に消す。
find "$DIST" -name '*.map' -type f -delete

cp "$SCRIPT_DIR/mcp-dist-README.md" "$DIST/README.md"

# MIT は許諾表示の同梱を条件にする。ルートの LICENSE を HEAD から写す。
git -C "$REPO_ROOT" archive HEAD LICENSE | tar -x -C "$DIST"

node "$SCRIPT_DIR/finalize-dist.mjs" "$DIST" "$VERSION" "$PECOTV_ROOT" "$REPO_ROOT"

# bin shim。cli.js は import だけでは動かないので main() を呼び、引数なしの起動にも `mcp` を足す。
mkdir -p "$DIST/bin"
cat > "$DIST/bin/pecot-visual-mcp.mjs" << 'BIN_SHIM'
#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.CLAUDE_PLUGIN_ROOT = root
// 配布物は MCP サーバ専用エントリ。登録例が引数なしでも mcp として起動させる。
if (!process.argv.slice(2).includes('mcp')) process.argv.splice(2, 0, 'mcp')
const { main } = await import(path.join(root, 'cli/dist/cli.js'))
main()
BIN_SHIM
chmod +x "$DIST/bin/pecot-visual-mcp.mjs"

mcp_publish_write_shrinkwrap "$DIST"

# 監査した依存ツリーとの突合。dry-run でも一致を出力に残すため、早期 return より前に置く。
DIST_FP="$(node "$SCRIPT_DIR/dist-fingerprint.mjs" "$DIST/npm-shrinkwrap.json")"
echo "==> 配布ツリーの指紋: $DIST_FP"
if [ "$AUDIT_SKIPPED" = false ]; then
    if [ "$DIST_FP" != "$RECORD_FP" ]; then
        echo "ERROR: 監査した依存ツリーと配布ツリーが一致しません（監査 $RECORD_FP / 配布 $DIST_FP）。" >&2
        echo "       release commit 上で audit-mcp-dist.sh を再実行して記録を作り直し、" >&2
        echo "       pnpm exec nx release publish を再実行してください。" >&2
        exit 1
    fi
    echo "==> 監査記録と一致 (指紋 $DIST_FP, 監査時 HEAD $RECORD_HEAD)"
fi

DIST_SIZE="$(du -sh "$DIST" | cut -f1)" || true
echo "==> 配布ツリー: $DIST ($DIST_SIZE)"

# --- 5. 固めて、届ける ---
mcp_publish_attach "@pecot/visual-mcp"
