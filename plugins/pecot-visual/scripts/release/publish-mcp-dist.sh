#!/usr/bin/env bash
# pecot-visual MCP サーバを npm へ出す準備をする (#982)。
#
# nx release の publish phase から `pecot-visual:nx-release-publish` target 経由で起動される。
# プラグイン未導入の環境でも、`npx -y @pecot/visual-mcp` を 1 エントリ登録するだけで
# MCP サーバを使えるようにしたい。
# そのため、ビルド済みの配布ツリーを `npm pack` で tgz に固め、GitHub Release に添える。
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

# git hook (pre-push 等) から起動されると、git が GIT_DIR / GIT_INDEX_FILE を export する。
# その状態では `git -C <dir>` の -C が無視され、**呼び出し元リポの index** が書き換わる。
# 手元で確認した例では、GIT_DIR を設定して `git -C <別リポ> add -A` を実行すると、
# 呼び出し元の ls-files が 8173 件から 1 件になった。
# 本スクリプトは REPO_ROOT と一時ディレクトリの双方へ git を発行し得る。
# そのため、継承した git env は先頭で必ず捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE


SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PECOTV_ROOT="$REPO_ROOT/plugins/pecot-visual"
# eslint プラグインの置き場所。build の前に dist を消し、配布ツリーへ dist を写す元になる。
# 既定は実ツリー。テストは偽の build と組み合わせて一時の写しを指し、並行する別のテストが読む実ツリーの dist を消さない。
ESLINT_PLUGINS_DIR="${PECOTV_ESLINT_PLUGINS_DIR:-$PECOTV_ROOT/assets/slidev/scripts/eslint}"

VERSION=""
OUT_DIR=""
DRY_RUN=false
SKIP_BUILD=false
AUDIT_RECORD="${PECOTV_AUDIT_RECORD:-$REPO_ROOT/.nx/release-audit/pecotv-audit.json}"

case "${NX_DRY_RUN:-}" in
    true | 1) DRY_RUN=true ;;
esac

for arg in "$@"; do
    case "$arg" in
        --version=*) VERSION="${arg#--version=}" ;;
        --out-dir=*) OUT_DIR="${arg#--out-dir=}" ;;
        --dry-run) DRY_RUN=true ;;
        --skip-build) SKIP_BUILD=true ;;
        --audit-record=*) AUDIT_RECORD="${arg#--audit-record=}" ;;
        *)
            echo "ERROR: 未対応の引数: $arg" >&2
            echo "       使用可能: --version=<ver>|--out-dir=<dir>|--dry-run|--skip-build|--audit-record=<path>" >&2
            exit 1
            ;;
    esac
done

# 依存解決の npm キャッシュを永続化する、検証用の opt-in (#1225)。
# リリース系の test が 2 回目以降も、レジストリへアクセスせずに依存を解決するための設定になる。
# 未設定（本番）は従来どおり使い捨てキャッシュを使う。
# 実配布では使わせない: 古い packument のまま shrinkwrap を解決して配布しかねない。
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
    VERSION="$(node -e "process.stdout.write(require('$PECOTV_ROOT/.claude-plugin/plugin.json').version)")"
fi
RELEASE_TAG="pecot-visual-v$VERSION"

# --- 1. 冪等性の確認 ---
# この確認は、dry-run 判定より後には置けない。nx release --dry-run は tag を作らない。
# そのため先にこの確認を通すと、dry-run が常に早期 return し、配布ツリーの構築を一度も検証しない。
# remote を照会せずローカル tag で判定するので、オフラインでも成立する。
# pecot-workflow 単独のリリースで、GitHub への到達性と認証がリリースの成否に結びつくことも避けられる。
if [ "$DRY_RUN" = false ]; then
    if ! git -C "$REPO_ROOT" tag --points-at HEAD | grep -Fxq "$RELEASE_TAG"; then
        echo "==> スキップ: HEAD に $RELEASE_TAG が無いため pecot-visual のリリースではありません"
        exit 0
    fi
    # 配布ツリーは、テンプレートを HEAD (git archive) から、dist を作業ツリーから取る。
    # 作業ツリーが HEAD と乖離していると、$RELEASE_TAG が指すコミットに対応しない dist を
    # 配布するおそれがある。--skip-build を付けた場合は、build による上書きも起きない。
    # 混在を防ぐため、plugins/pecot-visual、libs/text-rules が
    # HEAD と一致していることを、publish の前提にする。
    DIRTY="$(git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-visual libs/text-rules)"
    if [ -n "$DIRTY" ]; then
        echo "ERROR: plugins/pecot-visual / libs/text-rules に未コミットの変更があります。" >&2
        echo "       配布ツリーは HEAD 由来のテンプレートと、作業ツリー由来の dist を混在させます。" >&2
        echo "       $RELEASE_TAG が指すコミットと作業ツリーが一致した状態でのみ publish できます:" >&2
        echo "$DIRTY" >&2
        exit 1
    fi
