#!/bin/bash
# git コマンドからリポジトリパスを解決するユーティリティ。
#
# 配置は hooks/lib/core/git-repo-resolver.sh。
#
# 使用方法は次のとおり。
# core の 1 つ上のディレクトリからは、`source "${SCRIPT_DIR%/*}/core/git-repo-resolver.sh"` で読み込む。
# core 内からは、`source "${SCRIPT_DIR}/git-repo-resolver.sh"` で読み込む。
#
# 解決優先順位は次のとおり。
#   Priority 1: git -C <path>（コマンド内のどこにあっても検出）。
#   Priority 2: cd <path> チェインコマンド（cd /path && git commit 等）。
#   Priority 3: HOOK_TOOL_CWD（ツール呼び出し時点のCWD。アダプタが渡す）。
#   Priority 4: HOOK_WORKING_DIR、最後に pwd。
#
# 提供変数は REPO_DIR で、解決されたリポジトリパスを持つ（未解決時は空文字）。
#
# 提供関数は次のとおり。
#   _resolve_repo_dir_with_session_default は、P1〜P3 → HOOK_WORKING_DIR → pwd の順で解決する。
#   git-worktree-branch-check が使う。
#   _resolve_repo_dir_explicit は、明示された指定のみで解決する（P1〜P3）。

REPO_DIR=""

# 明示された指定のみからリポジトリパスを解決し、REPO_DIR を設定する。
# 対象は Priority 1〜3 で、pwd には落ちないため、未解決時は空文字で返す。
# @param $1 command  git コマンド文字列。
_resolve_repo_dir_explicit() {
    local cmd="$1"
    REPO_DIR=""

    # Priority 1: git -C <path>（コマンド内のどこにあっても検出）。
    if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
        REPO_DIR="${BASH_REMATCH[1]}"
        return
    fi

    # Priority 2: cd <path> チェインコマンド（cd /path && git commit 等）。
    # ディレクトリの存在だけでは確定しない。
    # git ワークツリーとして解決できた cd 先のみ採用し、非 git なら次の cd を評価する（多段 cd）。
    # 全滅なら Priority 3 へ落とす。
    # ディレクトリ存在だけで確定すると、非 git ディレクトリへの cd で、保護ブランチガードの「git リポジトリでなければ許可」の分岐へ進む。
    # その結果ガードをすり抜ける（#1087 の回帰）。
    local cd_regex="(^|[;&\\|])[[:space:]]*cd[[:space:]]+(\"([^\"]+)\"|'([^']+)'|([^[:space:];&\\|]+))"
    local rest="$cmd"
    local cd_path
    while [[ "$rest" =~ $cd_regex ]]; do
        cd_path="${BASH_REMATCH[3]:-${BASH_REMATCH[4]:-${BASH_REMATCH[5]}}}"
        rest="${rest#*"${BASH_REMATCH[0]}"}"
        [ -n "$cd_path" ] || continue
        # 相対パスはツールの cwd（無ければフックプロセスの pwd）を基点に解決する。
        # `[ -d ]` と `git -C` は、フックプロセスの cwd で評価される。
        # 基点を補わないと、ツール cwd 側の `cd sibling` が、フック pwd 側の同名ディレクトリで判定される。
        # `cd -` / `~` 始まりは解釈せず、未解決として次の候補へ送る。
        case "$cd_path" in
            /*) ;;
            -|'~'*) continue ;;
            *) cd_path="${HOOK_TOOL_CWD:-$PWD}/${cd_path}" ;;
        esac
        if git -C "$cd_path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
            REPO_DIR="$cd_path"
            return
        fi
    done

    # Priority 3: HOOK_TOOL_CWD（ツール呼び出し時点のCWD。アダプタが入力 JSON から渡す）。
    if [ -n "${HOOK_TOOL_CWD:-}" ] \
        && git -C "${HOOK_TOOL_CWD}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        REPO_DIR="${HOOK_TOOL_CWD}"
        return
    fi
}

# git コマンドからリポジトリパスを解決し、REPO_DIR を設定する。
# 解決順は、Priority 1〜3 → HOOK_WORKING_DIR → pwd。
# 対象が特定できないときの既定をセッション起点に置くガード向け。
# @param $1 command  git コマンド文字列。
_resolve_repo_dir_with_session_default() {
    _resolve_repo_dir_explicit "$1"
    if [ -n "$REPO_DIR" ]; then
        return
    fi

    if [ -n "${HOOK_WORKING_DIR:-}" ]; then
        REPO_DIR="${HOOK_WORKING_DIR}"
    else
        REPO_DIR="$(pwd)"
    fi
}
