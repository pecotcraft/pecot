#!/usr/bin/env bash
# 文章規則の git hook（pre-commit）を入れる。post-create.sh から呼ぶ。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! command -v uv > /dev/null 2>&1; then
  echo "ERROR: uv が見つからない。pre-commit を入れるには uv が要る" >&2
  exit 1
fi

if git -C "$root" config --get core.hooksPath > /dev/null; then
  echo "core.hooksPath が設定済みのため、pre-commit の hook 導入をスキップする" >&2
  exit 0
fi

# 2 回目以降も成功する
uv tool install pre-commit

# 設定ファイルが無いと pre-commit の hook しか入らないので、種類を明示する
cd "$root"
"$(uv tool dir --bin)/pre-commit" install --allow-missing-config \
  -t pre-commit -t commit-msg -t pre-push
