#!/usr/bin/env bash
# MCP サーバの配布ツリーを npm pack で tgz に固め、GitHub Release に添えて publish-npm.yml を起動する。
#
# plugins/pecot-visual と plugins/pecot-tools の publish-mcp-dist.sh が、配布ツリーを組み立てた後に呼ぶ。
# 2 本で同じ処理を持つと、片方だけ直して食い違う（#74 のレビューで gh release view の扱いが割れた）。
# そのため pack から gh の 3 回の呼び出しまでを、ここに 1 本化している。
# 配布ツリーの組み立て（build・shrinkwrap）はプラグインごとに違うので、呼び出し側に残す。
#
#   --dist=<dir>      npm pack する配布ツリー。
#   --tag=<tag>       Release のタグ。workflow の --ref にも使う。
#   --package=<name>  表示に使うパッケージ名。
#   --version=<ver>   表示に使う版。
#   --repo-root=<dir> origin を読むリポジトリ。
#   --dry-run         pack までを実施し、gh release view / upload / workflow run は表示だけにする。
set -euo pipefail

# git hook から起動されたときに継承した git env は、先頭で捨てる（publish-mcp-dist.sh と同じ理由）。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

DIST=""
TAG=""
PACKAGE=""
VERSION=""
REPO_ROOT=""
DRY_RUN=false

for arg in "$@"; do
    case "$arg" in
        --dist=*) DIST="${arg#--dist=}" ;;
        --tag=*) TAG="${arg#--tag=}" ;;
        --package=*) PACKAGE="${arg#--package=}" ;;
        --version=*) VERSION="${arg#--version=}" ;;
        --repo-root=*) REPO_ROOT="${arg#--repo-root=}" ;;
        --dry-run) DRY_RUN=true ;;
        *)
            echo "ERROR: 未対応の引数: $arg (使用可能: --dist=<dir>|--tag=<tag>|--package=<name>|--version=<ver>|--repo-root=<dir>|--dry-run)" >&2
            exit 1
            ;;
    esac
done

for required in DIST TAG PACKAGE VERSION REPO_ROOT; do
    if [ -z "${!required}" ]; then
        echo "ERROR: $required に当たる引数がありません。" >&2
        exit 1
    fi
done
if [ ! -d "$DIST" ]; then
    echo "ERROR: --dist がディレクトリではありません: $DIST" >&2
    exit 1
fi

PACK_DIR="$(mktemp -d)"
cleanup() {
    local rc=$?
    rm -rf "$PACK_DIR"
    exit "$rc"
}
trap cleanup EXIT

# --- 1. 固める ---
echo "==> npm pack"
PACK_JSON="$(cd "$DIST" && npm pack --json --ignore-scripts --pack-destination "$PACK_DIR")"
# 名前と中身の一覧は pack の JSON から取る。
mapfile -t PACK_INFO < <(printf '%s' "$PACK_JSON" | node -e '
const [pack] = JSON.parse(require("fs").readFileSync(0, "utf8"))
console.log(pack.filename)
for (const f of pack.files) console.log(f.path)
')
TGZ_NAME="${PACK_INFO[0]:-}"
TGZ="$PACK_DIR/$TGZ_NAME"
if [ -z "$TGZ_NAME" ] || [ ! -f "$TGZ" ]; then
    echo "ERROR: npm pack が tgz を作りませんでした: $TGZ" >&2
    exit 1
fi
echo "==> tgz: $TGZ_NAME"
echo "==> tgz の中身（$(( ${#PACK_INFO[@]} - 1 )) ファイル）"
printf '    %s\n' "${PACK_INFO[@]:1}"

# --- 2. 届ける ---
# gh には -R を明示する。値は nx が Release を作る origin の URL から求める。
# remote が増えても、gh だけ別のリポを向かない。
# URL の解析は nx（extract-repo-slug.js）と同じく node の new URL() で行う。
# sed で剥がすと、ポート付きの ssh:// や末尾の / が owner/name に残ってしまう。
ORIGIN_URL="$(git -C "$REPO_ROOT" remote get-url origin)"
GH_REPO="$(node "$(dirname "${BASH_SOURCE[0]}")/origin-slug.mjs" "$ORIGIN_URL")"
if ! printf '%s' "$GH_REPO" | grep -Eq '^[^/]+/[^/]+$'; then
    echo "ERROR: origin の URL から owner/name を求められません: $ORIGIN_URL" >&2
    exit 1
fi

if [ "$DRY_RUN" = true ]; then
    echo "==> dry-run のため gh は実行しません。次を実行します:"
    echo "    gh release view $TAG -R $GH_REPO"
    echo "    gh release upload $TAG $TGZ_NAME --clobber -R $GH_REPO"
    echo "    gh workflow run publish-npm.yml -f tag=$TAG --ref $TAG -R $GH_REPO"
    echo "    (注: 版は version の段階より前の値です。本実行では、nx が上げた版のタグになります)"
    exit 0
fi

# Release は nx の changelog の段階で作られている。無ければ upload は失敗するので、先に見て案内する。
# 認証切れやネットワークの失敗でも同じ分岐に入る。Release が無いとは言い切らず、gh の出力を添える。
echo "==> gh release view $TAG -R $GH_REPO"
if ! RELEASE_ERR="$(gh release view "$TAG" -R "$GH_REPO" 2>&1 > /dev/null)"; then
    echo "ERROR: Release $TAG を確認できません: $RELEASE_ERR" >&2
    echo "       Release が無いときは、Release を作ってから pnpm exec nx release publish を再実行してください。" >&2
    exit 1
fi
echo "==> gh release upload $TAG $TGZ_NAME --clobber -R $GH_REPO"
gh release upload "$TAG" "$TGZ" --clobber -R "$GH_REPO"
echo "==> gh workflow run publish-npm.yml -f tag=$TAG --ref $TAG -R $GH_REPO"
gh workflow run publish-npm.yml -f "tag=$TAG" --ref "$TAG" -R "$GH_REPO"

echo "==> $PACKAGE v$VERSION を Release に添え、publish-npm.yml を起動しました ($GH_REPO)"
