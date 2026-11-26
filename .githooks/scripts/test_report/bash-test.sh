#!/usr/bin/env bash
# bash のテストの確かめを 1 つずつ Allure の結果（{uuid}-result.json）にする関数。source 専用。
# 結果を書くのは bt_run_file が結果のディレクトリを渡したときだけで、手で打つと印字だけになる。

if [ -n "${_BT_LOADED:-}" ]; then
    return 0
fi
_BT_LOADED=1

_BT_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"

# bt_run_file が子に渡す値。孫のプロセスに渡らないよう、読んだら環境から外す。
_BT_RESULTS="${BT_RESULTS:-}"
_BT_WORKDIR="${BT_WORKDIR:-}"
_BT_FILE="${BT_FILE:-$0}"
unset BT_RESULTS BT_WORKDIR BT_FILE

declare -A _BT_SEEN=()

_bt_now_ms() {
    local t="${EPOCHREALTIME:-}"
    t="${t//[!0-9]/}"
    if [ -n "$t" ]; then
        printf '%s' "$((10#$t / 1000))"
    else
        printf '%s000' "$(date +%s)"
    fi
}

_bt_relpath() {
    local dir
    dir="$(cd -P "$(dirname "$1")" 2> /dev/null && pwd -P)" || dir="$(dirname "$1")"
    local abs="$dir/$(basename "$1")"
    printf '%s' "${abs#"$_BT_ROOT"/}"
}

_BT_REL="$(_bt_relpath "$_BT_FILE")"
_BT_LAST_MS="$(_bt_now_ms)"

# 件数は、( ... ) の中の確かめも数えられるようファイルに書く。
# 手で打つときは名前だけ決め、最初の確かめで作る。bt_run_file だけを使う runner に残さないため。
if [ -n "$_BT_WORKDIR" ]; then
    _BT_STATE="$_BT_WORKDIR/state"
    _BT_OWN_STATE=""
else
    _BT_STATE="$(mktemp -u)"
    _BT_OWN_STATE=1
fi

_bt_json() {
    local s="$1" i ch code
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    if [[ "$s" == *[$'\001'-$'\037']* ]]; then
        for ((i = 1; i < 32; i++)); do
            printf -v ch "\\$(printf '%03o' "$i")"
            if [[ "$s" == *"$ch"* ]]; then
                printf -v code '\\u%04x' "$i"
                s="${s//"$ch"/$code}"
            fi
        done
    fi
    printf '"%s"' "$s"
}

# _bt_write <相対パス> <status> <題> <理由> <start> <stop> [<expected> <actual>]
_bt_write() {
    local results="$1"
    shift
    [ -n "$results" ] || return 0
    local rel="$1" status="$2" title="$3" message="$4" start="$5" stop="$6"
    local project="${NX_TASK_TARGET_PROJECT:-}" lane="${NX_TASK_TARGET_TARGET:-}"
    local uuid details labels
    read -r uuid < /proc/sys/kernel/random/uuid
    details=""
    if [ -n "$message" ]; then
        details="\"message\":$(_bt_json "$message")"
    fi
    if [ "$#" -ge 8 ]; then
        details="${details:+$details,}\"expected\":$(_bt_json "$7"),\"actual\":$(_bt_json "$8")"
    fi
    labels="{\"name\":\"parentSuite\",\"value\":$(_bt_json "$rel")}"
    labels+=",{\"name\":\"host\",\"value\":$(_bt_json "${HOSTNAME:-}")}"
    labels+=",{\"name\":\"thread\",\"value\":$(_bt_json "$$")}"
    labels+=",{\"name\":\"language\",\"value\":\"bash\"},{\"name\":\"framework\",\"value\":\"bash\"}"
    [ -n "$project" ] && labels+=",{\"name\":\"project\",\"value\":$(_bt_json "$project")}"
    [ -n "$lane" ] && labels+=",{\"name\":\"lane\",\"value\":$(_bt_json "$lane")}"
    mkdir -p "$results"
    printf '{"uuid":"%s","name":%s,"fullName":%s,"status":"%s","stage":"finished","statusDetails":{%s},"start":%s,"stop":%s,"labels":[%s]}\n' \
        "$uuid" "$(_bt_json "$title")" "$(_bt_json "$project:$lane $rel#$title")" \
        "$status" "$details" "$start" "$stop" "$labels" > "$results/$uuid-result.json"
}

# _bt_record <status> <題> <理由> [<expected> <actual>]
_bt_record() {
    local status="$1" title="$2" message="$3"
    shift 3
    local now
    now="$(_bt_now_ms)"
    local seen="${_BT_SEEN[$title]:-0}"
    _BT_SEEN[$title]=$((seen + 1))
    if [ "$seen" -gt 0 ]; then
        # 前の確かめの再実行にまとまらないよう、題に回数を足して別の 1 件にする。
        status=failed
        message="題が重なる（同じファイルに同じ題の確かめがある）${message:+: $message}"
        title="$title（$((seen + 1)) 回目）"
    fi
    case "$status" in
        passed) printf 'PASS: %s\n' "$title" ;;
        skipped) printf 'SKIP: %s — %s\n' "$title" "$message" ;;
        *) printf 'FAIL: %s — %s\n' "$title" "$message" ;;
    esac
    printf '%s\n' "$status" >> "$_BT_STATE"
    _bt_write "$_BT_RESULTS" "$_BT_REL" "$status" "$title" "$message" "$_BT_LAST_MS" "$now" "$@"
    _BT_LAST_MS="$now"
    return 0
}

