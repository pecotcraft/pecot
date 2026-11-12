# pecot-workflow bin shared helpers — bin/pecot が source する共通関数。
# sourced 前提のため shebang は付けず、`set -e` も付けない（呼び出し側の設定に従う）。
# bash 3.2（macOS 標準）でも動く書き方に限る。
#
# data-dir ブロック（下の 2 本のマーカーの間）は pecot-visual / pecot-tools の bin/_lib.sh と逐語一致させる。
# プラグインは導入先へ単体でコピーされるため、他プラグインのファイルを source する形にはできない。
# project 名は引数で受けるので、ブロックの中に固有名は書かない。
# pnpm ブロックは、Node 側（cli-node/）の依存導入に使う。scripts/ci/*.sh が source する。
# runtime-mirror ブロックは pecot-visual / pecot-tools と cli の起動パスの 1 行だけ違う（lib-consistency.sh が差を固定する）。

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

# --- runtime-mirror: pecot-visual / pecot-tools で逐語一致 ---

# 実行用ミラー（${DATA}/runtime/<deps-hash>-<src-hash>/）の準備。このブロックは両プラグインで逐語一致させる。
# プラグイン側が plugin_runtime_{deps_files,src_files,build} と PLUGIN_RUNTIME_NAME を定める。
# bash 3.2 でも動く書き方に限る。

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

# 依存のハッシュ（依存の入力・node のメジャー版・pnpm の版）。plugin.json と CHANGELOG は入れない。引数: $1 = プラグインルート
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
    [ -f "$1/.complete" ] && [ -f "$1/cli-node/dist/cli.js" ]
}

# 観測用の固定行（回数はこの行の数で数える）。
plugin_runtime_event() {
    printf '%s: %s\n' "${PLUGIN_RUNTIME_NAME:-plugin}" "$*" >&2
}

plugin_runtime_note() {
    printf '[%s runtime] %s\n' "${PLUGIN_RUNTIME_NAME:-plugin}" "$*" >&2
}

# ハードリンク、reflink、実体コピーの順に落としてディレクトリを複製する。引数: $1 = 複製元、$2 = 複製先（存在しないこと）
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

# 標準入力の相対パスのファイルを $1 から $2 へ複製する（書き込み可能にする）。
# runtime-*.yaml は pnpm が workspace root とみなす名前に改名して置く。
plugin_runtime_copy_files() {
    local from="$1" to="$2" list
    list="$(LC_ALL=C sort -u)"
    [ -n "$list" ] || return 0
    mkdir -p "$to" || return 1
    printf '%s\n' "$list" | (cd "$from" && tar -cf - -T -) | (cd "$to" && tar -xf -) || return 1
    chmod -R u+w "$to" || return 1
    # pnpm は workspace root の名前を pnpm-workspace.yaml に限る。配布物の側は別名で持つ。
    local name
    for name in workspace lock; do
        [ ! -f "$to/runtime-$name.yaml" ] || mv -f "$to/runtime-$name.yaml" "$to/pnpm-$name.yaml" || return 1
    done
}

# $1 の node_modules を $2 へハードリンクで複製する。pnpm の状態ファイルは絶対パスを持ち、複製先で install が始まるため外す。
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

# `current` を $2 へ相対 symlink で差し替える（rename(2)）。
# GNU の mv -T、無ければ node の renameSync を使う。BSD の mv は symlink を辿る。
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

# `current` が無い・切れているときだけ $2 へ張る。世代が並走しても往復させないため。
plugin_runtime_ensure_current() {
    local base="$1" name="$2"
    [ -d "$base/current" ] && return 0
    plugin_runtime_swap_current "$base" "$name"
}

# 使用中でなければ消す。`.inuse` の排他ロックが取れたときだけ消し、flock(1) が無い環境では消さない。引数: $1 = ミラーのディレクトリ
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

# 世代を削除する。`current` の先と完成済みの直近 2 つ、使用中のものは残す（旧セッションが旧版を使うため）。bootstrap ロックを持って呼ぶ。
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

# bootstrap ロックを取る。flock(1) があれば fd 9、無ければ noclobber のロックファイル（mkdir は同時呼び出しで 2 人成功する実装がある）。
# stale の掃除は rename できた 1 人だけが行う（rm だと後の側が先の側のロックを消す）。引数: $1 = ${DATA}/runtime
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

# 完成済みのミラーを用意し、パスを PLUGIN_RUNTIME_DIR に入れる。同じ deps-hash の donor があれば複製して build のみ、無ければ frozen で install して build する。
# PLUGIN_RUNTIME_FORCE=1 は使用中でなければ作り直す。引数: $1 = プラグインルート、$2 = ${DATA}/runtime
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
    mkdir -p "$base" || { plugin_runtime_note "error: cannot create directory: ${base}"; return 1; }
    plugin_runtime_lock_acquire "$base" || { plugin_runtime_note "error: cannot acquire lock: ${base}"; return 1; }
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
            plugin_runtime_note "in use, so it is kept as is instead of being rebuilt: ${target}"
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
        plugin_runtime_note "the first run can take several minutes because it fetches dependencies and builds; it takes longer when the pnpm store is empty"
        # `$pnpm` は意図的に quote しない（"corepack pnpm" を 2 トークンに分割するため）
        # shellcheck disable=SC2086
        ( cd "$target" && $pnpm install --frozen-lockfile ) || { rc=$?; plugin_runtime_diagnose_failure "$root"; return "$rc"; }
    fi

    plugin_runtime_event "building"
    plugin_runtime_build "$target" "$pnpm" || { rc=$?; plugin_runtime_diagnose_failure "$root"; return "$rc"; }

    : > "$target/.complete" || return 1
    plugin_runtime_swap_current "$base" "$name" || { plugin_runtime_note "error: cannot switch current"; return 1; }
    plugin_runtime_collect "$base" "$name"
    plugin_runtime_note "ready ($(($(date +%s) - start))s)"
    return 0
}

