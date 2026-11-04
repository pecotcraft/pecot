#!/usr/bin/env bash
# ブランドの語が、リポジトリと配布物に残っていないことを確かめる。
#
# 用法: check-brand-terms.sh [--require-terms] [--ref <ref>]... [--dir <path>]...
#
#   --ref <ref>      そのコミットの中身とパスの名前を調べる（git grep -F -f と git ls-tree）。
#   --dir <path>     git に頼らず、ディレクトリの全ファイル（ドットファイルを含む）の
#                    中身とパスの名前を調べる。パスは <path> からの相対で調べる。
#   引数なし         pre-push 用。PRE_COMMIT_TO_REF、無ければ HEAD を --ref で調べる。
#   --require-terms  語の一覧が無いとき止める（リリース用）。付けないときは、
#                    一覧が無ければ飛ばしたことを表示して exit 0 にする。
#
# 語の一覧は環境変数 PECOT_BRAND_TERMS_FILE のファイルから読む。
#   - 1 行 1 件の固定文字列（正規表現ではない）。大文字小文字を区別する。
#   - `#` の直後が空白か行末の行は注釈。`#abcdef` のような色の行は語として読む。
#   - 空行と CR は除く。注釈を除いた語が 0 件なら失敗にする。
#
# どのモードでも CHANGELOG.md は対象から除く。
#
# exit code: 0 = 一致なし（または一覧が無く飛ばした）/ 1 = 一致あり / 2 = 使い方・一覧の誤り

set -uo pipefail

script_name="check-brand-terms"

usage_error() {
    echo "$script_name: $*" >&2
    exit 2
}

require_terms=0
declare -a refs=()
declare -a dirs=()

while [ "$#" -gt 0 ]; do
    case "$1" in
        --require-terms)
            require_terms=1
            shift
            ;;
        --ref)
            [ "$#" -ge 2 ] || usage_error "--ref には ref が必要です"
            refs+=("$2")
            shift 2
            ;;
        --dir)
            [ "$#" -ge 2 ] || usage_error "--dir にはディレクトリが必要です"
            dirs+=("$2")
            shift 2
            ;;
        *)
            usage_error "未知の引数です: $1（用法: [--require-terms] [--ref <ref>]... [--dir <path>]...）"
            ;;
    esac
done

# --dir は、cd する前に絶対パスへ解決する
declare -a dir_abs=()
for d in ${dirs[@]+"${dirs[@]}"}; do
    [ -d "$d" ] || usage_error "ディレクトリが存在しません: $d"
    dir_abs+=("$(cd "$d" && pwd)")
done

# --- 語の一覧 ---
terms_src="${PECOT_BRAND_TERMS_FILE:-}"
if [ -z "$terms_src" ] || [ ! -f "$terms_src" ]; then
    if [ "$require_terms" -eq 1 ]; then
        usage_error "語の一覧がありません。環境変数 PECOT_BRAND_TERMS_FILE に一覧ファイルの絶対パスを渡してください（現在: ${terms_src:-未設定}）"
    fi
    echo "$script_name: PECOT_BRAND_TERMS_FILE が未設定、またはファイルが無いため、ブランドの語の確認を飛ばしました" >&2
    exit 0
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/check-brand-terms.XXXXXX") || usage_error "作業ディレクトリを作れません"
trap 'rm -rf "$work_dir"' EXIT

terms="$work_dir/terms"
# CR を除き、注釈（`#` の直後が空白か行末）と空行を除く
tr -d '\r' < "$terms_src" | grep -v -E '^#( |$)' | grep -v -E '^$' > "$terms" || true
if [ ! -s "$terms" ]; then
    usage_error "語の一覧に、注釈を除いた語が 1 件もありません: $terms_src"
fi

hits="$work_dir/hits"
: > "$hits"

# 標準入力のパス（1 行 1 件）から、語を含むものを hits へ書く。
# $1 = 表示に付ける接頭辞（ref 名や dir 名）
record_path_matches() {
    local prefix="$1" path term base
    while IFS= read -r path; do
        [ -z "$path" ] && continue
        base="${path##*/}"
        [ "$base" = "CHANGELOG.md" ] && continue
        while IFS= read -r term; do
            [ -z "$term" ] && continue
            if [[ "$path" == *"$term"* ]]; then
                printf '%s\t%s\t%s\n' "$prefix$path" "パスの名前" "$term" >> "$hits"
            fi
        done < "$terms"
    done < <(grep -F -f "$terms" || true)
}

# 標準入力の「<パス>NUL<行番号>:<語>」の列から、パス・語の組を hits へ書く。
# $1 = 取り除く接頭辞、$2 = 表示に付ける接頭辞
record_content_matches() {
    local strip="$1" prefix="$2" file rest term
    while IFS= read -r -d '' file; do
        IFS= read -r rest || true
        term="${rest#*:}"
        file="${file#"$strip"}"
        printf '%s\t%s\t%s\n' "$prefix$file" "中身" "$term" >> "$hits"
    done
}

check_ref() {
    local ref="$1" root
    root=$(git rev-parse --show-toplevel 2> /dev/null) || usage_error "git リポジトリの中で実行してください（--ref: $ref）"
    git -C "$root" rev-parse --verify --quiet "$ref^{commit}" > /dev/null \
        || usage_error "ref を解決できません: $ref"
    (
        cd "$root" || exit 2
        git grep -a -F -o -n -z -f "$terms" "$ref" -- . ':(exclude,glob)**/CHANGELOG.md' 2> /dev/null || true
    ) | record_content_matches "$ref:" "$ref:"
    git -C "$root" -c core.quotepath=false ls-tree -r --name-only "$ref" | record_path_matches "$ref:"
}

check_dir() {
    local abs="$1" given="$2"
    (
        cd "$abs" || exit 2
        grep -r -a -F -o -n -H -Z -f "$terms" --exclude=CHANGELOG.md . 2> /dev/null || true
    ) | record_content_matches "./" "$given/"
    (
        cd "$abs" || exit 2
        find . -mindepth 1 -print
    ) | sed 's|^\./||' | record_path_matches "$given/"
}

targets=()
if [ "${#refs[@]}" -eq 0 ] && [ "${#dirs[@]}" -eq 0 ]; then
    default_ref="${PRE_COMMIT_TO_REF:-HEAD}"
    case "$default_ref" in
        0000000000000000000000000000000000000000 | 0000000000000000000000000000000000000000000000000000000000000000)
            echo "$script_name: ブランチの削除の push のため、確認を飛ばしました" >&2
            exit 0
            ;;
    esac
    refs=("$default_ref")
fi

for r in ${refs[@]+"${refs[@]}"}; do
    check_ref "$r"
    targets+=("ref $r")
done
i=0
for d in ${dirs[@]+"${dirs[@]}"}; do
    check_dir "${dir_abs[$i]}" "$d"
    targets+=("dir $d")
    i=$((i + 1))
done

target_text=$(printf '%s, ' "${targets[@]}")
target_text="${target_text%, }"

if [ -s "$hits" ]; then
    sort -u "$hits" | while IFS=$'\t' read -r path kind term; do
        echo "$script_name: 一致 $path ($kind) 語: $term"
    done
    count=$(sort -u "$hits" | wc -l | tr -d ' ')
    echo "$script_name: 一致 $count 件（対象: $target_text）" >&2
    exit 1
fi

echo "$script_name: 一致 0 件（対象: $target_text）"
exit 0
