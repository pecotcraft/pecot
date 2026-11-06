# pecotv bin shared helpers — bin/pecotv・setup.sh・hooks が source する共通関数。
# sourced 前提のため shebang は付けず、`set -e` も付けない（呼び出し側の設定に従う）。
#
# 構成は次のとおり。
#   pnpm の解決・診断の helper。pecot-tools の bin/_lib.sh と同じ関数群で、ログ helper の prefix だけが違う。
#   data-dir ブロック。データ置き場の解決と作成で、pecot-workflow / pecot-tools の bin/_lib.sh と逐語一致させる。
#   runtime-mirror ブロック。実行用ミラーの準備で、pecot-tools の bin/_lib.sh と逐語一致させる。
#   pecot-visual 固有の部分。ミラーの入力、build、hooks 向けの解決。
# プラグインは導入先へ単体でコピーされるため、他プラグインのファイルを source する形にはできない。
# 逐語一致は cli/tests/bootstrap/lib-consistency.sh で確認する。

# pnpm 起動コマンドを解決する。
# 利用者環境に pnpm が無くても、corepack または npx 経由で透過的に起動できるようにする。
# マーケットプレイス配布版で、`corepack enable` や pnpm の事前導入を要求しない設計とする。
# corepack は Node.js 16.9〜24 に同梱されていて、`corepack pnpm <args>` は enable 不要で透過的に起動できる。
# Node.js 25 以降は corepack を同梱しない。
# その場合は、npm 同梱の npx で、packageManager に固定したバージョンの pnpm を取得して起動する。
# npx を使うときは、関数 plugin_npx_pnpm にバージョンを添えた文字列を返す。
# 呼び出し側は `$pnpm install` のように展開する。
# 引数: $1 = plugin root。package.json の packageManager から pnpm のバージョンを読む。
# 戻り値: stdout に「pnpm」「corepack pnpm」「plugin_npx_pnpm <版>」「（空文字列）」のいずれか
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

# npx 経由で pnpm を起動する。resolve_pnpm が npx を選んだときに返す。
# npm 11 は、cwd の package.json が devEngines.packageManager に pnpm を宣言していると、npx も EBADDEVENGINES で止める。
# そのため cwd を / にして npx を起動し、pnpm には --dir で対象の dir（呼び出し時の cwd）を指す。
# --prefix=/ は、global の npmrc が /etc/npmrc に変わり、利用者が設定したレジストリを読まなくなるので採らない。
# 引数: $1 = pnpm の版、残り = pnpm への引数。
plugin_npx_pnpm() {
    local version="$1" dir="$PWD"
    shift
    (cd / && npx --yes "pnpm@$version" --dir "$dir" "$@")
}

# package.json の packageManager（例: pnpm@12.15.0+sha512...）から pnpm の版だけを返す。
# manifest が無い、または宣言が無いときは、空文字列を返す。
# `[^+"]*` で `+`（ビルドメタデータ区切り）または閉じる `"` の手前までを版として扱う。
# `[0-9.]*` だとプレリリース版（例: pnpm@10.0.0-beta.1+sha512...）の `-beta.1` を
# 切り詰めて `10.0.0` を誤って返してしまう。
pnpm_version_from_manifest() {
    local manifest="${1:-}/package.json"
    [ -f "$manifest" ] || return 0
    sed -n 's/.*"packageManager": *"pnpm@\([^+"]*\).*/\1/p' "$manifest" | head -n 1
}

# resolve_pnpm が空文字列を返したとき、原因を呼び出し側の案内文言に反映するための補助関数。
# 対象は、npx はあるが packageManager から pnpm のバージョンを読めないケース。
# 読めない原因は、manifest の不在、宣言なし、形式の不一致のいずれか。
# このケースを、pnpm / corepack / npx がどれも無いケースと区別して案内する。
# 戻り値: npx があり、バージョンを読めないときはヒント文言。それ以外（npx 自体が無いときなど）は空文字列。
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
            echo "npx はありますが、${plugin_root}/package.json の packageManager から pnpm の版を読めませんでした。plugin root と packageManager の記述を確認してください。"
            return
        fi
    fi
    echo ""
}

