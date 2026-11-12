#!/usr/bin/env bash
# bin/pecot / .mcp.json の CUJ テスト（pecot-tools の cli/tests/bootstrap/run.sh と同型）。
#
# vitest は `dist/cli.js` を直接起動する。そのため、手前にある bash wrapper と登録ファイルには検証が掛からない。
# ここで押さえるのは 9 つ。
#   CUJ 1  .mcp.json の登録内容（command / args）と、置換後パスが実行可能なこと。
#   CUJ 2  Python と uv の無い PATH で、初回の `bin/pecot mcp` がデータ置き場に実行用ミラーを作る（install + build）。
#          MCP サーバとして応答し、stdout が JSON-RPC 専有のまま、stdin の EOF で 0 終了すること。
#          旧方式の venv（${DATA}/venv と既定の場所の venv）は、使用中の世代を残して消える。
#   CUJ 3  2 回目の起動は準備（install / build）をしないこと。
#   CUJ 4  ソースだけを変えた複製で起動すると、install なしの build だけを実行する。
#   CUJ 5  クライアントが置き場を渡さない起動（変数なし）は、標準の場所に実行用ミラーを作る。
#   CUJ 6  pnpm と corepack が無く、npx だけある環境（Node.js 25 以降）で、npx 経由の pnpm が完走する。
#   CUJ 7  Node が無い PATH では、`pnpm / corepack / npx not found` の行を出して非 0 で止まる。
#   CUJ 8  プラグインルートの解決（CLAUDE_PLUGIN_ROOT の優先・無効なとき・symlink 経由）と、読み取り専用のルートでの初回の準備。
#   CUJ 9  旧方式の venv の片づけの境界。消せない世代があっても起動する。symlink の先や旧方式でないものは消さない。
#          旧版のロック（venv/.lock）を持つプロセスがいる間は消さない。flock の無い環境ではロックを見ずに消す。
#
# 依存と build 成果物はプラグインのデータ置き場（${データ置き場}/runtime/<hash>/）に作る。
# データ置き場は $WORK_DIR 配下の一時ディレクトリで、CLAUDE_PLUGIN_DATA で渡す。
# HOME と XDG_DATA_HOME を付け替える起動では、pnpm の store を npm_config_store_dir で元の場所に固定する。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT/../.." && pwd)"
MCP_JSON="$PLUGIN_ROOT/.mcp.json"
TOOL_COUNT=34

WORK_DIR="$REPO_ROOT/.pecot/tmp/pecot-workflow-bootstrap-test"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

unset PECOT_BOOTSTRAP_SKIP PECOT_BOOTSTRAP_FORCE PLUGIN_DATA
DATA_DIR="$WORK_DIR/data"
mkdir -p "$DATA_DIR"
export CLAUDE_PLUGIN_DATA="$DATA_DIR"

HOLDER_PID=""
MCP_PID=""
cleanup() {
  local exit_code=$?
  [ -z "$HOLDER_PID" ] || kill "$HOLDER_PID" 2>/dev/null || true
  [ -z "$MCP_PID" ] || kill "$MCP_PID" 2>/dev/null || true
  chmod -R u+w "$WORK_DIR" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR" >/dev/null 2>&1 || true
  exit "$exit_code"
}
trap cleanup EXIT

fail() {
  echo "[bootstrap-test] FAIL: $*" >&2
  exit 1
}

# ファイルにロックを保持する子プロセスを起こす（$1 = ロックするファイル、$2 = flock の種類 -s か -x）。
# 子は stdin・stdout・stderr を継がず、60 秒で終わる。ロックを取ったら $WORK_DIR/holder.ready を書くので、それを待つ。
# flock(1) は子プロセスで動くため、bash 自身を sleep に置き換え、kill が保持者へ届くようにする。
start_holder() {
  local ready="$WORK_DIR/holder.ready" _
  rm -f "$ready"
  bash -c 'exec 9<"$1"; flock "$3" 9 || exit 1; : > "$2"; exec sleep 60' _ "$1" "$ready" "$2" </dev/null >/dev/null 2>&1 &
  HOLDER_PID=$!
  for _ in $(seq 1 100); do
    [ -e "$ready" ] && return 0
    sleep 0.1
  done
  fail "ロックの保持者がロックを取れなかった: $1"
}

