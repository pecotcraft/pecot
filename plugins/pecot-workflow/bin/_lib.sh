# pecot-workflow bin shared helpers — bin/pecot が source する共通関数。
# sourced 前提のため shebang は付けず、`set -e` も付けない（呼び出し側の設定に従う）。
# bash 3.2（macOS 標準）でも動く書き方に限る。
#
# data-dir ブロック（下の 2 本のマーカーの間）は pecot-visual / pecot-tools の bin/_lib.sh と逐語一致させる。
# プラグインは導入先へ単体でコピーされるため、他プラグインのファイルを source する形にはできない。
# project 名は引数で受けるので、ブロックの中に固有名は書かない。
# pnpm ブロック（data-dir の後）は、Node 側（cli-node/）の依存導入に使う。scripts/ci/*.sh が source する。

# --- data-dir: 3 本で逐語一致 ---

# 値がデータ置き場として有効なら、末尾の改行と CR を落とした値を stdout に出して 0 を返す。無効なら 1 を返す。
# 有効な値は、空でない絶対パスで、クライアントが展開しなかったプレースホルダ（先頭がドル記号と波括弧）ではないもの。
# 実在は問わない。クライアントが渡す値はまだ作られていないことがあるため。
# 作成は plugin_data_dir_ensure が行う。
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

# データ置き場を解決して stdout に出す。何も作らない。解決の順序は次のとおり。
#   1. CLAUDE_PLUGIN_DATA。hook と MCP に、Claude Code と Copilot CLI が渡す。
#   2. PLUGIN_DATA。Agent Plugins 1.0 の MCP に渡す env、または単体配布の登録の env。
#   3. 既定の場所 ${XDG_DATA_HOME}/pecot/<project 名>。
#      XDG_DATA_HOME が絶対パスでなければ未設定として扱い、HOME が絶対パスのときだけ ${HOME}/.local/share/pecot/<project 名> を使う。
# HOME と XDG_DATA_HOME がどちらも有効でないときだけ、理由を stderr に 1 行出して 1 を返す。
# SKIP（*_BOOTSTRAP_SKIP=1）の判定は呼び出し側が先に行う。
# cli/src/infra/_shared/dependency-root.ts の解決と同じ結果になること（テストが固定する）。
# 引数: $1 = project 名（pecot-workflow / pecot-visual / pecot-tools）
plugin_data_dir_resolve() {
    local project="${1:-}" base home
    [ -n "$project" ] || { echo "plugin_data_dir_resolve: project 名が必要です" >&2; exit 127; }
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
    echo "${project}: HOME が設定されておらず（または絶対パスでなく）、データ置き場を決められません。HOME か XDG_DATA_HOME を設定してください。" >&2
    return 1
}

# plugin_data_dir_resolve の結果を mkdir -p で作って stdout に出す。解決または作成に失敗したら理由を stderr に出して 1 を返す。
# 引数: $1 = project 名
plugin_data_dir_ensure() {
    local project="${1:-}" data
    [ -n "$project" ] || { echo "plugin_data_dir_ensure: project 名が必要です" >&2; exit 127; }
    data="$(plugin_data_dir_resolve "$project")" || return 1
    if ! mkdir -p "$data" 2>/dev/null; then
        echo "${project}: データ置き場を作れません（${data}）。" >&2
        return 1
    fi
    printf '%s\n' "$data"
}

# --- end data-dir ---

# --- pnpm: Node 側（cli-node/）の依存導入に使う helper。scripts/ci/*.sh が source する ---

# pnpm 起動コマンドを解決する。
# 利用者環境に pnpm が無くても、corepack または npx 経由で透過的に起動できるようにする。
# corepack は Node.js 16.9〜24 に同梱されていて、`corepack pnpm <args>` は enable 不要で透過的に起動できる。
# Node.js 25 以降は corepack を同梱しない。
# その場合は、npm 同梱の npx で、packageManager に固定したバージョンの pnpm を取得して起動する。
# 引数: $1 = plugin root。package.json の packageManager から pnpm のバージョンを読む。
# 戻り値: stdout に「pnpm」「corepack pnpm」「npx --yes pnpm@<バージョン>」「（空文字列）」のいずれか
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
            echo "npx --yes pnpm@$version"
        else
            echo ""
        fi
    else
        echo ""
    fi
}

# package.json の packageManager（例: pnpm@12.15.0+sha512...）から pnpm のバージョンだけを返す。
# manifest が無い、または宣言が無いときは、空文字列を返す。
# `[^+"]*` で `+`（ビルドメタデータ区切り）または閉じる `"` の手前までを返す。
# `[0-9.]*` だとプレリリース版（例: pnpm@10.0.0-beta.1+sha512...）の `-beta.1` を切り詰めてしまう。
pnpm_version_from_manifest() {
    local manifest="${1:-}/package.json"
    [ -f "$manifest" ] || return 0
    sed -n 's/.*"packageManager": *"pnpm@\([^+"]*\).*/\1/p' "$manifest" | head -n 1
}

# resolve_pnpm が空文字列を返したとき、原因を呼び出し側の案内文言に反映するための補助関数。
# 対象は、npx はあるが packageManager から pnpm のバージョンを読めないケース。
# このケースを、pnpm / corepack / npx がどれも無いケースと区別して案内する。
# 戻り値: npx があり、バージョンを読めないときはヒント文言。それ以外は空文字列。
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
            echo "npx はありますが、${plugin_root}/package.json の packageManager から pnpm のバージョンを読めませんでした。plugin root と packageManager の記述を確認してください。"
            return
        fi
    fi
    echo ""
}