# bootstrap 進捗を stderr に出す helper。CUJ 5 の並行起動テストで文字列 grep するため、
# `[pecotv bootstrap] ` prefix は固定。文字列の揺れは bash テストを壊す。
pecotv_log() {
    echo "[pecotv bootstrap] $*" >&2
}

# 起動中の node が脆弱性の修正を含まない版なら、cli/src/node-runtime.ts の checkNodeRuntime が
# 返す案内文を stdout に出す。許可する版・node 不在・.ts を直接 import できない node・
# ファイルが読めない場合は何も出さない（呼び出し側は従来どおりの失敗で終わる）。
# 成功したときは呼ばない。install / build が失敗した後の診断だけに使う。
# 古い node では pnpm が engines.node の不一致で先に止まり、英語のエラーしか出ないため。
pecotv_node_runtime_message() {
    local plugin_root="$1"
    [ -f "$plugin_root/cli/src/node-runtime.ts" ] || return 0
    command -v node >/dev/null 2>&1 || return 0
    node --input-type=module -e '
import { pathToFileURL } from "node:url"
try {
  const m = await import(pathToFileURL(process.argv[1]).href)
  const r = m.checkNodeRuntime(process.versions.node)
  if (typeof r === "string") process.stdout.write(r)
} catch {}
' "$plugin_root/cli/src/node-runtime.ts" 2>/dev/null || true
}

# install / build 失敗時に呼ぶ。案内文があれば CLI と同じ書式で stderr に出して exit 1 する。
# 案内文が無ければ戻り（呼び出し側が元の終了コードで終わる）。
pecotv_fail_if_node_runtime_blocked() {
    local message
    message="$(pecotv_node_runtime_message "$1")"
    [ -n "$message" ] || return 0
    printf 'pecotv: %s\n' "$message" >&2
    exit 1
}

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

# --- runtime-mirror: pecot-visual / pecot-tools で逐語一致 ---

# 実行用ミラー（${DATA}/runtime/<deps-hash>-<src-hash>/）の準備。bin/<plugin> と hooks が source する。
# プラグインは導入先へ単体でコピーされるため、他プラグインのファイルは source できない。
# このブロックは両プラグインで逐語一致させる（プラグイン固有の部分は次の 3 つの関数に出す）。
#   plugin_runtime_deps_files <root>  依存の入力の相対パスを 1 行ずつ出す。入力は lock・workspace 定義・全 package.json。
#   plugin_runtime_src_files <root>   ソースの入力の相対パスを 1 行ずつ出す。build の入力にあたる。
#   plugin_runtime_build <dir> <pnpm> ミラー内で build する。失敗したら非 0 を返す。
# 加えて、呼び出し側は PLUGIN_RUNTIME_NAME（ログの接頭辞。pecotv / pecot-tools）を決めておく。
# bash 3.2（macOS 標準）でも動く書き方に限る。

# 標準入力の SHA-256 を 16 進で出す。
plugin_runtime_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum | cut -d' ' -f1
    else
        shasum -a 256 | cut -d' ' -f1
    fi
}

# 標準入力の相対パス（1 行 1 本。root 配下の実在するファイル）を LC_ALL=C で並べ、相対パスと内容のハッシュを出す。
# 引数: $1 = root
plugin_runtime_hash_files() {
    local root="$1" sorted
    sorted="$(LC_ALL=C sort -u)"
    [ -n "$sorted" ] || { printf 'empty\n' | plugin_runtime_sha256; return 0; }
    (
        cd "$root" || exit 1
        printf '%s\n' "$sorted" | tr '\n' '\0' | if command -v sha256sum >/dev/null 2>&1; then
            xargs -0 sha256sum
        else
            xargs -0 shasum -a 256
        fi
    ) | plugin_runtime_sha256
}