stop_holder() {
  [ -z "$HOLDER_PID" ] || kill "$HOLDER_PID" 2>/dev/null || true
  wait "$HOLDER_PID" 2>/dev/null || true
  HOLDER_PID=""
}

assert_exit_zero() {
  local code="$1"; local label="$2"
  if [ "$code" -ne 0 ]; then
    fail "$label (exit=$code)"
  fi
}

# PATH から名前に合うコマンドを除いた bin を作る（$1 = 作る dir、残り = 除く名前の case パターン）。
make_filtered_bin() {
  local dest="$1" dir entry name pattern skip
  shift
  mkdir -p "$dest"
  local IFS=:
  for dir in $PATH; do
    [ -d "$dir" ] || continue
    for entry in "$dir"/*; do
      name="${entry##*/}"
      skip=0
      for pattern in "$@"; do
        # shellcheck disable=SC2254
        case "$name" in $pattern) skip=1 ;; esac
      done
      [ "$skip" -eq 0 ] || continue
      [ -x "$entry" ] && [ ! -d "$entry" ] || continue
      [ -e "$dest/$name" ] || ln -s "$entry" "$dest/$name"
    done
  done
}

INITIALIZE_REQUEST='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"bootstrap-test","version":"0.0.0"}}}'
INITIALIZED_NOTIFICATION='{"jsonrpc":"2.0","method":"notifications/initialized"}'
TOOLS_LIST_REQUEST='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# 応答 2 行（initialize と tools/list）が揃うまで待って stdin を閉じる。終了コードは MCP_EXIT_CODE に残す。
# 第 4 引数でプラグインルートを差し替えられる。EXCHANGE_ENV に `VAR=値` を並べると、wrapper の環境に足す。
MCP_EXIT_CODE=0
EXCHANGE_ENV=()
run_mcp_exchange() {
  local stdout_file="$1"; local stderr_file="$2"; local wait_seconds="$3"
  local root="${4:-$PLUGIN_ROOT}"
  local fifo="$WORK_DIR/mcp.stdin.fifo"
  local pid deadline exit_deadline

  rm -f "$fifo" "$stdout_file" "$stderr_file"
  mkfifo "$fifo"

  set +e
  env "${EXCHANGE_ENV[@]+"${EXCHANGE_ENV[@]}"}" CLAUDE_PLUGIN_ROOT="$root" "$root/bin/pecot" mcp <"$fifo" >"$stdout_file" 2>"$stderr_file" &
  pid=$!
  MCP_PID=$pid
  # fd 7 を writer として保持し続けることで stdin の EOF を保留する。
  exec 7>"$fifo"
  printf '%s\n' "$INITIALIZE_REQUEST" >&7
  printf '%s\n' "$INITIALIZED_NOTIFICATION" >&7
  printf '%s\n' "$TOOLS_LIST_REQUEST" >&7
  deadline=$(( $(date +%s) + wait_seconds ))
  while [ "$(wc -l < "$stdout_file")" -lt 2 ] && [ "$(date +%s)" -le "$deadline" ]; do
    sleep 0.5
  done
  sleep 0.5
  exec 7>&-
  # EOF の後に終わらないものは、30 秒で止めて失敗にする。
  exit_deadline=$(( $(date +%s) + 30 ))
  while kill -0 "$pid" 2>/dev/null && [ "$(date +%s)" -le "$exit_deadline" ]; do
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    fail "stdin の EOF の後も bin/pecot mcp が終わらない（stderr: $stderr_file）"
  fi
  wait "$pid"
  MCP_EXIT_CODE=$?
  MCP_PID=""
  set -e

  rm -f "$fifo"
}

# stdout の全行が JSON-RPC で、tools/list が $TOOL_COUNT 件を返していることを見る。
# 非 JSON 行（bootstrap の進捗が混入する等）があれば JSON.parse が throw して失敗する。
assert_json_rpc_stdout() {
  local stdout_file="$1"; local label="$2"
  node -e '
    const fs = require("node:fs");
    const expected = Number(process.argv[2]);
    const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter((line) => line !== "");
    if (lines.length !== 2) {
      console.error(`stdout line count is not 2: ${lines.length}\n${lines.join("\n")}`);
      process.exit(1);
    }
    const messages = lines.map((line) => JSON.parse(line));
    for (const message of messages) {
      if (message.jsonrpc !== "2.0") { console.error(`line lacks jsonrpc 2.0: ${JSON.stringify(message)}`); process.exit(1); }
    }
    const listed = messages.find((message) => message.id === 2);
    const tools = listed && listed.result && listed.result.tools;
    if (!Array.isArray(tools) || tools.length !== expected) {
      console.error(`tools/list did not return ${expected} tools: ${Array.isArray(tools) ? tools.length : "none"}`);
      process.exit(1);
    }
    const names = tools.map((tool) => tool.name);
    for (const required of ["project_info", "issue_read", "pr_create"]) {
      if (!names.includes(required)) { console.error(`tools/list lacks ${required}`); process.exit(1); }
    }
  ' "$stdout_file" "$TOOL_COUNT" || fail "$label"
}

