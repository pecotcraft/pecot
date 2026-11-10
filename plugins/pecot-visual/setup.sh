#!/usr/bin/env bash
# pecot-visual plugin setup script — bin/pecotv の self-bootstrap を強制起動する薄い shim。
# 実体の install / build ロジックは bin/pecotv 側に集約されており、ここはその起動手順を提供するのみ。
# --help でも bootstrap は exec 前に完走する。この設計を前提とする。
# 将来 bin/pecotv 側で、--help の bootstrap を省く最適化は入れないこと。
#
# Bash 用の置き場を用意する。
# 準備先は、データ置き場の実行用ミラー（${データ置き場}/runtime/）。
# 置き場は CLAUDE_PLUGIN_DATA → PLUGIN_DATA → 既定の場所の順で決める。
# プラグイン本体の配下には何も作らない。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bin/_lib.sh
. "$SCRIPT_DIR/bin/_lib.sh"

echo "=== pecot-visual plugin setup ==="
if ! plugin_data_dir_ensure pecot-visual >/dev/null; then
  echo "=== pecot-visual plugin setup failed (cannot prepare the data directory) ===" >&2
  exit 1
fi
# PECOTV_REQUIRE_HOST_DEPS=1: Chromium の OS ライブラリを入れられなかったとき bin/pecotv が
# 非 0 で終わる。通常のコマンド起動では非 fatal だが、setup が完了に見えて直っていない
# 状態を避けるため、ここでは失敗として扱う。
rc=0
PECOTV_BOOTSTRAP_FORCE=1 PECOTV_REQUIRE_HOST_DEPS=1 "$SCRIPT_DIR/bin/pecotv" --help >/dev/null || rc=$?
if [ "$rc" -ne 0 ]; then
  echo "=== pecot-visual plugin setup failed (exit $rc) ===" >&2
  if [ "$rc" -eq 2 ]; then
    echo "Could not install the OS libraries that Chromium needs to start. Run the command in the guidance above with administrator privileges, then run setup again." >&2
  fi
  exit "$rc"
fi
echo "=== pecot-visual plugin setup complete ==="