# node のメジャー版。node が無ければ空。
plugin_runtime_node_major() {
    command -v node >/dev/null 2>&1 || return 0
    node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

# 依存のハッシュ。依存の入力ファイル + node のメジャー版 + pnpm の版（package.json の packageManager）。
# plugin.json と CHANGELOG は入れない（リリースが変えるのはこの 2 つとソースだけで、版だけの更新を 0/0 にする）。
# 引数: $1 = プラグインルート
plugin_runtime_deps_hash() {
    local root="$1"
    {
        plugin_runtime_deps_files "$root" | plugin_runtime_hash_files "$root"
        printf 'node-major=%s\n' "$(plugin_runtime_node_major)"
        printf 'pnpm=%s\n' "$(pnpm_version_from_manifest "$root")"
    } | plugin_runtime_sha256
}

# ソースのハッシュ。build の入力ファイル。
# 引数: $1 = プラグインルート
plugin_runtime_src_hash() {
    plugin_runtime_src_files "$1" | plugin_runtime_hash_files "$1"
}

# ミラーのディレクトリ名 `<deps-hash の先頭 12 桁>-<src-hash の先頭 12 桁>` を出す。
# 引数: $1 = プラグインルート
plugin_runtime_name() {
    local deps src
    deps="$(plugin_runtime_deps_hash "$1")" || return 1
    src="$(plugin_runtime_src_hash "$1")" || return 1
    printf '%s-%s\n' "${deps:0:12}" "${src:0:12}"
}

# 完成済みか。完成印があり、実行する実体がある。
# 引数: $1 = ミラーのディレクトリ
plugin_runtime_is_complete() {
    [ -f "$1/.complete" ] && [ -f "$1/cli/dist/cli.js" ]
}

# 観測用の固定行（回数はこの行の数で数える）。
plugin_runtime_event() {
    printf '%s: %s\n' "${PLUGIN_RUNTIME_NAME:-plugin}" "$*" >&2
}

plugin_runtime_note() {
    printf '[%s runtime] %s\n' "${PLUGIN_RUNTIME_NAME:-plugin}" "$*" >&2
}

# ディレクトリを複製する。ハードリンク → reflink → 実体コピー（macOS は clonefile → 実体コピー）の順に落とす。
# 失敗した試行の残りは消してから次へ進む。
# 引数: $1 = 複製元、$2 = 複製先（存在しないこと）
plugin_runtime_copy_dir() {
    local from="$1" to="$2"
    if [ "$(uname -s)" = "Darwin" ]; then
        cp -cR "$from" "$to" 2>/dev/null && return 0
        rm -rf "$to"
        cp -R "$from" "$to" && return 0
        return 1
    fi
    cp -al "$from" "$to" 2>/dev/null && return 0
    rm -rf "$to"
    cp -a --reflink=auto "$from" "$to" 2>/dev/null && return 0
    rm -rf "$to"
    cp -a "$from" "$to" && return 0
    return 1
}

# 標準入力の相対パス（1 行 1 本）のファイルを $1 から $2 へ複製する（親ディレクトリも作る）。
# 複製先は書き込み可能にする（読み取り専用のプラグインルートから複製しても、ミラー内で build できるように）。
# 引数: $1 = 複製元のルート、$2 = 複製先のルート
plugin_runtime_copy_files() {
    local from="$1" to="$2" list
    list="$(LC_ALL=C sort -u)"
    [ -n "$list" ] || return 0
    mkdir -p "$to" || return 1
    printf '%s\n' "$list" | (cd "$from" && tar -cf - -T -) | (cd "$to" && tar -xf -) || return 1
    chmod -R u+w "$to" || return 1
}

# 完成済みの $1 の node_modules（root と workspace 各メンバーの入れ子）を $2 へハードリンクで複製する。
# pnpm の状態ファイルと実行時キャッシュは複製から外す。
# pnpm の状態ファイルは絶対パスを持つため、複製したミラーで pnpm が install を始める原因になる。
# 実行時キャッシュは、別の世代と共有する意味が無い。
# 引数: $1 = 複製元のミラー、$2 = 複製先のミラー
plugin_runtime_clone_node_modules() {
    local donor="$1" target="$2" source rel destination
    while IFS= read -r source; do
        rel="${source#"$donor"/}"
        destination="$target/$rel"
        mkdir -p "$(dirname "$destination")" || return 1
        plugin_runtime_copy_dir "$source" "$destination" || return 1
        rm -rf \
            "$destination/.pnpm-workspace-state-v1.json" \
            "$destination/.pnpm-task-run-state-v1" \
            "$destination/.vite" "$destination/.vite-temp" "$destination/.slidev" "$destination/.cache" \
            "$destination"/.pecotv-* "$destination"/.pecot-tools-*
    done < <(find "$donor" -name node_modules -type d -prune 2>/dev/null | LC_ALL=C sort)
}

# 同じ deps-hash の完成済みミラー（$3 以外）の中で最も新しいものを出す。無ければ何も出さない。
# 引数: $1 = ${DATA}/runtime、$2 = deps-hash の先頭 12 桁、$3 = 除外するディレクトリ名
plugin_runtime_find_donor() {
    local base="$1" deps="$2" except="$3" name
    while IFS= read -r name; do
        [ "$name" != "$except" ] || continue
        case "$name" in "$deps"-*) ;; *) continue ;; esac
        if plugin_runtime_is_complete "$base/$name"; then
            printf '%s\n' "$base/$name"
            return 0
        fi
    done < <(ls -1t "$base" 2>/dev/null)
    return 0
}

