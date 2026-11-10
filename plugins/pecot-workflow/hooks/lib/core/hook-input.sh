#!/bin/bash
# hook 入力 JSON を 1 回の jq で読み、PECOT_HOOK_* に export する。
#
# サブスクリプトは stdin の JSON を読み直さず、ここで export された PECOT_HOOK_* だけを読む。
# 読み方の手段を 1 本にして、Bash 1 回あたりの jq 起動を抑える。
#
# 提供関数は次のとおり。
# - `pecot_hook_command_reload`
#
#     PECOT_HOOK_COMMAND_OVERSIZE=1 のとき、stdin の JSON から PECOT_HOOK_COMMAND を読み直す（export しない）。
#     stdin の JSON は、merge-hook-outputs.sh が各サブスクリプトへ流す入力。
#     コマンドを読むサブスクリプトが、サイズ超過のコマンドでも動くための手段。
#     通常は何もしない。
# - pecot_hook_input_load <json>
#     次を export する。
#     入力に無い・型が違う項目は空文字にする（前の入力の値は残さない）。
#       PECOT_HOOK_EVENT            hook_event_name。
#       PECOT_HOOK_TOOL_NAME        tool_name。
#       PECOT_HOOK_COMMAND          tool_input.command。
#                                  tool_input がオブジェクトのときだけ読む。
#                                  PECOT_HOOK_COMMAND_MAX_BYTES を超えるときは export しない。
#       PECOT_HOOK_CWD              cwd。
#       PECOT_HOOK_SESSION_ID       session_id。
#       PECOT_HOOK_TRANSCRIPT_PATH  transcript_path。
#       PECOT_HOOK_FILE_PATH        tool_input.file_path // notebook_path // path。
#                                  Copilot CLI の Read / Edit は path で、apply_patch は tool_input が文字列なので空。
#       PECOT_HOOK_PLAN_PATH        tool_input.planFilePath（ExitPlanMode の計画ファイル）。
#       PECOT_HOOK_SKILL_NAME       tool_input.skill（Skill ツール）。
#                                  Claude Code は pecot-w:w-help のような接頭辞付きで届く。
#                                  Copilot CLI は w-help のような名前空間なしで届く。
#       PECOT_HOOK_SOURCE           source（SessionStart の startup / resume / fork / clear / compact）。
#                                  Copilot CLI は new / resume。
#       PECOT_HOOK_SESSION_TITLE    session_title（Claude Code が送る現在のセッション名）。
#                                  名前の無いセッションではキー自体が無く、空になる。
#       PECOT_HOOK_COMMAND_OVERSIZE コマンドが PECOT_HOOK_COMMAND_MAX_BYTES を超えるとき 1、それ以外は空。
#
# 大きな値は export しない。
# 環境変数 1 個が 128KiB を超えると、その後の execve がすべて `Argument list too long` で失敗する。
# すると、ガードが deny を返す前に素通しとなる。
# tool の stdout などはここに入れず、必要なスクリプトが判定した結果のフラグだけを渡す。
# コマンドも同じ扱いにする。
# PECOT_HOOK_COMMAND_MAX_BYTES を超えるときは、PECOT_HOOK_COMMAND を export しない。
# この値は、コアのガードが deny 理由にコマンドを 2 回まで載せても 128KiB に収まる大きさ。
# コマンドは同じプロセスのシェル変数としてだけ残す。PostToolUse の bash-post-match.sh が読む。
# 代わりに PECOT_HOOK_COMMAND_OVERSIZE=1 を export する。
# 子プロセスで動く PreToolUse のガードは、これを見て fail-closed（ask）にする。
#
# source されるため、このファイル自体は何も実行しない。

pecot_hook_command_reload() {
    [ "${PECOT_HOOK_COMMAND_OVERSIZE:-}" = "1" ] || return 0
    PECOT_HOOK_COMMAND=$(jq -r '
        (.tool_input | if type == "object" then .command else "" end)
        | if type == "string" then . else "" end' 2>/dev/null) || PECOT_HOOK_COMMAND=""
}

PECOT_HOOK_COMMAND_MAX_BYTES=60000
export PECOT_HOOK_COMMAND_MAX_BYTES

pecot_hook_input_load() {
    local input="${1:-}" parsed="" size=0
    PECOT_HOOK_EVENT="" PECOT_HOOK_TOOL_NAME="" PECOT_HOOK_COMMAND="" PECOT_HOOK_CWD=""
    PECOT_HOOK_SESSION_ID="" PECOT_HOOK_TRANSCRIPT_PATH="" PECOT_HOOK_FILE_PATH="" PECOT_HOOK_PLAN_PATH="" PECOT_HOOK_SKILL_NAME=""
    PECOT_HOOK_SOURCE="" PECOT_HOOK_SESSION_TITLE=""
    if [ -n "$input" ]; then
        parsed=$(printf '%s' "$input" | jq -r '
            def s: if type == "string" then . else "" end;
            (.tool_input | if type == "object" then . else {} end) as $ti
            | [ (.hook_event_name | s), (.tool_name | s), ($ti.command | s), (.cwd | s),
                (.session_id | s), (.transcript_path | s),
                (($ti.file_path // $ti.notebook_path // $ti.path) | s), ($ti.planFilePath | s), ($ti.skill | s),
                (.source | s), (.session_title | s) ]
            | @sh' 2>/dev/null) || parsed=""
    fi
    if [ -n "$parsed" ]; then
        eval "set -- $parsed"
        PECOT_HOOK_EVENT="$1" PECOT_HOOK_TOOL_NAME="$2" PECOT_HOOK_COMMAND="$3" PECOT_HOOK_CWD="$4"
        PECOT_HOOK_SESSION_ID="$5" PECOT_HOOK_TRANSCRIPT_PATH="$6" PECOT_HOOK_FILE_PATH="$7" PECOT_HOOK_PLAN_PATH="$8" PECOT_HOOK_SKILL_NAME="$9"
        PECOT_HOOK_SOURCE="${10}" PECOT_HOOK_SESSION_TITLE="${11}"
    fi
    PECOT_HOOK_COMMAND_OVERSIZE=""
    # バイト数で測る（日本語は 1 文字 3 バイト）
    local LC_ALL=C
    size=${#PECOT_HOOK_COMMAND}
    if [ "$size" -gt "$PECOT_HOOK_COMMAND_MAX_BYTES" ]; then
        PECOT_HOOK_COMMAND_OVERSIZE=1
        export -n PECOT_HOOK_COMMAND
    else
        export PECOT_HOOK_COMMAND
    fi
    export PECOT_HOOK_COMMAND_OVERSIZE
    export PECOT_HOOK_EVENT PECOT_HOOK_TOOL_NAME PECOT_HOOK_CWD
    export PECOT_HOOK_SESSION_ID PECOT_HOOK_TRANSCRIPT_PATH PECOT_HOOK_FILE_PATH PECOT_HOOK_PLAN_PATH PECOT_HOOK_SKILL_NAME
    export PECOT_HOOK_SOURCE PECOT_HOOK_SESSION_TITLE
}
