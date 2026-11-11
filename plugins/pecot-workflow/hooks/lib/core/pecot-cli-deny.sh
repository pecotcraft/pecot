#!/bin/bash
# Bash の pecot 起動を検出し、対応する MCP ツールの使用を促して阻止するコアチェック。
#
# 入力は環境変数 HOOK_COMMAND。出力は exit 0 + 空 stdout = 素通し、exit 1 + stdout = 阻止、exit 2 + stderr = 内部エラー。
# セグメントの分け方とクオートの正規化は command-segments.sh を共有する。
# 起動形は共有の _PECOT より締める。pecot の後ろに語の境界（空白か行末）を求め、パスの部分に = を含めない。
# サブコマンド別の許可・阻止は持たない。
# セグメント先頭に起動形が来ない形（${PECOT} / time / env / bash -c / { …; } / if）は素通しになる。
#
# どのスクリプトからも呼ばない（pre-tool-use-bash.sh への接続は切り替えのフェーズで行う）。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/hook-message.sh"
source "${SCRIPT_DIR}/command-segments.sh"
source "${SCRIPT_DIR}/pecot-tool-names.sh"

if [ -z "$HOOK_COMMAND" ]; then
  hook_message error "HOOK_COMMAND environment variable is required" >&2
  exit 2
fi

# 改行は区切りに直す。ただし <<（ヒアドキュメント）を含むときは、本文の行を止めないよう空白にする。
if [[ "$HOOK_COMMAND" == *"<<"* ]]; then
  HOOK_COMMAND="${HOOK_COMMAND//$'\n'/ }"
else
  HOOK_COMMAND="${HOOK_COMMAND//$'\n'/;}"
fi
HOOK_COMMAND="$(_dequote "$HOOK_COMMAND")"

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
