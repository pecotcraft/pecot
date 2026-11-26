#!/usr/bin/env bash
# 公開サイトの保管ブランチ pages-store を、引数のリポ（省くとこのリポ）の origin からの取得の対象から外す。
# pages-store は大きく（展開 565 MB）、開発では読まないため。post-start.sh から呼ぶ。
set -euo pipefail

repo="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
exclude='^refs/heads/pages-store'

if ! git -C "$repo" remote get-url origin > /dev/null 2>&1; then
  exit 0
fi

if ! git -C "$repo" config --get --fixed-value remote.origin.fetch "$exclude" > /dev/null; then
  git -C "$repo" config --add remote.origin.fetch "$exclude"
fi

# 負の refspec で外したブランチの追跡 ref は、fetch --prune でも消えない
if git -C "$repo" show-ref --verify --quiet refs/remotes/origin/pages-store; then
  git -C "$repo" update-ref -d refs/remotes/origin/pages-store
fi
