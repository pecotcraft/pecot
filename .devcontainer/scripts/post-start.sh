#!/usr/bin/env bash
set -euo pipefail

# 前回コンテナで作った worktree の管理情報が残るため、起動ごとに prune する
shopt -s nullglob
for d in /workspaces/base/*/; do
  if [ -d "$d/.git" ]; then
    git -C "$d" worktree prune || true
  fi
done
