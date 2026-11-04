#!/bin/bash
# /tmp/ 使用警告（非ブロック）。
#
# 入力は、hook-input.sh が export 済みの PECOT_HOOK_* で、stdin の JSON は読まない。
# tool_name == "Bash" の command 引数に `/tmp/<word>` パターンが含まれていた場合は、リマインダーを返す。
# リマインダーは additionalContext で、`.pecot/work/<word>` への置き換えを促す。
# system 調査用途 (`find /tmp` `ls /tmp` 等) は、false positive を避けるため除外する。
# exit 0、ブロックはしない。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "tmp-path-warner" true || exit 0

[ "${PECOT_HOOK_TOOL_NAME:-}" = "Bash" ] || exit 0

source "${SCRIPT_DIR%/*}/core/hook-input.sh"
pecot_hook_command_reload
COMMAND="${PECOT_HOOK_COMMAND:-}"
[ -z "$COMMAND" ] && exit 0

# `/tmp/<word>` パターン検出（単語境界つき）。`/tmpfs/...` `/tmp.bak` 等は無視。
# 境界文字: 行頭 / 空白 / `"` / `'` / `=`（`'"'"'` は single-quote 内で `'` を表す bash 慣用形）。
echo "$COMMAND" | grep -qE '(^|[[:space:]"'"'"'=])/tmp/[A-Za-z0-9._-]' || exit 0

# system 調査 whitelist: `find /tmp` `ls /tmp` `du /tmp` `df /tmp` などで始まるコマンド、
# および /tmp の存在/権限確認系は警告しない。
# command-prefix (`sudo` `env` `time` `nice` `nohup`) は次のトークンを判定対象にする。
read -r FIRST_TOKEN SECOND_TOKEN _ <<< "$COMMAND"
case "$FIRST_TOKEN" in
    sudo|env|time|nice|nohup)
        # 修飾子は読み飛ばし、第二トークンを判定対象とする。
        EFFECTIVE_TOKEN="$SECOND_TOKEN"
        ;;
    *)
        EFFECTIVE_TOKEN="$FIRST_TOKEN"
        ;;
esac
case "$EFFECTIVE_TOKEN" in
    find|ls|du|df|stat|file|readlink|realpath)
        # コマンド先頭が read-only inspection なら抑制。
        exit 0
        ;;
esac

MESSAGE='【リマインダー】Bash コマンドに `/tmp/<X>` が含まれています。
agent/session の作業成果物は user から見えないため、`.pecot/work/<タスクID>/<X>` に置き換えてください。
- 例: `/tmp/release-smoke` → `.pecot/work/655/release-smoke`
- system 調査 (`find /tmp` `ls /tmp` 等) や `/tmpfs` パスは無視して構いません
- user が明示的に指定した `/tmp/<path>` は警告を無視して構いません。'

jq -n --arg msg "$MESSAGE" '{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": $msg
  }
}'
