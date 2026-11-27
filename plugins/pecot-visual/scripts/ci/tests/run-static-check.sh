#!/usr/bin/env bash
# check-pm-guard-scripts.bats が `bash run-static-check.sh <guard> <fixture>` で呼び、fixture に静的確認だけを動かす。
# `|| exit 1` は、本番の `run_static_check || overall=1` と同じく関数の中の set -e を外す。
# shellcheck source=../check-pm-guard.sh
. "$1"
# shellcheck disable=SC2034  # run_static_check が読む
REPO_ROOT="$2"
# shellcheck disable=SC2034  # run_static_check が読む
PECOTV_PLUGIN_ROOT="$2/plugins/pecot-visual"
run_static_check || exit 1
