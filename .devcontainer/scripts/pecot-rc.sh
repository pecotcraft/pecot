#!/usr/bin/env bash
# 作業ツリーの pecot-w・pecot-t・pecot-v を読み込んで claude remote-control を起動する。引数はそのまま渡す。
# remote-control は --plugin-dir を受け付けないので、同じ働きの CLAUDE_CODE_PLUGIN_DIRS で渡す。
set -euo pipefail

if ! root="$(git rev-parse --show-toplevel 2> /dev/null)"; then
  echo "ERROR: git の作業ツリーの中で打ってください" >&2
  exit 1
fi

export CLAUDE_CODE_PLUGIN_DIRS="$root/plugins/pecot-workflow:$root/plugins/pecot-tools:$root/plugins/pecot-visual"
exec claude remote-control "$@"
