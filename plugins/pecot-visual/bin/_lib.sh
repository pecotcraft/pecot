# pecotv bin shared helpers — bin/pecotv・setup.sh・hooks が source する共通関数。shebang と `set -e` は付けない。
# data-dir・runtime-mirror ブロックは他プラグインと逐語一致させる（確認は cli/tests/bootstrap/lib-consistency.sh）。

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
            echo "npx はありますが、${plugin_root}/package.json の packageManager から pnpm の版を読めませんでした。plugin root と packageManager の記述を確認してください。"
            return
        fi
    fi
    echo ""
}

# bootstrap 進捗を stderr に出す。`[pecotv bootstrap] ` は bash テストが grep するので変えない。
pecotv_log() {
    echo "[pecotv bootstrap] $*" >&2
}

# 起動中の node が脆弱性の修正前の版なら、checkNodeRuntime の案内文を stdout に出す。install / build の失敗後の診断だけに使う（古い node では pnpm が英語のエラーで先に止まるため）。
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

# install / build の失敗時に呼ぶ。案内文があれば stderr に出して exit 1 する。無ければ戻る。
pecotv_fail_if_node_runtime_blocked() {
    local message
    message="$(pecotv_node_runtime_message "$1")"
    [ -n "$message" ] || return 0
    printf 'error: %s\n' "$message" >&2
    exit 1
}

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
    [ -f "$1/.complete" ] && [ -f "$1/cli/dist/cli.js" ]
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

# 依存の入力（root で実在するもの）。runtime-lock.yaml・runtime-workspace.yaml・.npmrc。
# 加えて、workspace メンバー（vendor/text-rules を除く）の package.json。
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
                # vendor/text-rules は入れない。version がリリースのたびに変わり、全利用者の導入がやり直しになるため。src には載る。
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

# ソースの入力（build の入力でミラーへ同期する集合）。cli、v-slidev の ESLint プラグイン、vendor/text-rules、deck-lint の設定、build.mjs・tsc.mjs、runtime の manifest。テストと生成物は含めない。
plugin_runtime_src_files() {
    local root="$1" package file
    local prune=( \( -name node_modules -o -name dist -o -name coverage -o -name build \) -prune -o )
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
            assets/slidev/scripts/tsc.mjs \
            assets/slidev/deck-lint.config.js \
            assets/slidev/deck-lint.env.config.js \
            assets/slidev/runtime/package.json
        plugin_runtime_slidev_packages | while IFS= read -r package; do
            # vendor/text-rules はリンクなので -L で辿り、node_modules などは -prune する。*.md・package-lock.json・project.json は外す（リリースでハッシュを動かさないため）。
            case "$package" in
                vendor/text-rules)
                    find -L "$package" "${prune[@]}" \
                        -type f ! -path '*/tests/*' ! -name '*.test.ts' ! -name '*.tsbuildinfo' \
                        ! -path '*/__pycache__/*' ! -path '*.egg-info/*' \
                        ! -name '*.md' ! -name package-lock.json ! -name project.json -print 2>/dev/null || true
                    ;;
                *)
                    find -L "$package" "${prune[@]}" \
                        -type f ! -path '*/tests/*' ! -name '*.test.ts' ! -name '*.tsbuildinfo' \
                        ! -path '*/__pycache__/*' ! -path '*.egg-info/*' -print 2>/dev/null || true
                    ;;
            esac
        done
    ) | while IFS= read -r file; do
        if [ -f "$root/$file" ]; then printf '%s\n' "$file"; fi
    done
}

# ミラー内で cli と ESLint プラグインを build する。状態ファイルの絶対パスが合わず verifyDepsBeforeRun が依存を削るため、pnpm 呼び出しに --config.verify-deps-before-run=false を付ける。
# 引数: $1 = ミラーのディレクトリ、$2 = pnpm の起動コマンド
plugin_runtime_build() {
    local dir="$1" pnpm="$2"
    # slidev を先に build する（build.mjs が text-rules を build し、cli の型解決が dist を読む）。
    # `$pnpm` は "corepack pnpm" を 2 トークンに分けるため quote しない。
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

# hooks が使う実行用ミラーを出す。自分の版のハッシュの dir を優先し、無ければ `current`。
# 未完成なら何も出さず 1 を返す。データ置き場は作らない。
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
