#!/usr/bin/env bash
set -eu

# option の version は、大文字の環境変数 VERSION で渡る。
if [ -z "${VERSION:-}" ]; then
  echo "playwright-deps: version の option が空です。" >&2
  exit 1
fi
if ! command -v npx >/dev/null 2>&1; then
  echo "playwright-deps: npx がありません。node の feature の後に動いているか確かめてください。" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
npx -y "playwright-core@${VERSION}" install-deps chromium

rm -rf /var/lib/apt/lists/* /root/.npm
