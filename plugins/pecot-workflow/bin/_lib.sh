# pecot-workflow bin shared helpers — bin/pecot が source する共通関数。
# sourced 前提のため shebang は付けず、`set -e` も付けない（呼び出し側の設定に従う）。
# bash 3.2（macOS 標準）でも動く書き方に限る。
#
# data-dir ブロック（下の 2 本のマーカーの間）は pecot-visual / pecot-tools の bin/_lib.sh と逐語一致させる。
# プラグインは導入先へ単体でコピーされるため、他プラグインのファイルを source する形にはできない。
# project 名は引数で受けるので、ブロックの中に固有名は書かない。
# pnpm ブロック（data-dir の後）は、Node 側（cli-node/）の依存導入に使う。scripts/ci/*.sh が source する。

# --- data-dir: 3 本で逐語一致 ---

# 値が有効なデータ置き場（空でない絶対パスで、未展開のプレースホルダでないもの）なら、改行と CR を落として出し 0 を返す。実在は問わない。
# 引数: $1 = 判定する値
plugin_data_dir_normalize() {
    local value="${1:-}"
    while :; do
        case "$value" in
            *$'\n' | *$'\r') value="${value%?}" ;;
            *) break ;;
        esac
    done
    case "$value" in
        '' | '${'*) return 1 ;;
        /*) ;;
        *) return 1 ;;
    esac
    printf '%s\n' "$value"
}

# データ置き場を解決して出す（何も作らない）。順序は CLAUDE_PLUGIN_DATA、PLUGIN_DATA、${XDG_DATA_HOME}/pecot/<project>、${HOME}/.local/share/pecot/<project>。
# dependency-root.ts の解決と同じ結果になること（テストが固定する）。引数: $1 = project 名
plugin_data_dir_resolve() {
    local project="${1:-}" base home
    [ -n "$project" ] || { echo "plugin_data_dir_resolve: project name is required" >&2; exit 127; }
    plugin_data_dir_normalize "${CLAUDE_PLUGIN_DATA:-}" && return 0
    plugin_data_dir_normalize "${PLUGIN_DATA:-}" && return 0
    if base="$(plugin_data_dir_normalize "${XDG_DATA_HOME:-}")"; then
        printf '%s\n' "${base}/pecot/${project}"
        return 0
    fi
    if home="$(plugin_data_dir_normalize "${HOME:-}")"; then
        printf '%s\n' "${home}/.local/share/pecot/${project}"
        return 0
    fi
    echo "${project}: cannot decide the data directory because HOME is unset or not an absolute path (fix: set HOME or XDG_DATA_HOME)" >&2
    return 1
}

# plugin_data_dir_resolve の結果を mkdir -p で作って stdout に出す。解決または作成に失敗したら理由を stderr に出して 1 を返す。
# 引数: $1 = project 名
plugin_data_dir_ensure() {
    local project="${1:-}" data
    [ -n "$project" ] || { echo "plugin_data_dir_ensure: project name is required" >&2; exit 127; }
    data="$(plugin_data_dir_resolve "$project")" || return 1
    if ! mkdir -p "$data" 2>/dev/null; then
        echo "${project}: cannot create the data directory: ${data}" >&2
        return 1
    fi
    printf '%s\n' "$data"
}

# --- end data-dir ---

# --- pnpm: Node 側（cli-node/）の依存導入に使う helper。scripts/ci/*.sh が source する ---

# pnpm の起動コマンドを返す（pnpm / corepack pnpm / plugin_npx_pnpm <版> / 空）。Node.js 25 以降は corepack が無いため npx で版を固定して起動する。
# 引数: $1 = plugin root（package.json の packageManager から版を読む）
resolve_pnpm() {
    local plugin_root="${1:-}"
    if command -v pnpm >/dev/null 2>&1; then
        echo "pnpm"
    elif command -v corepack >/dev/null 2>&1; then
        echo "corepack pnpm"
    elif command -v npx >/dev/null 2>&1; then
        local version
        version="$(pnpm_version_from_manifest "$plugin_root")"
        if [ -n "$version" ]; then
            echo "plugin_npx_pnpm $version"
        else
            echo ""
        fi
    else
        echo ""
    fi
}

# npm 11 は devEngines.packageManager に pnpm があると npx も EBADDEVENGINES で止めるため、cwd を / にして --dir で対象を指す。
# 引数: $1 = pnpm の版、残り = pnpm への引数
plugin_npx_pnpm() {
    local version="$1" dir="$PWD"
    shift
    (cd / && npx --yes "pnpm@$version" --dir "$dir" "$@")
}

# packageManager から pnpm の版だけを返す（無ければ空）。`[0-9.]*` だと pnpm@10.0.0-beta.1 の `-beta.1` が落ちるため `[^+"]*` を使う。
pnpm_version_from_manifest() {
    local manifest="${1:-}/package.json"
    [ -f "$manifest" ] || return 0
    sed -n 's/.*"packageManager": *"pnpm@\([^+"]*\).*/\1/p' "$manifest" | head -n 1
}

# resolve_pnpm が空のとき、npx はあるのに packageManager の版を読めないケースだけヒントを返す。それ以外は空。
pnpm_resolution_hint() {
    local plugin_root="${1:-}"
    if command -v pnpm >/dev/null 2>&1 || command -v corepack >/dev/null 2>&1; then
        echo ""
        return
    fi
    if command -v npx >/dev/null 2>&1; then
        local version
        version="$(pnpm_version_from_manifest "$plugin_root")"
        if [ -z "$version" ]; then
            echo "npx is available but the pnpm version could not be read from packageManager in ${plugin_root}/package.json (fix: check the plugin root and the packageManager field)"
            return
        fi
    fi
    echo ""
}
