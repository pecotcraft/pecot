#!/usr/bin/env bash
# fixture の Python に ruff と pyright strict をかける。.githooks/scripts/run-lint.sh の Python の部分と同じ作り。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."   # libs/interface-spec
PROJECT="$PWD"
REPO_ROOT="$(cd ../.. && pwd)"

if ! command -v uvx &>/dev/null; then
    echo "ERROR: interface-spec の lint に uv が必要です。" >&2
    echo "  インストール: https://docs.astral.sh/uv/getting-started/installation/" >&2
    exit 1
fi

# 設定は root の pre-commit と同じ pyproject を渡す。--fix は付けない（fixture を書き換えると期待の行番号が崩れる）。
RUFF_CONFIG="$REPO_ROOT/plugins/pecot-workflow/cli/pyproject.toml"
uvx ruff@0.17.4 check --config "$RUFF_CONFIG" tests/fixtures
uvx ruff@0.17.4 format --check --config "$RUFF_CONFIG" tests/fixtures

# npm 11 は、cwd から上へたどって見つけた package.json が pnpm を宣言していると npx も止める。
# そのため cwd を / にして呼ぶ。
( cd / && npx --yes pyright@1.1.410 --project "$PROJECT" )