# `current` を $2 に差し替える。リンクは相対で作り、rename(2) で置き換える（途中の状態を見せない）。
# GNU の `mv -T`、無ければ node の fs.renameSync（BSD の mv はディレクトリへの symlink を辿るため使わない）。
# 引数: $1 = ${DATA}/runtime、$2 = ミラーのディレクトリ名
plugin_runtime_swap_current() {
    local base="$1" name="$2" temporary
    temporary="$base/.current.$$"
    rm -f "$temporary"
    ln -s "$name" "$temporary" || return 1
    if mv -T "$temporary" "$base/current" 2>/dev/null; then
        return 0
    fi
    if command -v node >/dev/null 2>&1 \
        && node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$temporary" "$base/current" 2>/dev/null; then
        return 0
    fi
    rm -f "$temporary"
    return 1
}

# `current` が $2 を指していなければ差し替える。完成済みを使うだけの起動で、世代の並走時に
# `current` が往復しないよう、指す先が無い（無い・切れている）ときだけ張る。
# 引数: $1 = ${DATA}/runtime、$2 = ミラーのディレクトリ名
plugin_runtime_ensure_current() {
    local base="$1" name="$2"
    [ -d "$base/current" ] && return 0
    plugin_runtime_swap_current "$base" "$name"
}

# 使用中でなければ消す。使用中は、実行中の wrapper が `.inuse` を共有ロックしたまま保持していること。
# 排他ロックが取れたときだけ消す。flock(1) が無い環境では使用中かを判定できないので消さない。
# 引数: $1 = ミラーのディレクトリ
plugin_runtime_remove_unused() {
    local dir="$1"
    [ -d "$dir" ] || return 0
    if [ ! -e "$dir/.inuse" ]; then
        rm -rf "$dir"
        return 0
    fi
    command -v flock >/dev/null 2>&1 || return 0
    (
        exec 7<"$dir/.inuse" || exit 0
        flock -n -x 7 || exit 0
        # 完成印を先に外す。この間に起動した wrapper は、共有ロックを取った後に印が無いと見て作り直しへ回る。
        rm -f "$dir/.complete"
        rm -rf "$dir"
    )
}

