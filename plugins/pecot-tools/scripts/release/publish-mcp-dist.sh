#!/usr/bin/env bash
# pecot-tools MCP サーバを npm へ出す準備をする (#1056)。
#
# nx release の publish phase から `pecot-tools:nx-release-publish` target 経由で起動される。
# プラグイン未導入の環境でも、`npx -y @pecot/tools-mcp` を 1 エントリ登録するだけで
# MCP サーバを使えるようにしたい。
# そのため、ビルド済みの配布ツリーを `npm pack` で tgz に固め、GitHub Release に添える。
# npm への publish は、添えた後に起動する publish-npm.yml が行う。
#
#   --version=<ver>  配布する版。既定は plugins/pecot-tools/.claude-plugin/plugin.json の版。
#   --out-dir=<dir>  配布ツリーの構築先。既定は mktemp -d で、実行後に破棄する。
#   --dry-run        npm pack までを実施し、gh release view / upload / workflow run は表示だけにする。
#   --skip-build     cli の build を省略する。既に build 済みの場合に使う。
#
# 環境変数 NX_DRY_RUN=true|1 でも dry-run になる。nx release --dry-run からの伝播を受ける。
set -euo pipefail

# git hook (pre-push 等) から起動されると、git が GIT_DIR / GIT_INDEX_FILE を export する。
# その状態では `git -C <dir>` の -C が無視され、**呼び出し元リポの index** が書き換わる。
# 本スクリプトは REPO_ROOT へ git を発行する。
# そのため、継承した git env は先頭で必ず捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE
# nx run-commands は子プロセスへ FORCE_COLOR=true を注入する。
# nx 経由実行と直接実行で挙動が割れる問題を予防的に塞ぐため、除去する（run-tests.sh と対称）。
unset FORCE_COLOR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# --out-dir は pwd -P（物理パス）で正規化するため、REPO_ROOT もここで揃える。論理パス
# (pwd) のままだと、リポジトリを指す symlink 経由で起動したときに前方一致が外れる。
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd -P)"
TOOLS_ROOT="$REPO_ROOT/plugins/pecot-tools"

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

# 依存解決の npm キャッシュを永続化する、検証用の opt-in (#1225)。
# リリース系の test が 2 回目以降も、レジストリへアクセスせずに依存を解決するための設定になる。
# 未設定（本番）は従来どおり使い捨てキャッシュを使う。
# 実配布では使わせない。古い packument のまま shrinkwrap を解決して配布しかねないため。
# dry-run でない実行を実配布とみなし、拒否する。
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

# --out-dir は構築の直前に rm -rf する。誤指定で既存資産を消さないよう、引数解釈の直後に
# 正規化し、次の 2 条件を満たすことを要求する。build を待たずに弾くため、この位置で確認する。
#   (a) REPO_ROOT の外にあること。リポ配下は .git の有無に関わらず、全域を対象外にする。
#   (b) 不在または空であること。$HOME やリポ外のサブディレクトリなど、
#       既存の内容を持つ場所は rm -rf の対象にしない。`/` もここで落ちる。
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
    VERSION="$(node -e "process.stdout.write(require('$TOOLS_ROOT/.claude-plugin/plugin.json').version)")"
fi
RELEASE_TAG="pecot-tools-v$VERSION"

# --- 1. 冪等性の確認 ---
# この確認は、dry-run 判定より後には置けない。nx release --dry-run は tag を作らない。
# そのため先にこの確認を通すと、dry-run が常に早期 return し、配布ツリーの構築を一度も検証しない。
# remote を照会せずローカル tag で判定するので、オフラインでも成立する。
# pecot-workflow / pecot-visual のみのリリースで、GitHub への到達性と認証がリリースの成否に結びつくことも避けられる。
if [ "$DRY_RUN" = false ]; then
    # git 自体の失敗と「タグが無い」を分ける。
    # 否定付きの `cmd | grep` は、cmd の失敗を errexit の対象外にしてしまう。
    # すると grep の不一致と同じ扱い（早期スキップ）になる。
    HEAD_TAGS="$(git -C "$REPO_ROOT" tag --points-at HEAD)"
    if ! printf '%s\n' "$HEAD_TAGS" | grep -Fxq "$RELEASE_TAG"; then
        echo "==> スキップ: HEAD に $RELEASE_TAG が無いため pecot-tools のリリースではありません"
        exit 0
    fi
    # 配布ツリーは、cli/dist・README テンプレート・manifest のいずれも作業ツリーから取る。
    # 「タグと配布物が対応している」根拠は、$RELEASE_TAG が指すコミットと作業ツリーが一致していることだけ。
    # そのため乖離した状態では publish しない。
    # gitignore 対象の cli/dist はここでは見えない。
    # ただし節 2 の build が作り直すことで、対応が保たれる（publish target は --skip-build を渡さない）。
    # LICENSE は git archive HEAD から写すので、作業ツリーの変更は配布物に影響しない。確認の対象にしない。
    DIRTY="$(git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-tools)"
    if [ -n "$DIRTY" ]; then
        echo "ERROR: plugins/pecot-tools に未コミットの変更があります。配布ツリーは作業ツリーから" >&2
        echo "       組み立てるため、$RELEASE_TAG が指すコミットと作業ツリーが一致した状態でのみ" >&2
        echo "       publish できます:" >&2
        echo "$DIRTY" >&2
        exit 1
    fi