echo "[bootstrap-test] CUJ 1: .mcp.json registration"
MCP_COMMAND="$(node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const server = (manifest.mcpServers || {})["pecot-workflow"];
  if (!server) { console.error("mcpServers.pecot-workflow がありません"); process.exit(1); }
  process.stdout.write(String(server.command));
' "$MCP_JSON")" || fail "CUJ 1 .mcp.json の読み出し"
MCP_ARGS="$(node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(JSON.stringify((manifest.mcpServers || {})["pecot-workflow"].args));
' "$MCP_JSON")" || fail "CUJ 1 .mcp.json の読み出し"

if [ "$MCP_COMMAND" != '${CLAUDE_PLUGIN_ROOT}/bin/pecot' ]; then
  fail "CUJ 1 command が想定と違う: $MCP_COMMAND"
fi
if [ "$MCP_ARGS" != '["mcp"]' ]; then
  fail "CUJ 1 args が想定と違う: $MCP_ARGS"
fi
RESOLVED_COMMAND="${MCP_COMMAND/'${CLAUDE_PLUGIN_ROOT}'/$PLUGIN_ROOT}"
if [ ! -x "$RESOLVED_COMMAND" ]; then
  fail "CUJ 1 置換後のパスが実行可能でない: $RESOLVED_COMMAND"
fi
echo "[bootstrap-test] CUJ 1 pass"

# pnpm の store の位置は、HOME / XDG_DATA_HOME を付け替える起動の前に調べておく。
# shellcheck source=../../../bin/_lib.sh
. "$PLUGIN_ROOT/bin/_lib.sh"
PNPM_CMD="$(resolve_pnpm "$PLUGIN_ROOT")"
# shellcheck disable=SC2086
PNPM_STORE="$(cd "$PLUGIN_ROOT" && $PNPM_CMD store path)" || fail "pnpm の store を調べられない"

echo "[bootstrap-test] CUJ 2: first bin/pecot mcp builds the runtime mirror without python/uv and removes the old venvs"
NOPY_BIN="$WORK_DIR/nopy-bin"
make_filtered_bin "$NOPY_BIN" 'python*' 'uv' 'uvx' 'pip*'
if env PATH="$NOPY_BIN" bash --noprofile --norc -c 'command -v python3 python uv uvx' >/dev/null 2>&1; then
  fail "CUJ 2 の PATH に python / uv が残っている"
fi
# 旧方式の venv を、解決した置き場（DATA_DIR）と既定の場所（CLAUDE_PLUGIN_DATA を外して求める）の 2 か所に置く。
# 使用中（.inuse の共有ロックを保持）の世代は残り、そうでない世代は消える。
CUJ2_HOME="$WORK_DIR/cuj2-home"
DEFAULT_DATA="$CUJ2_HOME/.local/share/pecot/pecot-workflow"
mkdir -p "$CUJ2_HOME"
for venv_root in "$DATA_DIR/venv" "$DEFAULT_DATA/venv"; do
  for generation in aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb cccccccccccccccc-dddddddddddddddd; do
    mkdir -p "$venv_root/$generation/bin"
    : > "$venv_root/$generation/.pecot-complete"
    : > "$venv_root/$generation/.inuse"
  done
  ln -s aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb "$venv_root/current"
  : > "$venv_root/.lock"
done
HOLD_DIR="$DEFAULT_DATA/venv/cccccccccccccccc-dddddddddddddddd"
if command -v flock >/dev/null 2>&1; then
  start_holder "$HOLD_DIR/.inuse" -s
