#!/bin/bash
# PostToolUse hook: 書き込んだファイルを pecot-text-lint で確認し、違反をモデルに返す。
# bin は実行用ミラーの node_modules/.bin/pecot-text-lint を node で起動する（拡張子の判定は bin に任せる）。
# talk-dir の pages/*.md と slides.md は飛ばす（eslint-check.sh の textlint-body が見るので、二重に報告しないため）。
# 出力: stdout は additionalContext を持つ JSON か空だけ（merge-hook-outputs.sh が非 JSON を文脈に丸めるため）。診断は stderr に trace 1 行。
# 違反は exit 1 で出力があるときだけ。ミラー・bin が無い、timeout、それ以外の非 0 は「未実施」にする。

# 開発者診断 trace。verdict は skip / pass / violation / not-checked。
trace() {
    echo "[text-lint-check] $1" >&2
}

# talk-dir の探索と plugin hooks root の解決は、post-tool-use の hook で共有する。
# 共有ライブラリを解決できない配置で、未定義関数のまま動かすと、対象外と区別できない skip になる。
# そのため明示的に対象外として終える。
SCRIPT_DIR="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_PATHS_LIB="${SCRIPT_DIR%/*}/core/hook-paths.sh"
if [ ! -f "$HOOK_PATHS_LIB" ]; then
    trace "skip: shared library cannot be resolved ($HOOK_PATHS_LIB)"
    exit 0
fi
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../core/hook-paths.sh
. "$HOOK_PATHS_LIB"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../core/hook-message.sh
. "${SCRIPT_DIR%/*}/core/hook-message.sh"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../core/context-cap.sh
. "${SCRIPT_DIR%/*}/core/context-cap.sh"

# 未実施の通知。$1 = 理由（1 行以上）
notify_not_checked() {
    local message
    message=$(hook_message warning "text lint not run: $FILE_PATH
$1
The writing rules were not applied to this file, so no violations were detected.")
    jq -n --arg message "$message" '{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": $message}}'
}

INPUT=$(cat)

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
if [ -z "$FILE_PATH" ]; then
    trace "skip: tool_input.file_path is empty"
    exit 0
fi

# talk-dir の lint 対象は eslint-check.sh の担当。探索は logical パスで行う（eslint-check.sh と同じ）。
ORIG_DIR=$(CDPATH= cd "$(dirname "$FILE_PATH")" 2>/dev/null && pwd)
TALK_ROOT=$(find_talk_root "$ORIG_DIR" "pages")
if [ -n "$TALK_ROOT" ] && is_talk_lint_target "$(talk_relative_path "$TALK_ROOT" "$ORIG_DIR" "$FILE_PATH")"; then
    trace "skip: eslint-check handles talk-dir lint targets ($FILE_PATH)"
    exit 0
fi

# plugin の hooks root を解決。逆算が成立しない配置（別所へコピーされた等）は対象外に落とす。
HOOKS_ROOT=$(resolve_hooks_root "$SCRIPT_DIR" "/lib/post-tool-use")
if [ -z "$HOOKS_ROOT" ]; then
    trace "skip: plugin root cannot be resolved (PLUGIN_HOOKS and CLAUDE_PLUGIN_ROOT are unset, and SCRIPT_DIR=$SCRIPT_DIR does not lead back to it)"
    exit 0
fi

# 依存は bin/pecotv が作る実行用ミラーにしか無い。ミラーが無い（初回の build 中など）ときは未実施に倒す。
if ! RUNTIME_DIR="$(resolve_runtime_dir "$(dirname "$HOOKS_ROOT")" "$SCRIPT_DIR/../../../bin/_lib.sh")"; then
    trace "not-checked: runtime mirror is missing"
    notify_not_checked "The runtime mirror is not ready yet. Run the pecotv command once to set it up."
    exit 0
fi

BIN="$RUNTIME_DIR/node_modules/.bin/pecot-text-lint"
if [ ! -e "$BIN" ]; then
    trace "not-checked: bin is missing from the mirror ($BIN)"
    notify_not_checked "pecot-text-lint is missing from the runtime mirror. Run the pecotv command once to set it up."
    exit 0
fi

# stdout と stderr は別々に取る。stderr を混ぜると、node の警告が違反として報告される。
STDERR_FILE=$(mktemp)
trap 'rm -f "$STDERR_FILE"' EXIT
OUTPUT=$(timeout 20 node "$BIN" "$FILE_PATH" 2>"$STDERR_FILE")
BIN_EXIT=$?
if [ $BIN_EXIT -eq 0 ]; then
    trace "pass: no violations ($FILE_PATH / bin: $BIN)"
    exit 0
fi

if [ $BIN_EXIT -eq 1 ] && [ -n "$OUTPUT" ]; then
    trace "violation: violations found ($FILE_PATH / bin: $BIN)"
    cap_context "$PECOTV_CONTEXT_MAX_TEXT_LINT" '.' violations <<<"$OUTPUT"
    VIOLATION_MESSAGE=$(hook_message warning "text lint violations: $FILE_PATH

$CAPPED_BODY

The text above does not satisfy the writing rules. The rules stay enabled.${CAP_NOTE:+
$CAP_NOTE}")
    jq -n --arg message "$VIOLATION_MESSAGE" '{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": $message}}'
    exit 0
fi

if [ $BIN_EXIT -eq 124 ]; then
    REASON="pecot-text-lint timed out (over 20 seconds)."
else
    REASON="pecot-text-lint failed (exit $BIN_EXIT):"
    STDERR_HEAD=$(head -n 10 "$STDERR_FILE")
    if [ -n "$STDERR_HEAD" ]; then
        REASON="$REASON
$STDERR_HEAD"
    fi
fi
trace "not-checked: bin did not finish normally (exit $BIN_EXIT / bin: $BIN)"
notify_not_checked "$REASON"
