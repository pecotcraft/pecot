# shellcheck shell=bash
# 独立した *.test.sh を並走させ、ログを引数の順に出す。1 本でも落ちたら一覧を出して 1 を返す。
# 子は別のプロセスグループで起動し、INT / TERM ではグループごと止める（& の子は SIGINT を無視するため）。
# shellcheck source=../../../../.githooks/scripts/test_report/bash-test.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)/.githooks/scripts/test_report/bash-test.sh"

run_tests_parallel() {
    if [ "$#" -eq 0 ]; then
        echo "ERROR: run_tests_parallel: テストファイルが 0 本です" >&2
        return 1
    fi
    local workdir file pid i=0 failed=()
    local -a pids=() logs=() files=()
    workdir="$(mktemp -d)"
    # 子 pid = そのプロセスグループの id（job control 下の子は自分がグループリーダーになる）。
    trap 'for pid in "${pids[@]}"; do kill -TERM -- "-$pid" 2>/dev/null; done; wait; rm -rf "$workdir"; exit 130' INT TERM
    local monitor_was_off=false
    case $- in
        *m*) ;;
        *)
            monitor_was_off=true
            set -m
            ;;
    esac
    for file in "$@"; do
        logs[i]="$workdir/$i.log"
        files[i]="$file"
        bt_run_file "$file" > "${logs[i]}" 2>&1 < /dev/null &
        pids[i]=$!
        i=$((i + 1))
    done
    if [ "$monitor_was_off" = true ]; then
        set +m
    fi
    for ((i = 0; i < ${#files[@]}; i++)); do
        local rc=0
        wait "${pids[i]}" || rc=$?
        echo "==> bash ${files[i]}"
        cat "${logs[i]}"
        if [ "$rc" -ne 0 ]; then
            failed+=("${files[i]} (exit $rc)")
        fi
    done
    trap - INT TERM
    rm -rf "$workdir"
    if [ "${#failed[@]}" -gt 0 ]; then
        echo "FAILED: ${#failed[@]} 本のテストが失敗しました:" >&2
        printf '  %s\n' "${failed[@]}" >&2
        return 1
    fi
    return 0
}
