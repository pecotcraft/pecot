# pecot-tools の pnpm の解決 — scripts/ci/*.sh と scripts/release/publish-mcp-dist.sh が source する。shebang と `set -e` は付けない。

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
