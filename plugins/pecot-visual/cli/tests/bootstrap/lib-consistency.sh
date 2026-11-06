#!/usr/bin/env bash
# 3 プラグインの bin/_lib.sh で逐語一致させるブロックの一致確認（#1230）。
#
# プラグインは導入先へ単体でコピーされるため、他プラグインのファイルは source できない。そこで同じ処理を
# 複数の _lib.sh に写す。写しが片側だけ直されると、解決順や既定の場所がプラグインごとに食い違うので、
# マーカーで囲んだブロックの一致をここで押さえる。
#   data-dir        pecot-workflow / pecot-visual / pecot-tools の 3 本。データ置き場の解決と作成。
#   runtime-mirror  pecot-visual / pecot-tools の 2 本。実行用ミラーの準備。
#   tsc.mjs         pecot-visual cli を基準に 5 本。typescript7 の tsc の探索。
# 食い違ったら、data-dir は pecot-workflow、runtime-mirror は pecot-visual の側を基準として写し直す。
#
#   bash plugins/pecot-visual/cli/tests/bootstrap/lib-consistency.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGINS="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
WORKFLOW="$PLUGINS/pecot-workflow/bin/_lib.sh"
VISUAL="$PLUGINS/pecot-visual/bin/_lib.sh"
TOOLS="$PLUGINS/pecot-tools/bin/_lib.sh"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   $1"; }
ng() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }

# block <file> <開始マーカー（行頭一致の正規表現）> <終了マーカー>: マーカー行を含めて出す
block() { sed -n "/^$2\$/,/^$3\$/p" "$1"; }

compare() {
  local name="$1" start="$2" end="$3" reference="$4"
  shift 4
  local expected file actual
  expected="$(block "$reference" "$start" "$end")"
  if [ -z "$expected" ]; then ng "$name: 基準のブロックが見つからない: $reference"; return; fi
  local relative reference_relative="${reference#"$PLUGINS"/}"
  for file in "$@"; do
    actual="$(block "$file" "$start" "$end")"
    relative="${file#"$PLUGINS"/}"
    if [ "$actual" = "$expected" ]; then
      ok "$name: $relative は基準と逐語一致"
    else
      ng "$name: $relative が基準と食い違う。基準は $reference_relative"
      diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") | head -n 20 | sed 's/^/     /' || true
    fi
  done
}

compare "data-dir" '# --- data-dir: 3 本で逐語一致 ---' '# --- end data-dir ---' "$WORKFLOW" "$VISUAL" "$TOOLS"
compare "runtime-mirror" '# --- runtime-mirror: pecot-visual \/ pecot-tools で逐語一致 ---' '# --- end runtime-mirror ---' "$VISUAL" "$TOOLS"

# ブロックの数（マーカーの重複で片方が二重に入っていないこと）
DATA_DIR_MARKER='# --- data-dir: 3 本で逐語一致 ---'
for file in "$WORKFLOW" "$VISUAL" "$TOOLS"; do
  count="$(grep -c -x -F -- "$DATA_DIR_MARKER" "$file" || true)"
  relative="${file#"$PLUGINS"/}"
  if [ "$count" = 1 ]; then ok "data-dir: $relative にブロックが 1 つ"; else ng "data-dir: $relative のブロックが $count 個"; fi
done
for file in "$VISUAL" "$TOOLS"; do
  count="$(grep -c '^# --- runtime-mirror: ' "$file" || true)"
  relative="${file#"$PLUGINS"/}"
  if [ "$count" = 1 ]; then ok "runtime-mirror: $relative にブロックが 1 つ"; else ng "runtime-mirror: $relative のブロックが $count 個"; fi
done

# typescript7 の tsc を探す scripts/tsc.mjs は、配布の都合でプラグインごと・ライブラリごとに持つ。5 本の逐語一致を押さえる。
REPO="$(cd "$PLUGINS/.." && pwd)"
TSC_REFERENCE="$PLUGINS/pecot-visual/cli/scripts/tsc.mjs"
for file in \
  "$PLUGINS/pecot-visual/assets/slidev/scripts/tsc.mjs" \
  "$PLUGINS/pecot-tools/cli/scripts/tsc.mjs" \
  "$PLUGINS/pecot-workflow/cli-node/scripts/tsc.mjs" \
  "$REPO/libs/text-rules/scripts/tsc.mjs"; do
  relative="${file#"$REPO"/}"
  if cmp -s "$TSC_REFERENCE" "$file"; then ok "tsc.mjs: $relative は pecot-visual/cli と逐語一致"; else ng "tsc.mjs: $relative が pecot-visual/cli/scripts/tsc.mjs と食い違う"; fi
done

echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
