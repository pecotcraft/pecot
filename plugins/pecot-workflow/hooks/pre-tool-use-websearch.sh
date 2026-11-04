#!/bin/bash
# PreToolUse (WebSearch): WebSearch 自動許可エントリスクリプト
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

INPUT=$(cat)
source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"
echo "$INPUT" | "$SCRIPT_DIR/lib/pre-tool-use/websearch-allow.sh"
exit 0
