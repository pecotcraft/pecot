# shellcheck shell=bash
# hooks がエージェントへ返す文言に、行の種類の頭と字下げを付ける共有ライブラリ。source して使う
# （単体実行しない。実行ビットも付けない）。
#
# 使い方: hook_message <error|warning|note> <text>
#   1 行目に `<kind>: `、2 行目以降の先頭に空白 2 つを付ける。空行は空のまま残す。
#   末尾の改行は 1 つにそろえる。
#   空行を空のままにする理由は、pre-commit の trailing-whitespace が .sh の行末の空白を消すため。
#
# pecot-workflow の hooks/lib/core/hook-message.sh と同じ中身にしている。
# 他プラグインのファイルは nx の入力に入らないので、プラグインごとに置く。
hook_message() {
    local kind="$1" text="$2"
    while [ "${text%$'\n'}" != "$text" ]; do text="${text%$'\n'}"; done
    printf '%s\n' "$text" | awk -v k="$kind" 'NR == 1 { print k ": " $0; next } $0 == "" { print ""; next } { print "  " $0 }'
}
