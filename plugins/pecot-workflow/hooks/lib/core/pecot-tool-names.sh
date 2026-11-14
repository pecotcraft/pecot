#!/bin/bash
# MCP ツール名の一覧と取り出し（source して使う）。
# 一覧は interface/generated.json の 35 項目と一致する（cli/tests/hook-tool-names.test.ts が突合する）。
# 連想配列は bash 3.2 で使えないため、空白区切りの文字列と case で持つ。

PECOT_TOOL_NAMES="board_add board_move board_show board_sync branch_delete issue_block issue_comment issue_create issue_reopen issue_show issue_unblock pr_check pr_create pr_show project_activate project_create project_get project_init project_link project_list project_search project_set project_unset release_check release_create release_merge session_finish session_restore session_show session_start tracker_sync worktree_add worktree_init worktree_link worktree_remove"

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
