#!/usr/bin/env bash
set -euo pipefail

# root 共通フック (.githooks/ 配下) の pytest のランナー。GIT_* は conftest.py の autouse fixture が剥がす。
# 引数のテストのファイルだけを動かす。引数が無ければ tests/ の全部を動かす。
# test_check_text.py が使う libs/text-rules/dist は、test-checks の dependsOn の text-rules:build が用意する。

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 外の nx が渡す色の指定。引き継ぐと、出力を比べるテストが落ちる。
unset FORCE_COLOR

targets=("$@")
if [ "${#targets[@]}" -eq 0 ]; then
    targets=("$TESTS_DIR")
fi

echo "==> pytest (.githooks/tests/)"
uvx --python 3.12 --with pytest-xdist==3.8.0 --with packaging==26.3 --with pyyaml==6.0.3 \
    pytest==9.2.0 "${targets[@]}" -q --import-mode=importlib -n auto -p no:cacheprovider
