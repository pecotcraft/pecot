#!/usr/bin/env bash
# open_browser.sh - URLをOS判定してデフォルトブラウザで開く
#
# Usage: open_browser.sh <url>

set -euo pipefail

url="${1:?Usage: open_browser.sh <url>}"

if grep -qi microsoft /proc/version 2>/dev/null; then
  # WSL → Windows側ブラウザ
  powershell.exe -Command "Start-Process '$url'"
elif [[ "$(uname)" == "Darwin" ]]; then
  # macOS
  open "$url"
elif command -v xdg-open &>/dev/null; then
  # Linux
  xdg-open "$url"
else
  echo "ブラウザを自動で開けません。以下のURLを手動で開いてください:" >&2
  echo "$url" >&2
  exit 1
fi
