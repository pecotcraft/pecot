#!/usr/bin/env bash
# bin/pecotv の Chromium OS ライブラリ確認の軽量テスト。
# 確認は、印があれば飛ばす。MCP 起動では飛ばす。失敗しても止めない。setup ルートでは止める。
# 実 Chromium・apt・pnpm は使わない。pnpm を stub にし、cli/dist/cli.js を exit code を制御できる stub にする。
# その最小の plugin root を一時ディレクトリに組んで実行する。
# 印は、cli の runtimeStateDirectory (infra/_shared/dependency-root.ts) と同じ `${データ置き場}/runtime` に置く。
# cli へは PECOTV_RUNTIME_DIR で渡り、その親が置き場になる。
#
#   bash plugins/pecot-visual/cli/tests/bootstrap/host-deps-marker.sh
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  echo "skip: host-deps の確認は Linux のみ"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=stub-root.sh
. "$SCRIPT_DIR/stub-root.sh"
stub_root_init host-deps-marker

# ミラーを 1 度作って完成させる（以降の起動は準備を飛ばし、確認の分岐だけを見る）。
stub_run -- mcp
[ "$RC" = 0 ] || { echo "FAIL ミラーの準備: exit=$RC"; show_err; exit 1; }

STAMP="$DATA/runtime/.pecotv-chromium-host-deps"

# run_case <名前> <印の内容|-> <STUB_RC> <期待 exit> <期待 host-deps 呼び出し回数> [VAR=値...] -- [pecotv 引数...]
run_case() {
  local name="$1" stamp="$2" stub_rc="$3" want_rc="$4" want_calls="$5"
  shift 5
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  rm -f "$STAMP"
  if [ "$stamp" != "-" ]; then printf '%s\n' "$stamp" > "$STAMP"; fi
  stub_run STUB_RC="$stub_rc" "${envs[@]+"${envs[@]}"}" "$@"
  local calls
  calls="$(grep -c '^host-deps$' "$CALLS" || true)"
  if [ "$RC" = "$want_rc" ] && [ "$calls" = "$want_calls" ]; then
    ok "$name"
  else
    ng "$name" "exit=$RC (want $want_rc) host-deps calls=$calls (want $want_calls)"
    show_err
  fi
}

NOW="$(date +%s)"
OLD=$((NOW - 90000))

run_case "印なし: 確認する (成功)" - 0 0 1 -- --help
run_case "ok の印 (現リビジョン): 飛ばす" "$REV ok $OLD" 0 0 0 -- --help
run_case "ok の印でもリビジョン違い: 確認する" "1100 ok $NOW" 0 0 1 -- --help
run_case "失敗の印 (24h 以内): 飛ばす" "$REV missing $NOW" 2 0 0 -- --help
run_case "launch-failed の印 (24h 以内): 飛ばす" "$REV launch-failed $NOW" 2 0 0 -- --help
run_case "失敗の印 (24h 超): 確認する" "$REV missing $OLD" 0 0 1 -- --help
run_case "失敗の印でもリビジョン違い: 確認する" "1100 missing $NOW" 0 0 1 -- --help
run_case "形式不正の印: 確認する" "garbage" 0 0 1 -- --help
run_case "記録時刻が未来の失敗の印: 確認する" "$REV missing $((NOW + 100000))" 0 0 1 -- --help
run_case "MCP 起動: 印なしでも確認しない" - 2 0 0 -- mcp --help
run_case "確認に失敗しても通常起動は止めない" - 2 0 1 -- --help
run_case "PLAYWRIGHT_BROWSERS_PATH=0 でも host-deps は確認する" - 0 0 1 PLAYWRIGHT_BROWSERS_PATH=0 -- --help
run_case "setup ルート: 入れられなければ exit 2" - 2 2 1 PECOTV_REQUIRE_HOST_DEPS=1 -- --help
run_case "setup ルート: 失敗の印 (24h 以内) でも確かめる" "$REV missing $NOW" 2 2 1 PECOTV_REQUIRE_HOST_DEPS=1 -- --help
run_case "setup ルート: ok の印なら飛ばす" "$REV ok $NOW" 2 0 0 PECOTV_REQUIRE_HOST_DEPS=1 -- --help
run_case "setup ルート: 成功すれば exit 0" - 0 0 1 PECOTV_REQUIRE_HOST_DEPS=1 -- --help

# 印の置き場: ミラーの node_modules（ハードリンクで別世代と共有する）の中には置かない。
assert_eq "印はミラーの node_modules の中に置かない" no \
  "$(find "$DATA/runtime" -path '*/node_modules/.pecotv-chromium-host-deps' | head -n 1 | grep -q . && echo yes || echo no)"

echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