# 世代を削除する。`current` の指す先と、完成済みの直近 2 つを残す。使用中のものは消さない
# （Claude は旧版を 14 日間残して旧セッションを動かすので、件数だけで消すと使用中のミラーを消す）。
# 完成印の無いもの（途中で止まったもの）は、使用中でなければ消す。bootstrap ロックを持って呼ぶこと。
# 引数: $1 = ${DATA}/runtime、$2 = 今回使うミラーのディレクトリ名
plugin_runtime_collect() {
    local base="$1" keep="$2" current_name="" name kept=0 re='^[0-9a-f]{12}-[0-9a-f]{12}$'
    # flock(1) が無い環境では使用中かを判定できないので、世代削除はしない（使用中のミラーを消さないため）。
    command -v flock >/dev/null 2>&1 || return 0
    if [ -L "$base/current" ]; then
        current_name="$(basename "$(readlink "$base/current")")"
    fi
    while IFS= read -r name; do
        [[ "$name" =~ $re ]] || continue
        [ -d "$base/$name" ] || continue
        if [ "$name" = "$keep" ] || [ "$name" = "$current_name" ]; then
            kept=$((kept + 1))
            continue
        fi
        if plugin_runtime_is_complete "$base/$name"; then
            if [ "$kept" -lt 2 ]; then
                kept=$((kept + 1))
                continue
            fi
        fi
        plugin_runtime_remove_unused "$base/$name"
    done < <(ls -1t "$base" 2>/dev/null)
    return 0
}

# bootstrap ロックを取る。flock(1) があれば fd 9 の排他ロック、無ければ（macOS 標準）pid を書いたロックファイルで
# 代用する（bin/pecot の _lock_acquire と同じ方式）。後発は待ち、取得後に完成済みかを見直して二重の install / build を避ける。
# ロックファイルは bash の noclobber（set -C）で作る。bash が O_EXCL で開くので、作れるのは 1 人だけになる
# （mkdir は実装によって不可分でなく、uutils coreutils の mkdir は同時に呼ぶと 2 人とも成功する）。
# stale（保持者が死んでいる）の掃除は rename で行い、rename できた 1 人だけが中身を確かめて消す
# （rm で消すと、先に取り直した側のロックを後の側が消して二重取得になる）。
# 引数: $1 = ${DATA}/runtime
plugin_runtime_lock_acquire() {
    local base="$1" lock="$1/.bootstrap.lock.pid" waited=0 holder reaped
    if command -v flock >/dev/null 2>&1; then
        exec 9>"$base/.bootstrap.lock" || return 1
        if ! flock -n 9 2>/dev/null; then
            plugin_runtime_note "waiting for concurrent bootstrap to finish ..."
            flock 9 || { exec 9>&-; return 1; }
        fi
        return 0
    fi
    until ( set -C; printf '%s\n' "$$" > "$lock" ) 2>/dev/null; do
        holder="$(cat "$lock" 2>/dev/null || true)"
        if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
            reaped="$lock.stale.$$"
            if mv "$lock" "$reaped" 2>/dev/null; then
                if [ "$(cat "$reaped" 2>/dev/null || true)" != "$holder" ]; then
                    # 生きているロックを掴んでしまった。空いていれば戻す
                    ( set -C; cat "$reaped" > "$lock" ) 2>/dev/null || true
                fi
                rm -f "$reaped"
            fi
            continue
        fi
        if [ "$waited" -eq 0 ]; then
            plugin_runtime_note "waiting for concurrent bootstrap to finish ..."
        fi
        waited=$((waited + 1))
        [ "$waited" -gt 3000 ] && return 1
        sleep 0.2
    done
}

# plugin_runtime_lock_acquire で取ったロックを放す。
plugin_runtime_lock_release() {
    if command -v flock >/dev/null 2>&1; then
        exec 9>&-
    else
        rm -f "$1/.bootstrap.lock.pid"
    fi
}