fi
# 本体（plugins/pecot-workflow）の追跡と無視の状態を、起動の前後で比べる。
PLUGIN_STATE_BEFORE="$(git -C "$REPO_ROOT" status --porcelain --ignored -- plugins/pecot-workflow)"
STDOUT2="$WORK_DIR/cuj2.stdout"
STDERR2="$WORK_DIR/cuj2.stderr"
CUJ2_ENV=(PATH="$NOPY_BIN" HOME="$CUJ2_HOME" XDG_DATA_HOME= npm_config_store_dir="$PNPM_STORE")
EXCHANGE_ENV=("${CUJ2_ENV[@]}")
run_mcp_exchange "$STDOUT2" "$STDERR2" 300
EXCHANGE_ENV=()
assert_exit_zero "$MCP_EXIT_CODE" "CUJ 2 exit ($STDERR2 を参照)"
assert_json_rpc_stdout "$STDOUT2" "CUJ 2 stdout が JSON-RPC 専有でない ($STDERR2 を参照)"
grep -qx 'pecot: installing dependencies' "$STDERR2" || fail "CUJ 2 で install が実行されていない（stderr に 'pecot: installing dependencies' が無い）"
grep -qx 'pecot: building' "$STDERR2" || fail "CUJ 2 で build が実行されていない（stderr に 'pecot: building' が無い）"
CURRENT_DIR="$(readlink -f "$DATA_DIR/runtime/current")"
if [ ! -f "$CURRENT_DIR/.complete" ] || [ ! -f "$CURRENT_DIR/cli-node/dist/cli.js" ]; then
  fail "CUJ 2 の後に完成したミラーが無い: $DATA_DIR/runtime"
fi
# 本体のワークツリーには何も作らない。
PLUGIN_STATE_AFTER="$(git -C "$REPO_ROOT" status --porcelain --ignored -- plugins/pecot-workflow)"
PLUGIN_STATE_DIFF="$(diff <(printf '%s\n' "$PLUGIN_STATE_BEFORE") <(printf '%s\n' "$PLUGIN_STATE_AFTER") || true)"
[ "$PLUGIN_STATE_BEFORE" = "$PLUGIN_STATE_AFTER" ] || fail "CUJ 2 が本体へ書き込んだ: $PLUGIN_STATE_DIFF"
# 旧方式の venv
for generation in aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb cccccccccccccccc-dddddddddddddddd; do
  [ ! -e "$DATA_DIR/venv/$generation" ] || fail "CUJ 2 で解決した置き場の venv の世代が残っている: $generation"
done
[ ! -e "$DATA_DIR/venv" ] || fail "CUJ 2 で解決した置き場の空の venv が残っている"
[ ! -e "$DEFAULT_DATA/venv/aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb" ] || fail "CUJ 2 で既定の場所の venv の世代が残っている"
if [ -n "$HOLDER_PID" ]; then
  [ -d "$HOLD_DIR" ] || fail "CUJ 2 が使用中の世代を消した: $HOLD_DIR"
  stop_holder
  # 使用中でなくなった世代は、次回の起動で消える（この起動は準備済みなので、片づけだけを行う）。
  EXCHANGE_ENV=("${CUJ2_ENV[@]}")
  run_mcp_exchange "$WORK_DIR/cuj2b.stdout" "$WORK_DIR/cuj2b.stderr" 60
  EXCHANGE_ENV=()
  assert_exit_zero "$MCP_EXIT_CODE" "CUJ 2 の次回の起動の exit"
  [ ! -e "$HOLD_DIR" ] || fail "CUJ 2 の次回の起動で、使用中でなくなった世代が消えていない: $HOLD_DIR"
fi
echo "[bootstrap-test] CUJ 2 pass"

echo "[bootstrap-test] CUJ 3: second bin/pecot mcp does not install or build"
STDOUT3="$WORK_DIR/cuj3.stdout"
STDERR3="$WORK_DIR/cuj3.stderr"
run_mcp_exchange "$STDOUT3" "$STDERR3" 60
assert_exit_zero "$MCP_EXIT_CODE" "CUJ 3 exit"
assert_json_rpc_stdout "$STDOUT3" "CUJ 3 stdout が JSON-RPC 専有でない ($STDERR3 を参照)"
if grep -qE '^pecot: (installing dependencies|building)$' "$STDERR3"; then
  fail "CUJ 3 で準備がやり直された ($STDERR3 を参照)"
fi
[ "$(readlink -f "$DATA_DIR/runtime/current")" = "$CURRENT_DIR" ] || fail "CUJ 3 で current が動いた"
echo "[bootstrap-test] CUJ 3 pass"

