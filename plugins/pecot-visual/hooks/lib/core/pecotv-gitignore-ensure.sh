#!/usr/bin/env bash
# .pecotv/.gitignore を生成する。中身の定義はこのスクリプトを単一の出所とする。
#
# 中身は許可の一覧で、`*` で全部を除外する。.pecotv/ に追跡する設定は無い。
# 利用者ローカルの config/hooks-config.json も管理外のままにする。
# 追跡している .pecotv/.gitignore は書き換えない（無関係のブランチに差が出るため）。
# 書くのは、ファイルが無いか追跡していないときだけ。git 外・git 不在は追跡なしとして書く。
#
# session-start.sh と pecotv-dir-init.sh の双方から呼ばれる。
# pecot-workflow プラグインの pecot-gitignore-ensure.sh と同構造にしている。
#
# 使い方: pecotv-gitignore-ensure.sh [--print]
#   --print  書かずに定義を標準出力へ出す（CLAUDE_PROJECT_DIR は不要）。
set -euo pipefail

_print_definition() {
    cat <<'GITIGNORE_EOF'
# pecotv の生成物を管理外にする許可の一覧。追跡する設定は無い。
*
GITIGNORE_EOF
}

if [[ "${1:-}" == "--print" ]]; then
    _print_definition
    exit 0
fi

[[ -z "${CLAUDE_PROJECT_DIR:-}" ]] && exit 0

PECOTV_DIR="${CLAUDE_PROJECT_DIR}/.pecotv"
TARGET="${PECOTV_DIR}/.gitignore"

if [[ -f "$TARGET" ]] && command -v git >/dev/null 2>&1 \
    && git -C "$CLAUDE_PROJECT_DIR" ls-files --error-unmatch -- .pecotv/.gitignore >/dev/null 2>&1; then
    exit 0
fi

mkdir -p "$PECOTV_DIR"

# 一時ファイルへ書き出してから、mv でアトミックに差し替える。
# 利用検知と SessionStart が並行発火しても、空ファイルは生じない（同一 filesystem で mv がアトミック）。
_TMP=$(mktemp "${PECOTV_DIR}/.gitignore.XXXXXX")
trap 'rm -f "$_TMP"' EXIT

_print_definition > "$_TMP"
mv -f "$_TMP" "$TARGET"
