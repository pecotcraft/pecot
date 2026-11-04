# shellcheck shell=bash
# PostToolUse hook 群のパス解決を集約する共有ライブラリ。source して使う
# （単体実行しない。実行ビットも付けない）。
#
# talk-dir の探索と plugin hooks root の解決を、3 本の hook が同じ処理で重複して持っていた。
# このファイルはそれを 1 か所にまとめたもの。
# 3 本は eslint-check.sh、validate-references-check.sh、layout-conventions.sh。
# 退行ガードは各 hook のテストが持つ symlink トポロジのケースが担う。
# （eslint-check は 4 種、validate-references は 2 種、layout-conventions は 2 種）
#
# テーマの宣言の解釈は、このファイルでは行わない。
# resolve_talk_theme_json が実行用ミラーの CLI（slide theme --json）を起こし、その結果を各 hook が読む。

# 編集ファイルの dir から上方向に talk-dir マーカーを探す（git 非依存）。
#
# 探索は logical パスで行う。呼び出し元は、起点 dir を `cd` に `-P` を付けずに求めること。
# 物理パスにすると、pages/ 自体やその配下が talk-dir 外への symlink のとき、
# 上方向の探索が talk-dir を通らず、マーカーを見失う。
#
# $1 = 探索起点の dir（logical 絶対パス）
# $2 = slides.md と併せて要求するマーカー dir。3 本とも "pages"。
# stdout = 見つかった talk root。見つからなければ何も出力せず非 0 を返す。
find_talk_root() {
    local dir="$1" marker_dir="$2"
    while [ -n "$dir" ] && [ "$dir" != "/" ]; do
        if [ -f "$dir/slides.md" ] && [ -d "$dir/$marker_dir" ]; then
            printf '%s\n' "$dir"
            return 0
        fi
        dir=$(dirname "$dir")
    done
    return 1
}

# plugin の hooks root を解決する。
# 優先順は PLUGIN_HOOKS、CLAUDE_PLUGIN_ROOT、呼び出し元の dir からの逆算の順。
# 逆算は pecotv-dir-init.sh と同じ方式で、env が無い起動でも hook 自身の位置から plugin を辿れる。
#
# 逆算が成立しない配置（別の場所へコピーされた等）は空を返す。
# 呼び出し元はこれを「解決不能 = 対象外」として扱うこと。
# 「解決できたが binary や dist が無い（設定不備）」とは区別する。
#
# $1 = 呼び出し元スクリプトの dir
# $2 = hooks root から見た $1 の位置（逆算で削る接尾辞。例 "/lib/post-tool-use"）
resolve_hooks_root() {
    local script_dir="$1" suffix="$2" hooks_root
    if [ -n "${PLUGIN_HOOKS:-}" ]; then
        hooks_root="$PLUGIN_HOOKS"
    elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
        hooks_root="${CLAUDE_PLUGIN_ROOT}/hooks"
    else
        hooks_root="${script_dir%"$suffix"}"
        [ "$hooks_root" = "$script_dir" ] && hooks_root=""
    fi
    printf '%s\n' "$hooks_root"
}

# 実行用ミラー（データ置き場の runtime/<hash> または current）のディレクトリを出す。
# 依存（node_modules）と build 成果物は bin/pecotv がここに作る。
# プラグイン本体（CLAUDE_PLUGIN_ROOT）側には置かれない。
# 自分の版のハッシュのミラーを優先し、無いときだけ `current` を使う（bin/_lib.sh の plugin_runtime_dir_for_hooks）。
# `current` だけを見ると、別セッションが切り替えた新版のミラーを、旧版のセッションが使ってしまう。
# ミラーが無い（初回の build 中、データ置き場を解決できない）ときは、何も出さず 1 を返す。
# 呼び出し元はこれを「ミラーが未準備」として扱うこと。
#
# ハッシュの計算には、呼び出し元の hook 自身のプラグインの bin/_lib.sh を渡す。
# テストが偽のプラグインルートを渡しても、実物の関数でハッシュを計算する必要があるため。
#
# $1 = プラグインルート（ミラーのハッシュを計算する対象）
# $2 = bin/_lib.sh のパス
resolve_runtime_dir() {
    local plugin_root="$1" lib="$2"
    [ -f "$lib" ] || return 1
    # shellcheck source=/dev/null
    . "$lib"
    plugin_runtime_dir_for_hooks "$plugin_root"
}

