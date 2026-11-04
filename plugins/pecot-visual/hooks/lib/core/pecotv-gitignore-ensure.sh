#!/usr/bin/env bash
# .pecotv/.gitignore を生成する。
#
# .pecotv/ 配下の runtime 生成物（state/ tmp/）と、プラグインからコピーされるファイル（README.md / CHANGELOG.md）がある。
# これらは repo root の .gitignore 設定に依存せず、確実に git 管理外にする。
# そのため、最初の .pecotv/ 書き込みより前にこのスクリプトを呼ぶ。
#
# session-start.sh と pecotv-dir-init.sh の双方から呼ばれる。
# .gitignore の内容定義は、このスクリプトを単一の出所とする。
# pecot-workflow プラグインの pecot-gitignore-ensure.sh と同構造にしている。
set -euo pipefail

PECOTV_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}/.pecotv"
mkdir -p "$PECOTV_DIR"

# 一時ファイルへ書き出してから、mv でアトミックに差し替える。
# 検知レイヤ（user-prompt-submit / pre-tool-use-skill）と SessionStart が並行発火しても、
# 空ファイル等は生じない。
# mv（同一 filesystem）がアトミックなためだ。
_TMP=$(mktemp "${PECOTV_DIR}/.gitignore.XXXXXX")
trap 'rm -f "$_TMP"' EXIT

cat > "$_TMP" <<'GITIGNORE_EOF'
# 実行時生成ファイル（git管理外）
state/
tmp/
work/
# プラグインからコピーされるファイル（git管理外）
README.md
CHANGELOG.md
# ユーザーローカル設定（git管理外。pecot 側 .pecot/.gitignore と対称）
config/hooks-config.json
# このファイル自身（フックが自動再生成するため git 管理外）
/.gitignore
GITIGNORE_EOF

mv -f "$_TMP" "${PECOTV_DIR}/.gitignore"
