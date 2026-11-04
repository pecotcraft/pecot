#!/bin/bash
# Stop hook: リポジトリルート以外に生成された .pecot/ 誤配置を検知して案内する。
#
# CLAUDE.md の規約は、作業ファイルをルートの .pecot/work/<Issue番号>/ に置くこと。
# この規約はプロンプトの遵守のみに依存し、サブエージェントが CWD 相対で .pecot/ を作る誤配置が再発していた。
# そこで、毎ターン終了時に find で走査する。git index に依存しないため、untracked も検出できる。
# 誤配置があれば、systemMessage で利用者に案内する。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "misplaced-pecot-notice" true || exit 0

# 基準は CLAUDE_PROJECT_DIR（エントリポイントが project-root.sh で hook 入力の cwd の
# git toplevel に揃えたもの）。cwd がサブディレクトリでも prune パス（"$PROJECT_DIR/.pecot"）
# がルートと一致するため、上位の誤検知・見逃しが起きない。未設定（git リポ外）は安全側に
# 倒して検知せず終了する。
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
[ -z "$PROJECT_DIR" ] && exit 0
PROJECT_DIR="${PROJECT_DIR%/}"  # 末尾スラッシュを除去

# ルート直下の正規 .pecot は prune で除外（配下の work 残骸内に fixture 由来の
# .pecot があっても誤検知しない）。.git / node_modules / .pnpm-store / .venv も
# 走査対象外。find はデフォルトで symlink を辿らないため WT の .pecot/work symlink
# も安全。検出した .pecot 自身も -print 後に -prune し、誤配置 .pecot 配下の入れ子
# .pecot をトップ 1 件に集約する。find の stderr は読み取り不能ディレクトリの
# Permission denied 抜け防止のため抑制する。
# 制約: ルート .pecot/ を丸ごと prune するため、その配下に生成された誤配置
# （例: CWD=.pecot/work/<N> 作業時の入れ子 .pecot）は検出対象外。
MISPLACED=$(find "$PROJECT_DIR" -mindepth 1 \
  \( -path "$PROJECT_DIR/.pecot" -o -name .git -o -name node_modules -o -name .pnpm-store -o -name .venv \) -prune \
  -o -type d -name .pecot -print -prune 2>/dev/null)

[ -z "$MISPLACED" ] && exit 0

SYS_MESSAGE="【誤配置検知】リポジトリルート以外に .pecot/ ディレクトリが生成されています。

${MISPLACED}

必要なファイルはリポジトリルートの .pecot/work/<Issue番号>/ へ移動し、不要なら削除してください。"

jq -n --arg sys "$SYS_MESSAGE" '{"systemMessage": $sys}'