fi

# ブランドの語の一覧が無いときは、build を始める前に止める。
# 配布ツリーの語の確認（shrinkwrap の後）が一覧を要求するため、build の後で気付くと手戻りが大きい。
if [ -z "${PECOT_BRAND_TERMS_FILE:-}" ] || [ ! -f "${PECOT_BRAND_TERMS_FILE:-}" ]; then
    echo "ERROR: ブランドの語の一覧が無いため中止: PECOT_BRAND_TERMS_FILE が未設定か、指す先がありません（現在: ${PECOT_BRAND_TERMS_FILE:-未設定}）。" >&2
    echo "       CLAUDE.md の「ブランドの語の確認」の節に従って、一覧ファイルの絶対パスを渡してください。" >&2
    exit 1
fi

echo "==> @pecot/tools-mcp 配布ツリーを構築 (version=$VERSION / dry-run=$DRY_RUN)"

# --- 2. build ---
# pnpm 起動コマンドの解決は、bin/_lib.sh (resolve_pnpm) に一本化する（run-tests.sh / run-lint.sh と共通）。
# shellcheck source=../../bin/_lib.sh
. "$TOOLS_ROOT/bin/_lib.sh"

if [ "$SKIP_BUILD" = false ]; then
    PNPM="$(resolve_pnpm "$TOOLS_ROOT")"
    if [ -z "$PNPM" ]; then
        echo "ERROR: pnpm / corepack / npx not found. Install Node.js 24.22.1+ in the 24.x line or 26.12.1+ (npm and npx are bundled) and retry." >&2
        HINT="$(pnpm_resolution_hint "$TOOLS_ROOT")"
        [ -n "$HINT" ] && echo "  $HINT" >&2
        exit 1
    fi
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    # run-tests.sh は build の前に install する。
    # publish は build を直接起動するので、node_modules 未導入の環境や、
    # リリースコミットで依存が変わった直後の環境では、install を経ずに build が失敗する。
    # そのため build の直前に install を固定する。
    echo "==> $PNPM install --frozen-lockfile (cwd=$TOOLS_ROOT)"
    # shellcheck disable=SC2086
    (cd "$TOOLS_ROOT" && $PNPM install --frozen-lockfile)
    echo "==> $PNPM --filter @pecot/pecot-tools-cli run build"
    # shellcheck disable=SC2086
    (cd "$TOOLS_ROOT" && $PNPM --filter @pecot/pecot-tools-cli run build)
fi

if [ ! -d "$TOOLS_ROOT/cli/dist" ]; then
    echo "ERROR: $TOOLS_ROOT/cli/dist がありません（--skip-build の指定誤り、または build 失敗）。" >&2
    exit 1
fi

# --- 3. 配布ツリーの構築 ---
CLEANUP_DIRS=()
# set -e 下の EXIT trap は、最後に実行したコマンドの非ゼロがそのまま終了コードになる。
# 元の rc を退避して明示 exit する（空配列時の判定失敗で成功実行が失敗扱いになるのを防ぐ）。
cleanup() {
    local rc=$?
    if [ "${#CLEANUP_DIRS[@]}" -gt 0 ]; then
        rm -rf "${CLEANUP_DIRS[@]}"
    fi
    exit "$rc"
}
trap cleanup EXIT

if [ -n "$OUT_DIR" ]; then
    # 指定の可否は、引数解釈の直後に確認済み。
    DIST="$OUT_DIR"
    rm -rf "$DIST"
else
    DIST="$(mktemp -d)"
    CLEANUP_DIRS+=("$DIST")
fi
mkdir -p "$DIST"

# 配布ルートからの階層はプラグインツリーと同じに保つ（cli/dist/version.js から ../.. が
# 配布ルート = plugin ルートの解決先）。build 成果物は .d.ts も含めて同梱する。
# ソースマップ（*.map）だけは写した後に消す。npm の配布物にソースマップを入れない（spec 018 US4）。
mkdir -p "$DIST/cli"
cp -a "$TOOLS_ROOT/cli/dist" "$DIST/cli/dist"
find "$DIST" -name '*.map' -type f -delete

