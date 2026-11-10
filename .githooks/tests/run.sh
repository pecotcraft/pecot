#!/usr/bin/env bash
set -euo pipefail

# root 共通フック (.githooks/ 配下) の pytest のランナー。引数のファイルだけ、無ければ tests/ 全部を動かす。
# 固定した版は dependabot が追わない。上げるときは uvx の版をここで直し、tests を全量で通す。

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 外の nx の色指定は、出力を比べるテストを落とすので外す。
unset FORCE_COLOR

targets=("$@")
if [ "${#targets[@]}" -eq 0 ]; then
    targets=("$TESTS_DIR")
fi

echo "==> pytest ${targets[*]}"
uvx --python 3.12 --with pytest-xdist==3.8.0 --with packaging==26.3 --with pyyaml==6.0.3 \
    pytest==9.2.0 "${targets[@]}" -q --import-mode=importlib -n auto -p no:cacheprovider
