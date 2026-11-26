#!/usr/bin/env bash
# bin/pecotv の self-bootstrap を、一時 worktree と隔離した HOME で端から端まで確かめる手動の CUJ（レーンに入らない）。
# 実 DL は CUJ 1 の chromium だけで、PECOTV_BOOTSTRAP_TEST_HEAVY=1 のときは CUJ 13c も取る。CUJ 6b / 6c はネットに依存する。
set -euo pipefail

# PLAYWRIGHT_BROWSERS_PATH があると、chromium の置き場が隔離した HOME の外へ逃げる。
unset PLAYWRIGHT_BROWSERS_PATH PLAYWRIGHT_DOWNLOAD_HOST

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT_SRC="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT_SRC/../.." && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"

# Issue に紐づかない scratch なので、.pecot/work/ でなく .pecot/tmp/ に置く。
WORK_DIR="$REPO_ROOT/.pecot/tmp/bootstrap-test"
mkdir -p "$WORK_DIR"
TMP_WORKTREE="$WORK_DIR/wt-$$-$(date +%s)"
TMP_BRANCH="bootstrap-test/$$-$(date +%s)"

# 隔離した HOME。ISO_HOME_C は chromium のキャッシュを持たない状態を保つ別の HOME。
ISO_HOME="$WORK_DIR/iso-home-$$-$(date +%s)"
ISO_HOME_C="$WORK_DIR/iso-home-c-$$-$(date +%s)"
# プラグインのデータ置き場。DATA_DIR_11B はミラーを持たない状態を保つ。
DATA_DIR="$WORK_DIR/data-$$-$(date +%s)"
DATA_DIR_11B="$WORK_DIR/data-11b-$$-$(date +%s)"

