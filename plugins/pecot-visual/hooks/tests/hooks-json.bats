# hooks.json の PostToolUse が、3 つの MCP のツールを mcp_tool のフックで呼ぶことを確かめる (#795)。

bats_require_minimum_version 1.5.0

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

PLUGIN_ROOT="$BATS_TEST_DIRNAME/../.."
CLAUDE_HOOKS="$PLUGIN_ROOT/hooks/hooks.json"
COPILOT_HOOKS="$PLUGIN_ROOT/com.github.copilot/hooks/hooks.json"

setup() {
    bats_load_library pecot-bats
}

setup_file() {
    bats_load_library pecot-bats
    command -v jq >/dev/null 2>&1 || fail "jq が無いため hooks.json を読めない"
}

@test "Claude Code の PostToolUse は、Write と Edit で 3 つのツールを同じ設定の mcp_tool で呼ぶ" {
    explains "Claude Code 用の \`hooks/hooks.json\` を読むテストです。PostToolUse が 1 組の \`Write|Edit\` で、3 つのツールを同じ server・input・timeout の mcp_tool で呼ぶことを確認します。"
    run jq -c '[.hooks.PostToolUse[].matcher]' "$CLAUDE_HOOKS"
    assert_output '["Write|Edit"]'
    run jq -c '[.hooks.PostToolUse[0].hooks[].tool]' "$CLAUDE_HOOKS"
    assert_output '["file_lint","file_validate","file_brief"]'
    run jq -c '[.hooks.PostToolUse[0].hooks[] | [.type, .server, .input.file_path, .input.cwd, .timeout]] | unique' "$CLAUDE_HOOKS"
    # shellcheck disable=SC2016
    assert_output '[["mcp_tool","plugin:pecot-v:pecot-visual","${tool_input.file_path}","${cwd}",80]]'
}

# Copilot CLI には mcp_tool のフックが無いため、PostToolUse を置かない。
@test "Copilot CLI の hooks.json には、PostToolUse を置かない" {
    explains "Copilot CLI 用の \`com.github.copilot/hooks/hooks.json\` を読むテストです。hooks の中に PostToolUse の項目が無いことを確認します。"
    run jq -c '.hooks | has("PostToolUse")' "$COPILOT_HOOKS"
    assert_output "false"
}
