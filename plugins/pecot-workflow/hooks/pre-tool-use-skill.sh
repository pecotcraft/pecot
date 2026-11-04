#!/bin/bash
# PreToolUse hook: Skill ツール起動前の処理
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib/pre-tool-use"
CORE_DIR="$SCRIPT_DIR/lib/core"

INPUT=$(cat)
source "$CORE_DIR/project-root.sh" "$INPUT"

echo "$INPUT" | "$CORE_DIR/pecot-dir-init-detect.sh"

echo "$INPUT" | "$LIB_DIR/pecot-skill-compliance.sh"
