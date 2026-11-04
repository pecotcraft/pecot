#!/bin/bash
# セッションの起点ディレクトリの永続化: CLAUDE_ENV_FILEにPECOT_SESSION_PROJECT_DIRを追記。
#
# Bashツールの子プロセスにはCLAUDE_PROJECT_DIRが渡らない。
# worktreeの .pecot/work はbaseの .pecot/work への symlink で、そこへcdするとgit toplevelがbase側になる。
# CLIがセッションのworktreeを判定できるよう、起点をここで書き残す。
# 書く値は、project-root.sh が上書きする前の（Claude Codeが渡した元の）CLAUDE_PROJECT_DIR のgit toplevel。
# hooksが.pecot/work配下の判定に使う起点と同じにする。
# Copilot CLIにはCLAUDE_ENV_FILEが無く、何もしない。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "session-project-dir" true || exit 0

ORIGIN_DIR="${PECOT_ORIGINAL_CLAUDE_PROJECT_DIR:-}"
if [ -n "$CLAUDE_ENV_FILE" ] && [ -n "$ORIGIN_DIR" ] && [ -d "$ORIGIN_DIR" ]; then
    SESSION_TOP=$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY \
        -u GIT_ALTERNATE_OBJECT_DIRECTORIES git -C "$ORIGIN_DIR" rev-parse --show-toplevel 2>/dev/null)
    if [ -n "$SESSION_TOP" ]; then
        printf 'export PECOT_SESSION_PROJECT_DIR=%q\n' "$SESSION_TOP" >> "$CLAUDE_ENV_FILE"
    fi
fi
