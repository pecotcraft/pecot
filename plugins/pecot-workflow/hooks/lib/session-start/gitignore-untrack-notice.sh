#!/bin/bash
# .pecot/.gitignore が tracked な既存リポを検知し untrack 手順を案内する。
#
# .pecot/.gitignore はフックが自動再生成するファイルで、生成内容は self-ignore 行
# （/.gitignore）を含む。だが ignore は untracked ファイルにのみ働くため、過去に
# commit して tracked になっているリポは、プラグイン更新のたび、生成内容の変化で dirty になる。
# このスクリプトは、tracked を検知したら untrack 手順を stdout で案内する。
# SessionStart の stdout は、セッションコンテキストに注入される。
# index は一切変異させない（実行はユーザー/AI に委ねる）。
#
# set -euo pipefail は付けない。
# lib/session-start/ の既存サブスクリプト群（git-sync.sh 等）は、明示しないのが慣行。
# 特に set -u は、config-dispatcher.sh 内の ${CLAUDE_PROJECT_DIR} 未設定参照で不具合を起こしうるため、踏襲しない。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "gitignore-untrack-notice" true || exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
[ -z "$PROJECT_DIR" ] && exit 0
PROJECT_DIR="${PROJECT_DIR%/}"  # 末尾スラッシュを除去（既存慣行）

# 相対パス `.pecot/.gitignore` は `-C "$PROJECT_DIR"` 基準で解決する。
# .pecot は常に ${CLAUDE_PROJECT_DIR} 直下に生成される。
# pecot-dir-init と gitignore-ensure がすべて同基準なので、この基準で tracked 判定してよい。
# 非 git ディレクトリ・git 不在・untracked 済みでは無出力で exit 0。
if command -v git >/dev/null 2>&1 \
    && git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    && git -C "$PROJECT_DIR" ls-files --error-unmatch -- .pecot/.gitignore >/dev/null 2>&1; then
    echo '`.pecot/.gitignore` はフックが自動再生成するファイルです。untrack してください: `git rm --cached .pecot/.gitignore`（commit すると以後 git 管理外になります）'
fi
