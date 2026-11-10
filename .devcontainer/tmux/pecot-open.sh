#!/bin/bash
# pecot-open.sh - pecot関連リポを devcontainer 内で tmux の複数ペインで開く（PC用）
#
# 使い方は次のとおり。
#   ./pecot-open.sh                              # base / layout=default / session=pecot-base-default。
#   ./pecot-open.sh myname                       # base / layout=default / session=myname。
#   ./pecot-open.sh -v wt1                       # wt1 / layout=default / session=pecot-wt1-default。
#   ./pecot-open.sh --layout parallel-a           # session=pecot-base-parallel-a。
#   ./pecot-open.sh -v wt1 --layout parallel-a foo # variant=wt1、layout=parallel-a、session=foo。
#   ./pecot-open.sh --list-layouts               # 利用可能なレイアウト一覧を表示する。
#
# -v / --variant <name> で base 以外のワークツリーを指定できる（layout エントリが
#   variant を持たない場合の既定値）。
# -l / --layout  <name> で .devcontainer/tmux/layouts/<name>.conf を読み込む。
# layout 内の REPOS エントリは `<repo>` または `<variant>:<repo>` 形式を取れる。
# 例えば REPOS=(wt1:pecot wt2:pecot) なら、wt1 と wt2 の pecot を同時に開ける。
# これで複数 worktree の並列作業ができる。
# セッション名は常に `pecot-<variant>-<layout>`（positional 指定時はそれを最優先）。
# layout が異なれば別セッションとなり、並行起動できる。
# `pecot-base-default` と `pecot-base-parallel-a` は併存できる。
# 既存セッションがあればアタッチする。事前に base devcontainer が起動している必要あり。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAYOUTS_DIR="$SCRIPT_DIR/layouts"

usage() {
    cat >&2 <<'EOF'
Usage: pecot-open.sh [-v|--variant <name>] [-l|--layout <name>] [session-name]
       pecot-open.sh --list-layouts

  -v, --variant <name>  variant 名（例: base, wt1, wt2）。省略時は base。
  -l, --layout <name>   レイアウト名（layouts/<name>.conf）。省略時は default。
      --list-layouts    利用可能なレイアウトを一覧表示して終了。
  session-name          tmux セッション名。省略時は `pecot-<variant>-<layout>`。
EOF
}