cp "$SCRIPT_DIR/mcp-dist-README.md" "$DIST/README.md"

# MIT は許諾表示の同梱を条件にする。ルートの LICENSE を HEAD から写す。
git -C "$REPO_ROOT" archive HEAD LICENSE | tar -x -C "$DIST"

node "$SCRIPT_DIR/finalize-dist.mjs" "$DIST" "$VERSION" "$TOOLS_ROOT"

# bin shim。`cli.js` は self-execution ガードを持つ。
# そのため import しただけでは、何も出力せず exit 0 になる。
# main() を明示呼び出しし、登録例どおり引数なしで起動されたときだけ argv に `mcp` を注入する。
# 引数がある起動は、そのまま commander へ渡す（`--version` / `--help` をここで止めない）。
# バージョンの解決は cli/dist/version.js が import.meta.url 相対で行うため、env の注入は要らない。
mkdir -p "$DIST/bin"
cat > "$DIST/bin/pecot-tools-mcp.mjs" << 'BIN_SHIM'
#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 配布物は MCP サーバ専用エントリ。登録例が引数なしでも mcp として起動させる。
if (process.argv.length === 2) process.argv.push('mcp')
// 絶対パスの動的 import は Windows で ERR_UNSUPPORTED_ESM_URL_SCHEME になるため file URL を通す。
const { main } = await import(pathToFileURL(path.join(root, 'cli/dist/cli.js')).href)
main()
BIN_SHIM
chmod +x "$DIST/bin/pecot-tools-mcp.mjs"

echo "==> npm-shrinkwrap.json を生成"
# 依存解決は使い捨てキャッシュに閉じる。共有キャッシュに残った古いメタデータで解決結果が
# 実行ごとにずれるのを防ぐ。
# PECOT_RELEASE_TEST_NPM_CACHE があるときだけ（検証用。冒頭で実配布を拒否済み）そのディレクトリを
# 使い、prefer-offline で解決する (#1225)。
# 設定は環境変数でなく CLI フラグで渡す。npm は npm_config_* を大文字小文字を区別せず読み、
# 環境の NPM_CONFIG_* と競合し得るが、CLI フラグは常に環境変数に勝つ。
NPM_FLAGS=()
if [ -n "$NPM_CACHE_OPT_IN" ]; then
    NPM_CACHE="$NPM_CACHE_OPT_IN"
    NPM_FLAGS+=(--prefer-offline)
else
    NPM_CACHE="$(mktemp -d)"
    CLEANUP_DIRS+=("$NPM_CACHE")
fi
echo "==> npm レジストリへ依存を解決中"
# レジストリ不達時に、標準出力・標準エラーとも無出力のまま分単位で停止しないようにしたい。
# そのため fetch のタイムアウトと再試行回数を短く固定する。
# pre-push の nx affected test 経由だと、原因不明のハングとして現れるため。
(cd "$DIST" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund \
    --fetch-timeout=30000 --fetch-retries=1 \
    --cache="$NPM_CACHE" ${NPM_FLAGS[@]+"${NPM_FLAGS[@]}"} > /dev/null)
mv "$DIST/package-lock.json" "$DIST/npm-shrinkwrap.json"

DIST_SIZE="$(du -sh "$DIST" | cut -f1)" || DIST_SIZE=""
echo "==> 配布ツリー: $DIST ($DIST_SIZE)"

# 配布ツリーの全ファイル（cli/dist などの生成物を含む）の中身とパスの名前に、ブランドの語が無いことを確かめる。
# git を使わずファイルを全部たどる。dry-run でも実行し、一致したら pack へ進まない。
echo "==> ブランドの語の確認（配布ツリー）"
if ! "$REPO_ROOT/.githooks/pre-commit/check-brand-terms.sh" --require-terms --dir "$DIST"; then
    echo "ERROR: 配布ツリーにブランドの語が残っているか、語の確認を完了できませんでした。上の出力を確認してください。" >&2
    exit 1
fi

# --- 4. 固めて、届ける ---
# pack から gh の呼び出しまでは、リポジトリのルートの共通スクリプトが担う。
# pecot-visual の publish-mcp-dist.sh も同じスクリプトを呼ぶ。
ATTACH_ARGS=(--dist="$DIST" --tag="$RELEASE_TAG" --package="@pecot/tools-mcp" --version="$VERSION" --repo-root="$REPO_ROOT")
if [ "$DRY_RUN" = true ]; then
    ATTACH_ARGS+=(--dry-run)
fi
"$REPO_ROOT/.githooks/scripts/attach-mcp-tgz.sh" "${ATTACH_ARGS[@]}"
