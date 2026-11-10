#!/bin/bash
# hooks がエージェントへ返す文言の頭と字下げを付ける。
# 提供関数: hook_message <error|warning|note> <text>
# 1 行目に「<kind>: 」を付け、2 行目以降の先頭に空白 2 つを付ける。空行は行末空白を避けるため空のまま残す。

hook_message() {
    local kind="$1" text="$2"
    while [ "${text%$'\n'}" != "$text" ]; do text="${text%$'\n'}"; done
    printf '%s\n' "$text" | awk -v k="$kind" 'NR == 1 { print k ": " $0; next } $0 == "" { print ""; next } { print "  " $0 }'
}