# 完成済みのミラーを用意する（無ければ作る）。成功したら 0 を返し、ミラーのパスを PLUGIN_RUNTIME_DIR に入れる。
# 完成済みなら、何もしない。
# 同じ deps-hash の完成済みがあれば、node_modules をハードリンクで複製し、build する。install はしない。
# どちらも無ければ、pnpm install --frozen-lockfile して build する。
# PLUGIN_RUNTIME_FORCE=1 のときは、使用中でなければ消して作り直す。
# 作成中は bootstrap ロックを持つ。後発は待ち、取得後に完成済みかを見直して二重の install / build を避ける。
# 引数: $1 = プラグインルート、$2 = ${DATA}/runtime
plugin_runtime_ensure() {
    local root="$1" base="$2" name target rc=0
    name="$(plugin_runtime_name "$root")" || return 1
    target="$base/$name"
    PLUGIN_RUNTIME_NAME_HASHED="$name"
    PLUGIN_RUNTIME_DIR="$target"
    if [ "${PLUGIN_RUNTIME_FORCE:-}" != "1" ] && plugin_runtime_is_complete "$target"; then
        plugin_runtime_ensure_current "$base" "$name" || true
        return 0
    fi
    mkdir -p "$base" || { plugin_runtime_note "error: ${base} を作れません。"; return 1; }
    plugin_runtime_lock_acquire "$base" || { plugin_runtime_note "error: ${base} のロックを取得できません。"; return 1; }
    plugin_runtime_ensure_locked "$root" "$base" "$name" "$target" || rc=$?
    plugin_runtime_lock_release "$base"
    return "$rc"
}

# plugin_runtime_ensure の本体（bootstrap ロックを持って呼ぶ）。
plugin_runtime_ensure_locked() {
    local root="$1" base="$2" name="$3" target="$4" deps donor pnpm start rc
    if plugin_runtime_is_complete "$target"; then
        if [ "${PLUGIN_RUNTIME_FORCE:-}" != "1" ]; then
            plugin_runtime_note "already bootstrapped by another process, skipping"
            plugin_runtime_ensure_current "$base" "$name" || true
            return 0
        fi
        # FORCE: 使用中なら作り直さずそのまま使う。
        plugin_runtime_remove_unused "$target"
        if plugin_runtime_is_complete "$target"; then
            plugin_runtime_note "使用中のため作り直さず、そのまま使います: ${target}"
            plugin_runtime_ensure_current "$base" "$name" || true
            return 0
        fi
    fi
    # 完成印の無いもの（途中で止まった作成）は、ロックを持つ今は誰も作っていないので消してよい。
    rm -rf "$target" || return 1
    start="$(date +%s)"
    mkdir -p "$target" || return 1
    : > "$target/.inuse" || return 1

    # corepack の `packageManager` 初回 fetch 時の Y/n プロンプトを抑止する。
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    pnpm="$(resolve_pnpm "$root")"
    if [ -z "$pnpm" ]; then
        plugin_runtime_note "pnpm / corepack / npx not found. Install Node.js 24.22.1+ in the 24.x line or 26.12.1+ (npm and npx are bundled) and retry."
        local hint
        hint="$(pnpm_resolution_hint "$root")"
        [ -z "$hint" ] || plugin_runtime_note "$hint"
        rm -rf "$target"
        return 1
    fi

    { plugin_runtime_deps_files "$root"; plugin_runtime_src_files "$root"; } | plugin_runtime_copy_files "$root" "$target" || return 1

    deps="${name%%-*}"
    donor="$(plugin_runtime_find_donor "$base" "$deps" "$name")"
    if [ -n "$donor" ]; then
        plugin_runtime_clone_node_modules "$donor" "$target" || return 1
    else
        plugin_runtime_event "installing dependencies"
        plugin_runtime_note "依存の取得と build 込みで初回は数分かかる場合があります（pnpm store が空の環境ではさらに長くなります）"
        # `$pnpm` は意図的に quote しない（"corepack pnpm" を 2 トークンに分割するため）
        # shellcheck disable=SC2086
        ( cd "$target" && $pnpm install --frozen-lockfile ) || { rc=$?; plugin_runtime_diagnose_failure "$root"; return "$rc"; }
    fi

    plugin_runtime_event "building"
    plugin_runtime_build "$target" "$pnpm" || { rc=$?; plugin_runtime_diagnose_failure "$root"; return "$rc"; }

    : > "$target/.complete" || return 1
    plugin_runtime_swap_current "$base" "$name" || { plugin_runtime_note "error: current を切り替えられません。"; return 1; }
    plugin_runtime_collect "$base" "$name"
    plugin_runtime_note "ready ($(($(date +%s) - start))s)"
    return 0
}

