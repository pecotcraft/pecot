#!/bin/bash
# PostToolUse(Bash): 後続のサブスクリプトを動かす条件に一致するかを 1 回だけ判定する。
#
# source されるファイル（エントリ post-tool-use-bash.sh が project-root.sh の後で source する）。
# 提供する変数（export）は次のとおり。
#   PECOT_POST_COMMIT     成功した git commit なら 1、そうでなければ空。
#   PECOT_POST_MATCHED    commit が成功なら 1、そうでなければ空（エントリはここで exit 0 する）。
#   PECOT_POST_REPO_DIR   commit のときだけ。コマンドから解決した対象リポジトリ。
#                        git-repo-resolver.sh の REPO_DIR と同じ値で、別名で渡す。
#                        source 時にあちらが REPO_DIR を空にするため。
#
# 一致したときだけ project-root（git rev-parse --show-toplevel）を 1 回解決する。
# `_resolve_repo_dir` もここで 1 回だけ実行する。commit-info-display / auto-push は
# この結果を読み、解決し直さない。
# hooks-config.json はここでは読まない（project-root の解決前に読むと別のリポの設定を見るため）。
#
# コマンドは PECOT_HOOK_COMMAND（hook-input.sh）。出力は Claude の tool_response.stdout と
# Copilot CLI の tool_result.text_result_for_llm のどちらからも取る。Copilot には interrupted が
# 無いので false 扱い。tool の出力は大きくなりうるため export しない（128KiB 超で execve が失敗する）。

# source されるため自己ディレクトリは BASH_SOURCE[0] から導出する（エントリの SCRIPT_DIR は壊さない）。
_PECOT_POST_MATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# commit パターン（commit-info-display.sh と auto-push.sh に重複していたものをここに一本化）。
_PECOT_POST_COMMIT_PATTERN='(^|;|&&|\|\||\|)[[:space:]]*git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?commit([[:space:]]|$)'

# 判定本体は関数に入れる（eval した値を位置パラメータに展開するため、source 元の $@ を壊さない）。
_pecot_post_match() {
    local input="${1:-}" fields="" stdout="" interrupted=""
    local commit_candidate=""
    PECOT_POST_COMMIT=""
    PECOT_POST_MATCHED=""
    PECOT_POST_REPO_DIR=""

    if [[ "${PECOT_HOOK_COMMAND:-}" =~ $_PECOT_POST_COMMIT_PATTERN ]]; then
        commit_candidate=1
    fi

    if [ -n "$commit_candidate" ]; then
        # 出力と中断の判定（コマンドが一致したときだけ jq を呼ぶ）。
        fields=$(printf '%s' "$input" | jq -r '
            [ (.tool_response.stdout // .tool_response.output // .tool_result.text_result_for_llm // ""),
              (.tool_response.interrupted // false | tostring) ] | @sh' 2>/dev/null) || fields=""
        if [ -n "$fields" ]; then
            eval "set -- $fields"
            stdout="$1"
            interrupted="$2"
            if [ "$interrupted" != "true" ]; then
                if printf '%s' "$stdout" | grep -qE '^\[.+ [0-9a-f]+\]'; then
                    PECOT_POST_COMMIT=1
                fi
            fi
        fi
    fi

    if [ -n "$PECOT_POST_COMMIT" ]; then
        PECOT_POST_MATCHED=1
        pecot_export_project_root
        HOOK_TOOL_CWD="${PECOT_HOOK_CWD:-}"
        export HOOK_TOOL_CWD
        source "${_PECOT_POST_MATCH_DIR%/*}/core/git-repo-resolver.sh"
        _resolve_repo_dir "$PECOT_HOOK_COMMAND"
        PECOT_POST_REPO_DIR="$REPO_DIR"
    fi
    export PECOT_POST_COMMIT PECOT_POST_MATCHED PECOT_POST_REPO_DIR
}

_pecot_post_match "${1:-}"