echo "[bootstrap-test] CUJ 4: source-only change builds without install and keeps stdout JSON-RPC only"
COPY_ROOT="$WORK_DIR/plugin-copy"
mkdir -p "$COPY_ROOT"
{
  plugin_runtime_deps_files "$PLUGIN_ROOT"
  plugin_runtime_src_files "$PLUGIN_ROOT"
  printf '%s\n' bin/pecot bin/_lib.sh .claude-plugin/plugin.json
} | LC_ALL=C sort -u | (cd "$PLUGIN_ROOT" && tar -cf - -T -) | (cd "$COPY_ROOT" && tar -xf -)
printf '\n// source-only change\n' >> "$COPY_ROOT/cli-node/src/cli.ts"
STDOUT4="$WORK_DIR/cuj4.stdout"
STDERR4="$WORK_DIR/cuj4.stderr"
run_mcp_exchange "$STDOUT4" "$STDERR4" 300 "$COPY_ROOT"
assert_exit_zero "$MCP_EXIT_CODE" "CUJ 4 exit"
assert_json_rpc_stdout "$STDOUT4" "CUJ 4 stdout に build の出力が漏れている ($STDERR4 を参照)"
if grep -qx 'pecot: installing dependencies' "$STDERR4"; then
  fail "CUJ 4 でソースだけの変更なのに install が実行された ($STDERR4 を参照)"
fi
grep -qx 'pecot: building' "$STDERR4" || fail "CUJ 4 で build が実行されていない（stderr に 'pecot: building' が無い）"
[ "$(readlink -f "$DATA_DIR/runtime/current")" != "$CURRENT_DIR" ] || fail "CUJ 4 で current が新しいミラーに切り替わっていない"
[ -f "$CURRENT_DIR/cli-node/dist/cli.js" ] || fail "CUJ 4 が旧ミラーを壊した: $CURRENT_DIR"
if [ -e "$COPY_ROOT/node_modules" ] || [ -e "$COPY_ROOT/cli-node/dist" ]; then
  fail "CUJ 4 が複製したプラグインルートに node_modules / cli-node/dist を作った"
fi
echo "[bootstrap-test] CUJ 4 pass"

# CUJ 5: クライアントが置き場を渡さない起動は、標準の場所（${XDG_DATA_HOME}/pecot/pecot-workflow）に実行用ミラーを作る。
echo "[bootstrap-test] CUJ 5: default data directory when no variable is given"
XDG_DIR="$WORK_DIR/xdg-share"
STDERR5="$WORK_DIR/cuj5.stderr"
set +e
env -u CLAUDE_PLUGIN_DATA -u PLUGIN_DATA XDG_DATA_HOME="$XDG_DIR" npm_config_store_dir="$PNPM_STORE" \
  CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" "$PLUGIN_ROOT/bin/pecot" --help >/dev/null 2>"$STDERR5"
code=$?
set -e
assert_exit_zero "$code" "CUJ 5 exit ($STDERR5 を参照)"
DEFAULT_CURRENT="$(readlink -f "$XDG_DIR/pecot/pecot-workflow/runtime/current")"
[ -f "$DEFAULT_CURRENT/cli-node/dist/cli.js" ] || fail "CUJ 5 が既定の場所にミラーを作っていない: $XDG_DIR/pecot/pecot-workflow/runtime"
echo "[bootstrap-test] CUJ 5 pass"

# CUJ 6: pnpm 無し / corepack 無し / npx あり（Node.js 25 以降の corepack 非同梱環境）。
# 隔離 HOME のため npx は pnpm の tarball を毎回取得する（ネット依存）。npx が無い環境では飛ばす。
echo "[bootstrap-test] CUJ 6: npx fallback (no pnpm, no corepack)"
NPM_PATH="$(command -v npm 2>/dev/null || true)"
NPX_PATH="$(command -v npx 2>/dev/null || true)"
if [ -z "$NPM_PATH" ] || [ -z "$NPX_PATH" ]; then
  echo "[bootstrap-test] CUJ 6 skipped: npm / npx not present in environment" >&2
