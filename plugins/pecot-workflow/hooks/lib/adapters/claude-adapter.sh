#!/bin/bash
# Claude Code用アダプター。
#
# Claude CodeのPreToolUseフックからコアチェックスクリプトを呼び出す。
# stdin JSONを環境変数に変換し、コアの結果をClaude Code形式に変換する。
#
# 使用法は次のとおり。
#   echo '{"tool_input":{"command":"..."}}' | claude-adapter.sh <core-script>。
#   source claude-adapter.sh && run_claude_guard <core-script>。
#
# 出力は次のとおり。
#   - コア exit 0 + 非空stdout → そのまま出力（警告テキスト）
#   - コア exit 1 → hookSpecificOutput.permissionDecision:"deny" の JSON出力
#   - コア exit 2 → stderrにログ、フェイルオープン（何も出力しない）
# 常にexit 0を返す（Claude Code規約）。

_ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${_ADAPTER_DIR%/*}/core/config-dispatcher.sh"

run_claude_guard() {
  pecot_hook_enabled "claude-adapter" true || return 0

  local core_script="$1"

  if [ -z "$core_script" ]; then
    echo "Usage: claude-adapter.sh <core-script>" >&2
    return 0
  fi

  if [ ! -x "$core_script" ]; then
    echo "Core script not found or not executable: $core_script" >&2
    return 0
  fi

  # stdin JSONからコマンドを抽出。
  local input
  if ! input=$(cat); then
    echo "Failed to read input from stdin" >&2
    return 0
  fi
  local command
  if ! command=$(echo "$input" | jq -r '.tool_input.command // ""' 2>/dev/null); then
    echo "Invalid JSON input" >&2
    return 0
  fi

  if [ -z "$command" ]; then
    return 0
  fi

  # 環境変数を設定してコアスクリプトを実行。
  export HOOK_COMMAND="$command"
  export HOOK_WORKING_DIR="${CLAUDE_PROJECT_DIR:-}"
  # Claude Code の hook 入力 `cwd` は hook 起動時点の作業ディレクトリで、Bash ツールの
  # `cd` に追随する。ただし PreToolUse は当該コマンドの実行前に発火するため、コマンド
  # 自身に含まれる `cd` は反映されない（そちらは core がコマンド文字列から解釈する）。
  local tool_cwd
  tool_cwd=$(echo "$input" | jq -r '.cwd // ""' 2>/dev/null) || tool_cwd=""
  export HOOK_TOOL_CWD="$tool_cwd"

  local output
  local exit_code
  local stderr_file
  stderr_file=$(mktemp)
  output=$("$core_script" 2>"$stderr_file")
  exit_code=$?

  unset HOOK_COMMAND
  unset HOOK_WORKING_DIR
  unset HOOK_TOOL_CWD

  case $exit_code in
    0)
      # 許可、または警告（非空stdoutの場合）。
      if [ -n "$output" ]; then
        echo "$output"
      fi
      ;;
    1)
      # ブロック: JSON形式で出力。
      if ! jq -n --arg reason "$output" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}' 2>/dev/null; then
        local script_name
        script_name=$(basename "$core_script")
        jq -n --arg reason "フック実行エラー: コアスクリプト ${script_name} の出力をJSON変換できませんでした。\n原因: コアスクリプトがブロック判定を返しましたが、出力形式が不正です。\n対処: フックのログ（tmp/pecot/hooks/）を確認し、コアスクリプトの出力内容を調べてください。" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
      fi
      ;;
    2)
      # 内部エラー: フェイルオープン。
      echo "Hook core script error (fail-open): $core_script" >&2
      if [ -s "$stderr_file" ]; then
        cat "$stderr_file" >&2
      fi
      ;;
  esac

  rm -f "$stderr_file"
  return 0
}

# 直接実行時（sourceではなく）。
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  run_claude_guard "$1"
fi