fi

# --- 2. 監査記録の確認 ---
# audit-mcp-dist.sh が version 作成前に書いた記録を読み、
# 監査したツリーと、これから配布するツリーが対応することを確かめる (#1059)。
# ここで見るのは記録の素性だけで、対象は存在・スキップ有無・監査時 HEAD・severity になる。
# 指紋の突合は shrinkwrap の生成後（セクション 4）に行う。
# 確認はいずれも pack / upload より前に行うので、止まった時点で Release には何も残らない。
#
# この突合は、監査したツリーと配布ツリーの取り違えやドリフトを見つける検出器にとどまる。
# 改竄の防止にはならない。記録は git 管理外の平文で置かれている。
#
# 記録の解釈は audit-record.mjs に委ねる。スキーマはこのモジュールだけが定義し、
# audit-mcp-dist.sh の書き手も同じモジュールを使う。
# 存在しない記録、読めない記録、スキーマを満たさない記録は、止めずに通すことをしない。
# 出力は status / fingerprint / head / blocking の 1 フィールド 1 行とする。
# 監査は配布ツリーと永続層の 2 ツリーを見る。publish が突合できるのは配布ツリーだけなので、
# fingerprint は記録にある配布ツリーの指紋を、blocking は両ツリーの合計を受ける。
# タブ区切りの read は、タブが IFS の空白に当たるため、空フィールドが畳まれて値が 1 つずれる。
# mapfile は IFS を使わず空行を保持するので、こちらを使う。
mapfile -t RECORD_FIELDS < <(node "$SCRIPT_DIR/audit-record.mjs" read "$AUDIT_RECORD")
RECORD_STATUS="${RECORD_FIELDS[0]:-}"
RECORD_FP="${RECORD_FIELDS[1]:-}"
RECORD_HEAD="${RECORD_FIELDS[2]:-}"
RECORD_BLOCKING="${RECORD_FIELDS[3]:-0}"

# 監査がスキップされたリリース（pecot-visual 非対象）。dry-run は突合対象が無い状態の
# プレビューとして続行し、本実行は配布しない。
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
# pnpm 起動コマンドの解決は bin/_lib.sh の resolve_pnpm が担う。
# run-tests.sh と run-lint.sh も同じ関数を使う。
# shellcheck source=../../bin/_lib.sh
. "$PECOTV_ROOT/bin/_lib.sh"

# 以下の 2 つは、scripts/ci/install.sh:20-25 と同じ理由で置く。
# 1 つ目は playwright postinstall のブラウザ DL (~180MB) を抑止する。
# 2 つ目は nx run-commands が注入する FORCE_COLOR=true を除去し、
# nx 経由の実行と直接の実行で挙動が割れるのを防ぐ。
# build 時の `npm install --package-lock-only` にも作用する。
# `--skip-build` を付けた場合と env を揃えるため、if の外に置く。
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
unset FORCE_COLOR

