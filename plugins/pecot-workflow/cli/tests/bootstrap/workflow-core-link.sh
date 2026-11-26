#!/usr/bin/env bash
# libs/workflow-core をプラグインへ載せる仕組みの静的なテスト。pecot-visual の text-rules-link.sh と同じ形。
# プラグインの vendor/workflow-core は、repo 共通のライブラリへのリンクにしている。
# 次の 2 つの退行を捕まえる。
#   リンクがコピーした実ディレクトリに置き換わる。
#   ミラーの入力を出す関数の prune が外れて、node_modules・dist・coverage・テストが入る。
#
#   bash plugins/pecot-workflow/cli/tests/bootstrap/workflow-core-link.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT_SRC="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT_SRC/../.." && pwd)"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   $1"; }
ng() { FAIL=$((FAIL + 1)); echo "FAIL $1"; shift; [ "$#" -eq 0 ] || printf '     %s\n' "$@"; }
assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else ng "$1" "want [$2]" "got  [$3]"; fi; }

# --- リンク ---
# 作業ツリーでは、ステージ済みのリンクも含めて index の値を見る。
entry="$(git -C "$REPO_ROOT" ls-files -s -- plugins/pecot-workflow/vendor/workflow-core)"
assert_eq "index の mode は 120000（リンク）" 120000 "$(printf '%s\n' "$entry" | awk 'NR == 1 { print $1 }')"
assert_eq "index のエントリは 1 件だけ（実ディレクトリのファイルが入らない）" 1 "$(printf '%s\n' "$entry" | grep -c . || true)"
if [ -L "$PLUGIN_ROOT_SRC/vendor/workflow-core" ]; then
  assert_eq "リンク先は ../../../libs/workflow-core" ../../../libs/workflow-core "$(readlink "$PLUGIN_ROOT_SRC/vendor/workflow-core")"
else
  ng "作業ツリーの vendor/workflow-core がリンクでない"
fi
assert_eq "リンクは repo 共通のライブラリの実体を指す" "$REPO_ROOT/libs/workflow-core" "$(cd "$PLUGIN_ROOT_SRC/vendor/workflow-core" && pwd -P)"

# --- ミラーの入力 ---
# shellcheck source=../../../bin/_lib.sh
. "$PLUGIN_ROOT_SRC/bin/_lib.sh"
sources="$(plugin_runtime_src_files "$PLUGIN_ROOT_SRC")"
deps="$(plugin_runtime_deps_files "$PLUGIN_ROOT_SRC")"

for file in src/commands-shared/output.ts package.json tsconfig.json tsconfig.build.json scripts/build.mjs scripts/tsc.mjs; do
  assert_eq "src に vendor/workflow-core/$file がある" 1 "$(printf '%s\n' "$sources" | grep -cx "vendor/workflow-core/$file" || true)"
done
for dir in node_modules dist coverage tests; do
  assert_eq "src に /$dir/ を含む行が無い" 0 "$(printf '%s\n' "$sources" | grep -c "/$dir/" || true)"
done
for name in CHANGELOG.md project.json eslint.config.js vitest.config.ts .gitignore; do
  assert_eq "src に vendor/workflow-core/$name が無い" 0 "$(printf '%s\n' "$sources" | grep -cx "vendor/workflow-core/$name" || true)"
done
assert_eq "deps に vendor/workflow-core/package.json が無い" 0 "$(printf '%s\n' "$deps" | grep -cx 'vendor/workflow-core/package.json' || true)"
assert_eq "deps に他のメンバーの package.json がある（cli）" 1 "$(printf '%s\n' "$deps" | grep -cx 'cli/package.json' || true)"
assert_eq "runtime-workspace.yaml のメンバーに vendor/workflow-core がある" 1 "$(grep -cx '  - vendor/workflow-core' "$PLUGIN_ROOT_SRC/runtime-workspace.yaml" || true)"

echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
