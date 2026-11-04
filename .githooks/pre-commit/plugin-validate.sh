#!/bin/bash
# 3 プラグインとリポジトリルートの 4 対象に `claude plugin validate --strict` を掛ける
# （warning も失敗扱い）。
#
# 対象は git のトップレベル基準で固定し、staged ファイルの引数は使わない。
# 失敗した対象の出力だけを出して非 0 で終える。claude CLI が無い環境では skip せず失敗する。
# 対象のディレクトリが無いときは validate 自体が exit 1 になるため、存在確認は書かない。

set -e

if ! command -v claude >/dev/null 2>&1; then
    echo "plugin-validate: claude CLI not found. Claude Code をインストールして PATH に通してください。" >&2
    exit 1
fi

root=$(git rev-parse --show-toplevel)
cd "$root"

failed=0

for target in plugins/pecot-workflow plugins/pecot-visual plugins/pecot-tools .; do
    if ! output=$(claude plugin validate --strict "$target" 2>&1); then
        echo "plugin-validate: $target の検証に失敗しました" >&2
        echo "$output" >&2
        failed=1
    fi
done

exit "$failed"
