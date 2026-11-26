#!/usr/bin/env bash
# vendor/text-rules が libs/text-rules へのリンクのままで、ミラーの入力に node_modules・dist などが入らないことの静的なテスト。
#   bash plugins/pecot-visual/cli/tests/bootstrap/text-rules-link.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT_SRC="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT_SRC/../.." && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"

# --- リンク ---
# 作業ツリーでは、ステージ済みのリンクも含めて index の値を見る。
entry="$(git -C "$REPO_ROOT" ls-files -s -- plugins/pecot-visual/vendor/text-rules)"
bt_eq "index の mode は 120000（リンク）" 120000 "$(printf '%s\n' "$entry" | awk 'NR == 1 { print $1 }')"
bt_eq "index のエントリは 1 件だけ（実ディレクトリのファイルが入らない）" 1 "$(printf '%s\n' "$entry" | grep -c . || true)"
if [ -L "$PLUGIN_ROOT_SRC/vendor/text-rules" ]; then
  bt_eq "リンク先は ../../../libs/text-rules" ../../../libs/text-rules "$(readlink "$PLUGIN_ROOT_SRC/vendor/text-rules")"
else
  bt_fail "リンク先は ../../../libs/text-rules" "作業ツリーの vendor/text-rules がリンクでない"
fi
bt_eq "リンクは repo 共通のライブラリの実体を指す" "$REPO_ROOT/libs/text-rules" "$(cd "$PLUGIN_ROOT_SRC/vendor/text-rules" && pwd -P)"

# --- ミラーの入力 ---
# shellcheck source=../../../bin/_lib.sh
. "$PLUGIN_ROOT_SRC/bin/_lib.sh"
sources="$(plugin_runtime_src_files "$PLUGIN_ROOT_SRC")"
deps="$(plugin_runtime_deps_files "$PLUGIN_ROOT_SRC")"

bt_eq "src に vendor/text-rules/index.ts がある" 1 "$(printf '%s\n' "$sources" | grep -cx 'vendor/text-rules/index.ts' || true)"
bt_eq "src に vendor/text-rules/package.json がある" 1 "$(printf '%s\n' "$sources" | grep -cx 'vendor/text-rules/package.json' || true)"
for dir in node_modules dist coverage; do
  bt_eq "src に /$dir/ を含む行が無い" 0 "$(printf '%s\n' "$sources" | grep -c "/$dir/" || true)"
done
for name in CHANGELOG.md package-lock.json project.json; do
  bt_eq "src に vendor/text-rules/$name が無い" 0 "$(printf '%s\n' "$sources" | grep -cx "vendor/text-rules/$name" || true)"
done
bt_eq "deps に vendor/text-rules/package.json が無い" 0 "$(printf '%s\n' "$deps" | grep -cx 'vendor/text-rules/package.json' || true)"
bt_eq "deps に他のメンバーの package.json がある（cli）" 1 "$(printf '%s\n' "$deps" | grep -cx 'cli/package.json' || true)"

bt_finish
