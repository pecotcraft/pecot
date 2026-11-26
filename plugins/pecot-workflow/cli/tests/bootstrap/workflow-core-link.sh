#!/usr/bin/env bash
# vendor/workflow-core が libs/workflow-core へのリンクのままで、ミラーの入力に node_modules・dist などが入らないことの静的なテスト。
#   bash plugins/pecot-workflow/cli/tests/bootstrap/workflow-core-link.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT_SRC="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT_SRC/../.." && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"

# --- リンク ---
# 作業ツリーでは、ステージ済みのリンクも含めて index の値を見る。
entry="$(git -C "$REPO_ROOT" ls-files -s -- plugins/pecot-workflow/vendor/workflow-core)"
bt_eq "index の mode は 120000（リンク）" 120000 "$(printf '%s\n' "$entry" | awk 'NR == 1 { print $1 }')"
bt_eq "index のエントリは 1 件だけ（実ディレクトリのファイルが入らない）" 1 "$(printf '%s\n' "$entry" | grep -c . || true)"
if [ -L "$PLUGIN_ROOT_SRC/vendor/workflow-core" ]; then
  bt_eq "リンク先は ../../../libs/workflow-core" ../../../libs/workflow-core "$(readlink "$PLUGIN_ROOT_SRC/vendor/workflow-core")"
else
  bt_fail "リンク先は ../../../libs/workflow-core" "作業ツリーの vendor/workflow-core がリンクでない"
fi
bt_eq "リンクは repo 共通のライブラリの実体を指す" "$REPO_ROOT/libs/workflow-core" "$(cd "$PLUGIN_ROOT_SRC/vendor/workflow-core" && pwd -P)"

# --- ミラーの入力 ---
# shellcheck source=../../../bin/_lib.sh
. "$PLUGIN_ROOT_SRC/bin/_lib.sh"
sources="$(plugin_runtime_src_files "$PLUGIN_ROOT_SRC")"
deps="$(plugin_runtime_deps_files "$PLUGIN_ROOT_SRC")"

for file in src/commands-shared/output.ts package.json tsconfig.json tsconfig.build.json scripts/build.mjs scripts/tsc.mjs; do
  bt_eq "src に vendor/workflow-core/$file がある" 1 "$(printf '%s\n' "$sources" | grep -cx "vendor/workflow-core/$file" || true)"
done
for dir in node_modules dist coverage tests; do
  bt_eq "src に /$dir/ を含む行が無い" 0 "$(printf '%s\n' "$sources" | grep -c "/$dir/" || true)"
done
for name in CHANGELOG.md project.json eslint.config.js vitest.config.ts .gitignore; do
  bt_eq "src に vendor/workflow-core/$name が無い" 0 "$(printf '%s\n' "$sources" | grep -cx "vendor/workflow-core/$name" || true)"
done
bt_eq "deps に vendor/workflow-core/package.json が無い" 0 "$(printf '%s\n' "$deps" | grep -cx 'vendor/workflow-core/package.json' || true)"
bt_eq "deps に他のメンバーの package.json がある（cli）" 1 "$(printf '%s\n' "$deps" | grep -cx 'cli/package.json' || true)"
bt_eq "runtime-workspace.yaml のメンバーに vendor/workflow-core がある" 1 "$(grep -cx '  - vendor/workflow-core' "$PLUGIN_ROOT_SRC/runtime-workspace.yaml" || true)"

bt_finish