if [ "$SKIP_BUILD" = false ]; then
    PNPM="$(resolve_pnpm "$PECOTV_ROOT")"
    if [ -z "$PNPM" ]; then
        echo "ERROR: pnpm / corepack / npx not found. Install Node.js 24.22.1+ in the 24.x line or 26.12.1+ (npm and npx are bundled) and retry." >&2
        HINT="$(pnpm_resolution_hint "$PECOTV_ROOT")"
        [ -n "$HINT" ] && echo "  $HINT" >&2
        exit 1
    fi
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    # run-tests.sh は build の前に install する。
    # 一方 publish は build を直接起動するため、node_modules が未導入の環境や、
    # リリースコミットで依存が変わった直後の環境では、install を経ずに build が落ちる。
    # そこで build の直前に install を固定する。
    # 導入の手順は scripts/ci/dev-install-lib.sh を参照。
    # shellcheck source=../ci/dev-install-lib.sh
    . "$PECOTV_ROOT/scripts/ci/dev-install-lib.sh"
    pecotv_dev_install "$PECOTV_ROOT" "$PNPM"
    echo "==> $PNPM --filter @pecot/pecotv-cli run build"
    # shellcheck disable=SC2086
    (cd "$PECOTV_ROOT" && $PNPM --filter @pecot/pecotv-cli run build)
    # build は tsc -b で、削除したソースに対応する dist を掃除しない。
    # 古い dist が残ると、消したモジュールが配布へそのまま同梱される。
    # tsbuildinfo も dist の中にあるので、dist ごと消せば全部作り直される。
    rm -rf "${ESLINT_PLUGINS_DIR:?}"/*/dist
    echo "==> $PNPM --filter @pecot/slidev-assets-dev run build (eslint プラグイン dist を含む)"
    # shellcheck disable=SC2086
    (cd "$PECOTV_ROOT" && $PNPM --filter @pecot/slidev-assets-dev run build)
    # 同梱する text-rules の dist。依存は済んでいるので build だけ行う。
    echo "==> $PNPM --filter @pecot/text-rules-src run build"
    # shellcheck disable=SC2086
    (cd "$REPO_ROOT" && $PNPM --filter @pecot/text-rules-src run build)
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

# working tree の生成物を混ぜないため、HEAD の内容を起点にする。
# --strip-components=2 で `plugins/pecot-visual/` を落とし、プラグインツリーと同じ深さを保つ。
# assets/slidev が深さ 2、assets/slidev/runtime が深さ 3 で、cli/dist/version.js から ../.. が配布ルートになる。
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

# eslint プラグインの tests/ は skills/ を 8 階層上へ逆参照する parity テストを含み、
# 配布ツリー内で実行すると必ず落ちるため同梱しない。
find "$DIST/assets/slidev/scripts/eslint" -type d -name tests -prune -exec rm -rf {} +

# .gitignore を持ち込むと、その `dist/` などが npm の除外規則として働く。
# すると eslint プラグイン dist が、気付かないまま tgz から落ちる。手元で再現を確認した。
find "$DIST" -name '.gitignore' -delete

mkdir -p "$DIST/cli"
cp -a "$PECOTV_ROOT/cli/dist" "$DIST/cli/dist"

# text-rules の build 済み dist。finalize-dist.mjs が text-constraints dist の import を
# この実体への相対パスへ書き換える。dist/package.json の {type: module} も一緒に入る。
mkdir -p "$DIST/vendor/text-rules"
cp -a "$REPO_ROOT/libs/text-rules/dist" "$DIST/vendor/text-rules/dist"

# npm の配布物にソースマップを入れない（spec 018 US4）。
# 写し終えた cli/dist・eslint の dist・vendor/text-rules/dist から取り除く。
# finalize-dist.mjs が配布ツリーを書き換える前に消す。
find "$DIST" -name '*.map' -type f -delete

cp "$SCRIPT_DIR/mcp-dist-README.md" "$DIST/README.md"

# MIT は許諾表示の同梱を条件にする。ルートの LICENSE を HEAD から写す。
git -C "$REPO_ROOT" archive HEAD LICENSE | tar -x -C "$DIST"

node "$SCRIPT_DIR/finalize-dist.mjs" "$DIST" "$VERSION" "$PECOTV_ROOT" "$REPO_ROOT"

# bin shim。`cli.js` は self-execution ガードを持つため、import しただけでは何も出さず exit 0 になる。
# main() を明示呼び出しし、登録例どおり引数なしで起動されても mcp として振る舞うよう
# argv に `mcp` を注入する。
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

echo "==> npm-shrinkwrap.json を生成"
# 依存解決は使い捨てキャッシュに閉じる（audit-mcp-dist.sh と同条件）。共有キャッシュに
# 残った古いメタデータで解決結果が監査時とずれるのを防ぐ。
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
(cd "$DIST" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund \
    --cache="$NPM_CACHE" ${NPM_FLAGS[@]+"${NPM_FLAGS[@]}"} > /dev/null)
mv "$DIST/package-lock.json" "$DIST/npm-shrinkwrap.json"

# 監査した依存ツリーとの突合。dry-run の早期 return より前に置く（dry-run でも
# 指紋の一致を出力に残すため）。突合相手は記録の配布ツリー指紋 (dist)。永続層 (runtime) は
# publish の対象外で、記録に残る指紋は監査時点の証跡でしかない。
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
# pack から gh の呼び出しまでは、リポジトリのルートの共通スクリプトが担う。
# pecot-tools の publish-mcp-dist.sh も同じスクリプトを呼ぶ。
ATTACH_ARGS=(--dist="$DIST" --tag="$RELEASE_TAG" --package="@pecot/visual-mcp" --version="$VERSION" --repo-root="$REPO_ROOT")
if [ "$DRY_RUN" = true ]; then
    ATTACH_ARGS+=(--dry-run)
fi
"$REPO_ROOT/.githooks/scripts/attach-mcp-tgz.sh" "${ATTACH_ARGS[@]}"
