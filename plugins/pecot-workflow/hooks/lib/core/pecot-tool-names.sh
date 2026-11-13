#!/bin/bash
# MCP ツール名の一覧と取り出し（source して使う）。
# 一覧は interface/generated.json の 34 項目と一致する（cli/tests/hook-tool-names.test.ts が突合する）。
# 連想配列は bash 3.2 で使えないため、空白区切りの文字列と case で持つ。

PECOT_TOOL_NAMES="add_to_project create_branch delete_branch dependabot_sync issue_block issue_comment issue_create issue_quick issue_read issue_reopen issue_unblock pr_cleanup pr_create pr_preflight pr_read project_activate project_create project_info project_init project_list project_search project_set_aggregation_repo project_set_repo project_show_aggregation_repo project_unset_aggregation_repo release_create release_merge release_preflight security_sync session_restore session_status update_issue_status worktree_add worktree_init worktree_link worktree_remove"

# $1 が一覧にあれば 0。
pecot_tool_known() {
    case " ${PECOT_TOOL_NAMES} " in
        *" $1 "*) return 0 ;;
    esac
    return 1
}

# フックの tool_name（Claude Code のプラグイン内・外の登録と、Copilot CLI の形）から接頭辞を外し、一覧にあるときだけ名前を出力する。
# 一覧に無い（別の MCP サーバのツールを含む）ときは 1 を返し、何も出力しない。
pecot_tool_from_hook_name() {
    local name="$1"
    case "$name" in
        mcp__plugin_pecot-w_pecot-workflow__*) name="${name#mcp__plugin_pecot-w_pecot-workflow__}" ;;
        mcp__pecot-workflow__*) name="${name#mcp__pecot-workflow__}" ;;
        pecot-workflow-*) name="${name#pecot-workflow-}" ;;
        *) return 1 ;;
    esac
    pecot_tool_known "$name" || return 1
    printf '%s' "$name"
}
