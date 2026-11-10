#!/usr/bin/env bash
set -euo pipefail

# root 共通フック (.githooks/ 配下) の pytest のランナー。GIT_* は conftest.py の autouse fixture が剥がす。

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# test_check_text.py が起動する libs/text-rules/dist を用意する。CI の githooks の job では他に作る者がいない。
# shellcheck source=../lib/text-rules-ready.sh
source "$TESTS_DIR/../lib/text-rules-ready.sh"
require_text_rules_ready "$(cd "$TESTS_DIR/../.." && pwd)" || exit 1

echo "==> pytest (.githooks/tests/)"
uvx --python 3.12 --with pytest-xdist --with packaging --with pyyaml \
    pytest "$TESTS_DIR" -q --import-mode=importlib -n auto -p no:cacheprovider