# --- end runtime-mirror ---

# --- pecot-workflow 固有: 実行用ミラーの入力・build・古い venv の片づけ ---

PLUGIN_RUNTIME_NAME=pecot

# bootstrap 進捗を stderr に出す。
pecot_log() {
    echo "pecot: $*" >&2
}

# 依存の入力（root で実在するもの）。package.json・runtime-lock.yaml・runtime-workspace.yaml・.npmrc と、workspace メンバーの package.json。
plugin_runtime_deps_files() {
    local root="$1" file member
    (
        cd "$root" || exit 0
        for file in package.json runtime-lock.yaml runtime-workspace.yaml .npmrc; do
            [ ! -f "$file" ] || printf '%s\n' "$file"
        done
        if [ -f runtime-workspace.yaml ]; then
            awk '
                /^packages:/ { collecting = 1; next }
                collecting && /^[^ ]/ { collecting = 0 }
                collecting && /^  - / { sub(/^  - /, ""); gsub(/["\047 ]/, ""); print }
            ' runtime-workspace.yaml | while IFS= read -r member; do
                [ ! -f "$member/package.json" ] || printf '%s\n' "$member/package.json"
            done
        fi
    )
}

# ソースの入力（build の入力でミラーへ同期する集合）。テストと生成物は含めない。
plugin_runtime_src_files() {
    local root="$1" file
    (
        cd "$root" || exit 0
        printf '%s\n' cli-node/package.json cli-node/tsconfig.json cli-node/tsconfig.build.json cli-node/scripts/tsc.mjs
        find cli-node/src -type f ! -path '*/tests/*' ! -name '*.test.ts' ! -name '*.tsbuildinfo' \
            ! -path '*/node_modules/*' ! -path '*/dist/*' 2>/dev/null || true
    ) | while IFS= read -r file; do
        if [ -f "$root/$file" ]; then printf '%s\n' "$file"; fi
    done
}

# ミラー内で cli を build する。状態ファイルの絶対パスが合わず verifyDepsBeforeRun が依存を削るため、--config.verify-deps-before-run=false を付ける。
# 引数: $1 = ミラーのディレクトリ、$2 = pnpm の起動コマンド
plugin_runtime_build() {
    local dir="$1" pnpm="$2"
    # `$pnpm` は意図的に quote しない（"corepack pnpm" を 2 トークンに分割するため）
    # shellcheck disable=SC2086
    ( cd "$dir" && $pnpm --config.verify-deps-before-run=false --filter @pecot/pecot-workflow-cli run build )
}

# install / build が失敗した後の診断。Node の下限の確認は持たないので、何もせず戻る。
plugin_runtime_diagnose_failure() {
    return 0
}

# 旧方式の venv（${DATA}/venv/<世代>/）を片づける。`.inuse` の排他ロックが取れた世代だけ消し、使用中の世代は次回に回す。
# flock(1) が無い環境では、ロックを見ずに消す。引数: $1 = venv のディレクトリ
plugin_legacy_venv_remove() {
    local root="$1" dir remaining=0
    [ -d "$root" ] || return 0
    for dir in "$root"/.stage-* "$root"/.current.*; do
        [ -e "$dir" ] || [ -L "$dir" ] || continue
        rm -rf "$dir"
    done
    for dir in "$root"/*/; do
        dir="${dir%/}"
        [ -d "$dir" ] && [ ! -L "$dir" ] || continue
        if [ -e "$dir/.inuse" ] && command -v flock >/dev/null 2>&1; then
            (
                exec 8<"$dir/.inuse" || exit 1
                flock -xn 8 || exit 1
                rm -rf "$dir"
            ) 2>/dev/null || remaining=1
        else
            rm -rf "$dir"
        fi
    done
    [ "$remaining" -eq 0 ] || return 0
    rm -rf "$root/current" "$root/.lock" "$root/.lock.pid" "$root"/.lock.pid.stale.*
    rmdir "$root" 2>/dev/null || true
}

# 解決したデータ置き場と、クライアントの置き場を外して求めた既定の場所の、2 か所の venv を片づける。引数: $1 = 解決したデータ置き場
plugin_legacy_venv_cleanup() {
    local data="$1" fallback=""
    plugin_legacy_venv_remove "$data/venv"
    fallback="$(unset CLAUDE_PLUGIN_DATA PLUGIN_DATA; plugin_data_dir_resolve pecot-workflow 2>/dev/null)" || return 0
    [ "$fallback" = "$data" ] || plugin_legacy_venv_remove "$fallback/venv"
    return 0
}
