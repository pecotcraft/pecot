#!/bin/bash
# PostToolUse hook: 書き込んだファイルを文章規則（pecot-text-lint）で確認し、違反をモデルに返す
#
# bin は実行用ミラーの node_modules/.bin/pecot-text-lint を node で起動する。
# symlink 先に実行ビットが無いため、node を挟む。
# 拡張子の判定は bin に任せる。対象外の拡張子なら、bin は 0.12 秒で exit 0 を返す。
# hook に拡張子の一覧を持つと、bin の descriptor と 2 か所で管理することになる。
#
# talk-dir の pages/*.md と slides.md は飛ばす。
# eslint-check.sh の textlint-body が、本文と発表者ノートを確認しているため。
# 両方で掛けると、同じ違反が 2 回報告される。
#
# モデルに返す文言は英語にする。利用者の画面には出ず、モデルだけが読む。
#
# 出力チャネル:
#   stdout = モデルに届けるものだけ（additionalContext を持つ JSON）。
#            どの分岐でも、空または妥当な JSON にする。
#            呼び出し元の merge-hook-outputs.sh は、非 JSON の stdout を additionalContext に丸める。
#            そのため診断ログを stdout に出してはならない。
#   stderr = 開発者向けの trace を 1 行。使った bin のパスを含む。
#
# 分岐の分類。「確認していない」ことと「違反があった」ことを区別する。
# 違反とするのは、exit 1 で出力があるときだけ。
# 対象外は trace のみ。file_path が無い、talk-dir の lint 対象、plugin root を解決できない場合。
# pass も trace のみ。exit 0 のとき。
# 違反は Writing-rule violations を返す。
# 未実施は Not checked を返す。ミラーが無い、bin が無い、timeout、それ以外の非 0、exit 1 で出力が空の場合。

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
    trace "skip: 共有ライブラリを解決できない ($HOOK_PATHS_LIB)"
    exit 0
fi
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../core/hook-paths.sh
. "$HOOK_PATHS_LIB"

# 未実施の通知。$1 = 理由（1 行以上）
notify_not_checked() {
    jq -n --arg path "$FILE_PATH" --arg reason "$1" '{
      "hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": ("[text-lint] Not checked: " + $path + "\n" + $reason
          + "\nThe writing rules were not applied to this file, so no violations were detected.")
      }
    }'
}

INPUT=$(cat)

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
if [ -z "$FILE_PATH" ]; then
    trace "skip: tool_input.file_path が空"
    exit 0
fi

# talk-dir の lint 対象は eslint-check.sh の担当。探索は logical パスで行う（eslint-check.sh と同じ）。
ORIG_DIR=$(CDPATH= cd "$(dirname "$FILE_PATH")" 2>/dev/null && pwd)
TALK_ROOT=$(find_talk_root "$ORIG_DIR" "pages")
if [ -n "$TALK_ROOT" ] && is_talk_lint_target "$(talk_relative_path "$TALK_ROOT" "$ORIG_DIR" "$FILE_PATH")"; then
    trace "skip: talk-dir の lint 対象は eslint-check が担当 ($FILE_PATH)"
    exit 0
fi

# plugin の hooks root を解決。逆算が成立しない配置（別所へコピーされた等）は対象外に落とす。
HOOKS_ROOT=$(resolve_hooks_root "$SCRIPT_DIR" "/lib/post-tool-use")
if [ -z "$HOOKS_ROOT" ]; then
    trace "skip: plugin root を解決できない (PLUGIN_HOOKS / CLAUDE_PLUGIN_ROOT 未設定 かつ SCRIPT_DIR=$SCRIPT_DIR から逆算不能)"
    exit 0
fi

# 依存は bin/pecotv が作る実行用ミラーにしか無い。ミラーが無い（初回の build 中など）ときは未実施に倒す。
if ! RUNTIME_DIR="$(resolve_runtime_dir "$(dirname "$HOOKS_ROOT")" "$SCRIPT_DIR/../../../bin/_lib.sh")"; then
    trace "not-checked: 実行用ミラーが無い"
    notify_not_checked "The runtime mirror is not ready yet. Run the pecotv command once to set it up."
    exit 0
fi

BIN="$RUNTIME_DIR/node_modules/.bin/pecot-text-lint"
if [ ! -e "$BIN" ]; then
    trace "not-checked: ミラーに bin が無い ($BIN)"
    notify_not_checked "pecot-text-lint is missing from the runtime mirror. Run the pecotv command once to set it up."
    exit 0
fi

# stdout と stderr は別々に取る。stderr を混ぜると、node の警告が違反として報告される。
STDERR_FILE=$(mktemp)
trap 'rm -f "$STDERR_FILE"' EXIT
OUTPUT=$(timeout 20 node "$BIN" "$FILE_PATH" 2>"$STDERR_FILE")
BIN_EXIT=$?
# 出力は最大 100 行にする。終了コードを捕捉した後に行う。
OUTPUT=$(echo "$OUTPUT" | head -n 100)

if [ $BIN_EXIT -eq 0 ]; then
    trace "pass: 違反なし ($FILE_PATH / bin: $BIN)"
    exit 0
fi

if [ $BIN_EXIT -eq 1 ] && [ -n "$OUTPUT" ]; then
    trace "violation: 違反検出 ($FILE_PATH / bin: $BIN)"
    jq -n --arg path "$FILE_PATH" --arg output "$OUTPUT" '{
      "hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": ("[text-lint] Writing-rule violations in " + $path + ":\n\n" + $output
          + "\n\nRewrite the text above to satisfy the rules. Do not relax or disable the rules.")
      }
    }'
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
trace "not-checked: bin が正常に終わらなかった (exit $BIN_EXIT / bin: $BIN)"
notify_not_checked "$REASON"
