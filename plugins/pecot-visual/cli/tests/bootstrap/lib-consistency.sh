#!/usr/bin/env bash
# 2 プラグインの bin/_lib.sh に写したブロック（data-dir・runtime-mirror）と 5 本の tsc.mjs が逐語一致することの確認（#1230）。
# 食い違ったら、data-dir は pecot-workflow、runtime-mirror と tsc.mjs は pecot-visual の側を基準として写し直す。
#   bash plugins/pecot-visual/cli/tests/bootstrap/lib-consistency.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGINS="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
WORKFLOW="$PLUGINS/pecot-workflow/bin/_lib.sh"
VISUAL="$PLUGINS/pecot-visual/bin/_lib.sh"

# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$PLUGINS/../.githooks/scripts/test_report/bash-test.sh"

# block <file> <開始マーカー（行頭一致の正規表現）> <終了マーカー>: マーカー行を含めて出す
block() { sed -n "/^$2\$/,/^$3\$/p" "$1"; }

compare() {
  local name="$1" start="$2" end="$3" reference="$4"
  shift 4
  local expected file actual
  expected="$(block "$reference" "$start" "$end")"
  local relative reference_relative="${reference#"$PLUGINS"/}"
  if [ -z "$expected" ]; then bt_fail "$name: 基準のブロックがある" "見つからない: $reference_relative"; return; fi
  for file in "$@"; do
    actual="$(block "$file" "$start" "$end")"
    relative="${file#"$PLUGINS"/}"
    if [ "$actual" = "$expected" ]; then
      bt_pass "$name: $relative は基準と逐語一致"
    else
      local difference
      difference="$(diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") | head -n 20 || true)"
      bt_fail "$name: $relative は基準と逐語一致" "基準 $reference_relative と食い違う: $difference"
    fi
  done
}

compare "data-dir" '# --- data-dir: 2 本で逐語一致 ---' '# --- end data-dir ---' "$WORKFLOW" "$VISUAL"
compare "runtime-mirror" '# --- runtime-mirror: pecot-workflow \/ pecot-visual で逐語一致 ---' '# --- end runtime-mirror ---' "$VISUAL" "$WORKFLOW"

# ブロックの数（マーカーの重複で片方が二重に入っていないこと）
DATA_DIR_MARKER='# --- data-dir: 2 本で逐語一致 ---'
for file in "$WORKFLOW" "$VISUAL"; do
  count="$(grep -c -x -F -- "$DATA_DIR_MARKER" "$file" || true)"
  relative="${file#"$PLUGINS"/}"
  bt_eq "data-dir: $relative にブロックが 1 つ" 1 "$count"
done
for file in "$WORKFLOW" "$VISUAL"; do
  count="$(grep -c '^# --- runtime-mirror: ' "$file" || true)"
  relative="${file#"$PLUGINS"/}"
  bt_eq "runtime-mirror: $relative にブロックが 1 つ" 1 "$count"
done

# typescript7 の tsc を探す scripts/tsc.mjs は、配布の都合でプラグインごと・ライブラリごとに持つ。5 本の逐語一致を押さえる。
REPO="$(cd "$PLUGINS/.." && pwd)"
TSC_REFERENCE="$PLUGINS/pecot-visual/cli/scripts/tsc.mjs"
for file in \
  "$PLUGINS/pecot-visual/assets/slidev/scripts/tsc.mjs" \
  "$PLUGINS/pecot-tools/cli/scripts/tsc.mjs" \
  "$PLUGINS/pecot-workflow/cli/scripts/tsc.mjs" \
  "$REPO/libs/text-rules/scripts/tsc.mjs"; do
  relative="${file#"$REPO"/}"
  if cmp -s "$TSC_REFERENCE" "$file"; then bt_pass "tsc.mjs: $relative は pecot-visual/cli と逐語一致"; else bt_fail "tsc.mjs: $relative は pecot-visual/cli と逐語一致" "pecot-visual/cli/scripts/tsc.mjs と食い違う"; fi
done

bt_finish