cleanup() {
  local exit_code=$?
  if [ -d "$TMP_WORKTREE" ]; then
    git -C "$REPO_ROOT" worktree remove --force "$TMP_WORKTREE" >/dev/null 2>&1 || true
  fi
  git -C "$REPO_ROOT" branch -D "$TMP_BRANCH" >/dev/null 2>&1 || true
  rm -rf "$ISO_HOME" "$ISO_HOME_C" "$DATA_DIR" "$DATA_DIR_11B" >/dev/null 2>&1 || true
  # 出力は失敗の調査のため、成功したときだけ消す。stub-root.sh などの mktemp の領域には触れない。
  if [ "$exit_code" -eq 0 ]; then
    rm -rf "$WORK_DIR"/cuj* "$WORK_DIR"/iso-bin-node* "$WORK_DIR/minimal-slidev-9b" "$WORK_DIR/theme-9b" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT

# 前提が崩れたら止める。bt_finish まで届かないので、broken として出る。
die() {
  echo "[bootstrap-test] $*" >&2
  exit 1
}

mkdir -p "$ISO_HOME/.cache" "$ISO_HOME/.local/share"

# 親シェルの置き場は使わない。XDG_DATA_HOME は pnpm の store の置き場まで動くので付け替えない。
unset PECOTV_RUNTIME_DIR PECOTV_DEPENDENCY_ROOT PECOTV_BOOTSTRAP_SKIP PECOTV_BOOTSTRAP_FORCE PLUGIN_DATA
mkdir -p "$DATA_DIR"
export CLAUDE_PLUGIN_DATA="$DATA_DIR"

echo "[bootstrap-test] preparing temp worktree at $TMP_WORKTREE"
git -C "$REPO_ROOT" worktree add -b "$TMP_BRANCH" "$TMP_WORKTREE" HEAD >/dev/null

# worktree は HEAD から作られるので、未 commit の変更を rsync で写す。node_modules・cli/dist などは写さない。
echo "[bootstrap-test] syncing working-tree changes (plugins/pecot-visual)"
rsync -a --delete \
  --exclude '/node_modules' \
  --exclude '/cli/dist' \
  --exclude '/cli/coverage' \
  --exclude '/cli/node_modules' \
  --exclude '/.pnpm-store' \
  "$PLUGIN_ROOT_SRC/" "$TMP_WORKTREE/plugins/pecot-visual/"

PLUGIN_ROOT="$TMP_WORKTREE/plugins/pecot-visual"
BIN_PECOTV="$PLUGIN_ROOT/bin/pecotv"

# run_pecotv <stdout> <stderr> [env の引数 ...] -- <引数...>: bin/pecotv を動かし、終了コードを code に残す。
code=0
run_pecotv() {
  local out="$1" err="$2" envs=()
  shift 2
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    envs+=("$1")
    shift
  done
  shift
  code=0
  env "${envs[@]}" "$BIN_PECOTV" "$@" <"/dev/null" >"$out" 2>"$err" || code=$?
}

# initialize を送り、応答を待って stdin を閉じる。終了コードを code に残す。
MCP_INIT_REQUEST='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"bootstrap-test","version":"0.0.0"}}}'
# mcp_initialize <stdout> <stderr> <待つ秒> [env の引数 ...]
mcp_initialize() {
  local out="$1" err="$2" seconds="$3" fifo="$1.stdin.fifo" pid deadline
  shift 3
  rm -f "$fifo" "$out" "$err"
  mkfifo "$fifo"
  env "$@" "$BIN_PECOTV" mcp <"$fifo" >"$out" 2>"$err" &
  pid=$!
  # 書き手を開いたままにし、準備が済む前に EOF が届かないようにする。
  exec 7>"$fifo"
  printf '%s\n' "$MCP_INIT_REQUEST" >&7
  deadline=$(($(date +%s) + seconds))
  while [ ! -s "$out" ] && [ "$(date +%s)" -le "$deadline" ]; do
    sleep 0.5
  done
  # 応答の 1 行を書き切ってから EOF を送る。
  sleep 0.5
  exec 7>&-
  code=0
  wait "$pid" || code=$?
  rm -f "$fifo"
}

# expect_code <題> <期待> <stderr>: 終了コード（code）を比べる。落ちたら stderr の末尾を理由に添える。
expect_code() {
  if [ "$code" = "$2" ]; then
    bt_pass "$1"
  else
    local tail_err
    tail_err="$(tail -n 40 "$3" 2> /dev/null)"
    bt_fail "$1" "期待 $2 / 実際 $code: $tail_err"
  fi
}

# expect_failure <題> <stderr>: 終了コード（code）が 0 以外。
expect_failure() {
  if [ "$code" -ne 0 ]; then
    bt_pass "$1"
  else
    local tail_err
    tail_err="$(tail -n 40 "$2" 2> /dev/null)"
    bt_fail "$1" "0 で終わった: $tail_err"
  fi
}

# expect_grep <題> <正規表現> <ファイル...>
expect_grep() {
  local title="$1" pattern="$2" content
  shift 2
  if grep -qE -- "$pattern" "$@" 2> /dev/null; then
    bt_pass "$title"
  else
    content="$(head -n 40 "$@" 2>&1)"
    bt_fail "$title" "「$pattern」が無い: $content"
  fi
}

# expect_no_grep <題> <正規表現> <ファイル>
expect_no_grep() {
  local matched
  if matched="$(grep -E -- "$2" "$3" 2> /dev/null)"; then
    bt_fail "$1" "「$2」がある: $matched"
  else
    bt_pass "$1"
  fi
}

# expect_node <題> <スクリプト> <引数...>: node -e のスクリプトが 0 で終わる。落ちたら標準エラーを理由にする。
expect_node() {
  local title="$1" script="$2" reason
  shift 2
  if reason="$(node -e "$script" "$@" 2>&1 > /dev/null)"; then
    bt_pass "$title"
  else
    bt_fail "$title" "$reason"
  fi
}

# stdout の全行が JSON-RPC で、initialize の結果を含む。
JSON_RPC_INITIALIZED='
  const fs = require("fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter((l) => l !== "");
  if (lines.length === 0) { console.error("stdout has no lines"); process.exit(1); }
  let sawInitializeResult = false;
  for (const line of lines) {
    let message;
    try { message = JSON.parse(line); }
    catch { console.error("non-JSON line on stdout: " + line); process.exit(1); }
    if (message.jsonrpc !== "2.0") { console.error("line lacks jsonrpc field: " + line); process.exit(1); }
    if (message.id === 1 && message.result && message.result.serverInfo) sawInitializeResult = true;
  }
  if (!sawInitializeResult) { console.error("no initialize result on stdout"); process.exit(1); }
'

# MCP のツールの結果が成功（isError が無い）。
TOOL_SUCCEEDED='
  const fs = require("fs");
  const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result;
  if (!result || result.isError !== undefined) {
    console.error("expected success, got: " + JSON.stringify(result && result.structuredContent)); process.exit(1);
  }
'

# yes / no を返す小さな確かめ。
chromium_cache() { if compgen -G "$1/chromium-*" > /dev/null; then echo yes; else echo no; fi; }
exists() { if [ -e "$1" ]; then echo yes; else echo no; fi; }
nonempty() { if [ -s "$1" ]; then echo yes; else echo no; fi; }
current_mirror() { readlink -f "$DATA_DIR/runtime/current" || true; }
inode() { stat -c %i "$1" 2> /dev/null || echo "無い: $1"; }

# nvm では node・pnpm・corepack が同じ dir にあるので、要るものだけを張った bin を PATH に置く。
ISO_BIN_NODE_ONLY="$WORK_DIR/iso-bin-node"
ISO_BIN_NODE_COREPACK="$WORK_DIR/iso-bin-node-corepack"
# Node.js 25 以降の、corepack を同梱しない環境を再現する。
ISO_BIN_NODE_NPX="$WORK_DIR/iso-bin-node-npx"
rm -rf "$ISO_BIN_NODE_ONLY" "$ISO_BIN_NODE_COREPACK" "$ISO_BIN_NODE_NPX"
mkdir -p "$ISO_BIN_NODE_ONLY" "$ISO_BIN_NODE_COREPACK" "$ISO_BIN_NODE_NPX"
ln -s "$(command -v node)" "$ISO_BIN_NODE_ONLY/node"
ln -s "$(command -v node)" "$ISO_BIN_NODE_COREPACK/node"
ln -s "$(command -v node)" "$ISO_BIN_NODE_NPX/node"
COREPACK_PATH="$(command -v corepack 2>/dev/null || true)"
if [ -n "$COREPACK_PATH" ]; then
  ln -s "$COREPACK_PATH" "$ISO_BIN_NODE_COREPACK/corepack"
fi
NPM_PATH="$(command -v npm 2>/dev/null || true)"
NPX_PATH="$(command -v npx 2>/dev/null || true)"
if [ -n "$NPM_PATH" ] && [ -n "$NPX_PATH" ]; then
  ln -s "$NPM_PATH" "$ISO_BIN_NODE_NPX/npm"
  ln -s "$NPX_PATH" "$ISO_BIN_NODE_NPX/npx"
fi

echo "[bootstrap-test] HOME isolation self-check"
[ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] || die "PLAYWRIGHT_BROWSERS_PATH must not be set"
[ -z "${PLAYWRIGHT_DOWNLOAD_HOST:-}" ] || die "PLAYWRIGHT_DOWNLOAD_HOST must not be set"
[ "$(chromium_cache "$ISO_HOME/.cache/ms-playwright")" = no ] || die "ISO_HOME unexpectedly has chromium cache"
# 本物の HOME の状態は記録だけ（どちらでも動く）。
if [ "$(chromium_cache "$HOME/.cache/ms-playwright")" = yes ]; then
  echo "[bootstrap-test] isolation diverges from real HOME (real HAS chromium-*, ISO_HOME does NOT)"
else
  echo "[bootstrap-test] note: real HOME also lacks chromium-* (isolation still applied, divergence not observable here)"
fi

echo "[bootstrap-test] CUJ 1: clean clone bootstrap"
STDERR1="$WORK_DIR/cuj1.stderr"
rm -rf "$DATA_DIR/runtime"
run_pecotv /dev/null "$STDERR1" HOME="$ISO_HOME" -- --help
expect_code "CUJ 1: 0 で終わる" 0 "$STDERR1"
expect_grep "CUJ 1: stderr に準備のログが出る" '\[pecotv runtime\]' "$STDERR1"
expect_grep "CUJ 1: 依存を入れる" '^pecotv: installing dependencies$' "$STDERR1"
expect_grep "CUJ 1: ready の行が出る" 'ready \([0-9]+s\)' "$STDERR1"
expect_grep "CUJ 1: 隔離した HOME で chromium の取得を始める" 'running playwright install chromium' "$STDERR1"
bt_eq "CUJ 1: 隔離した HOME に chromium のキャッシュができる" yes "$(chromium_cache "$ISO_HOME/.cache/ms-playwright")"

# 置き場を渡さない起動（Bash から呼ぶ・単体配布）は、ISO_HOME の ~/.local/share/pecot/pecot-visual を使う。
echo "[bootstrap-test] CUJ 1b: default data directory when no variable is given"
STDERR1B="$WORK_DIR/cuj1b.stderr"
DEFAULT_DATA="$ISO_HOME/.local/share/pecot/pecot-visual"
run_pecotv /dev/null "$STDERR1B" -u CLAUDE_PLUGIN_DATA -u PLUGIN_DATA XDG_DATA_HOME= HOME="$ISO_HOME" -- --help
expect_code "CUJ 1b: 0 で終わる" 0 "$STDERR1B"
expect_grep "CUJ 1b: 依存を入れる" '^pecotv: installing dependencies$' "$STDERR1B"
bt_eq "CUJ 1b: 既定の置き場にミラーを build する" yes "$(exists "$DEFAULT_DATA/runtime/current/cli/dist/cli.js")"

# .mcp.json からの起動では、node より前に bash が stdout へ何か書くと、クライアントは JSON-RPC を読めない。
echo "[bootstrap-test] CUJ 10: cold pecotv mcp keeps stdout JSON-RPC only"
STDERR10="$WORK_DIR/cuj10.stderr"
STDOUT10="$WORK_DIR/cuj10.stdout"
rm -rf "$DATA_DIR/runtime"
mcp_initialize "$STDOUT10" "$STDERR10" 300 HOME="$ISO_HOME"
expect_code "CUJ 10: 0 で終わる" 0 "$STDERR10"
expect_grep "CUJ 10: 準備のログは stderr に出る" '\[pecotv runtime\]' "$STDERR10"
expect_grep "CUJ 10: 依存を入れる（cold）" '^pecotv: installing dependencies$' "$STDERR10"
expect_no_grep "CUJ 10: stdout に pnpm の出力が出ない" 'Scope: all|Progress|postinstall|Downloading' "$STDOUT10"
expect_node "CUJ 10: stdout は JSON-RPC だけで、initialize に答える" "$JSON_RPC_INITIALIZED" "$STDOUT10"

# PECOTV_BOOTSTRAP_SKIP=1 は本体ツリーの成果物を直接動かす。本体に cli/dist が無ければ何も出さずに止まる。
echo "[bootstrap-test] CUJ 11: SKIP without the tree's cli/dist fails fast without partial output"
STDERR11="$WORK_DIR/cuj11.stderr"
STDOUT11="$WORK_DIR/cuj11.stdout"
run_pecotv "$STDOUT11" "$STDERR11" PECOTV_BOOTSTRAP_SKIP=1 HOME="$ISO_HOME" -- mcp
expect_failure "CUJ 11: 0 以外で終わる" "$STDERR11"
bt_eq "CUJ 11: stdout に何も書かない" "" "$(head -n 20 "$STDOUT11")"
expect_grep "CUJ 11: stderr で build を促す" 'build first' "$STDERR11"
bt_eq "CUJ 11: プラグインルートに node_modules・cli/dist を作らない" no \
  "$([ -e "$PLUGIN_ROOT/cli/dist" ] || [ -e "$PLUGIN_ROOT/node_modules" ] && echo yes || echo no)"

# 利用者に起きる準備の不能（pnpm / corepack が無く、ミラーも無い）でも、stdout を汚さずに止まる。
echo "[bootstrap-test] CUJ 11b: fail fast without partial output when pnpm/corepack are absent"
STDERR11B="$WORK_DIR/cuj11b.stderr"
STDOUT11B="$WORK_DIR/cuj11b.stdout"
mkdir -p "$DATA_DIR_11B"
run_pecotv "$STDOUT11B" "$STDERR11B" \
  -i CLAUDE_PLUGIN_DATA="$DATA_DIR_11B" HOME="$ISO_HOME" PATH="$ISO_BIN_NODE_ONLY:/usr/bin:/bin" -- mcp
expect_failure "CUJ 11b: 0 以外で終わる" "$STDERR11B"
bt_eq "CUJ 11b: stdout に何も書かない" "" "$(head -n 20 "$STDOUT11B")"
expect_grep "CUJ 11b: stderr に pnpm / corepack / npx が無いと出る" 'pnpm / corepack / npx not found' "$STDERR11B"

echo "[bootstrap-test] CUJ 2: skip on second invocation"
STDERR2="$WORK_DIR/cuj2.stderr"
TIMEFILE="$WORK_DIR/cuj2.time"
# LC_ALL=C で time の小数点を . にそろえる。
{ LC_ALL=C TIMEFORMAT='%R'; time run_pecotv /dev/null "$STDERR2" HOME="$ISO_HOME" -- --help; } 2>"$TIMEFILE"
expect_code "CUJ 2: 0 で終わる" 0 "$STDERR2"
expect_no_grep "CUJ 2: 依存を入れない" '^pecotv: installing dependencies$' "$STDERR2"
expect_no_grep "CUJ 2: build しない" '^pecotv: building$' "$STDERR2"
real_ms=$(awk '{printf "%d", $1 * 1000}' "$TIMEFILE")
# 計測は約 300ms（入力のハッシュ約 100ms と、完成済みのミラー）。1000ms は環境の差を見込んだ幅。
if [ "$real_ms" -le 1000 ]; then
  bt_pass "CUJ 2: 1000ms 以内に終わる"
else
  bt_fail "CUJ 2: 1000ms 以内に終わる" "${real_ms}ms かかった"
fi

echo "[bootstrap-test] CUJ 3: runtime-lock update triggers install + build into a new mirror"
STDERR3="$WORK_DIR/cuj3.stderr"
before_current="$(current_mirror)"
printf '\n# cuj3 lock change\n' >> "$PLUGIN_ROOT/runtime-lock.yaml"
run_pecotv /dev/null "$STDERR3" HOME="$ISO_HOME" -- --help
expect_code "CUJ 3: 0 で終わる" 0 "$STDERR3"
expect_grep "CUJ 3: 依存を入れ直す" '^pecotv: installing dependencies$' "$STDERR3"
expect_grep "CUJ 3: build し直す" '^pecotv: building$' "$STDERR3"
bt_ne "CUJ 3: current が新しいミラーに切り替わる" "$before_current" "$(current_mirror)"

echo "[bootstrap-test] CUJ 4: src update triggers re-build only"
STDERR4="$WORK_DIR/cuj4.stderr"
before_current="$(current_mirror)"
printf '\n// cuj4 source change\n' >> "$PLUGIN_ROOT/cli/src/cli.ts"
run_pecotv /dev/null "$STDERR4" HOME="$ISO_HOME" -- --help
expect_code "CUJ 4: 0 で終わる" 0 "$STDERR4"
expect_grep "CUJ 4: build し直す" '^pecotv: building$' "$STDERR4"
expect_no_grep "CUJ 4: 依存を入れない" '^pecotv: installing dependencies$' "$STDERR4"
after_current="$(current_mirror)"
bt_ne "CUJ 4: current が新しいミラーに切り替わる" "$before_current" "$after_current"
bt_eq "CUJ 4: node_modules を旧ミラーとハードリンクで共有する" \
  "$(inode "$before_current/node_modules/.modules.yaml")" "$(inode "$after_current/node_modules/.modules.yaml")"

echo "[bootstrap-test] CUJ 4b: version-only update does nothing"
STDERR4B="$WORK_DIR/cuj4b.stderr"
before_current="$(current_mirror)"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.version = "99.0.0";
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$PLUGIN_ROOT/.claude-plugin/plugin.json"
printf '\n## 99.0.0\n' >> "$PLUGIN_ROOT/CHANGELOG.md"
run_pecotv "$WORK_DIR/cuj4b.stdout" "$STDERR4B" HOME="$ISO_HOME" -- --version
expect_code "CUJ 4b: 0 で終わる" 0 "$STDERR4B"
expect_no_grep "CUJ 4b: 依存を入れず、build もしない" '^pecotv: (installing dependencies|building)$' "$STDERR4B"
bt_eq "CUJ 4b: current は動かない" "$before_current" "$(current_mirror)"
expect_grep "CUJ 4b: 新しい版を返す" '99\.0\.0' "$WORK_DIR/cuj4b.stdout"

# A が flock を取る前に B が判定へ進む短い窓は残る。flaky になったら A の起動の後に sleep 0.05 を挟む。
echo "[bootstrap-test] CUJ 5: concurrent invocations do not double-run"
rm -rf "$DATA_DIR/runtime"
STDERR5A="$WORK_DIR/cuj5a.stderr"
STDERR5B="$WORK_DIR/cuj5b.stderr"
HOME="$ISO_HOME" "$BIN_PECOTV" --help >/dev/null 2>"$STDERR5A" &
pid_a=$!
HOME="$ISO_HOME" "$BIN_PECOTV" --help >/dev/null 2>"$STDERR5B" &
pid_b=$!
code=0
wait "$pid_a" || code=$?
expect_code "CUJ 5: 先に起動したプロセスが 0 で終わる" 0 "$STDERR5A"
code=0
wait "$pid_b" || code=$?
expect_code "CUJ 5: 後から起動したプロセスが 0 で終わる" 0 "$STDERR5B"
install_count=$(cat "$STDERR5A" "$STDERR5B" 2>/dev/null | grep -c '^pecotv: installing dependencies$' || true)
build_count=$(cat "$STDERR5A" "$STDERR5B" 2>/dev/null | grep -c '^pecotv: building$' || true)
if [ "$install_count" -eq 1 ]; then
  bt_pass "CUJ 5: 依存を入れるのは 1 回だけ"
else
  CUJ5_LOGS="$(printf -- '--- A ---\n%s\n--- B ---\n%s' "$(head -n 40 "$STDERR5A")" "$(head -n 40 "$STDERR5B")")"
  bt_fail "CUJ 5: 依存を入れるのは 1 回だけ" "${install_count} 回: $CUJ5_LOGS"
fi
bt_eq "CUJ 5: build は 1 回だけ" 1 "$build_count"
expect_grep "CUJ 5: 後の側が、待つか skip するログを出す" \
  'waiting for concurrent bootstrap|already bootstrapped by another process, skipping' "$STDERR5A" "$STDERR5B"

echo "[bootstrap-test] CUJ 6a: missing pnpm and corepack"
rm -rf "$DATA_DIR/runtime"
STDERR6A="$WORK_DIR/cuj6a.stderr"
run_pecotv /dev/null "$STDERR6A" \
  -i CLAUDE_PLUGIN_DATA="$DATA_DIR" HOME="$ISO_HOME" PATH="$ISO_BIN_NODE_ONLY:/usr/bin:/bin" -- --help
expect_failure "CUJ 6a: 0 以外で終わる" "$STDERR6A"
expect_grep "CUJ 6a: stderr に pnpm / corepack / npx が無いと出る" 'pnpm / corepack / npx not found' "$STDERR6A"

# pnpm を外して corepack だけ置くと、corepack 経由で install と build を終える。
echo "[bootstrap-test] CUJ 6b: corepack fallback"
STDERR6B="$WORK_DIR/cuj6b.stderr"
rm -rf "$DATA_DIR/runtime"
if [ -z "$COREPACK_PATH" ]; then
  bt_skip "CUJ 6b: corepack を使って 0 で終わる" "corepack が無い環境"
  bt_skip "CUJ 6b: corepack 経由で build する" "corepack が無い環境"
else
  run_pecotv /dev/null "$STDERR6B" -i CLAUDE_PLUGIN_DATA="$DATA_DIR" HOME="$ISO_HOME" \
    PATH="$ISO_BIN_NODE_COREPACK:/usr/bin:/bin" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -- --help
  expect_code "CUJ 6b: corepack を使って 0 で終わる" 0 "$STDERR6B"
  expect_grep "CUJ 6b: corepack 経由で build する" '^pecotv: building$' "$STDERR6B"
fi

# pnpm と corepack を外して npx だけ置くと、npx の pnpm で install と build を終える。
echo "[bootstrap-test] CUJ 6c: npx fallback (no pnpm, no corepack)"
STDERR6C="$WORK_DIR/cuj6c.stderr"
rm -rf "$DATA_DIR/runtime"
if [ -z "$NPX_PATH" ]; then
  bt_skip "CUJ 6c: npx を使って 0 で終わる" "npx が無い環境"
  bt_skip "CUJ 6c: npx 経由で依存を入れる" "npx が無い環境"
  bt_skip "CUJ 6c: npx 経由で build する" "npx が無い環境"
else
  run_pecotv /dev/null "$STDERR6C" \
    -i CLAUDE_PLUGIN_DATA="$DATA_DIR" HOME="$ISO_HOME" PATH="$ISO_BIN_NODE_NPX:/usr/bin:/bin" -- --help
  expect_code "CUJ 6c: npx を使って 0 で終わる" 0 "$STDERR6C"
  expect_grep "CUJ 6c: npx 経由で依存を入れる" '^pecotv: installing dependencies$' "$STDERR6C"
  expect_grep "CUJ 6c: npx 経由で build する" '^pecotv: building$' "$STDERR6C"
fi

echo "[bootstrap-test] CUJ 7: skill subcommand without prior setup.sh"
rm -rf "$DATA_DIR/runtime"
STDERR7="$WORK_DIR/cuj7.stderr"
STDOUT7="$WORK_DIR/cuj7.stdout"
run_pecotv "$STDOUT7" "$STDERR7" HOME="$ISO_HOME" -- slide --help
expect_code "CUJ 7: 0 で終わる" 0 "$STDERR7"
expect_grep "CUJ 7: slide の help を出す" 'slide' "$STDOUT7"

# 使用中でなく current でもないミラーは、直近の 2 つを残して消える。
echo "[bootstrap-test] CUJ 8: old mirror generations are pruned to the most recent two"
mirror_count="$({ find "$DATA_DIR/runtime" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null || true; } | wc -l | tr -d ' ')"
if [ "$mirror_count" -le 2 ]; then
  bt_pass "CUJ 8: ミラーの世代は 2 つ以下"
else
  MIRROR_LIST="$(ls -la "$DATA_DIR/runtime" 2>&1)"
  bt_fail "CUJ 8: ミラーの世代は 2 つ以下" "${mirror_count} 世代: $MIRROR_LIST"
fi
bt_eq "CUJ 8: current は完成したミラー" yes "$(exists "$(current_mirror)/.complete")"

# CUJ 1 で取った chromium を使い、drawio url が PNG まで書き出す。
echo "[bootstrap-test] CUJ 9a: first-time drawio url succeeds under ISO_HOME"
STDERR9A="$WORK_DIR/cuj9a.stderr"
DRAWIO_FIXTURE="$PLUGIN_ROOT/cli/tests/fixtures/drawio/minimal.drawio"
CUJ9A_HTML="$WORK_DIR/cuj9a.drawio.html"
CUJ9A_PNG="$WORK_DIR/cuj9a.drawio.png"
rm -f "$CUJ9A_HTML" "$CUJ9A_PNG"
run_pecotv "$WORK_DIR/cuj9a.stdout" "$STDERR9A" HOME="$ISO_HOME" -- drawio url "$DRAWIO_FIXTURE" --output "$CUJ9A_HTML"
expect_code "CUJ 9a: 0 で終わる" 0 "$STDERR9A"
expect_no_grep "CUJ 9a: Chromium の起動に失敗しない" 'Playwright Chromium cannot launch' "$STDERR9A"
bt_eq "CUJ 9a: HTML を書き出す" yes "$(nonempty "$CUJ9A_HTML")"
bt_eq "CUJ 9a: PNG を書き出す" yes "$(nonempty "$CUJ9A_PNG")"

# slidev build と chromium の export を通り、pptx ができる（60〜90 秒かかる）。
echo "[bootstrap-test] CUJ 9b: first-time slide convert (pptx) succeeds under ISO_HOME"
STDERR9B="$WORK_DIR/cuj9b.stderr"
SLIDEV_SRC="$PLUGIN_ROOT/cli/tests/fixtures/minimal-slidev"
SLIDEV_DST="$WORK_DIR/minimal-slidev-9b"
CUJ9B_PPTX="$WORK_DIR/cuj9b.pptx"
rm -rf "$SLIDEV_DST"
rm -f "$CUJ9B_PPTX"
cp -a "$SLIDEV_SRC" "$SLIDEV_DST"
# talk-dir はテーマの参照が要る。テスト用のテーマを複製して file: で指し、テーマの依存は元を指す symlink で置く。
THEME9B_NAME="slidev-theme-pecotv-test-declared"
THEME9B_ROOT="$WORK_DIR/theme-9b"
rm -rf "$THEME9B_ROOT"
mkdir -p "$THEME9B_ROOT/node_modules"
cp -a "$PLUGIN_ROOT/cli/tests/fixtures/themes/with-declaration" "$THEME9B_ROOT/$THEME9B_NAME"
cp -a "$PLUGIN_ROOT/cli/tests/fixtures/themes/theme-only-dep" "$THEME9B_ROOT/theme-only-dep"
mkdir -p "$THEME9B_ROOT/$THEME9B_NAME/node_modules"
ln -sfn "$THEME9B_ROOT/theme-only-dep" "$THEME9B_ROOT/$THEME9B_NAME/node_modules/pecotv-test-theme-dep"
# slidev は依存を talk-dir の node_modules で探すので、ミラーの依存を 1 つずつ張る。
# ミラーの直下を張るので、pnpm-workspace.yaml の nodeLinker: hoisted が前提。
mkdir -p "$SLIDEV_DST/node_modules"
for entry in "$DATA_DIR/runtime/current/node_modules"/* "$DATA_DIR/runtime/current/node_modules"/.bin; do
  [ -e "$entry" ] && ln -sfn "$entry" "$SLIDEV_DST/node_modules/$(basename "$entry")"
done
ln -sfn "$THEME9B_ROOT/$THEME9B_NAME" "$SLIDEV_DST/node_modules/$THEME9B_NAME"
jq --arg n "$THEME9B_NAME" --arg p "file:$THEME9B_ROOT/$THEME9B_NAME" '.dependencies[$n] = $p | del(.dependencies["@slidev/theme-default"])' \
  "$SLIDEV_SRC/package.json" >"$SLIDEV_DST/package.json"
sed -i "s|^theme: default$|theme: \"$THEME9B_NAME\"|" "$SLIDEV_DST/slides.md"
run_pecotv "$WORK_DIR/cuj9b.stdout" "$STDERR9B" HOME="$ISO_HOME" -- slide convert "$SLIDEV_DST" --out "$CUJ9B_PPTX"
expect_code "CUJ 9b: 0 で終わる" 0 "$STDERR9B"
expect_no_grep "CUJ 9b: Chromium の起動に失敗しない" 'Playwright Chromium cannot launch' "$STDERR9B"
bt_eq "CUJ 9b: PPTX を書き出す" yes "$(nonempty "$CUJ9B_PPTX")"

# chromium のキャッシュがあれば取り直さない。9c がミラーを消すので、その前に回す。
echo "[bootstrap-test] CUJ 9d: no re-DL when chromium cache exists"
STDERR9D="$WORK_DIR/cuj9d.stderr"
CUJ9D_HTML="$WORK_DIR/cuj9d.drawio.html"
CUJ9D_PNG="$WORK_DIR/cuj9d.drawio.png"
rm -f "$CUJ9D_HTML" "$CUJ9D_PNG"
run_pecotv "$WORK_DIR/cuj9d.stdout" "$STDERR9D" HOME="$ISO_HOME" -- drawio url "$DRAWIO_FIXTURE" --output "$CUJ9D_HTML"
expect_code "CUJ 9d: 0 で終わる" 0 "$STDERR9D"
expect_no_grep "CUJ 9d: chromium を取り直さない" 'running playwright install chromium' "$STDERR9D"
bt_eq "CUJ 9d: HTML を書き出す" yes "$(nonempty "$CUJ9D_HTML")"
bt_eq "CUJ 9d: PNG を書き出す" yes "$(nonempty "$CUJ9D_PNG")"

# PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1 で取得を必ず失敗させる（12a・12b・13b も同じ）。
echo "[bootstrap-test] CUJ 9c: bin/pecotv fatal when chromium DL fails"
STDERR9C="$WORK_DIR/cuj9c.stderr"
mkdir -p "$ISO_HOME_C/.cache" "$ISO_HOME_C/.local/share"
rm -rf "$DATA_DIR/runtime"
run_pecotv "$WORK_DIR/cuj9c.stdout" "$STDERR9C" PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1 HOME="$ISO_HOME_C" -- --help
expect_failure "CUJ 9c: 0 以外で終わる" "$STDERR9C"
expect_grep "CUJ 9c: chromium の取得を始める" 'running playwright install chromium' "$STDERR9C"
expect_grep "CUJ 9c: stderr に error: chromium が出る" 'error: chromium' "$STDERR9C"
expect_grep "CUJ 9c: stderr でネットワークの設定を案内する" 'PLAYWRIGHT_DOWNLOAD_HOST' "$STDERR9C"
bt_eq "CUJ 9c: chromium のキャッシュを残さない" no "$(chromium_cache "$ISO_HOME_C/.cache/ms-playwright")"

CHROMIUM_INSTALL_LOG="$DATA_DIR/runtime/.pecotv-chromium-install.log"
CHROMIUM_INSTALL_LOCK="$DATA_DIR/runtime/.pecotv-chromium-install.lock"

# MCP の起動は chromium を条件にしない。MCP_TIMEOUT（30 秒）の内に install と build だけで接続する。
echo "[bootstrap-test] CUJ 12: cold pecotv mcp connects without fetching chromium"
STDERR12="$WORK_DIR/cuj12.stderr"
STDOUT12="$WORK_DIR/cuj12.stdout"
rm -rf "$DATA_DIR/runtime"
mcp_initialize "$STDOUT12" "$STDERR12" 300 HOME="$ISO_HOME_C"
expect_code "CUJ 12: 0 で終わる" 0 "$STDERR12"
expect_grep "CUJ 12: 依存を入れる（cold）" '^pecotv: installing dependencies$' "$STDERR12"
expect_no_grep "CUJ 12: chromium を同期で取得しない" 'running playwright install chromium' "$STDERR12"
expect_no_grep "CUJ 12: opt-in が無ければバックグラウンドで chromium を取得しない" 'fetching it in the background' "$STDERR12"
expect_no_grep "CUJ 12: chromium が無くても止まらない" 'error: chromium' "$STDERR12"
expect_node "CUJ 12: stdout は JSON-RPC だけで、initialize に答える" "$JSON_RPC_INITIALIZED" "$STDOUT12"
bt_eq "CUJ 12: chromium のキャッシュを作らない" no "$(chromium_cache "$ISO_HOME_C/.cache/ms-playwright")"
bt_eq "CUJ 12: バックグラウンド取得のログを作らない" no "$(exists "$CHROMIUM_INSTALL_LOG")"

# 準備が済み chromium だけ無い状態でも、CLI のルートは chromium を取りに行く（#543）。
echo "[bootstrap-test] CUJ 12a: warm bootstrap still fetches chromium on the plain CLI path"
STDERR12A="$WORK_DIR/cuj12a.stderr"
CUJ12A_HTML="$WORK_DIR/cuj12a.drawio.html"
rm -f "$CUJ12A_HTML"
run_pecotv "$WORK_DIR/cuj12a.stdout" "$STDERR12A" PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1 HOME="$ISO_HOME_C" \
  -- drawio url "$DRAWIO_FIXTURE" --output "$CUJ12A_HTML"
expect_failure "CUJ 12a: 0 以外で終わる" "$STDERR12A"
expect_no_grep "CUJ 12a: 準備は済んでいる（依存を入れない）" '^pecotv: installing dependencies$' "$STDERR12A"
expect_grep "CUJ 12a: 準備が済んでいても chromium の取得を始める" 'running playwright install chromium' "$STDERR12A"
expect_grep "CUJ 12a: chromium の取得に失敗したら止まる" 'error: chromium' "$STDERR12A"
bt_eq "CUJ 12a: chromium のキャッシュを残さない" no "$(chromium_cache "$ISO_HOME_C/.cache/ms-playwright")"

# PECOTV_AUTO_INSTALL_BROWSER=1 のときだけ、起動時にバックグラウンドで取得する。失敗しても serve は続く。
echo "[bootstrap-test] CUJ 12b: opt-in env starts the background chromium fetch"
STDERR12B="$WORK_DIR/cuj12b.stderr"
STDOUT12B="$WORK_DIR/cuj12b.stdout"
rm -f "$CHROMIUM_INSTALL_LOG"
mcp_initialize "$STDOUT12B" "$STDERR12B" 120 \
  PECOTV_AUTO_INSTALL_BROWSER=1 PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1 HOME="$ISO_HOME_C"
expect_code "CUJ 12b: 0 で終わる" 0 "$STDERR12B"
expect_grep "CUJ 12b: opt-in でバックグラウンド取得を始める" 'fetching it in the background' "$STDERR12B"
expect_no_grep "CUJ 12b: バックグラウンド取得の失敗で止まらない" 'error: chromium' "$STDERR12B"
expect_no_grep "CUJ 12b: 取得の出力は stdout に出ない" 'Downloading|Progress' "$STDOUT12B"
# 取得は MCP サーバの終了を待たずに動くので、ログができるまで少し待つ。
log_deadline=$(($(date +%s) + 30))
while [ ! -f "$CHROMIUM_INSTALL_LOG" ] && [ "$(date +%s)" -le "$log_deadline" ]; do
  sleep 0.5
done
bt_eq "CUJ 12b: バックグラウンド取得のログができる" yes "$(exists "$CHROMIUM_INSTALL_LOG")"
# ログは取得の前に必ずできるので、完走を待ってから中身を見る（13c が同じロックを取る順序も決まる）。
if [ -f "$CHROMIUM_INSTALL_LOG" ] && command -v flock >/dev/null 2>&1; then
  flock "$CHROMIUM_INSTALL_LOCK" true
fi
expect_grep "CUJ 12b: バックグラウンド取得が playwright を動かす" '[Cc]hromium|[Pp]laywright' "$CHROMIUM_INSTALL_LOG"
# 強制した DL の失敗は想定のうちで、弾くのは filter・cwd・pnpm の解決の失敗だけ。
expect_no_grep "CUJ 12b: バックグラウンド取得が workspace の filter と cwd を解決する" \
  'No projects matched|ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND|command not found' "$CHROMIUM_INSTALL_LOG"
bt_eq "CUJ 12b: chromium のキャッシュを作らない（取得は失敗させた）" no "$(chromium_cache "$ISO_HOME_C/.cache/ms-playwright")"

# chromium が要るツールは runtime_setup を案内し、runtime_setup の後は同じ呼び出しが通る。
export BIN_PECOTV
MCP_CALL="$SCRIPT_DIR/mcp-call.mjs"

echo "[bootstrap-test] CUJ 13a: chromium-dependent tool guides to the runtime_setup tool"
RESULT13A="$WORK_DIR/cuj13a.json"
code=0
HOME="$ISO_HOME_C" node "$MCP_CALL" drawio_export \
  "{\"input_path\":\"$DRAWIO_FIXTURE\",\"icons_dir\":\"$PLUGIN_ROOT/assets/drawio-icons\"}" \
  >"$RESULT13A" 2>"$WORK_DIR/cuj13a.stderr" || code=$?
expect_code "CUJ 13a: 0 で終わる" 0 "$WORK_DIR/cuj13a.stderr"
expect_node "CUJ 13a: runtime_setup ツールを案内する" '
  const fs = require("fs");
  const message = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const result = message.result;
  if (!result || result.isError !== true) { console.error("expected isError: true: " + JSON.stringify(message)); process.exit(1); }
  const data = result.structuredContent;
  if (!data || data.kind !== "chromium-not-installed") {
    console.error("unexpected data: " + JSON.stringify(data)); process.exit(1);
  }
  if (!String(data.detail).includes("`runtime_setup` tool")) {
    console.error("detail does not guide to the runtime_setup tool: " + data.detail); process.exit(1);
  }
' "$RESULT13A"

echo "[bootstrap-test] CUJ 13b: runtime_setup surfaces the reason when the download is unreachable"
RESULT13B="$WORK_DIR/cuj13b.json"
code=0
PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1 HOME="$ISO_HOME_C" node "$MCP_CALL" runtime_setup \
  >"$RESULT13B" 2>"$WORK_DIR/cuj13b.stderr" || code=$?
expect_code "CUJ 13b: 0 で終わる" 0 "$WORK_DIR/cuj13b.stderr"
expect_node "CUJ 13b: 取得できない理由と、プロキシ・取得元の設定を返す" '
  const fs = require("fs");
  const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result;
  if (!result || result.isError !== true) { console.error("expected isError: true: " + JSON.stringify(result)); process.exit(1); }
  const data = result.structuredContent;
  if (data.kind !== "chromium-install-failed") {
    console.error("unexpected kind: " + JSON.stringify(data)); process.exit(1);
  }
  for (const hint of ["HTTPS_PROXY", "PLAYWRIGHT_DOWNLOAD_HOST"]) {
    if (!String(data.detail).includes(hint)) {
      console.error("detail lacks " + hint + ": " + data.detail); process.exit(1);
    }
  }
' "$RESULT13B"

# ふだんは ISO_HOME の chromium を写し、冪等（取らない）ルートを見る。HEAVY=1 では 2 本目の実 DL（約 120MB）をする。
RESULT13C="$WORK_DIR/cuj13c.json"
if [ "${PECOTV_BOOTSTRAP_TEST_HEAVY:-}" = "1" ]; then
  echo "[bootstrap-test] CUJ 13c: runtime_setup actually downloads chromium and unblocks the tool (heavy)"
  EXPECT13C_EVENT="setup.done"
  EXPECT13C_DOWNLOADED="true"
else
  echo "[bootstrap-test] CUJ 13c: runtime_setup skips the download when chromium is already present"
  rm -rf "$ISO_HOME_C/.cache/ms-playwright"
  cp -a "$ISO_HOME/.cache/ms-playwright" "$ISO_HOME_C/.cache/ms-playwright"
  EXPECT13C_EVENT="setup.skipped"
  EXPECT13C_DOWNLOADED="false"
fi
code=0
HOME="$ISO_HOME_C" node "$MCP_CALL" runtime_setup >"$RESULT13C" 2>"$WORK_DIR/cuj13c.stderr" || code=$?
expect_code "CUJ 13c: 0 で終わる" 0 "$WORK_DIR/cuj13c.stderr"
expect_node "CUJ 13c: runtime_setup が $EXPECT13C_EVENT を返す" '
  const fs = require("fs");
  const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result;
  if (!result || result.isError !== undefined) {
    console.error("expected success, got: " + JSON.stringify(result && result.structuredContent)); process.exit(1);
  }
  const data = result.structuredContent;
  const expectedEvent = process.argv[2];
  const expectedDownloaded = process.argv[3] === "true";
  const chromium = data.chromium || {};
  if (data.event !== expectedEvent || chromium.installed !== true || chromium.downloaded !== expectedDownloaded) {
    console.error("unexpected data: " + JSON.stringify(data)); process.exit(1);
  }
' "$RESULT13C" "$EXPECT13C_EVENT" "$EXPECT13C_DOWNLOADED"
bt_eq "CUJ 13c: chromium のキャッシュがある" yes "$(chromium_cache "$ISO_HOME_C/.cache/ms-playwright")"

# 案内どおりに直る。Chromium の起動まで見るため、print_hash でなく SVG を書き出す。
echo "[bootstrap-test] CUJ 13d: drawio_export works again once runtime_setup has fetched chromium"
RESULT13D="$WORK_DIR/cuj13d.json"
CUJ13D_SVG="$WORK_DIR/cuj13d.svg"
rm -f "$CUJ13D_SVG"
code=0
HOME="$ISO_HOME_C" node "$MCP_CALL" drawio_export \
  "{\"input_path\":\"$DRAWIO_FIXTURE\",\"icons_dir\":\"$PLUGIN_ROOT/assets/drawio-icons\",\"out_path\":\"$CUJ13D_SVG\"}" \
  >"$RESULT13D" 2>"$WORK_DIR/cuj13d.stderr" || code=$?
expect_code "CUJ 13d: 0 で終わる" 0 "$WORK_DIR/cuj13d.stderr"
expect_node "CUJ 13d: runtime_setup の後は drawio_export が通る" "$TOOL_SUCCEEDED" "$RESULT13D"
bt_eq "CUJ 13d: SVG を書き出す" yes "$(nonempty "$CUJ13D_SVG")"

# 単体配布（npx）では icons_dir を組み立てられないので、省いても同梱のカタログで icon:// を解決する。
echo "[bootstrap-test] CUJ 13e: drawio_export resolves icon:// with the bundled catalog by default"
DRAWIO_ICON_FIXTURE="$PLUGIN_ROOT/cli/tests/fixtures/drawio/icon-resolvable.drawio"
RESULT13E="$WORK_DIR/cuj13e.json"
CUJ13E_SVG="$WORK_DIR/cuj13e.svg"
rm -f "$CUJ13E_SVG"
code=0
HOME="$ISO_HOME_C" node "$MCP_CALL" drawio_export \
  "{\"input_path\":\"$DRAWIO_ICON_FIXTURE\",\"out_path\":\"$CUJ13E_SVG\"}" \
  >"$RESULT13E" 2>"$WORK_DIR/cuj13e.stderr" || code=$?
expect_code "CUJ 13e: 0 で終わる" 0 "$WORK_DIR/cuj13e.stderr"
expect_node "CUJ 13e: icons_dir を省いても drawio_export が通る" "$TOOL_SUCCEEDED" "$RESULT13E"
bt_eq "CUJ 13e: SVG を書き出す" yes "$(nonempty "$CUJ13E_SVG")"

# chromium があれば、opt-in でもバックグラウンド取得を始めない（13c の後の ISO_HOME_C は取得済み）。
echo "[bootstrap-test] CUJ 14: opt-in does not refetch chromium when it is already present"
STDERR14="$WORK_DIR/cuj14.stderr"
STDOUT14="$WORK_DIR/cuj14.stdout"
rm -f "$CHROMIUM_INSTALL_LOG"
mcp_initialize "$STDOUT14" "$STDERR14" 120 PECOTV_AUTO_INSTALL_BROWSER=1 HOME="$ISO_HOME_C"
expect_code "CUJ 14: 0 で終わる" 0 "$STDERR14"
expect_no_grep "CUJ 14: chromium があればバックグラウンド取得を始めない" 'fetching it in the background' "$STDERR14"
expect_no_grep "CUJ 14: chromium を同期で取得しない" 'running playwright install chromium' "$STDERR14"
bt_eq "CUJ 14: バックグラウンド取得のログを作らない" no "$(exists "$CHROMIUM_INSTALL_LOG")"

echo "[bootstrap-test] static checks"
SETUP_SH="$PLUGIN_ROOT/setup.sh"
expect_no_grep "静的: setup.sh は pnpm の build を呼ばない" 'pnpm --filter @pecot/pecotv-cli run build' "$SETUP_SH"
expect_grep "静的: setup.sh は bin/pecotv に任せる" 'bin/pecotv' "$SETUP_SH"
# chromium の取得の失敗は止める（warn だけへ戻さない）。error: chromium の行の後 5 行に exit 1 があるかで見る。
if grep -A 5 'error: chromium' "$PLUGIN_ROOT/bin/pecotv" | grep -q 'exit 1'; then
  bt_pass "静的: bin/pecotv は error: chromium の後に exit 1 で止まる"
else
  bt_fail "静的: bin/pecotv は error: chromium の後に exit 1 で止まる" "error: chromium の後 5 行に exit 1 が無い"
fi

bt_finish
