#!/bin/bash
# インストール済みプラグインと marketplace clone 最新版の乖離を検知し、installed が古い場合に更新案内を 1 行 stdout に出す。
# SessionStart の stdout は、セッションコンテキストに注入される。
# stateless で、index・ファイルは一切変異させない。
#
# 何を検知し、いつ skip するか。
#   - jq 不在 → skip（version の読み出しに jq を使う）
#   - CLAUDE_PLUGIN_ROOT 不在 / dev 環境・直パス install → skip（更新導線が無く、通知しても無意味なため）。
#     対象は次の 2 形のみ。
#       Claude Code: <plugins ルート>/cache/<mp>/<name>/<ver>。
#         plugins ルートに known_marketplaces.json があること。
#       Copilot    : <home>/installed-plugins/<mp>/<name>。
#   - marketplace clone 不在 → skip（その場合は README の更新手順が導線を担う）
#   - installed / latest の version 欠落 → skip
#   - installed が latest 以上 → skip。
#     リリース直後の clone 未 pull レースで逆方向になるケースを含む。古い方向のみ通知する。
#
# 環境変数（CLAUDE_CONFIG_DIR / CLAUDE_CODE_PLUGIN_CACHE_DIR 等）と HOME は読まない。
# Claude Code は plugins ルートの下に、cache と marketplaces を兄弟で置く。
# plugins ルートは通常 <設定ディレクトリ>/plugins で、cowork_plugins 等でも同形。
# そのため、CLAUDE_PLUGIN_ROOT の 3 階層上（cache）の親を plugins ルートとする。
# clone は、known_marketplaces.json の installLocation を使う。無ければ <plugins ルート>/marketplaces/<mp> を使う。
# Copilot は自身の marketplace キャッシュを使う。
# キャッシュは <home>/.cache/copilot/marketplaces/<URL をスラッグ化した dir> にある。
# このうち marketplace.json の name が mp と一致するものを使う。
# 無ければ、Claude Code 側の clone（CLAUDE_CONFIG_DIR または */.copilot の隣の .claude）を使う。
#
# set -euo pipefail は付けない（lib/session-start/ の既存サブスクリプト群と対称）。
# 特に set -u は、config-dispatcher.sh 内の ${CLAUDE_PROJECT_DIR} 未設定参照で不具合を起こしうるため付けない。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecotv_hook_enabled "plugin-update-notice" true || exit 0
command -v jq >/dev/null 2>&1 || exit 0
ROOT="${CLAUDE_PLUGIN_ROOT:-}"; ROOT="${ROOT%/}"; [ -n "$ROOT" ] || exit 0
# ROOT のレイアウトから導入形態（Claude Code / Copilot）と marketplace clone を決める。
case "$ROOT" in
*/cache/*/*/*)
    ver_dir="$ROOT"; name_dir="${ver_dir%/*}"; mp_dir="${name_dir%/*}"; cache_dir="${mp_dir%/*}"
    plugins_dir="${cache_dir%/*}"
    [ "${cache_dir##*/}" = "cache" ] && [ -f "${plugins_dir}/known_marketplaces.json" ] || exit 0
    mp="${mp_dir##*/}"; name="${name_dir##*/}"
    mp_clone=$(jq -r --arg mp "$mp" '.[$mp].installLocation // empty' "${plugins_dir}/known_marketplaces.json" 2>/dev/null)
    [ -d "$mp_clone" ] || mp_clone="${plugins_dir}/marketplaces/${mp}"
    update_hint="\`claude plugin update ${name}@${mp}\`（project スコープ導入時は -s project を付与）"
    ;;
*/installed-plugins/*/*)
    cop_home="${ROOT%/installed-plugins/*}"
    rel="${ROOT#"$cop_home"/installed-plugins/}"
    case "$rel" in */*/*) exit 0 ;; esac
    mp="${rel%%/*}"; name="${rel#*/}"
    mp_clone=""
    for d in "${cop_home}"/.cache/copilot/marketplaces/*/; do
        [ "$(jq -r '.name // empty' "${d}.claude-plugin/marketplace.json" 2>/dev/null)" = "$mp" ] && { mp_clone="${d%/}"; break; }
    done
    if [ -z "$mp_clone" ]; then
        # Copilot のキャッシュに無い場合は Claude Code 側の clone を使う。
        fb="${CLAUDE_CONFIG_DIR:-}"; fb="${fb%/}"
        if [ -z "$fb" ]; then
            case "$ROOT" in */.copilot/*) fb="${ROOT%%/.copilot/*}/.claude" ;; esac
        fi
        [ -n "$fb" ] || exit 0
        mp_clone="${fb}/plugins/marketplaces/${mp}"
    fi
    update_hint="\`copilot plugin update ${name}@${mp}\`"
    ;;
*) exit 0 ;;  # dev 環境・直パス install は対象外
esac
installed=$(jq -r '.version // empty' "${ROOT}/.claude-plugin/plugin.json" 2>/dev/null)
# dir 名とプラグイン名は一致しない（pecot-w → plugins/pecot-workflow）。marketplace.json の
# source（文字列形式のみ）から clone 内のプラグインルートを引く。オブジェクト形式・不一致・
# 取得失敗は skip。
src=$(jq -r --arg n "$name" '.plugins[]|select(.name==$n)|.source|strings' "${mp_clone}/.claude-plugin/marketplace.json" 2>/dev/null | head -1)
[ -n "$src" ] || exit 0
latest=$(jq -r '.version // empty' "${mp_clone}/${src#./}/.claude-plugin/plugin.json" 2>/dev/null)
[ -n "$installed" ] && [ -n "$latest" ] || exit 0
# installed が古い方向のみ通知（リリース直後の clone 未 pull レースで逆方向誤案内を防ぐ）。
# sort -V は GNU 拡張。-V 非対応の sort では 2>/dev/null でエラーを握りつぶし、
# head -1 が installed と一致しない（= 通知なし）安全側に倒れる。
# version は plain semver（MAJOR.MINOR.PATCH）前提。prerelease タグは sort -V の
# 順序が逆転するが現行の pecot-w/pecot-v は発行しない。
if [ "$installed" != "$latest" ] \
    && [ "$(printf '%s\n%s\n' "$installed" "$latest" | sort -V 2>/dev/null | head -1)" = "$installed" ]; then
    echo "${name} プラグインに更新があります（installed: ${installed} / latest: ${latest}）。更新: ${update_hint}"
fi
exit 0