# --- end runtime-mirror ---

# --- pecot-visual 固有: 実行用ミラーの入力・build・失敗時の診断 ---

PLUGIN_RUNTIME_NAME=pecotv

# 依存の入力（相対パス。cd した root で実在するものだけ）。
# lock・workspace 定義・.npmrc。
# 加えて、workspace メンバーの package.json。ただし vendor/text-rules は除く。
# 実行時依存の manifest（assets/slidev/runtime/package.json）も workspace メンバーなので、ここで拾われる。
plugin_runtime_deps_files() {
    local root="$1" file member
    (
        cd "$root" || exit 0
        for file in package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc; do
            [ ! -f "$file" ] || printf '%s\n' "$file"
        done
        if [ -f pnpm-workspace.yaml ]; then
            awk '
                /^packages:/ { collecting = 1; next }
                collecting && /^[^ ]/ { collecting = 0 }
                collecting && /^  - / { sub(/^  - /, ""); gsub(/["\047 ]/, ""); print }
            ' pnpm-workspace.yaml | while IFS= read -r member; do
                # vendor/text-rules は入れない。依存の宣言は pnpm-lock.yaml の importers が持ち、package.json の version は
                # text-rules のリリースで毎回変わる。入れると、その版で利用者全員の導入がやり直しになる。
                # package.json 自体は src の入力に入っていて、ミラーへは src として載る。
                [ "$member" != vendor/text-rules ] || continue
                [ ! -f "$member/package.json" ] || printf '%s\n' "$member/package.json"
            done
        fi
    )
}

# v-slidev の ESLint プラグイン群（assets/slidev/tsconfig.build.json の references と同じ 7 本）。
# これに加えて、text-constraints が使う vendor/text-rules を載せる。repo 共通のライブラリをリンクで載せたもの。
plugin_runtime_slidev_packages() {
    printf '%s\n' \
        vendor/text-rules \
        assets/slidev/scripts/eslint/2layer \
        assets/slidev/scripts/eslint/asset-path \
        assets/slidev/scripts/eslint/pptx-compat \
        assets/slidev/scripts/eslint/_shared \
        assets/slidev/scripts/eslint/slidev-pages-lint \
        assets/slidev/scripts/eslint/text-constraints \
        assets/slidev/scripts/eslint/validate-references
}

# ソースの入力（build の入力であり、ミラーへ同期する集合）。
# 含めるものは次のとおり。
# cli の src・types・package.json・tsconfig。
# v-slidev の ESLint プラグイン一式の lib・schema.json・package.json・tsconfig。
# vendor/text-rules、deck-lint.config.js と deck-lint.env.config.js、build.mjs。
# 実行時依存の manifest（assets/slidev/runtime/package.json）も含める。
# テストと生成物（dist・node_modules・tsbuildinfo・__pycache__・egg-info・build）は含めない。
plugin_runtime_src_files() {
    local root="$1" package file
    (
        cd "$root" || exit 0
        printf '%s\n' cli/package.json cli/tsconfig.json cli/tsconfig.build.json cli/scripts/tsc.mjs
        find cli/src cli/types -type f ! -path '*/tests/*' ! -name '*.test.ts' ! -name '*.tsbuildinfo' \
            ! -path '*/node_modules/*' ! -path '*/dist/*' ! -path '*/__pycache__/*' ! -path '*.egg-info/*' ! -path '*/build/*' 2>/dev/null || true
        printf '%s\n' \
            assets/slidev/package.json \
            assets/slidev/tsconfig.base.json \
            assets/slidev/tsconfig.build.json \
            assets/slidev/scripts/build.mjs \
            assets/slidev/deck-lint.config.js \
            assets/slidev/deck-lint.env.config.js \
            assets/slidev/runtime/package.json
        plugin_runtime_slidev_packages | while IFS= read -r package; do
            # vendor/text-rules はリンクなので -L で辿る。開発環境では実体に npm の node_modules・dist・coverage が
            # あるため、降りないように -prune する。
            # vendor/text-rules では、build の入力にならない *.md・package-lock.json・project.json も外す。
            # リリースのたびに変わる CHANGELOG.md などで、ソースのハッシュを動かさないため。
            case "$package" in
                vendor/text-rules)
                    find -L "$package" \( -name node_modules -o -name dist -o -name coverage -o -name build \) -prune -o \
                        -type f ! -path '*/tests/*' ! -name '*.test.ts' ! -name '*.tsbuildinfo' \
                        ! -path '*/__pycache__/*' ! -path '*.egg-info/*' \
                        ! -name '*.md' ! -name package-lock.json ! -name project.json -print 2>/dev/null || true
                    ;;
                *)
                    find -L "$package" \( -name node_modules -o -name dist -o -name coverage -o -name build \) -prune -o \
                        -type f ! -path '*/tests/*' ! -name '*.test.ts' ! -name '*.tsbuildinfo' \
                        ! -path '*/__pycache__/*' ! -path '*.egg-info/*' -print 2>/dev/null || true
                    ;;
            esac
        done
    ) | while IFS= read -r file; do
        if [ -f "$root/$file" ]; then printf '%s\n' "$file"; fi
    done
}

# ミラー内で cli と v-slidev の ESLint プラグインを build する。
# ミラーで pnpm run すると、状態ファイルの絶対パスが合わず、verifyDepsBeforeRun が install を始めて依存を削る。
# そのため、ミラー内の pnpm 呼び出しにはすべて --config.verify-deps-before-run=false を付ける。
# 引数: $1 = ミラーのディレクトリ、$2 = pnpm の起動コマンド
plugin_runtime_build() {
    local dir="$1" pnpm="$2"
    # slidev の build を先に行う。build.mjs が libs/text-rules を build し、cli の型解決がその dist を読むため。
    # ミラーの 2 回目以降は donor の node_modules を複製して install を飛ばし、prepare による text-rules の build が動かない。
    # `$pnpm` は意図的に quote しない（"corepack pnpm" を 2 トークンに分割するため）
    # shellcheck disable=SC2086
    if ! ( cd "$dir" && $pnpm --config.verify-deps-before-run=false --filter @pecot/slidev-assets-dev run build ); then
        pecotv_log "error: v-slidev ESLint プラグインの build に失敗しました。eslint-check.sh hook が module not found で失敗する可能性があります。"
        return 1
    fi
    # shellcheck disable=SC2086
    ( cd "$dir" && $pnpm --config.verify-deps-before-run=false --filter @pecot/pecotv-cli run build ) || return $?
}

# install / build が失敗した後の診断。古い node では pnpm が engines.node の不一致で先に止まり英語のエラーしか出ないため、
# 案内文があれば CLI と同じ書式で出して exit 1 する。
plugin_runtime_diagnose_failure() {
    pecotv_fail_if_node_runtime_blocked "$1"
}

# hooks が使う実行用ミラーを出す。自分の版のハッシュのディレクトリを優先し、無いときだけ `current`。
# どちらも完成していなければ何も出さず 1 を返す（初回の build 中は未実施として扱う）。
# `current` だけを見ると、別セッションが切り替えた新版のテンプレートで旧版セッションの lint が動く。
# データ置き場は解決だけで作らない（hook が既定の場所を作らないため）。
# 引数: $1 = プラグインルート
plugin_runtime_dir_for_hooks() {
    local root="$1" data name
    data="$(plugin_data_dir_resolve pecot-visual 2>/dev/null)" || return 1
    name="$(plugin_runtime_name "$root")" || return 1
    if plugin_runtime_is_complete "$data/runtime/$name"; then
        printf '%s\n' "$data/runtime/$name"
        return 0
    fi
    if plugin_runtime_is_complete "$data/runtime/current"; then
        printf '%s\n' "$data/runtime/current"
        return 0
    fi
    return 1
}
