#!/bin/bash
# .pecot 配下への書き込みガード（gitignore-before-write 規約の単一実装）#666。
#
# 提供関数: pecot_state_dir_ensure
# .pecot へ書く全 hook はディレクトリ作成をこの関数経由に統一する。
# - .pecot 不在（pecot 未使用リポ）→ return 1。呼び出し元は書き込みをスキップする
#   （.pecot を新規作成しない。新規作成は利用検知フック pecot-dir-init.sh に一本化済 #662）。
# - .pecot 存在 → .gitignore 不在なら pecot-gitignore-ensure.sh を呼んでから mkdir
#   （gitignore-before-write）。鮮度維持は session-start の責務なので毎回上書きはしない。
#
# source されるため自己ディレクトリは BASH_SOURCE[0] から導出する（$0 は source 元を指す）。
_PECOT_STATE_GUARD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# @param $1 dir  作成したいディレクトリ（state / tmp/debug の両系統を 1 関数でカバー）。
# @return 0=作成済（書き込み可） / 1=pecot 未使用リポ（書き込みスキップ）。
pecot_state_dir_ensure() {
    local dir="$1"
    local pecot_dir="${CLAUDE_PROJECT_DIR}/.pecot"
    [ -d "$pecot_dir" ] || return 1          # pecot 未使用リポ → 書き込みスキップ
    if [ ! -f "${pecot_dir}/.gitignore" ]; then
        "${_PECOT_STATE_GUARD_DIR}/pecot-gitignore-ensure.sh" || true
    fi
    mkdir -p "$dir"
}
