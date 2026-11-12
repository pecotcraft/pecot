#!/usr/bin/env bash
# shellcheck disable=SC2034
# 各プラグインの publish-mcp-dist.sh が source する共通の関数。単独では実行しない。
#
# 呼び出し側は先に REPO_ROOT（pwd -P の物理パス）を決め、mcp_publish_defaults を呼ぶ。
# 共有するのは引数・--out-dir・タグ判定・shrinkwrap・tgz の添付で、build と配布ツリーの中身は各プラグインに残す。

# git hook から継承した GIT_DIR 等は `git -C` を無視させ、呼び出し元の index を書き換える。
# nx run-commands が注入する FORCE_COLOR は、nx 経由と直接実行で挙動を割る。
mcp_publish_sanitize_env() {
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
        GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE
    unset FORCE_COLOR
}

# 引数の既定値。NX_DRY_RUN は nx release --dry-run からの伝播。
mcp_publish_defaults() {
    VERSION=""
    OUT_DIR=""
    DRY_RUN=false
    SKIP_BUILD=false
    case "${NX_DRY_RUN:-}" in
        true | 1) DRY_RUN=true ;;
    esac
}

# 共通の引数を 1 つ解釈する。解釈したら 0、共通でなければ 1 を返す。
mcp_publish_parse_arg() {
    case "$1" in
        --version=*) VERSION="${1#--version=}" ;;
        --out-dir=*) OUT_DIR="${1#--out-dir=}" ;;
        --dry-run) DRY_RUN=true ;;
        --skip-build) SKIP_BUILD=true ;;
        *) return 1 ;;
    esac
}

# 未対応の引数で止める。$1 = 引数、$2 = プラグイン固有の使用可能な引数（`|--x=<v>` の形、省略可）。
mcp_publish_unknown_arg() {
    echo "ERROR: 未対応の引数: $1 (使用可能: --version=<ver>|--out-dir=<dir>|--dry-run|--skip-build${2:-})" >&2
    exit 1
}

# 検証用の opt-in。実配布（dry-run でない実行）では拒否する。結果は NPM_CACHE_OPT_IN に入る。
mcp_publish_check_npm_cache_opt_in() {
    NPM_CACHE_OPT_IN="${PECOT_RELEASE_TEST_NPM_CACHE:-}"
    [ -n "$NPM_CACHE_OPT_IN" ] || return 0
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
}

# --out-dir は構築の直前に rm -rf するため、build の前に REPO_ROOT の外で、不在か空であることを確かめる。
mcp_publish_validate_out_dir() {
    [ -n "$OUT_DIR" ] || return 0
    if [ -e "$OUT_DIR" ] && [ ! -d "$OUT_DIR" ]; then
        echo "ERROR: --out-dir がディレクトリではありません: $OUT_DIR" >&2
        exit 1
    fi
    if [ -d "$OUT_DIR" ]; then
        OUT_DIR="$(cd "$OUT_DIR" && pwd -P)"
    else
        # 未作成の path は、親を実体解決してから結合する。symlink・相対・.. はここで解消する。
        local out_parent out_parent_missing
        out_parent="$(cd "$(dirname "$OUT_DIR")" 2> /dev/null && pwd -P)" || out_parent=""
        if [ -z "$out_parent" ]; then
            out_parent_missing="$(dirname "$OUT_DIR")" || true
            echo "ERROR: --out-dir の親ディレクトリがありません: $out_parent_missing" >&2
            exit 1
        fi
        OUT_DIR="${out_parent%/}/$(basename "$OUT_DIR")"
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
}

# 本実行のとき、HEAD にリリースのタグが無ければ何もせず終了し、作業ツリーに差分があれば止める。
# dry-run はタグを作らないので、この確認は dry-run の判定より前に置けない。
# $1 = タグ、$2 = プラグイン名、$3... = 差分を見るパス。
mcp_publish_require_release_head() {
    local tag="$1" plugin="$2" head_tags dirty
    shift 2
    [ "$DRY_RUN" = false ] || return 0
    # 否定付きの `cmd | grep` は cmd の失敗を errexit の対象外にするので、git の失敗と「タグが無い」を分ける。
    head_tags="$(git -C "$REPO_ROOT" tag --points-at HEAD)"
    if ! printf '%s\n' "$head_tags" | grep -Fxq "$tag"; then
        echo "==> スキップ: HEAD に $tag が無いため $plugin のリリースではありません"
        exit 0
    fi
    # タグと配布物の対応は、タグの指すコミットと作業ツリーの一致だけが根拠になる。
    dirty="$(git -C "$REPO_ROOT" status --porcelain -- "$@")"
    if [ -n "$dirty" ]; then
        echo "ERROR: $* に未コミットの変更があります。配布ツリーは作業ツリーから" >&2
        echo "       組み立てるため、$tag が指すコミットと作業ツリーが一致した状態でのみ" >&2
        echo "       publish できます:" >&2
        echo "$dirty" >&2
        exit 1
    fi
}

CLEANUP_DIRS=()
# EXIT trap は最後のコマンドの非ゼロが終了コードになるので、元の rc を退避して明示 exit する。
mcp_publish_cleanup() {
    local rc=$?
    if [ "${#CLEANUP_DIRS[@]}" -gt 0 ]; then
        rm -rf "${CLEANUP_DIRS[@]}"
    fi
    exit "$rc"
}

# 配布ツリーの置き場 DIST を空で作る。--out-dir が無ければ使い捨てで、終了時に消す。
mcp_publish_make_dist() {
    trap mcp_publish_cleanup EXIT
    if [ -n "$OUT_DIR" ]; then
        DIST="$OUT_DIR"
        rm -rf "$DIST"
    else
        DIST="$(mktemp -d)"
        CLEANUP_DIRS+=("$DIST")
    fi
    mkdir -p "$DIST"
}

# npm-shrinkwrap.json を作る。依存解決は使い捨てキャッシュに閉じ、opt-in があるときだけ prefer-offline で永続キャッシュを使う。
# 設定は環境変数でなく CLI フラグで渡す（フラグは環境の NPM_CONFIG_* に勝つ）。
mcp_publish_write_shrinkwrap() {
    local dist="$1" npm_cache
    local npm_flags=()
    echo "==> npm-shrinkwrap.json を生成"
    if [ -n "${NPM_CACHE_OPT_IN:-}" ]; then
        npm_cache="$NPM_CACHE_OPT_IN"
        npm_flags+=(--prefer-offline)
    else
        npm_cache="$(mktemp -d)"
        CLEANUP_DIRS+=("$npm_cache")
    fi
    echo "==> npm レジストリへ依存を解決中"
    # レジストリ不達で無出力のまま分単位で止まらないよう、タイムアウトと再試行を短く固定する。
    (cd "$dist" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund \
        --fetch-timeout=30000 --fetch-retries=1 \
        --cache="$npm_cache" ${npm_flags[@]+"${npm_flags[@]}"} > /dev/null)
    mv "$dist/package-lock.json" "$dist/npm-shrinkwrap.json"
}

# pack から gh の呼び出しまでは、ルートの共通スクリプトが担う。$1 = npm のパッケージ名。
mcp_publish_attach() {
    local attach_args=(--dist="$DIST" --tag="$RELEASE_TAG" --package="$1" --version="$VERSION" --repo-root="$REPO_ROOT")
    if [ "$DRY_RUN" = true ]; then
        attach_args+=(--dry-run)
    fi
    "$REPO_ROOT/.githooks/scripts/attach-mcp-tgz.sh" "${attach_args[@]}"
}
