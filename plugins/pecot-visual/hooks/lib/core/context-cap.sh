# shellcheck shell=bash disable=SC2034
# hooks がエージェントへ返す文脈を UTF-8 のバイト数で切る共有ライブラリ。source 専用（実行ビットは付けない）。
# Copilot CLI の上限がバイトなので、UTF-16 の字数でなくバイトで数える。

PECOTV_CONTEXT_MAX_TOTAL=8000
PECOTV_CONTEXT_MAX_LAYOUT=3500
PECOTV_CONTEXT_MAX_ESLINT=3500
PECOTV_CONTEXT_MAX_TEXT_LINT=3000
PECOTV_CONTEXT_MAX_REFERENCES=3000

# cap_context <上限バイト> <件の正規表現> <単位>。本文は標準入力から読む。
# 結果: CAPPED_BODY（切った本文）、CAP_NOTE（切ったときだけ "Truncated at ..." の 1 行）。
# jq 1.6 の機能だけを使う（Ubuntu 20.04 / 22.04 の jq）。
cap_context() {
    local max="$1" re="$2" unit="$3" out
    out=$(jq -Rrs --argjson max "$max" --arg re "$re" --arg unit "$unit" '
      def cpbytes: if . < 128 then 1 elif . < 2048 then 2 elif . < 65536 then 3 else 4 end;
      def count_rest: [.[] | select(test($re))] | length;
      sub("\n+$"; "") | split("\n") as $lines
      | reduce range(0; $lines | length) as $i ({size: 0, cut: null};
          if .cut != null then .
          else (($lines[$i] | utf8bytelength) + (if $i == 0 then 0 else 1 end)) as $c
            | if .size + $c <= $max then .size += $c else .cut = $i end
          end) as $r
      | if $r.cut == null then "\n" + ($lines | join("\n"))
        else
          (if $r.cut == 0 then
             ($lines[0] | explode
               | reduce .[] as $cp ({n: 0, o: [], stop: false};
                   if .stop then .
                   elif .n + ($cp | cpbytes) > $max then .stop = true
                   else .n += ($cp | cpbytes) | .o += [$cp] end)
               | .o | implode) as $head
             | [$head, ($lines[1:] | count_rest)]
           else [($lines[:$r.cut] | join("\n")), ($lines[$r.cut:] | count_rest)] end) as $p
          | "Truncated at \($max) bytes: \($p[1]) more \($unit) not shown.\n" + $p[0]
        end')
    if [[ "$out" == *$'\n'* ]]; then
        CAP_NOTE="${out%%$'\n'*}"
        CAPPED_BODY="${out#*$'\n'}"
    else
        CAP_NOTE="$out"
        CAPPED_BODY=""
    fi
}
