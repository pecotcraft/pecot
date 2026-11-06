#!/usr/bin/env bash
# .pecot/.gitignore を生成する。中身の定義はこのスクリプトを単一の出所とする。
#
# 中身は許可の一覧で、`*` で全部を除外し、追跡する設定だけを `!` で戻す。
# 追跡している .pecot/.gitignore は書き換えない（無関係のブランチに差が出るため）。
# 書くのは、ファイルが無いか追跡していないときだけ。git 外・git 不在は追跡なしとして書く。
#
# 使い方: pecot-gitignore-ensure.sh [--print]
#   --print  書かずに定義を標準出力へ出す（CLAUDE_PROJECT_DIR は不要）。
set -euo pipefail

_print_definition() {
    cat <<'GITIGNORE_EOF'
# pecot の設定だけを追跡し、生成物は管理外にする許可の一覧。
*
!/config/
/config/*
!/config/worktree-config.json
!/config/.worktreeignore
!/config/projects/
/config/projects/*
!/config/projects/*.json
GITIGNORE_EOF
}

if [[ "${1:-}" == "--print" ]]; then
    _print_definition
    exit 0
fi

[[ -z "${CLAUDE_PROJECT_DIR:-}" ]] && exit 0

PECOT_DIR="${CLAUDE_PROJECT_DIR}/.pecot"
TARGET="${PECOT_DIR}/.gitignore"

if [[ -f "$TARGET" ]] && command -v git >/dev/null 2>&1 \
    && git -C "$CLAUDE_PROJECT_DIR" ls-files --error-unmatch -- .pecot/.gitignore >/dev/null 2>&1; then
    exit 0
fi

mkdir -p "$PECOT_DIR"

# 並行発火でも空ファイルが生じないよう、一時ファイルへ書いて mv（同一 filesystem でアトミック）。
_TMP=$(mktemp "${PECOT_DIR}/.gitignore.XXXXXX")
trap 'rm -f "$_TMP"' EXIT

_print_definition > "$_TMP"
mv -f "$_TMP" "$TARGET"