# bt_pass <題>
bt_pass() { _bt_record passed "$1" ""; }

# bt_fail <題> <理由>
bt_fail() { _bt_record failed "$1" "${2:-}"; }

# bt_skip <題> <理由>
bt_skip() { _bt_record skipped "$1" "${2:-}"; }

# bt_eq <題> <期待> <実際>
bt_eq() {
    if [ "$2" = "$3" ]; then
        bt_pass "$1"
    else
        _bt_record failed "$1" "期待 [$2] / 実際 [$3]" "$2" "$3"
    fi
}

# bt_ne <題> <違うはずの値> <実際>
bt_ne() {
    if [ "$2" != "$3" ]; then
        bt_pass "$1"
    else
        _bt_record failed "$1" "[$2] と違う値のはずが、同じだった" "not $2" "$3"
    fi
}

# bt_contains <題> <含むはずの文字列> <対象>
bt_contains() {
    if [[ "$3" == *"$2"* ]]; then
        bt_pass "$1"
    else
        _bt_record failed "$1" "「$2」を含まない: $3"
    fi
}

# bt_not_contains <題> <含まないはずの文字列> <対象>
bt_not_contains() {
    if [[ "$3" != *"$2"* ]]; then
        bt_pass "$1"
    else
        _bt_record failed "$1" "「$2」を含む: $3"
    fi
}

# bt_finish: 件数を印字し、落ちた確かめがあれば 1 を返す。ファイルの最後に置く。
bt_finish() {
    local status passed=0 failed=0 skipped=0
    if [ -f "$_BT_STATE" ]; then
        while IFS= read -r status; do
            case "$status" in
                passed) passed=$((passed + 1)) ;;
                skipped) skipped=$((skipped + 1)) ;;
                *) failed=$((failed + 1)) ;;
            esac
        done < "$_BT_STATE"
    fi
    printf '\nPASS: %d / FAIL: %d / SKIP: %d\n' "$passed" "$failed" "$skipped"
    if [ -n "$_BT_WORKDIR" ]; then
        : > "$_BT_WORKDIR/finished"
    fi
    if [ -n "$_BT_OWN_STATE" ]; then
        rm -f "$_BT_STATE"
    fi
    [ "$failed" -eq 0 ]
}

# bt_run_file <ファイル> [引数...]: テストのファイルを 1 本動かし、その終了コードを返す。
# bt_finish の前で終わったファイルは「最後まで動く」を broken として書き、終了コードが 0 でも 1 を返す。
# 本体を subshell で動かし、INT / TERM で止められても EXIT trap で作業ディレクトリを消す。
bt_run_file() (
    local file="$1"
    shift
    local wd rc=0 start stop rel
    wd="$(mktemp -d)"
    trap 'rm -rf "$wd"' EXIT
    start="$(_bt_now_ms)"
    BT_WORKDIR="$wd" BT_RESULTS="${PECOT_REPORT_RESULTS:-}" BT_FILE="$file" bash "$file" "$@" || rc=$?
    if [ ! -e "$wd/finished" ]; then
        stop="$(_bt_now_ms)"
        rel="$(_bt_relpath "$file")"
        printf 'BROKEN: %s: bt_finish に届かず、終了コード %d で終わった\n' "$rel" "$rc"
        _bt_write "${PECOT_REPORT_RESULTS:-}" "$rel" broken "最後まで動く" \
            "bt_finish に届かず、終了コード $rc で終わった" "$start" "$stop"
        [ "$rc" -ne 0 ] || rc=1
    fi
    exit "$rc"
)

# bt_run_files <ファイル>...: 1 本ずつ bt_run_file で最後まで動かし、落ちたファイルがあれば一覧を出して 1 を返す。
bt_run_files() {
    local file rc failed=()
    for file in "$@"; do
        echo "==> bash $file"
        rc=0
        bt_run_file "$file" || rc=$?
        if [ "$rc" -ne 0 ]; then
            failed+=("$file (exit $rc)")
        fi
    done
    if [ "${#failed[@]}" -gt 0 ]; then
        echo "FAILED: ${#failed[@]} 本のテストが失敗しました:" >&2
        printf '  %s\n' "${failed[@]}" >&2
        return 1
    fi
    return 0
}

# bt_results_dir <プラグインのルート>: nx のレーンから動いたときの結果のディレクトリ。nx の外では空。
bt_results_dir() {
    if [ -n "${NX_TASK_TARGET_TARGET:-}" ]; then
        printf '%s/test-results/%s/allure-results' "$1" "$NX_TASK_TARGET_TARGET"
    fi
}
