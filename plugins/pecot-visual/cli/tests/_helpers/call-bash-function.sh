#!/usr/bin/env bash
# テストから bash の関数を呼ぶ。$1 のライブラリを読み、残りの引数を 1 つのコマンドとして実行する。
# shellcheck source=/dev/null
. "$1" || exit
shift
"$@"
