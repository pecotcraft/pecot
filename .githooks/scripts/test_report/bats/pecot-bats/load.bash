# bats のテストのファイルが setup で `bats_load_library pecot-bats` と読むライブラリ。
# bats-support・bats-assert と、テストレポートに説明を付ける explains を読み込む。BATS_LIB_PATH は run.sh が置く。

bats_load_library bats-support
bats_load_library bats-assert

# explains <説明>: @test の本体の先頭で 1 回呼び、何を確認するテストかをテストレポートの説明に付ける。
# nx のレーンの中（run.sh が PECOT_BATS_REPORT を置く）でだけ、fd 3 に書いて formatter に渡す。
explains() {
    if [ "$#" -ne 1 ] || [ -z "$1" ] || [[ "$1" == *$'\n'* ]]; then
        echo "explains: 空でなく改行の無い説明を 1 つ渡してください" >&2
        return 1
    fi
    [ -n "${PECOT_BATS_REPORT:-}" ] || return 0
    printf '# pecot-description: %s\n' "$1" >&3
}

# severity <段階>: 場所から決まる重大度の代わりに、この @test にこの段階を付ける。本体の explains の後で呼ぶ。
severity() {
    case "${1:-}" in
        blocker | critical | normal | minor | trivial) ;;
        *)
            echo "severity: 段階は blocker・critical・normal・minor・trivial のどれかを渡してください（渡された値: ${1:-}）" >&2
            return 1
            ;;
    esac
    [ -n "${PECOT_BATS_REPORT:-}" ] || return 0
    printf '# pecot-severity: %s\n' "$1" >&3
}