list_layouts() {
    shopt -s nullglob
    local f name title
    for f in "$LAYOUTS_DIR"/*.conf; do
        name="$(basename "$f" .conf)"
        unset TITLE REPOS
        # shellcheck disable=SC1090
        source "$f"
        title="${TITLE:-}"
        if [[ -n "$title" ]]; then
            printf '%-20s %s\n' "$name" "$title"
        else
            printf '%s\n' "$name"
        fi
    done
}

VARIANT="base"
LAYOUT="default"
POSITIONAL=()
while (( $# > 0 )); do
    case "$1" in
        -v|--variant)
            if (( $# < 2 )); then
                echo "Error: $1 にはバリアント名が必要です" >&2
                usage
                exit 1
            fi
            VARIANT="$2"
            shift 2
            ;;
        -l|--layout)
            if (( $# < 2 )); then
                echo "Error: $1 にはレイアウト名が必要です" >&2
                usage
                exit 1
            fi
            LAYOUT="$2"
            shift 2
            ;;
        --list-layouts)
            list_layouts
            exit 0
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        --)
            shift
            while (( $# > 0 )); do
                POSITIONAL+=("$1")
                shift
            done
            ;;
        -*)
            echo "Error: 未知のオプション: $1" >&2
            usage
            exit 1
            ;;
        *)
            POSITIONAL+=("$1")
            shift
            ;;
    esac
done

NAME_RE='^[A-Za-z0-9_-]+$'
if [[ ! "$VARIANT" =~ $NAME_RE ]]; then
    echo "Error: variant '$VARIANT' に使える文字は英数字・ハイフン・アンダースコアのみです" >&2
    usage
    exit 1
fi
if [[ ! "$LAYOUT" =~ $NAME_RE ]]; then
    echo "Error: layout '$LAYOUT' に使える文字は英数字・ハイフン・アンダースコアのみです" >&2
    usage
    exit 1
fi

LAYOUT_FILE="$LAYOUTS_DIR/$LAYOUT.conf"
if [[ ! -f "$LAYOUT_FILE" ]]; then
    echo "Error: layout '$LAYOUT' not found ($LAYOUT_FILE)" >&2
    echo "利用可能なレイアウト:" >&2
    list_layouts >&2
    exit 1
fi

REPOS=()
TITLE=""
# shellcheck disable=SC1090
source "$LAYOUT_FILE"

if (( ${#REPOS[@]} == 0 )); then
    echo "Error: layout '$LAYOUT' が REPOS を定義していません" >&2
    exit 1
fi
if (( ${#REPOS[@]} > 4 )); then
    echo "Error: layout '$LAYOUT' のペイン数 ${#REPOS[@]} は未サポート (1〜4)" >&2
    exit 1
fi

DEFAULT_SESSION="pecot-$VARIANT-$LAYOUT"
SESSION_NAME="${POSITIONAL[0]:-$DEFAULT_SESSION}"

# pecot の base clone のルート（= devcontainer の local_folder ラベル値）。
# worktree から実行しても、共通の .git の親を指すので base になる。
LOCAL_FOLDER="$(dirname "$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir)")"

# Windows 側 VSCode から WSL リポを開いた場合、devcontainer の
# `devcontainer.local_folder` ラベルは UNC 形式になる。
# 例: `\\wsl.localhost\Ubuntu\home\<user>\...`
# WSL ターミナルから開いた場合は POSIX パスになる。
# 例: `/home/<user>/...`
# 両方で検索する。
wsl_to_unc() {
    local p="$1"
    local distro="${WSL_DISTRO_NAME:-Ubuntu}"
    local converted="${p//\//\\}"
    printf '\\\\wsl.localhost\\%s%s' "$distro" "$converted"
}

find_devcontainer_cids() {
    # $1: local_folder ラベル値, $2: status (running|exited)
    docker ps -a --filter "label=devcontainer.local_folder=$1" --filter "status=$2" --format '{{.ID}}'
}

UNC_FOLDER="$(wsl_to_unc "$LOCAL_FOLDER")"
mapfile -t CIDS < <(find_devcontainer_cids "$LOCAL_FOLDER" running)
if (( ${#CIDS[@]} == 0 )); then
    mapfile -t CIDS < <(find_devcontainer_cids "$UNC_FOLDER" running)
fi
if (( ${#CIDS[@]} == 0 )); then
    # running が無ければ exited を探して自動起動する（出先で VS Code が無い環境向け）
    mapfile -t STOPPED < <(find_devcontainer_cids "$LOCAL_FOLDER" exited)
    if (( ${#STOPPED[@]} == 0 )); then
        mapfile -t STOPPED < <(find_devcontainer_cids "$UNC_FOLDER" exited)
    fi
    if (( ${#STOPPED[@]} == 1 )); then
        echo "停止中の devcontainer を起動します: ${STOPPED[0]}" >&2
        docker start "${STOPPED[0]}" >/dev/null
        CIDS=("${STOPPED[0]}")
    elif (( ${#STOPPED[@]} > 1 )); then
        echo "Error: 停止中の pecot devcontainer が複数見つかりました (${#STOPPED[@]} 件)" >&2
        echo "古いものを 'docker rm' で整理してから再試行してください: ${STOPPED[*]}" >&2
        exit 1
    fi
fi
if (( ${#CIDS[@]} == 0 )); then
    echo "Error: pecot devcontainer が起動していません" >&2
    echo "  検索したラベル値:" >&2
    echo "    $LOCAL_FOLDER" >&2
    echo "    $UNC_FOLDER" >&2
    echo "VS Code で Reopen in Container を実行してから再試行してください" >&2
    exit 1
elif (( ${#CIDS[@]} > 1 )); then
    # 複数バリアント（base-only / base-wt1 等）を同時起動するとラベルが衝突する
    echo "Error: pecot devcontainer が複数起動しています (${#CIDS[@]} 件)" >&2
    echo "不要なバリアントを停止してから再試行してください: ${CIDS[*]}" >&2
    exit 1
fi
CID="${CIDS[0]}"

# REPOS エントリは `<repo>` または `<variant>:<repo>` 形式。
# variant 省略時は -v フラグの値が使われる。
entry_variant() {
    local entry="$1"
    if [[ "$entry" == *:* ]]; then
        printf '%s' "${entry%%:*}"
    else
        printf '%s' "$VARIANT"
    fi
}
entry_repo() {
    local entry="$1"
    printf '%s' "${entry##*:}"
}

for entry in "${REPOS[@]}"; do
    v="$(entry_variant "$entry")"
    r="$(entry_repo "$entry")"
    if [[ ! "$v" =~ $NAME_RE ]]; then
        echo "Error: REPOS エントリ '$entry' の variant '$v' が不正です" >&2
        exit 1
    fi
    if [[ ! "$r" =~ $NAME_RE ]]; then
        echo "Error: REPOS エントリ '$entry' の repo '$r' が不正です" >&2
        exit 1
    fi
done

# tmux はコンテナの中で動かす（#53）。コンテナの中の Claude Code が tmux の中にいると判定でき、
# マウスで選んだ文字を OSC 52 でホストの端末に送れる。teammate も tmux のペインに分かれる。
# 設定はリポジトリのファイルを -f で渡す。-f はサーバの起動時にだけ読まれる。
TMUX_CONF="/workspaces/base/pecot/.devcontainer/tmux/tmux.conf"
ctmux() {
    docker exec -u vscode "$CID" tmux -f "$TMUX_CONF" "$@"
}
# ホストの TERM がコンテナの terminfo に無いと、attach が
# `missing or unsuitable terminal` で止まる（#85）。
# 例: Ghostty の `xterm-ghostty` は、コンテナでは `ghostty` の名前でしか引けない。
# 候補を順にコンテナの infocmp で引き、最初に引けた名前を使う。
resolve_term() {
    local host_term="${TERM:-}"
    if [[ -z "$host_term" ]]; then
        printf '%s' xterm-256color
        return
    fi
    local cand
    for cand in "$host_term" "${host_term#xterm-}" xterm-256color; do
        if docker exec "$CID" infocmp "$cand" >/dev/null 2>&1; then
            if [[ "$cand" != "$host_term" ]]; then
                echo "TERM '$host_term' はコンテナの terminfo に無いため '$cand' で attach します" >&2
            fi
            printf '%s' "$cand"
            return
        fi
    done
    printf '%s' xterm-256color
}
ctmux_attach() {
    local term
    term="$(resolve_term)"
    local envs=(-e TERM="$term")
    # tmux は attach するクライアントの COLORTERM が truecolor / 24bit なら RGB を付ける（#87）。
    # ホストの端末が名乗る値をそのまま渡す。無ければ渡さない。
    if [[ -n "${COLORTERM:-}" ]]; then
        envs+=(-e COLORTERM="$COLORTERM")
    fi
    exec docker exec -it -u vscode "${envs[@]}" "$CID" \
        tmux -f "$TMUX_CONF" attach-session -t "$1"
}

dir_for() {
    local v r
    v="$(entry_variant "$1")"
    r="$(entry_repo "$1")"
    printf '%s' "/workspaces/$v/$r"
}

if ctmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "既存セッション '$SESSION_NAME' にアタッチします"
    ctmux_attach "$SESSION_NAME"
fi

build_panes() {
    local count=${#REPOS[@]}
    ctmux new-session -d -s "$SESSION_NAME" -c "$(dir_for "${REPOS[0]}")" bash
    case "$count" in
        1)
            ;;
        2)
            ctmux split-window -h -t "$SESSION_NAME" -c "$(dir_for "${REPOS[1]}")" bash
            ;;
        3)
            # 左 1 + 右を上下 2 分割
            ctmux split-window -h -t "$SESSION_NAME" -c "$(dir_for "${REPOS[1]}")" bash
            ctmux split-window -v -t "$SESSION_NAME.1" -c "$(dir_for "${REPOS[2]}")" bash
            ;;
        4)
            # 2x2
            ctmux split-window -h -t "$SESSION_NAME" -c "$(dir_for "${REPOS[1]}")" bash
            ctmux select-pane  -t "$SESSION_NAME.0"
            ctmux split-window -v -t "$SESSION_NAME" -c "$(dir_for "${REPOS[2]}")" bash
            ctmux select-pane  -t "$SESSION_NAME.2"
            ctmux split-window -v -t "$SESSION_NAME" -c "$(dir_for "${REPOS[3]}")" bash
            ;;
    esac
    ctmux select-pane -t "$SESSION_NAME.0"
}

build_panes

ctmux_attach "$SESSION_NAME"