else
  ISO_BIN_NODE_NPX="$WORK_DIR/iso-bin-node-npx"
  ISO_HOME="$WORK_DIR/iso-home-npx"
  DATA_DIR_6="$WORK_DIR/data-npx"
  mkdir -p "$ISO_BIN_NODE_NPX" "$ISO_HOME" "$DATA_DIR_6"
  ln -s "$(command -v node)" "$ISO_BIN_NODE_NPX/node"
  ln -s "$NPM_PATH" "$ISO_BIN_NODE_NPX/npm"
  ln -s "$NPX_PATH" "$ISO_BIN_NODE_NPX/npx"
  STDERR6="$WORK_DIR/cuj6.stderr"
  set +e
  env -i CLAUDE_PLUGIN_DATA="$DATA_DIR_6" HOME="$ISO_HOME" PATH="$ISO_BIN_NODE_NPX:/usr/bin:/bin" \
    "$PLUGIN_ROOT/bin/pecot" --help >/dev/null 2>"$STDERR6"
  code=$?
  set -e
  if [ "$code" -ne 0 ]; then
    sed -n '1,40p' "$STDERR6" >&2
    fail "CUJ 6 exit=$code (expected 0)"
  fi
  grep -q '^pecot: installing dependencies$' "$STDERR6" || fail "CUJ 6 が npx 経由で install していない"
  grep -q '^pecot: building$' "$STDERR6" || fail "CUJ 6 が npx 経由で build していない"
fi
echo "[bootstrap-test] CUJ 6 pass"

# CUJ 7: Node / npm / npx / pnpm / corepack の無い PATH では、理由の行を出して非 0 で止まる。何も実行しない。
echo "[bootstrap-test] CUJ 7: no Node on PATH stops with a reason"
NONODE_BIN="$WORK_DIR/nonode-bin"
make_filtered_bin "$NONODE_BIN" node npm npx pnpm corepack
DATA_DIR_7="$WORK_DIR/data-nonode"
STDERR7="$WORK_DIR/cuj7.stderr"
set +e
env PATH="$NONODE_BIN" CLAUDE_PLUGIN_DATA="$DATA_DIR_7" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
  "$PLUGIN_ROOT/bin/pecot" --help >"$WORK_DIR/cuj7.stdout" 2>"$STDERR7"
code=$?
set -e
[ "$code" -ne 0 ] || fail "CUJ 7 が Node の無い PATH で成功した"
grep -q 'pnpm / corepack / npx not found' "$STDERR7" || { sed -n '1,20p' "$STDERR7" >&2; fail "CUJ 7 の stderr に 'pnpm / corepack / npx not found' が無い"; }
[ ! -s "$WORK_DIR/cuj7.stdout" ] || fail "CUJ 7 が stdout に出力した"
[ -z "$(find "$DATA_DIR_7/runtime" -name .complete 2>/dev/null)" ] || fail "CUJ 7 が完成したミラーを作った"
echo "[bootstrap-test] CUJ 7 pass"

