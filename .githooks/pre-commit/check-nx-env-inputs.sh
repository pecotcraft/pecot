#!/usr/bin/env bash
# nx の task cache に宣言していない環境変数の読み取りを検出する（#1225）。
#
# Hook stage: pre-push
#
# test_nx_env_inputs.py（約 0.3 秒）だけを実行する。
# githooks の pytest 全体（約 9 秒）から切り離してあるのは、この確認の起動条件が広いためです。
# 起動条件は plugins 配下のソース全般で、起動のたびに全体を実行するのは割に合いません。
# 起動条件は .pre-commit-config.yaml の nx-env-inputs の files です。

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tests"

uvx --python 3.12 pytest "$TESTS_DIR/test_nx_env_inputs.py" -q --import-mode=importlib -p no:cacheprovider
