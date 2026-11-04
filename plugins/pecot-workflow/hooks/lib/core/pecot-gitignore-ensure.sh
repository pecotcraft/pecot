#!/usr/bin/env bash
# .pecot/.gitignore を生成する。
#
# .pecot/ 配下の runtime 生成物（state/ tmp/ 等）と、プラグインからコピーされるファイルがある。
# これらを、repo root の .gitignore 設定に依存せず確実に git 管理外にする。
# そのため、最初の .pecot/ 書き込みより前に、このスクリプトを呼ぶ。
#
# session-start フック（session-start-common.sh）と pecot-dir-init.sh の双方から
# 呼ばれる。.gitignore の内容定義はこのスクリプトを単一の出所とする。
set -euo pipefail

[[ -z "${CLAUDE_PROJECT_DIR:-}" ]] && exit 0

PECOT_DIR="${CLAUDE_PROJECT_DIR}/.pecot"
mkdir -p "$PECOT_DIR"

# 一時ファイルへ書き出してから mv でアトミックに差し替える。
# session-start-common.sh は flock 取得より前にこのスクリプトを呼ぶため、
# 複数 matcher の並行発火時に同一 .gitignore への書き込みが競合しうる。
# mv（同一 filesystem）はアトミックなので、競合しても空ファイル等は生じない。
_TMP=$(mktemp "${PECOT_DIR}/.gitignore.XXXXXX")
trap 'rm -f "$_TMP"' EXIT

cat > "$_TMP" <<'GITIGNORE_EOF'
# 実行時生成ファイル（git管理外）。
state/
tmp/
# work は WT 側で symlink になるため trailing slash なし（work/ は symlink にマッチしない）。
work
# プラグインからコピーされるファイル（git管理外）。
README.md
CHANGELOG.md
config/hooks-config.json
config/hooks-config.json.sample
config/projects/.active
config/hosts.json
config/hosts.json.sample
config/.env
config/.env.sample
# このファイル自身（フックが自動再生成するため git 管理外）。
/.gitignore
GITIGNORE_EOF

mv -f "$_TMP" "${PECOT_DIR}/.gitignore"
