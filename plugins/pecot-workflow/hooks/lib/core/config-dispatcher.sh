#!/bin/bash
# 共通ディスパッチャ: hooks-config.json によるフック有効/無効制御。
#
# 提供関数: pecot_hook_enabled
# 配置: hooks/lib/core/config-dispatcher.sh。
#
# 使用方法（各ロジックスクリプトの冒頭）は次のとおり。
#   source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
#   pecot_hook_enabled "hook-name" true || return 0

# hook_message（メッセージの頭と字下げ）を、このファイルを source するスクリプトへ提供する。
_PECOT_CONFIG_DISPATCHER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${_PECOT_CONFIG_DISPATCHER_DIR}/hook-message.sh"

# hooks-config.json のパスを解決
# テスト時は PECOT_HOOKS_CONFIG_PATH 環境変数でオーバーライド可能。
_PECOT_HOOKS_CONFIG="${PECOT_HOOKS_CONFIG_PATH:-${CLAUDE_PROJECT_DIR}/.pecot/config/hooks-config.json}"

# hooks-config.json は、プロセス内で最初の pecot_hook_enabled 呼び出しのときに 1 回の jq で読む。
# 読んだ内容は、「key<TAB>value」の行の文字列としてシェル変数にキャッシュする。
# 1 プロセスで複数のフックを判定しても、jq は 1 回で済む。
# 連想配列は bash 3.2（macOS 標準）で使えないため使わない。
# 状態: ""（未読込）/ absent（ファイルが無い・空）/ ok / error（パース失敗）。
_PECOT_HOOKS_CONFIG_LINES=""
_PECOT_HOOKS_CONFIG_STATE=""
_PECOT_HOOKS_CONFIG_LOADED_PATH=""

_pecot_hooks_config_load() {
    local out
    _PECOT_HOOKS_CONFIG_LINES=""
    _PECOT_HOOKS_CONFIG_LOADED_PATH="$_PECOT_HOOKS_CONFIG"

    if [[ ! -f "$_PECOT_HOOKS_CONFIG" ]] || [[ ! -s "$_PECOT_HOOKS_CONFIG" ]]; then
        _PECOT_HOOKS_CONFIG_STATE="absent"
        return 0
    fi

    # 文字列はそのまま、それ以外は JSON 文字列にして key / value の 2 列で受ける。
    if ! out=$(jq -r 'if type == "object" then to_entries[] | [.key, (.value | if type == "string" then . else tojson end)] | @tsv else error("not an object") end' "$_PECOT_HOOKS_CONFIG" 2>/dev/null); then
        _PECOT_HOOKS_CONFIG_STATE="error"
        return 0
    fi

    _PECOT_HOOKS_CONFIG_LINES="$out"
    _PECOT_HOOKS_CONFIG_STATE="ok"
}

# @param $1 hook-name  フック名（スクリプトファイル名から .sh を除いたもの）。
# @param $2 default    デフォルト値（"true" or "false"）。
# @return 0 = 有効（処理を続行）、1 = 無効（呼び出し元が早期リターン）。
pecot_hook_enabled() {
    local hook_name="$1"
    local default="$2"

    if [[ -z "$_PECOT_HOOKS_CONFIG_STATE" ]] || [[ "$_PECOT_HOOKS_CONFIG_LOADED_PATH" != "$_PECOT_HOOKS_CONFIG" ]]; then
        _pecot_hooks_config_load
    fi

    # hooks-config.json が存在しない or 空の場合はデフォルト値で判定。
    if [[ "$_PECOT_HOOKS_CONFIG_STATE" == "absent" ]]; then
        [[ "$default" == "true" ]]
        return $?
    fi

    # パースエラー（構文エラー等）の場合は警告 + デフォルト値で動作。
    if [[ "$_PECOT_HOOKS_CONFIG_STATE" == "error" ]]; then
        hook_message warning "failed to parse hooks-config.json; using the default value ($default)" >&2
        [[ "$default" == "true" ]]
        return $?
    fi

    # キーが無いか値が空の場合は、デフォルト値を使う。
    local key val value=""
    while IFS=$'\t' read -r key val; do
        if [[ -n "$key" ]] && [[ "$key" == "$hook_name" ]]; then
            value="$val"
            break
        fi
    done <<< "$_PECOT_HOOKS_CONFIG_LINES"
    if [[ -z "$value" ]]; then
        [[ "$default" == "true" ]]
        return $?
    fi

    # 設定値で判定。
    [[ "$value" == "true" ]]
    return $?
}

# プラグイン内部リソースのルートを解決
# 優先順位: 1. 既設定の PLUGIN_HOOKS  2. CLAUDE_PLUGIN_ROOT/hooks  3. SCRIPT_DIR から逆算。
if [ -z "${PLUGIN_HOOKS:-}" ]; then
    PLUGIN_HOOKS="${CLAUDE_PLUGIN_ROOT:+${CLAUDE_PLUGIN_ROOT}/hooks}"
fi
if [ -z "${PLUGIN_HOOKS:-}" ]; then
    PLUGIN_HOOKS="$(cd "${SCRIPT_DIR%/lib/*}" && pwd)"
fi
