#!/bin/bash
# hooks.json の PostToolUse が、3 つの MCP のツールを mcp_tool のフックで呼ぶことを確かめる（#795）。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
# shellcheck source=../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
CLAUDE_HOOKS="$PLUGIN_ROOT/hooks/hooks.json"
COPILOT_HOOKS="$PLUGIN_ROOT/com.github.copilot/hooks/hooks.json"

if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq が無いため hooks.json を読めない" >&2
    exit 1
fi

bt_eq "PostToolUse は matcher Write|Edit の 1 組" '["Write|Edit"]' \
    "$(jq -c '[.hooks.PostToolUse[].matcher]' "$CLAUDE_HOOKS")"

bt_eq "PostToolUse は file_lint・file_validate・file_brief の 3 つのツールを呼ぶ" \
    '["file_lint","file_validate","file_brief"]' \
    "$(jq -c '[.hooks.PostToolUse[0].hooks[].tool]' "$CLAUDE_HOOKS")"

# shellcheck disable=SC2016
bt_eq "3 つとも mcp_tool で、server・input・timeout が同じ" \
    '[["mcp_tool","plugin:pecot-v:pecot-visual","${tool_input.file_path}","${cwd}",80]]' \
    "$(jq -c '[.hooks.PostToolUse[0].hooks[] | [.type, .server, .input.file_path, .input.cwd, .timeout]] | unique' "$CLAUDE_HOOKS")"

# Copilot CLI には mcp_tool のフックが無いため、PostToolUse を置かない。
bt_eq "Copilot CLI の hooks.json に PostToolUse が無い" "false" \
    "$(jq -c '.hooks | has("PostToolUse")' "$COPILOT_HOOKS")"

bt_finish
