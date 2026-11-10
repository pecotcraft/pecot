#!/usr/bin/env bash
# fixture の Python に pyright strict をかける。ruff は root の pre-commit の hook（ruff-check・ruff-format）が fixture にもかける。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."   # libs/interface-spec
PROJECT="$PWD"

# npm 11 は、cwd から上へたどって見つけた package.json が pnpm を宣言していると npx も止める。
# そのため cwd を / にして呼ぶ。
( cd / && npx --yes pyright@1.1.410 --project "$PROJECT" )