# CUJ 8: プラグインルートの解決と、読み取り専用のルートでの起動。完成済みのミラー（CUJ 2〜3 と同じ置き場）を使う。
echo "[bootstrap-test] CUJ 8: plugin root resolution and a read-only root"
RESOLVE_ROOT="$WORK_DIR/resolve-root"
mkdir -p "$RESOLVE_ROOT"
{
  plugin_runtime_deps_files "$PLUGIN_ROOT"
  plugin_runtime_src_files "$PLUGIN_ROOT"
  printf '%s\n' bin/pecot bin/_lib.sh .claude-plugin/plugin.json
} | LC_ALL=C sort -u | (cd "$PLUGIN_ROOT" && tar -cf - -T -) | (cd "$RESOLVE_ROOT" && tar -xf -)
MANIFEST_OF_ROOT="$RESOLVE_ROOT/.claude-plugin/plugin.json"
VERSION_OF_ROOT=$(node -p 'require(process.argv[1]).version' "$MANIFEST_OF_ROOT")
run_version() {
  env -u CLAUDE_PLUGIN_ROOT "$@" 2>&1
}
# CLAUDE_PLUGIN_ROOT に plugin.json が無いときは、wrapper の位置から解決する。
OUT_INVALID="$(run_version CLAUDE_PLUGIN_ROOT="$WORK_DIR/not-a-plugin" "$RESOLVE_ROOT/bin/pecot" --version)" || fail "CUJ 8 無効な CLAUDE_PLUGIN_ROOT で起動できない: $OUT_INVALID"
case "$OUT_INVALID" in *"$VERSION_OF_ROOT"*) ;; *) fail "CUJ 8 wrapper の位置から解決していない: $OUT_INVALID" ;; esac
# symlink 経由で起動しても、実体の位置から解決する。
mkdir -p "$WORK_DIR/link-bin"
ln -s "$RESOLVE_ROOT/bin/pecot" "$WORK_DIR/link-bin/pecot"
OUT_LINK="$(run_version "$WORK_DIR/link-bin/pecot" --version)" || fail "CUJ 8 symlink 経由で起動できない: $OUT_LINK"
case "$OUT_LINK" in *"$VERSION_OF_ROOT"*) ;; *) fail "CUJ 8 symlink 経由でルートを解決していない: $OUT_LINK" ;; esac
# 読み取り専用のルートでも、初回の準備ができる（本体には何も書かない）。
READONLY_DATA="$WORK_DIR/data-readonly"
chmod -R a-w "$RESOLVE_ROOT"
set +e
OUT_RO="$(env -u CLAUDE_PLUGIN_ROOT CLAUDE_PLUGIN_DATA="$READONLY_DATA" "$RESOLVE_ROOT/bin/pecot" --version 2>"$WORK_DIR/cuj8.stderr")"
code=$?
set -e
chmod -R u+w "$RESOLVE_ROOT"
assert_exit_zero "$code" "CUJ 8 読み取り専用のルートの exit ($WORK_DIR/cuj8.stderr を参照)"
case "$OUT_RO" in *"$VERSION_OF_ROOT"*) ;; *) fail "CUJ 8 読み取り専用のルートの出力が想定と違う: $OUT_RO" ;; esac
[ ! -e "$RESOLVE_ROOT/node_modules" ] || fail "CUJ 8 が本体に node_modules を作った"
echo "[bootstrap-test] CUJ 8 pass"

# CUJ 9: 旧方式の venv の片づけ。完成済みのミラー（CUJ 2〜3 と同じ置き場）を使うので、起動は片づけだけを行う。
# HOME を付け替える。既定の場所（実ホーム）の venv を触らないため。
echo "[bootstrap-test] CUJ 9: legacy venv cleanup boundaries"
CUJ9_HOME="$WORK_DIR/cuj9-home"
mkdir -p "$CUJ9_HOME"
GEN_A=1111111111111111-2222222222222222
GEN_B=3333333333333333-4444444444444444
VENV="$DATA_DIR/venv"
VERSION_OF_PLUGIN=$(node -p 'require(process.argv[1]).version' "$PLUGIN_ROOT/.claude-plugin/plugin.json")
RS_CODE=0
# run_start [VAR=値 ...]: 完成済みのミラーで bin/pecot --version を起動する。結果は RS_CODE と cuj9.stdout / cuj9.stderr に残す。
run_start() {
  RS_CODE=0
  env -u CLAUDE_PLUGIN_ROOT HOME="$CUJ9_HOME" XDG_DATA_HOME= npm_config_store_dir="$PNPM_STORE" "$@" \
    "$PLUGIN_ROOT/bin/pecot" --version >"$WORK_DIR/cuj9.stdout" 2>"$WORK_DIR/cuj9.stderr" </dev/null || RS_CODE=$?
}
assert_started() {
  [ "$RS_CODE" -eq 0 ] || { sed -n '1,20p' "$WORK_DIR/cuj9.stderr" >&2; fail "$1 が起動に失敗した (exit=$RS_CODE)"; }
  CUJ9_STDOUT="$(cat "$WORK_DIR/cuj9.stdout")"
  grep -q "$VERSION_OF_PLUGIN" "$WORK_DIR/cuj9.stdout" || fail "$1 が版を返していない: $CUJ9_STDOUT"
}
make_generation() {
  mkdir -p "$1/bin"
  : > "$1/.pecot-complete"
  : > "$1/.inuse"
}
reset_venv() {
  chmod -R u+w "$VENV" 2>/dev/null || true
  rm -rf "$VENV" "$WORK_DIR/venv-target"
}

