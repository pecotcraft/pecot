#!/bin/bash
# hooks の基準ディレクトリ（CLAUDE_PROJECT_DIR）を、hook 入力の cwd の git toplevel に揃える。
#
# Claude Code は CLAUDE_PROJECT_DIR にセッション開始時のディレクトリを渡す。
# 一方、Bash ツールから呼ばれる pecot CLI は、cwd の git toplevel を `.pecot/state` の基準にする。
# Bash ツールで別の worktree に cd した後も、hooks と CLI が同じ `.pecot/state` を読み書きするようにする。
# そのため、全エントリポイント（hooks/*.sh）は、入力 JSON を読んだ直後に、入力 JSON を引数にしてこのファイルを source する。
# lib スクリプトは従来どおり ${CLAUDE_PROJECT_DIR} だけを参照する。
# エントリポイントには関数呼び出し行を書けない。
# 許可構文は source 行までなので（.githooks/pre-commit/check-entry-point-logic.sh）、source 時に引数で解決まで実行する。
#
# 入力 JSON はここで hook-input.sh により 1 回の jq で読まれ、PECOT_HOOK_* に export される（.cwd は PECOT_HOOK_CWD から読む）。
# 後続のスクリプトは JSON を読み直さない。
#
# 解決順は、PECOT_HOOK_CWD（入力 JSON の .cwd）→ CLAUDE_PROJECT_DIR → プロセスの pwd。
# 各候補で GIT_* を外した `git rev-parse --show-toplevel` が成功した最初の値を、CLAUDE_PROJECT_DIR に export する。
# どれも git 外なら CLAUDE_PROJECT_DIR は変更しない（未設定なら未設定のまま。各 hook は .pecot 不在として何もしない）。
#
# 例外は、PECOT_HOOK_CWD が .pecot/work 配下のとき。
# worktree の .pecot/work は base の .pecot/work への symlink になっている。
# そこへ cd すると、cwd と git toplevel の両方が base 側の実体パスを指す。
# cwd の実体がセッションの worktree（CLAUDE_PROJECT_DIR の toplevel）の .pecot/work の実体配下にあるとする。
# さらに、cwd から .pecot/work の手前までの親に .git が無ければ、その worktree を基準にする。
# 途中に .git がある場合は、.pecot/work/N に clone した入れ子のリポとみなす。
# その場合は、そのリポの toplevel を基準にする（判定に git は呼ばない）。
# この例外の判定が外れるのは、別リポの .pecot/work 配下・link 切れ・入れ子のリポのとき。
# このとき、セッションの toplevel の解決と候補ループで、--show-toplevel が 2 回になる。
#
# 上書きする前の CLAUDE_PROJECT_DIR は、PECOT_ORIGINAL_CLAUDE_PROJECT_DIR に export する。
# この値は Claude Code が渡す、セッション開始時から不変の値。
# session-project-dir.sh が Bash から呼ぶ CLI 用に、この値の toplevel を書く。
#
# PECOT_PROJECT_ROOT_LAZY が空でなければ、source 時には入力の読み込みだけを行う。
# toplevel の解決（git の呼び出し）は、呼び出し側が pecot_export_project_root を呼ぶまで遅らせる。
# 条件に一致しない大半の入力で git を呼ばないための例外で、PostToolUse(Bash) のエントリだけが使う。
# lib/post-tool-use/bash-post-match.sh が一致を判定してから解決する。
# Usage: source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"

_PECOT_PROJECT_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${_PECOT_PROJECT_ROOT_DIR}/hook-input.sh"

_pecot_git_toplevel() {
    local dir="$1"
    [ -n "$dir" ] && [ -d "$dir" ] || return 1
    env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY \
        -u GIT_ALTERNATE_OBJECT_DIRECTORIES \
        git -C "$dir" rev-parse --show-toplevel 2>/dev/null
}

# cd -P と pwd -P で実体パスを返す（古い macOS に realpath / readlink -f が無いため）。
_pecot_real_dir() {
    (cd -P "$1" 2>/dev/null && pwd -P)
}

# PECOT_HOOK_CWD の実体が、CLAUDE_PROJECT_DIR の toplevel の .pecot/work の実体と同じか、その配下にあるかを確かめる。
# 同じか配下にあり、cwd の実体から .pecot/work の手前までの親に .git が無ければ、その toplevel を返す。
# そうでなければ失敗する。
_pecot_session_work_owner() {
    local session_top work_real cwd_real dir
    session_top=$(_pecot_git_toplevel "${CLAUDE_PROJECT_DIR:-}") || return 1
    work_real=$(_pecot_real_dir "$session_top/.pecot/work") || return 1
    cwd_real=$(_pecot_real_dir "$PECOT_HOOK_CWD") || return 1
    case "$cwd_real/" in
        "$work_real"/*) ;;
        *) return 1 ;;
    esac
    dir="$cwd_real"
    while [ "$dir" != "$work_real" ]; do
        [ -e "$dir/.git" ] && return 1
        dir="${dir%/*}"
    done
    printf '%s\n' "$session_top"
}

pecot_export_project_root() {
    local candidate toplevel
    case "${PECOT_HOOK_CWD:-}" in
        */.pecot/work | */.pecot/work/*)
            if toplevel=$(_pecot_session_work_owner); then
                export CLAUDE_PROJECT_DIR="$toplevel"
                return 0
            fi
            ;;
    esac
    for candidate in "${PECOT_HOOK_CWD:-}" "${CLAUDE_PROJECT_DIR:-}" "$PWD"; do
        toplevel=$(_pecot_git_toplevel "$candidate") || continue
        if [ -n "$toplevel" ]; then
            export CLAUDE_PROJECT_DIR="$toplevel"
            return 0
        fi
    done
    return 0
}

pecot_hook_input_load "${1:-}"
export PECOT_ORIGINAL_CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [ -z "${PECOT_PROJECT_ROOT_LAZY:-}" ]; then
    pecot_export_project_root
fi
