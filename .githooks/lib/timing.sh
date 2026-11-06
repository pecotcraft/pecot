# shellcheck shell=bash
# 自前 hook の所要記録 lib（#1083）。
#
# hook ラッパー（with-timing.sh）と affected テストのチェック（run-affected-tests.sh）が
# source して使う。記録先は `<repo_root>/.pecot/tmp/githooks-timing.tsv` の 1 本で、
# 追記専用。1 行 5 列の TSV: 記録時刻 / 種別（hook|task|nx）/ 名前 / 所要秒（小数 1 桁）/ 補足。
#
# 方針:
#   - この lib は `set` しない（source 元のオプションを尊重）。nounset 環境でも
#     安全なように参照は `${VAR:-}` を使う。
#   - 記録は hook の成否を変えない。書き込み失敗（ディレクトリ作成不能・書き込み不能）は
#     メッセージも出さずに握り潰し、常に 0 を返す。
#   - 時刻の取得は EPOCHREALTIME（bash 5 以降）を使い fork しない。小数点はロケール依存のため
#     数字以外を除いた整数マイクロ秒で扱い、秒への変換も整数演算だけで行う。
#
# 提供する関数:
#   timing_now_us                       → 現在時刻（整数マイクロ秒）を stdout。
#   timing_elapsed_sec <start_us>       → start_us からの経過秒（小数 1 桁）を stdout。
#   timing_record <repo_root> <kind> <name> <sec> <detail>
#                                       → 記録ファイルへ 1 行追記（失敗は握り潰す）。

TIMING_RELPATH=".pecot/tmp/githooks-timing.tsv"

timing_now_us() {
    local t="${EPOCHREALTIME:-0}"
    echo "${t/[^0-9]/}"
}

timing_elapsed_sec() {
    local start_us="${1:-}" now_us tenths
    # 開始時刻が空・数字以外なら算術展開に入れず 0.0 を返す。
    case "$start_us" in
        '' | *[!0-9]*) echo "0.0"; return 0 ;;
    esac
    now_us=$(timing_now_us)
    # 四捨五入で 0.1 秒単位にする。
    tenths=$(( (now_us - start_us + 50000) / 100000 ))
    [ "$tenths" -lt 0 ] && tenths=0
    printf '%d.%d\n' "$((tenths / 10))" "$((tenths % 10))"
}

timing_record() {
    local repo_root="$1" kind="$2" name="$3" sec="$4" detail="$5"
    local file="$repo_root/$TIMING_RELPATH" ts
    printf -v ts '%(%Y-%m-%dT%H:%M:%S%z)T' -1
    {
        mkdir -p "${file%/*}" \
            && printf '%s\t%s\t%s\t%s\t%s\n' "$ts" "$kind" "$name" "$sec" "$detail" >> "$file"
    } 2> /dev/null || true
    return 0
}
