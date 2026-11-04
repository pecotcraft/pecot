#!/usr/bin/env bash
# libs/text-rules をプラグインへ載せる仕組みの静的なテスト。
# text-rules は repo 共通のライブラリで、プラグインの libs/text-rules はそこへのリンクにしている。
# 次の 2 つの退行を捕まえる。
#   リンクがコピーした実ディレクトリに置き換わる。
#   ミラーの入力を出す関数の prune が外れて、node_modules・dist・coverage が入る。
#
#   bash plugins/pecot-visual/cli/tests/bootstrap/text-rules-link.sh
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
entry="$(git -C "$REPO_ROOT" ls-files -s -- plugins/pecot-visual/libs/text-rules)"
assert_eq "index の mode は 120000（リンク）" 120000 "$(printf '%s\n' "$entry" | awk 'NR == 1 { print $1 }')"
assert_eq "index のエントリは 1 件だけ（実ディレクトリのファイルが入らない）" 1 "$(printf '%s\n' "$entry" | grep -c . || true)"
if [ -L "$PLUGIN_ROOT_SRC/libs/text-rules" ]; then
  assert_eq "リンク先は ../../../libs/text-rules" ../../../libs/text-rules "$(readlink "$PLUGIN_ROOT_SRC/libs/text-rules")"
else
  ng "作業ツリーの libs/text-rules がリンクでない"
fi
assert_eq "リンクは repo 共通のライブラリの実体を指す" "$REPO_ROOT/libs/text-rules" "$(cd "$PLUGIN_ROOT_SRC/libs/text-rules" && pwd -P)"

# --- ミラーの入力 ---
# shellcheck source=../../../bin/_lib.sh
. "$PLUGIN_ROOT_SRC/bin/_lib.sh"
sources="$(plugin_runtime_src_files "$PLUGIN_ROOT_SRC")"
deps="$(plugin_runtime_deps_files "$PLUGIN_ROOT_SRC")"

assert_eq "src に libs/text-rules/index.ts がある" 1 "$(printf '%s\n' "$sources" | grep -cx 'libs/text-rules/index.ts' || true)"
assert_eq "src に libs/text-rules/package.json がある" 1 "$(printf '%s\n' "$sources" | grep -cx 'libs/text-rules/package.json' || true)"
for dir in node_modules dist coverage; do
  assert_eq "src に /$dir/ を含む行が無い" 0 "$(printf '%s\n' "$sources" | grep -c "/$dir/" || true)"
done
for name in CHANGELOG.md package-lock.json project.json; do
  assert_eq "src に libs/text-rules/$name が無い" 0 "$(printf '%s\n' "$sources" | grep -cx "libs/text-rules/$name" || true)"
done
assert_eq "deps に libs/text-rules/package.json が無い" 0 "$(printf '%s\n' "$deps" | grep -cx 'libs/text-rules/package.json' || true)"
assert_eq "deps に他のメンバーの package.json がある（cli）" 1 "$(printf '%s\n' "$deps" | grep -cx 'cli/package.json' || true)"

echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
