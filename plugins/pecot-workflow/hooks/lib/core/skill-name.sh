#!/bin/bash
# Skill ツールのスキル名を、自プラグイン（pecot-w）の名前空間付きに正規化する。
#
# Claude Code の tool_input.skill は、`pecot-w:w-help` のように接頭辞付きで届く。
# Copilot CLI 1.0.103 は、同名のスキルが無い限り `w-help` のように名前空間なしで届く。
# 同名が複数あるときだけ、`<プラグイン名>:<スキル名>` で解決される（T050 追加確認）。
# 接頭辞（`w-` など）だけで判定すると、他のプラグインの同名スキルを取り違える。
# そのため、名前空間なしの名前は、自プラグインの skills/<名前>/SKILL.md が実在するときだけ、自プラグインのスキルとして扱う。
#
# 提供関数は次のとおり。
# - pecot_normalize_skill_name <skill>
#     stdout に正規化した名前を出す。
#     `pecot-w:*` と、他の名前空間（`pecot-v:x`）は、そのまま出す。
#     名前空間なしで自プラグインに実在する名前は `pecot-w:<名前>` にし、それ以外は入力のまま出す。
#
# source されるため、自己ディレクトリは BASH_SOURCE[0] から導出する。
# PLUGIN_HOOKS は config-dispatcher.sh が解決する（呼び出し側が先に source する）。

PECOT_PLUGIN_SKILL_NAMESPACE="pecot-w"

pecot_normalize_skill_name() {
    local raw="${1:-}"
    case "$raw" in
        *:*) printf '%s\n' "$raw"; return 0 ;;
    esac
    local skills_dir="${PLUGIN_HOOKS%/hooks}/skills"
    if [[ "$raw" =~ ^[A-Za-z0-9._-]+$ ]] && [ -f "${skills_dir}/${raw}/SKILL.md" ]; then
        printf '%s:%s\n' "$PECOT_PLUGIN_SKILL_NAMESPACE" "$raw"
    else
        printf '%s\n' "$raw"
    fi
}
