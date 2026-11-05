#!/bin/bash
# pecot-open-mobile.sh - pecot関連リポを devcontainer に接続し、独立した複数セッションで開く（スマホ用）
#
# 使い方は次のとおり。
#   ./pecot-open-mobile.sh                         # base / layout=default / prefix=pecot-base-default:。
#   ./pecot-open-mobile.sh -v wt1                  # wt1 / layout=default / prefix=pecot-wt1-default:。
#   ./pecot-open-mobile.sh --layout parallel4      # base / prefix=pecot-base-parallel4:。
#   ./pecot-open-mobile.sh -v wt1 --layout parallel4 # wt1 / prefix=pecot-wt1-parallel4:。
#   ./pecot-open-mobile.sh --list-layouts           # 利用可能なレイアウト一覧を表示する。
#
# 各エントリ（レイアウト内の各 REPOS エントリ）ごとに別セッションを作成し、先頭にアタッチする。
# REPOS エントリは `<repo>` または `<variant>:<repo>` 形式。省略時は -v の値。
# セッション名は常に `pecot-<variant>-<layout>:<entry_variant>-<repo>[-<N>]`。
# `-<N>` は、同じ (variant, repo) の組が同一 layout 内に複数回登場したときの連番。
# 連番は layout スコープ内でユニークになる。
# layout が異なれば別セッション群が作れるため、layout の並行起動ができる。
# 例えば `./pecot-open-mobile.sh --layout default` と `./pecot-open-mobile.sh --layout parallel4` を続けて実行する。
# この結果、`pecot-base-default:*` と `pecot-base-parallel4:*` の両セットが併存する。
# 他セッションへは "Ctrl-b s" で切り替え可能。既存セッションはそのまま残す。
# 事前に base devcontainer が起動している必要あり。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAYOUTS_DIR="$SCRIPT_DIR/layouts"

usage() {
    cat >&2 <<'EOF'
Usage: pecot-open-mobile.sh [-v|--variant <name>] [-l|--layout <name>]
       pecot-open-mobile.sh --list-layouts

  -v, --variant <name>  variant 名（例: base, wt1, wt2）。省略時は base。
  -l, --layout <name>   レイアウト名（layouts/<name>.conf）。省略時は default。
      --list-layouts    利用可能なレイアウトを一覧表示して終了。
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
        *)
            echo "Error: 未知のオプション: $1" >&2
            usage
            exit 1
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
    exec docker exec -it -u vscode -e TERM="$term" "$CID" \
        tmux -f "$TMUX_CONF" attach-session -t "$1"
}

dir_for() {
    local v r
    v="$(entry_variant "$1")"
    r="$(entry_repo "$1")"
    printf '%s' "/workspaces/$v/$r"
}

# (variant, repo) の組が複数出る場合は -2, -3... を付与（layout スコープ内でのみユニーク）
declare -A VR_SEEN=()
SESSION_NAMES=()
SESSION_PREFIX="pecot-$VARIANT-$LAYOUT"
for entry in "${REPOS[@]}"; do
    v="$(entry_variant "$entry")"
    r="$(entry_repo "$entry")"
    key="$v-$r"
    seen="${VR_SEEN[$key]:-0}"
    seen=$((seen + 1))
    VR_SEEN[$key]=$seen
    if (( seen == 1 )); then
        base_name="$v-$r"
    else
        base_name="$v-$r-$seen"
    fi
    SESSION_NAMES+=("$SESSION_PREFIX:$base_name")
done

# tmux はセッション名の `:` と `.` を `_` に替えて保存し、`-t a:b` をセッション a のウィンドウ b と読む。
# そのため、セッションを指すときは保存された名前を `=`（完全一致）で指す。
target_for() {
    local name="${1//[:.]/_}"
    printf '=%s' "$name"
}

for i in "${!REPOS[@]}"; do
    entry="${REPOS[$i]}"
    session="${SESSION_NAMES[$i]}"
    if ctmux has-session -t "$(target_for "$session")" 2>/dev/null; then
        echo "既存セッション '$session' を再利用します"
    else
        ctmux new-session -d -s "$session" -c "$(dir_for "$entry")" bash
        echo "セッション '$session' を作成しました"
    fi
done

ctmux_attach "$(target_for "${SESSION_NAMES[0]}")"
