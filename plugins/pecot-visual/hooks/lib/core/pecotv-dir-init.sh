#!/usr/bin/env bash
# pecot-visual プラグインの作業ディレクトリ (.pecotv/) をプロジェクト側に初期化し、
# README/CHANGELOG をプラグインから同期する。
# 検知レイヤ (user-prompt-submit / pre-tool-use-skill) から pecotv 利用時のみ呼ばれる。
# pecot-workflow プラグインの pecot-dir-init.sh と同じ「利用検知ベース + mtime ガード同期」設計。
set -euo pipefail

[[ -z "${CLAUDE_PROJECT_DIR:-}" ]] && exit 0

PECOTV_DIR="${CLAUDE_PROJECT_DIR}/.pecotv"

mkdir -p "${PECOTV_DIR}/state"
# work/ はスキル生成物の置き場（用途別: work/drawio 等。サブディレクトリは
# 各スキル / CLI が出力時に作る）。tmp はシステム中間物が現状無いため作らない。
mkdir -p "${PECOTV_DIR}/work"

# プラグインの hooks/ ルートを解決（PLUGIN_HOOKS > CLAUDE_PLUGIN_ROOT > SCRIPT_DIR逆算）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${PLUGIN_HOOKS:-}" ]]; then
    _HOOKS_ROOT="$PLUGIN_HOOKS"
elif [[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
    _HOOKS_ROOT="${CLAUDE_PLUGIN_ROOT}/hooks"
else
    _HOOKS_ROOT="${SCRIPT_DIR%/lib/core}"
fi

# mtime ガード: plugin.json より新しい同期マーカーがあれば skip
_VFILE="${PECOTV_DIR}/state/.plugin-sync-version"
_PJSON="${_HOOKS_ROOT}/../.claude-plugin/plugin.json"
if [[ -f "$_VFILE" && "$_VFILE" -nt "$_PJSON" ]]; then
    exit 0
fi

# .gitignore を最初に書く（コピーより前）。ファイルが無いか追跡していないときだけ書く。
# コピー後・gitignore 作成前の失敗で untracked 汚染が残るのを防ぐ。
"${SCRIPT_DIR}/pecotv-gitignore-ensure.sh"

# README.md を毎回同期
SRC="${_HOOKS_ROOT}/README.md"
if [[ -f "$SRC" ]]; then
    cp "$SRC" "${PECOTV_DIR}/README.md"
fi

# CHANGELOG.md を毎回同期
SRC="${_HOOKS_ROOT}/../CHANGELOG.md"
if [[ -f "$SRC" ]]; then
    cp "$SRC" "${PECOTV_DIR}/CHANGELOG.md"
fi

# 同期マーカーを更新
touch "$_VFILE"
