#!/bin/bash
# 共通ディスパッチャ: hooks-config.json によるフック有効/無効制御
#
# 提供関数: pecotv_hook_enabled
#
# 配置: hooks/lib/core/config-dispatcher.sh
# pecot-workflow プラグインの config-dispatcher.sh と対称にしている。
# 関数名・env override・既定パスを pecotv 名前空間へ読み替えた。
#
# 使用方法（呼び出し側）:
#   source "${SCRIPT_DIR}/lib/core/config-dispatcher.sh"
#
#   pecotv_hook_enabled "hook-name" true || <早期スキップ>
#
# set -u 下で source される可能性に備え、${CLAUDE_PROJECT_DIR} は :- で防御する。
# 呼び出し側の session-start.sh は set -euo pipefail で動く。

# hooks-config.json のパスを解決する。
# テスト時は PECOTV_HOOKS_CONFIG_PATH 環境変数でオーバーライド可能。
_PECOTV_HOOKS_CONFIG="${PECOTV_HOOKS_CONFIG_PATH:-${CLAUDE_PROJECT_DIR:-$(pwd)}/.pecotv/config/hooks-config.json}"

# @param $1 hook-name  フック名（スクリプトファイル名から .sh を除いたもの）。
# @param $2 default    デフォルト値（"true" or "false"）。
# @return 0 = 有効（処理を続行）、1 = 無効（呼び出し元が早期スキップ）。
pecotv_hook_enabled() {
    local hook_name="$1"
    local default="$2"

    # hooks-config.json が存在しない or 空の場合はデフォルト値で判定
    if [[ ! -f "$_PECOTV_HOOKS_CONFIG" ]] || [[ ! -s "$_PECOTV_HOOKS_CONFIG" ]]; then
        [[ "$default" == "true" ]]
        return $?
    fi

    # jq でフック名の値を取得
    local value
    value=$(jq -r --arg key "$hook_name" 'if has($key) then .[$key] else empty end' "$_PECOTV_HOOKS_CONFIG" 2>/dev/null)
    local jq_exit=$?

    # jq エラー（構文エラー等）の場合は警告 + デフォルト値で動作
    if [[ $jq_exit -ne 0 ]]; then
        # 1 行なので字下げは要らない。caller が hook_message を source していなくても動くよう、頭は直に付ける。
        echo "warning: hooks-config.json could not be parsed. The default ($default) is in effect." >&2
        [[ "$default" == "true" ]]
        return $?
    fi

    # キーが存在しない場合（empty）はデフォルト値
    if [[ -z "$value" ]]; then
        [[ "$default" == "true" ]]
        return $?
    fi

    # 設定値で判定
    [[ "$value" == "true" ]]
    return $?
}
