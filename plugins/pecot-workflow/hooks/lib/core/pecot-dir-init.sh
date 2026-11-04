#!/usr/bin/env bash
# .pecot/ ディレクトリ構造をプロジェクト側に初期化する。
# 新規プロジェクトで初めてプラグインを使う場合に必要。
set -euo pipefail

[[ -z "${CLAUDE_PROJECT_DIR:-}" ]] && exit 0

PECOT_DIR="${CLAUDE_PROJECT_DIR}/.pecot"

mkdir -p "${PECOT_DIR}/state"
mkdir -p "${PECOT_DIR}/tmp"
mkdir -p "${PECOT_DIR}/work"
mkdir -p "${PECOT_DIR}/config"
mkdir -p "${PECOT_DIR}/config/projects"

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
_VFILE="${PECOT_DIR}/state/.plugin-sync-version"
_PJSON="${_HOOKS_ROOT}/../.claude-plugin/plugin.json"
if [[ -f "$_VFILE" && "$_VFILE" -nt "$_PJSON" ]]; then
    exit 0
fi

# .gitignore を最初に更新する（コピーより前）。
# 既存リポの .gitignore が旧内容（README/CHANGELOG を含まない）の場合に、
# コピー後・gitignore 更新前の失敗で untracked 汚染が残るのを防ぐ。
# 内容定義は pecot-gitignore-ensure.sh が単一の出所。
"${SCRIPT_DIR}/pecot-gitignore-ensure.sh"

# hooks-config.json が未作成なら sample からコピー
HOOKS_CONFIG="${PECOT_DIR}/config/hooks-config.json"
if [[ ! -f "$HOOKS_CONFIG" ]]; then
    SAMPLE="${_HOOKS_ROOT}/hooks-config.json.sample"
    if [[ -f "$SAMPLE" ]]; then
        cp "$SAMPLE" "$HOOKS_CONFIG"
    fi
fi

# hosts.json が未作成なら sample からコピー
HOSTS_CONFIG="${PECOT_DIR}/config/hosts.json"
if [[ ! -f "$HOSTS_CONFIG" ]]; then
    SAMPLE="${_HOOKS_ROOT}/config/hosts.json.sample"
    if [[ -f "$SAMPLE" ]]; then
        cp "$SAMPLE" "$HOSTS_CONFIG"
    fi
fi

# .env が未作成なら sample からコピー
ENV_CONFIG="${PECOT_DIR}/config/.env"
if [[ ! -f "$ENV_CONFIG" ]]; then
    SAMPLE="${_HOOKS_ROOT}/config/.env.sample"
    if [[ -f "$SAMPLE" ]]; then
        cp "$SAMPLE" "$ENV_CONFIG"
    fi
fi

# hooks-config.json.sample を毎回同期
SRC="${_HOOKS_ROOT}/hooks-config.json.sample"
if [[ -f "$SRC" ]]; then
    cp "$SRC" "${PECOT_DIR}/config/hooks-config.json.sample"
fi

# hosts.json.sample を毎回同期
SRC="${_HOOKS_ROOT}/config/hosts.json.sample"
if [[ -f "$SRC" ]]; then
    cp "$SRC" "${PECOT_DIR}/config/hosts.json.sample"
fi

# .env.sample を毎回同期
SRC="${_HOOKS_ROOT}/config/.env.sample"
if [[ -f "$SRC" ]]; then
    cp "$SRC" "${PECOT_DIR}/config/.env.sample"
fi

# README.md を毎回同期
SRC="${_HOOKS_ROOT}/README.md"
if [[ -f "$SRC" ]]; then
    cp "$SRC" "${PECOT_DIR}/README.md"
fi

# CHANGELOG.md を毎回同期
SRC="${_HOOKS_ROOT}/../CHANGELOG.md"
if [[ -f "$SRC" ]]; then
    cp "$SRC" "${PECOT_DIR}/CHANGELOG.md"
fi

# 同期マーカーを更新
touch "$_VFILE"
