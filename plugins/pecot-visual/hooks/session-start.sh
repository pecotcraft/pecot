#!/usr/bin/env bash
# SessionStart hook: .pecotv が既に存在するリポに限り、.gitignore を再生成する。
# 再生成の元は、単一の出所（pecotv-gitignore-ensure.sh）とする。内容の鮮度を維持する。
# .pecotv/ の新規作成は利用検知側（pecotv-dir-init.sh）に一本化されており、ここでは行わない。
# （#662 / #676。pecot の session-start-common.sh と対称。）
#
# - Claude Code は matcher `startup|clear|resume` の 1 エントリで登録される（compact では起動しない）。
#   Copilot CLI は matcher を解釈しないため、matcher 無しの 1 エントリで、new / resume で起動する。
#   処理は、冪等な .gitignore 再生成と tracked 検知だけで、tracked 検知は再生成の後に続く。
#   tracked 検知は、読み取りと stdout 出力のみで index を変異させない。
#   そのため重複して起動しても無害。
# - lock は張らない。エントリが 1 つで、後続処理が index を変異させないためだ。
#   pecot の git-sync 等に相当するものは無い。
#   gitignore-ensure は mktemp+mv でアトミックだ。
#   SessionStart に処理を追加する場合は、直列化の要否を再検討すること。
#   後続の plugin-update-notice も読み取り専用（ファイル変異なし・stdout 出力のみ）なので、lock は不要。
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
PROJECT_DIR="${PROJECT_DIR%/}"  # 末尾スラッシュを除去
PECOTV_DIR="${PROJECT_DIR}/.pecotv"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -d "$PECOTV_DIR" ]; then
    CLAUDE_PROJECT_DIR="$PROJECT_DIR" "${SCRIPT_DIR}/lib/core/pecotv-gitignore-ensure.sh" || true
fi

# hooks-config.json による無効化ガードを読み込む（pecot 側 config-dispatcher.sh と対称）。
# dispatcher は ${CLAUDE_PROJECT_DIR} を参照して config パスを解決する。
# そのため source 前に、確定済みの PROJECT_DIR をエクスポートしておく（set -u 下でも安全）。
# gitignore-ensure 自体はガード対象にしない。pecot 側も ensure は無条件に実行する。
export CLAUDE_PROJECT_DIR="$PROJECT_DIR"
source "${SCRIPT_DIR}/lib/core/config-dispatcher.sh"

# SessionStart の出力は JSON 1 個にまとめる。
# 以降の各ブロックの stdout（素のテキスト）は一時ファイルに集め、終了時に additionalContext へ畳む。
# hookSpecificOutput.additionalContext は Claude Code が読む。
# トップレベルの additionalContext は Copilot CLI 1.0.103 が読む。
# Copilot は SessionStart では、素のテキストも hookSpecificOutput.additionalContext もモデルに渡さない。
# Claude Code はトップレベルを読まないので、二重に入らない。
# 起動中の node が脆弱性の修正を含まないバージョンなら、CLI と MCP サーバが起動を拒否する理由を案内する。
# Claude Code 上では、MCP サーバが failed と見えるだけで理由が届かない。
# そのため利用者には systemMessage（画面表示）、エージェントには additionalContext（コンテキスト）の
# 両方へ渡す。何も出ないときは何も出力しない。
# 判定は、CLI と同じ checkNodeRuntime（cli/src/node-runtime.ts）を node で読み込んで呼ぶ。
# 判定を読めない場合と node が無い場合は、案内なしで exit 0 のまま終わる。
NODE_RUNTIME_MESSAGE=""
if pecotv_hook_enabled "node-runtime-notice" true; then
    # shellcheck source=../bin/_lib.sh
    source "${SCRIPT_DIR}/../bin/_lib.sh"
    NODE_RUNTIME_MESSAGE="$(pecotv_node_runtime_message "$(cd "${SCRIPT_DIR}/.." && pwd)" || true)"
fi
_HOOK_BODY_FILE="$(mktemp)"
exec 4>&1 >"$_HOOK_BODY_FILE"
_emit_session_start() {
    exec 1>&4
    local body notice context
    body="$(cat "$_HOOK_BODY_FILE")"
    rm -f "$_HOOK_BODY_FILE"
    notice=""
    [ -z "$NODE_RUNTIME_MESSAGE" ] || notice="pecotv: ${NODE_RUNTIME_MESSAGE}"
    context="$body"
    if [ -n "$notice" ]; then
        if [ -n "$body" ]; then context="${notice}"$'\n'"${body}"; else context="$notice"; fi
    fi
    [ -n "$context" ] || return 0
    if command -v jq >/dev/null 2>&1; then
        jq -n --arg notice "$notice" --arg ctx "$context" '
            {
                hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx},
                additionalContext: $ctx
            }
            | if $notice != "" then .systemMessage = $notice else . end'
    else
        printf '%s\n' "$context"
    fi
}
trap _emit_session_start EXIT

# tracked 検知 + untrack 案内。必ず gitignore-ensure の後に置く。
# ブランチ跨ぎの直後は、.gitignore の実体が一時的に消えることがある。
# ensure の後なら実体が必ず存在するため、判定が index のみに依存して安定する。
# gitignore-untrack-notice を false にすると、この案内ブロックごと抑止される（pecot 側の同名フックと対称）。
#
# 検知は、読み取り（git ls-files）と stdout 出力のみで index を変異させない。
# untrack はユーザーか AI に委ねる。SessionStart の stdout は、セッションコンテキストに注入される。
#
# 相対パス `-- .pecotv/.gitignore` は、`-C "$PROJECT_DIR"` 基準で解決される。
# .pecotv は常に ${CLAUDE_PROJECT_DIR} 直下に生成される。
# pecotv-dir-init と gitignore-ensure が、すべて同基準だからだ。
# そのため、この基準で検知してよい。
if pecotv_hook_enabled "gitignore-untrack-notice" true \
    && command -v git >/dev/null 2>&1 \
    && git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    && git -C "$PROJECT_DIR" ls-files --error-unmatch -- .pecotv/.gitignore >/dev/null 2>&1; then
    echo '`.pecotv/.gitignore` はフックが自動再生成するファイルです。untrack してください: `git rm --cached .pecotv/.gitignore`（commit すると以後 git 管理外になります）'
fi

# installed プラグインと marketplace clone のバージョン比較による更新案内。
# set -euo pipefail 下のため非 0 exit でセッションを落とさないよう `|| true` を付ける。
# CLAUDE_PROJECT_DIR は上で export 済み。サブスクリプトは config-dispatcher 経由で
# 無効化ガード（plugin-update-notice）を自前で確認するためここでは素通しでよい。
"${SCRIPT_DIR}/lib/session-start/plugin-update-notice.sh" || true