# (a) 消せない世代があっても起動して結果を返す。消せたものだけ消え、残りは次回に消える。root は権限を無視するので飛ばす。
if [ "$(id -u)" -ne 0 ]; then
  reset_venv
  make_generation "$VENV/$GEN_A"
  make_generation "$VENV/$GEN_B"
  mkdir -p "$VENV/$GEN_A/locked"
  : > "$VENV/$GEN_A/locked/file"
  chmod a-w "$VENV/$GEN_A/locked"
  ln -s "$GEN_A" "$VENV/current"
  run_start
  assert_started "CUJ 9 消せない世代がある"
  [ -d "$VENV/$GEN_A/locked" ] || fail "CUJ 9 消せない世代が消えた"
  [ ! -e "$VENV/$GEN_B" ] || fail "CUJ 9 消せる世代が残った"
  [ -L "$VENV/current" ] || fail "CUJ 9 世代が残っているのに current を消した"
  chmod -R u+w "$VENV"
  run_start
  assert_started "CUJ 9 消せない世代が消せるようになった後"
  [ ! -e "$VENV" ] || fail "CUJ 9 消せるようになった次回の起動で venv が残った"
fi

# (b) venv が symlink なら、リンク先には何もしない。
reset_venv
mkdir -p "$WORK_DIR/venv-target"
make_generation "$WORK_DIR/venv-target/$GEN_A"
ln -s "$GEN_A" "$WORK_DIR/venv-target/current"
: > "$WORK_DIR/venv-target/.lock"
ln -s "$WORK_DIR/venv-target" "$VENV"
run_start
assert_started "CUJ 9 venv が symlink"
[ -f "$WORK_DIR/venv-target/$GEN_A/.pecot-complete" ] || fail "CUJ 9 symlink の先の世代を消した"
[ -L "$WORK_DIR/venv-target/current" ] && [ -e "$WORK_DIR/venv-target/.lock" ] || fail "CUJ 9 symlink の先の current か .lock を消した"

# (c) 旧方式でないものは消さない。旧方式の世代と同居するときは、世代だけを消す。
reset_venv
mkdir -p "$VENV/notes" "$VENV/.stage-user"
: > "$VENV/README"
: > "$VENV/notes/memo"
run_start
assert_started "CUJ 9 旧方式でない venv"
{ [ -f "$VENV/README" ] && [ -f "$VENV/notes/memo" ] && [ -d "$VENV/.stage-user" ]; } || fail "CUJ 9 旧方式でないものを消した"
make_generation "$VENV/$GEN_A"
ln -s "$GEN_A" "$VENV/current"
run_start
assert_started "CUJ 9 旧方式と同居"
[ ! -e "$VENV/$GEN_A" ] || fail "CUJ 9 同居する旧方式の世代が残った"
{ [ -f "$VENV/README" ] && [ -f "$VENV/notes/memo" ]; } || fail "CUJ 9 同居する旧方式でないものを消した"

# (d) 旧版のロックを持つプロセスがいる間は消さない。放すと次回に消える。
if command -v flock >/dev/null 2>&1; then
  reset_venv
  make_generation "$VENV/$GEN_A"
  mkdir -p "$VENV/.stage-building"
  : > "$VENV/.lock"
  start_holder "$VENV/.lock" -x
  run_start
  assert_started "CUJ 9 旧版のロックが取られている"
  { [ -d "$VENV/$GEN_A" ] && [ -d "$VENV/.stage-building" ]; } || fail "CUJ 9 旧版がロックを持つ間に、作成中のものを消した"
  stop_holder
  run_start
  assert_started "CUJ 9 旧版のロックが放された後"
  [ ! -e "$VENV" ] || fail "CUJ 9 旧版のロックが放された次回の起動で venv が残った"

  # (e) flock の無い環境では、ロックを見ずに消す（使用中でも消える）。
  reset_venv
  make_generation "$VENV/$GEN_A"
  : > "$VENV/.lock"
  start_holder "$VENV/$GEN_A/.inuse" -s
  NOFLOCK_BIN="$WORK_DIR/noflock-bin"
  make_filtered_bin "$NOFLOCK_BIN" flock
  if env PATH="$NOFLOCK_BIN" bash --noprofile --norc -c 'command -v flock' >/dev/null 2>&1; then
    fail "CUJ 9 の PATH に flock が残っている"
  fi
  run_start PATH="$NOFLOCK_BIN"
  assert_started "CUJ 9 flock の無い環境"
  [ ! -e "$VENV" ] || fail "CUJ 9 flock の無い環境で、古い世代がロックを見ずに消えていない"
  stop_holder
fi
reset_venv
echo "[bootstrap-test] CUJ 9 pass"

echo "[bootstrap-test] all CUJ passed"