# 実行用ミラー側の assets/slidev を出す。
# eslint 本体、deck lint の設定（deck-lint.env.config.js）、ルールの dist の供給元。
# ミラーが無いときは resolve_runtime_dir と同じく、何も出さず 1 を返す。
#
# $1 = プラグインルート（ミラーのハッシュを計算する対象）
# $2 = bin/_lib.sh のパス
resolve_slidev_assets_dir() {
    local runtime_dir assets_dir
    runtime_dir="$(resolve_runtime_dir "$1" "$2")" || return 1
    assets_dir="$runtime_dir/assets/slidev"
    # 物理パスで返す。
    # validate-references は argv[1] と import.meta.url を比べて自己実行を判定する。
    # symlink（`current` やデータ置き場の親）を跨ぐ argv では一致せず、検証が動かないため。
    # assets が無いときは、不在を伝えるために組み立てたパスをそのまま返す。
    CDPATH= cd -P "$assets_dir" 2>/dev/null && pwd -P && return 0
    printf '%s\n' "$assets_dir"
}

# 実行用ミラー側の deck-lint.env.config.js（本体の deck lint の設定）を出す。
# 環境変数 PECOTV_DECK_LINT に slide theme --json の lint を JSON で渡して使う。
# ミラーが無いときは resolve_runtime_dir と同じく、何も出さず 1 を返す。
# 設定のファイルが無いときも、不在を伝えるために組み立てたパスをそのまま返す。
#
# $1 = プラグインルート（ミラーのハッシュを計算する対象）
# $2 = bin/_lib.sh のパス
resolve_deck_lint_env_config() {
    local assets_dir
    assets_dir="$(resolve_slidev_assets_dir "$1" "$2")" || return 1
    printf '%s\n' "$assets_dir/deck-lint.env.config.js"
}

# talk-dir が参照するテーマの宣言を、ミラーの CLI（slide theme --json）で取る。
# 宣言を解釈する場所は CLI の 1 か所だけにして、hook は結果の JSON を読むだけにする。
# stdout = CLI の stdout の最終行（成功なら slide.theme.done、失敗なら slide.theme.error の JSON）。
# 戻り値 = CLI の終了コード。CLI が無い・起動できないときは出力が空で非 0 になる。
# 呼び出し元は、非 0 のときも stdout の JSON から reason（theme-none / theme-unlinked など）を読める。
# CLI の stderr は $3 のファイルに書く。Node の版不足のように JSON を出せない失敗の原因を、通知と trace に添えるため。
# timeout は 10 秒にする。3 本の hook が別々に起こし、merge-hook-outputs.sh は直列に実行するので、
# hooks.json の PostToolUse の上限（80 秒）に収まるよう短くする。
#
# $1 = 実行用ミラーの dir（resolve_runtime_dir の出力）
# $2 = talk root
# $3 = CLI の stderr を書くファイル
resolve_talk_theme_json() {
    local runtime_dir="$1" talk_root="$2" stderr_file="$3" output code
    [ -f "$runtime_dir/cli/dist/cli.js" ] || return 127
    output=$(timeout 10 node "$runtime_dir/cli/dist/cli.js" slide theme --dir "$talk_root" --json 2>"$stderr_file")
    code=$?
    printf '%s\n' "$output" | tail -n 1
    return $code
}

# talk-dir の root から見た、編集ファイルの相対パスを出す。
# $1 = talk root
# $2 = 探索起点の dir（find_talk_root に渡したものと同じ logical パス）
# $3 = 編集ファイルのパス
talk_relative_path() {
    local rel_dir="${2#"$1"}"
    rel_dir="${rel_dir#/}"
    printf '%s\n' "${rel_dir:+$rel_dir/}$(basename "$3")"
}

# talk-dir の相対パスが、deck lint の対象（pages/*.md と slides.md）か。
# この 2 種は、eslint-check.sh が本文と発表者ノートを確認する。
# $1 = talk_relative_path の出力
is_talk_lint_target() {
    case "$1" in
        pages/*.md | slides.md) return 0 ;;
    esac
    return 1
}
