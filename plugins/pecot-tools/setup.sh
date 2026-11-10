#!/usr/bin/env bash
# pecot-tools plugin setup script — bin/pecot-tools の self-bootstrap を強制起動する薄い shim。
# 実体の install / build ロジックは bin/pecot-tools 側に集約されている。
# ここはその起動の入り口を提供するのみ。--help でも bootstrap が exec の前に完走する設計を前提にしている。
#
# Bash から使う置き場を用意する。準備先はデータ置き場の実行用ミラー（${データ置き場}/runtime/）。
# 置き場は CLAUDE_PLUGIN_DATA → PLUGIN_DATA → 標準の場所の順で決める。
# プラグイン本体の配下には何も作らない。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bin/_lib.sh
. "$SCRIPT_DIR/bin/_lib.sh"

echo "=== pecot-tools plugin setup ==="
if ! plugin_data_dir_ensure pecot-tools >/dev/null; then
  echo "=== pecot-tools plugin setup failed (cannot prepare the data directory) ===" >&2
  exit 1
fi
PECOT_TOOLS_BOOTSTRAP_FORCE=1 "$SCRIPT_DIR/bin/pecot-tools" --help >/dev/null
echo "=== pecot-tools plugin setup complete ==="
