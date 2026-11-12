#!/bin/bash
# Bash の pecot 起動を検出し、対応する MCP ツールの使用を促して阻止するコアチェック。入力は HOOK_COMMAND。
# 起動形は共有の _PECOT より締める（pecot の後ろは空白か行末、パス部分に = を含めない）。接続は切り替えのフェーズ。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/hook-message.sh"
source "${SCRIPT_DIR}/command-segments.sh"
source "${SCRIPT_DIR}/pecot-tool-names.sh"

if [ -z "$HOOK_COMMAND" ]; then
  hook_message error "HOOK_COMMAND environment variable is required" >&2
  exit 2
fi

# ヒアドキュメントの本文の行と、区切り文字を含むクオートの範囲を除き、改行は ; にする。
# `<<<` と、クオート内の `<<` は、ヒアドキュメントと扱わない。
_strip_non_commands() {
  printf '%s\n' "$1" | awk '
    BEGIN { sq = sprintf("%c", 39); dq = "\""; inq = ""; out = ""; first = 1; nh = 0 }
    {
      line = $0
      if (nh > 0) {
        cmp = line
        if (hdash[1]) sub(/^\t+/, "", cmp)
        if (cmp == hd[1]) {
          for (k = 1; k < nh; k++) { hd[k] = hd[k + 1]; hdash[k] = hdash[k + 1] }
          nh--
        }
        next
      }
      if (!first) { if (inq == "") out = out ";"; else span = span "\n" }
      first = 0
      n = length(line); i = 1
      while (i <= n) {
        c = substr(line, i, 1)
        if (inq != "") {
          if (c == inq) {
            if (span !~ /[[:space:];&|()`]/) out = out span
            inq = ""; span = ""
          } else if (c == "\\" && inq == dq) {
            span = span c substr(line, i + 1, 1); i++
          } else span = span c
          i++
        } else if (c == "\\") {
          out = out c substr(line, i + 1, 1); i += 2
        } else if (c == sq || c == dq) {
          inq = c; span = ""; i++
        } else if (substr(line, i, 3) == "<<<") {
          out = out "<<<"; i += 3
        } else if (substr(line, i, 2) == "<<") {
          j = i + 2; dash = 0
          if (substr(line, j, 1) == "-") { dash = 1; j++ }
          while (substr(line, j, 1) ~ /[ \t]/) j++
          q = substr(line, j, 1); delim = ""
          if (q == sq || q == dq) {
            rest = substr(line, j + 1); k = index(rest, q)
            if (k > 0) { delim = substr(rest, 1, k - 1); j += k + 1 } else j = n + 1
          } else {
            while (j <= n && substr(line, j, 1) !~ /[[:space:];&|()<>]/) { delim = delim substr(line, j, 1); j++ }
          }
          if (delim != "" && delim !~ /^[0-9]/) { nh++; hd[nh] = delim; hdash[nh] = dash }
          out = out "<<"; i = j
        } else { out = out c; i++ }
      }
    }
    END { if (inq != "") out = out span; printf "%s", out }'
}

HOOK_COMMAND="$(_strip_non_commands "$HOOK_COMMAND")"

_DENY_PECOT='(\$PECOT|[^[:space:]=]*/pecot|pecot)'
_DENY_PATTERN="${_SEG_ANCHOR}${_DENY_PECOT}([[:space:]]+(.*))?\$"

# 起動形のあとの語から、MCP ツール名を決める。2 語をつないだ名前を先に、無ければ 1 語目を見る。
_tool_for_words() {
  local first="${1//-/_}" second="${2//-/_}"
  if [ -n "$second" ] && pecot_tool_known "${first}_${second}"; then
    printf '%s' "${first}_${second}"
  elif pecot_tool_known "$first"; then
    printf '%s' "$first"
  fi
}

while IFS= read -r seg; do
  [[ "$seg" =~ $_DENY_PATTERN ]] || continue
  set -f
  # shellcheck disable=SC2086
  set -- ${BASH_REMATCH[4]}
  set +f
  tool="$(_tool_for_words "${1:-}" "${2:-}")"
  if [ -n "$tool" ]; then
    hook_message error "pecot-cli-deny: calling the pecot CLI through Bash is not allowed.

Use the MCP tool $tool of the workflow server instead."
  else
    hook_message error "pecot-cli-deny: calling the pecot CLI through Bash is not allowed.

Use one of the MCP tools of the workflow server instead:
$PECOT_TOOL_NAMES"
  fi
  exit 1
done <<< "$(_split_segments "$HOOK_COMMAND")"

exit 0
