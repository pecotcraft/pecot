#!/bin/bash
# PreToolUse (WebSearch): WebSearch の自動許可。
#
# WebSearch は読み取り専用ツールのため、確認プロンプトを抑制する。
# 対象ツールの限定は hooks.json の matcher "WebSearch"（完全一致）が担う。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "websearch-allow" true || exit 0

REASON="WebSearch は読み取り専用のため自動許可（websearch-allow）"
jq -n --arg reason "$REASON" '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "permissionDecisionReason": $reason}}'
exit 0
