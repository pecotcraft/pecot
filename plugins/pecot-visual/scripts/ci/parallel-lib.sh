# shellcheck shell=bash
# 互いに独立した *.test.sh を並走させる共通関数 (#1225)。run-tests.sh の release ブロックが使う。
#
# release lane の 4 本は audit / opt-in / publish / runtime-manifest。
# どれも一時ディレクトリ・モックレジストリのポート（ephemeral）・監査記録（PECOTV_AUDIT_RECORD）をテスト内に閉じている。
# 共有するのは、読み取りだけの cli/dist と、npm のキャッシュ（cacache は複数プロセスから安全）。
# 直列だと 4 本の合計（約 39 秒）、並走すると最長の 1 本（約 20 秒）で終わる。
#
# この lib は `set` しない（source 元のオプションを尊重）。
#
# run_tests_parallel <test.sh>...
#   各テストを `bash <file>` で並走させ、ログは引数の順に 1 本ずつまとめて出す。
#   並走でも直列と同じ読み方ができる。
#   1 本でも失敗したら、失敗したファイルを列挙して 1 を返す。
#   失敗しても、残りは最後まで実行する。引数が 0 本なら 1 を返す（空のまま緑にしない）。
#   実行中に INT / TERM を受けたら、並走中の子をプロセスグループごと TERM で止めて待つ。
#   そのあと workdir を消して、130 で終わる。
#   非対話シェルの `&` で起動した子は SIGINT を無視する。
#   そのため Ctrl-C だけでは、子が最後まで動き続ける。
#   子はそれぞれ別のプロセスグループで起動する（起動の間だけ `set -m`）。
#   これで、テストが起動した孫（モックレジストリ等）も止まる。
#   bash は TERM で終了するときも EXIT trap を実行する。
#   そのため、各テストの後始末（trap ... EXIT）も実行される。
#   グループを分けた子は端末の入力を読めないので、stdin は /dev/null にする。
#   trap は関数の中だけで張り、戻る前に外す（呼び出し元の EXIT trap・`set -m` の状態は戻す）。
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
        bash "$file" > "${logs[i]}" 2>&1 < /dev/null &
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
