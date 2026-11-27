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

# run_attached [run の印…] <コマンド…>: run で動かし、コマンドの出力を添付してから run の終了コードを返す。
# 名前と型は vitest の attachOutput と同じ。既定の run は stderr を $output に入れるので、stdout の名前で添付する。
run_attached() {
    local rc=0
    run "$@" || rc=$?
    if _pecot_bats_attaching; then
        local label="${BATS_RUN_COMMAND:0:200}（終了コード ${status}）"
        if [ -n "$output" ] || [ -z "${stderr:-}" ]; then
            printf '%s' "$output" | _pecot_bats_attach "$label stdout" .txt
        fi
        if [ -n "${stderr:-}" ]; then
            printf '%s' "$stderr" | _pecot_bats_attach "$label stderr" .txt
        fi
    fi
    return "$rc"
}

# read_output <ファイル>: 判定に読むファイルの中身を stdout に出し、ファイル名を名前にして添付する。
# 型は vitest の readOutput と同じく、.txt・.json・.md・.svg のほかは .txt にする。
read_output() {
    if [ "$#" -ne 1 ]; then
        echo "read_output: ファイルを 1 つ渡してください" >&2
        return 1
    fi
    if [ ! -f "$1" ] || [ ! -r "$1" ]; then
        echo "read_output: ファイルを読めません: $1" >&2
        return 1
    fi
    cat -- "$1" || return 1
    _pecot_bats_attaching || return 0
    local extension
    extension="$(_pecot_bats_extension "$1")"
    case "$extension" in
        .txt | .json | .md | .svg) ;;
        *) extension=.txt ;;
    esac
    _pecot_bats_attach_once "$1" "$extension"
}

# attach_file <ファイル>: node などに読ませて判定するファイルを、中身を出さずに添付する。型は vitest の attachFile の表で決める。
attach_file() {
    if [ "$#" -ne 1 ]; then
        echo "attach_file: ファイルを 1 つ渡してください" >&2
        return 1
    fi
    _pecot_bats_attaching || return 0
    local extension
    extension="$(_pecot_bats_extension "$1")"
    if ! _pecot_bats_content_type "$extension" > /dev/null; then
        echo "attach_file: 添付の型が決まっていない拡張子: ${extension:-（拡張子なし）}" >&2
        return 1
    fi
    # ファイルが無いことは、テストに元からある判定が示す。
    [ -f "$1" ] || return 0
    _pecot_bats_attach_once "$1" "$extension"
}

# nx のレーンの中の @test の中でだけ添付する。setup_file・teardown_file の fd 3 は、formatter が @test の結果に入れない。
_pecot_bats_attaching() {
    [ -n "${PECOT_BATS_ATTACHMENTS:-}" ] && [ -n "${BATS_TEST_NAME:-}" ]
}

_pecot_bats_extension() { # <ファイル>
    local name="${1##*/}"
    if [[ "$name" == ?*.* ]]; then
        printf '.%s' "${name##*.}"
    fi
}

# 拡張子から添付の型を印字する。表は libs/interface-spec/src/vitest/attach.ts の CONTENT_TYPES と同じ。
_pecot_bats_content_type() { # <拡張子>
    case "$1" in
        .png) printf 'image/png' ;;
        .svg) printf 'image/svg+xml' ;;
        .pdf) printf 'application/pdf' ;;
        .pptx) printf 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ;;
        .xlsx) printf 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ;;
        .txt) printf 'text/plain' ;;
        .json) printf 'application/json' ;;
        .md) printf 'text/markdown' ;;
        *) return 1 ;;
    esac
}

# 同じ @test で同じファイルは 1 回だけ添付する。run が関数を subshell で動かすので、添付したパスをファイルに覚える。
_pecot_bats_attach_once() { # <ファイル> <拡張子>
    local seen="$PECOT_BATS_ATTACHMENTS/.seen/${BATS_SUITE_TEST_NUMBER:-0}" path
    path="$(realpath -- "$1")"
    mkdir -p "${seen%/*}"
    grep -Fqx -- "$path" "$seen" 2> /dev/null && return 0
    printf '%s\n' "$path" >> "$seen"
    _pecot_bats_attach "${1##*/}" "$2" < "$1"
}

# stdin の中身を添付のファイルに書き、fd 3 で formatter に「<ファイル名> <型> <名前>」を渡す。
_pecot_bats_attach() { # <名前> <拡張子>
    local uuid source name="${1//[$'\n\r\t']/ }"
    read -r uuid < /proc/sys/kernel/random/uuid
    source="$uuid-attachment$2"
    cat > "$PECOT_BATS_ATTACHMENTS/$source"
    printf '# pecot-attachment: %s %s %s\n' "$source" "$(_pecot_bats_content_type "$2")" "$name" >&3
}
