#!/usr/bin/env bash
set -euo pipefail

# root 共通フック (.githooks/ 配下の *.sh) の pytest を実行する専用ランナー。
# plugins/<plugin>/scripts/ci/run-tests.sh は plugin 専用 (R2) のため混ぜず、
# root 共通フックの回帰検知はこのランナーに分離する。
#
# GIT_* のプロセス単位 unset は不要。
# pre-push フック配下で git が export する GIT_DIR 等は、conftest.py の autouse fixture が剥がす。
# fixture は GIT_ プレフィックスを一括で delenv する。
# rootdir はリポルートに解決され、ini なしで動作する。

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> pytest (.githooks/tests/)"
uvx --python 3.12 --with pytest-xdist --with packaging \
    pytest "$TESTS_DIR" -q --import-mode=importlib -n auto -p no:cacheprovider
