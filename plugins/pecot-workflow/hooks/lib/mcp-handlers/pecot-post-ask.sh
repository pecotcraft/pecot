#!/bin/bash
# PreToolUse MCP handler: 投稿の ask（pecot-workflow の issue_create / issue_quick / pr_create）。
#
# 判定の入力は PECOT_HOOK_TOOL_NAME と stdin の tool_input。tool_input.prepare == true、
# pr_create の dry_run == true、スラッシュコマンド起点のフラグ、config キー false のどれかで素通しにする。
# ask の文言は external-post-check.sh の ISSUE_MSG / CREATE_MSG と同じ（切り替えまで 2 か所に置く）。
# 出力は permissionDecision: "ask" の JSON。対象外は無出力。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
source "${SCRIPT_DIR%/*}/core/pecot-tool-names.sh"

ISSUE_MSG='external-post-check: pecot issue quick / pecot issue create (a real post) publishes an Issue externally.

Do not run it until the user has explicitly approved.
The canonical routes for filing are these skills:
/pecot-w:w-quick, /pecot-w:w-ready, /pecot-w:w-backlog, /pecot-w:w-issueize.
To only generate a template, add --prepare (or -p) to pecot issue create
The quick subcommand has no --prepare / -p.'

CREATE_MSG='external-post-check: pecot pr create (a real post) publishes a PR externally.

Do not run it until the user has explicitly approved.
To only review the content, use --prepare / -p (template generation) or --dry-run / -n.'

TOOL=$(pecot_tool_from_hook_name "${PECOT_HOOK_TOOL_NAME:-}") || exit 0

case "$TOOL" in
    issue_create | issue_quick)
        pecot_hook_enabled "pecot-issue-create-ask" true || exit 0
        MESSAGE="$ISSUE_MSG"
        FLAG="${CLAUDE_PROJECT_DIR}/.pecot/state/issue-create-slash-pending"
        ;;
    pr_create)
        pecot_hook_enabled "pecot-pr-create-ask" true || exit 0
        MESSAGE="$CREATE_MSG"
        FLAG="${CLAUDE_PROJECT_DIR}/.pecot/state/pr-create-slash-pending"
        ;;
    *)
        exit 0
        ;;
esac

# tool_input が文字列で届くクライアントは空のオブジェクトとして読む（ask にする）。真偽値の true だけを素通しにする。
# jq が失敗したときは空のまま ask に進む（fail-safe）。
FLAGS=$(jq -r '(.tool_input | if type == "object" then . else {} end) as $ti | [($ti.prepare == true), ($ti.dry_run == true)] | @tsv' 2>/dev/null)
IFS=$'\t' read -r PREPARE DRY_RUN <<< "$FLAGS"
[ "$PREPARE" = "true" ] && exit 0
[ "$TOOL" = "pr_create" ] && [ "$DRY_RUN" = "true" ] && exit 0
[ -f "$FLAG" ] && exit 0

REASON=$(hook_message warning "$MESSAGE")
jq -n --arg reason "$REASON" '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": $reason}}'
exit 0
