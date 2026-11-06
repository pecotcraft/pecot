#!/usr/bin/env bash
# bin/pecot-tools / .mcp.json / setup.sh の CUJ テスト（pecotv の cli/tests/bootstrap/run.sh の最小版）。
#
# vitest は `dist/cli.js` を直接起動する。
# そのため、手前にある bash wrapper と登録ファイルには検証が掛からない。
# ここで押さえるのは 6 つ。
#   CUJ 1  .mcp.json の登録内容（command / args）と、置換後パスが実行可能なこと。
#   CUJ 2  初回の `bin/pecot-tools mcp` が、データ置き場に実行用ミラーを作る（install + build）。
#          MCP サーバとして応答し、stdout が JSON-RPC 専有のまま、stdin の EOF で 0 終了すること。
#   CUJ 3  2 回目の起動は準備（install / build）をしないこと。
#   CUJ 4  ソースだけを変えた複製で起動すると、install なしの build だけを実行する。
#          stdout が JSON-RPC 専有のままであること。
#   CUJ 5  クライアントが置き場を渡さない起動（変数なし）は、標準の場所に実行用ミラーを作る。
#          標準の場所は ${XDG_DATA_HOME}/pecot/pecot-tools。
#   CUJ 6  pnpm と corepack が無く、npx だけある環境（Node.js 25 以降）で、npx 経由の pnpm が install と build を完走する。
#          プラグインのルートの package.json は devEngines で pnpm を宣言しているため、cwd を / にして npx を呼ぶ形でないと止まる。
#
# 依存と build 成果物はプラグインのデータ置き場（${データ置き場}/runtime/<hash>/）に作る。
# 本体のワークツリーには node_modules・dist を作らず、触れない（書き込みが無いことを確かめる）。
# データ置き場は $WORK_DIR 配下の一時ディレクトリで、CLAUDE_PLUGIN_DATA で渡す。
# XDG_DATA_HOME は付け替えない。pnpm の store の置き場まで動くため。CUJ 5 だけが子プロセスに渡す。
# CUJ 4 は、プラグインルートの複製で行う。
# 複製するのは、ミラーの入力（bin/_lib.sh の plugin_runtime_deps_files と plugin_runtime_src_files）と wrapper だけ。
# 複製元のソースは書き換えない。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT/../.." && pwd)"
MCP_JSON="$PLUGIN_ROOT/.mcp.json"

# .pecot/work/ 直下は Issue 番号のみ（CLAUDE.md「作業ファイルの置き場所」）。
# そのためタスク非紐付けのテストハーネス scratch は、システム中間領域 .pecot/tmp/ に置く（pecotv と同じ）。
WORK_DIR="$REPO_ROOT/.pecot/tmp/pecot-tools-bootstrap-test"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

# 親シェルが bootstrap 済みフラグを持っていると、CUJ 3 の再ビルドの判定が通過してしまう。
unset PECOT_TOOLS_BOOTSTRAP_SKIP PECOT_TOOLS_BOOTSTRAP_FORCE PECOT_TOOLS_RUNTIME_DIR PLUGIN_DATA
# プラグインのデータ置き場（実行用ミラーの置き場）。親シェルの値は使わず、ここで作る一時ディレクトリを使う。
DATA_DIR="$WORK_DIR/data"
mkdir -p "$DATA_DIR"
export CLAUDE_PLUGIN_DATA="$DATA_DIR"

cleanup() {
  local exit_code=$?
  rm -rf "$WORK_DIR" >/dev/null 2>&1 || true
  exit "$exit_code"
}
trap cleanup EXIT

fail() {
  echo "[bootstrap-test] FAIL: $*" >&2
  exit 1
}

assert_exit_zero() {
  local code="$1"; local label="$2"
  if [ "$code" -ne 0 ]; then
    fail "$label (exit=$code)"
  fi
}

# protocolVersion は SDK の LATEST_PROTOCOL_VERSION に追従させない。MCP サーバは未知の版を
# 受けても自身が話せる版を result で返す仕様のため、リテラル固定でも initialize は成立する。
INITIALIZE_REQUEST='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"bootstrap-test","version":"0.0.0"}}}'
INITIALIZED_NOTIFICATION='{"jsonrpc":"2.0","method":"notifications/initialized"}'
TOOLS_LIST_REQUEST='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# 応答 2 行（initialize と tools/list）が揃うまで待って stdin を閉じる。
# 終了コードは MCP_EXIT_CODE に残す。第 4 引数でプラグインルートを差し替えられる
# （既定はワークツリー。差し替えたときは wrapper が使うルートを CLAUDE_PLUGIN_ROOT でも示す）。
MCP_EXIT_CODE=0
run_mcp_exchange() {
  local stdout_file="$1"; local stderr_file="$2"; local wait_seconds="$3"
  local root="${4:-$PLUGIN_ROOT}"
  local fifo="$WORK_DIR/mcp.stdin.fifo"
  local pid deadline

  rm -f "$fifo" "$stdout_file" "$stderr_file"
  mkfifo "$fifo"

  set +e
  CLAUDE_PLUGIN_ROOT="$root" "$root/bin/pecot-tools" mcp <"$fifo" >"$stdout_file" 2>"$stderr_file" &
  pid=$!
  # fd 7 を writer として保持し続けることで stdin の EOF を保留する。request を投げた直後に
  # 閉じると、bootstrap 完了前に EOF が届いて server が応答前に close する可能性がある。
  exec 7>"$fifo"
  printf '%s\n' "$INITIALIZE_REQUEST" >&7
  printf '%s\n' "$INITIALIZED_NOTIFICATION" >&7
  printf '%s\n' "$TOOLS_LIST_REQUEST" >&7
  deadline=$(( $(date +%s) + wait_seconds ))
  while [ "$(wc -l < "$stdout_file")" -lt 2 ] && [ "$(date +%s)" -le "$deadline" ]; do
    sleep 0.5
  done
  # 応答行の write が途中で観測されないよう僅かに待ってから EOF を送る。
  sleep 0.5
  exec 7>&-
  wait "$pid"
  MCP_EXIT_CODE=$?
  set -e

  rm -f "$fifo"
}

# stdout の全行が JSON-RPC で、tools/list が契約の 26 件を表の順で返していることを見る。
# 非 JSON 行（bootstrap の進捗が混入する等）があれば JSON.parse が throw して失敗する。
assert_json_rpc_stdout() {
  local stdout_file="$1"; local label="$2"
  node -e '
    const fs = require("node:fs");
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
    if (!Array.isArray(tools) || tools.length !== 26) {
      console.error(`tools/list did not return 26 tools: ${Array.isArray(tools) ? tools.length : "none"}`);
      process.exit(1);
    }
    if (tools[0].name !== "aws_sso_login") {
      console.error(`first tool is not in contract order: ${tools[0].name}`);
      process.exit(1);
    }
  ' "$stdout_file" || fail "$label"
}

echo "[bootstrap-test] CUJ 1: .mcp.json registration"
MCP_COMMAND="$(node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const server = (manifest.mcpServers || {})["pecot-tools"];
  if (!server) { console.error("mcpServers.pecot-tools がありません"); process.exit(1); }
  process.stdout.write(String(server.command));
' "$MCP_JSON")" || fail "CUJ 1 .mcp.json の読み出し"
MCP_ARGS="$(node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(JSON.stringify((manifest.mcpServers || {})["pecot-tools"].args));
' "$MCP_JSON")" || fail "CUJ 1 .mcp.json の読み出し"

if [ "$MCP_COMMAND" != '${CLAUDE_PLUGIN_ROOT}/bin/pecot-tools' ]; then
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

echo "[bootstrap-test] CUJ 2: first bin/pecot-tools mcp builds the runtime mirror and responds over stdio"
BEFORE_REF="$WORK_DIR/cuj2.before"
: > "$BEFORE_REF"
STDOUT2="$WORK_DIR/cuj2.stdout"
STDERR2="$WORK_DIR/cuj2.stderr"
run_mcp_exchange "$STDOUT2" "$STDERR2" 300
assert_exit_zero "$MCP_EXIT_CODE" "CUJ 2 exit"
assert_json_rpc_stdout "$STDOUT2" "CUJ 2 stdout が JSON-RPC 専有でない ($STDERR2 を参照)"
if ! grep -qx 'pecot-tools: installing dependencies' "$STDERR2"; then
  fail "CUJ 2 で install が実行されていない（stderr に 'pecot-tools: installing dependencies' が無い）"
fi
if ! grep -qx 'pecot-tools: building' "$STDERR2"; then
  fail "CUJ 2 で build が実行されていない（stderr に 'pecot-tools: building' が無い）"
fi
CURRENT_DIR="$(readlink -f "$DATA_DIR/runtime/current")"
if [ ! -f "$CURRENT_DIR/.complete" ] || [ ! -f "$CURRENT_DIR/cli/dist/cli.js" ]; then
  fail "CUJ 2 の後に完成したミラーが無い: $DATA_DIR/runtime"
fi
# 本体のワークツリーには何も作らない。
for created in "$PLUGIN_ROOT/.pecot-tools-bootstrap.lock"; do
  if [ -n "$(find "$created" -newer "$BEFORE_REF" 2>/dev/null || true)" ]; then
    fail "CUJ 2 が本体に旧配置のロックを作った: $created"
  fi
done
TOUCHED="$(find "$PLUGIN_ROOT/node_modules/.modules.yaml" "$PLUGIN_ROOT/cli/dist/cli.js" "$PLUGIN_ROOT/runtime-lock.yaml" -newer "$BEFORE_REF" 2>/dev/null || true)"
if [ -n "$TOUCHED" ]; then
  fail "CUJ 2 が本体へ書き込んだ: $TOUCHED"
fi
echo "[bootstrap-test] CUJ 2 pass"

echo "[bootstrap-test] CUJ 3: second bin/pecot-tools mcp does not install or build"
STDOUT3="$WORK_DIR/cuj3.stdout"
STDERR3="$WORK_DIR/cuj3.stderr"
run_mcp_exchange "$STDOUT3" "$STDERR3" 60
assert_exit_zero "$MCP_EXIT_CODE" "CUJ 3 exit"
assert_json_rpc_stdout "$STDOUT3" "CUJ 3 stdout が JSON-RPC 専有でない ($STDERR3 を参照)"
if grep -qE '^pecot-tools: (installing dependencies|building)$' "$STDERR3"; then
  fail "CUJ 3 で準備がやり直された ($STDERR3 を参照)"
fi
if [ "$(readlink -f "$DATA_DIR/runtime/current")" != "$CURRENT_DIR" ]; then
  fail "CUJ 3 で current が動いた"
fi
echo "[bootstrap-test] CUJ 3 pass"

echo "[bootstrap-test] CUJ 4: source-only change builds without install and keeps stdout JSON-RPC only"
# shellcheck source=../../../bin/_lib.sh
. "$PLUGIN_ROOT/bin/_lib.sh"
COPY_ROOT="$WORK_DIR/plugin-copy"
mkdir -p "$COPY_ROOT"
{
  plugin_runtime_deps_files "$PLUGIN_ROOT"
  plugin_runtime_src_files "$PLUGIN_ROOT"
  printf '%s\n' bin/pecot-tools bin/_lib.sh .claude-plugin/plugin.json
} | LC_ALL=C sort -u | (cd "$PLUGIN_ROOT" && tar -cf - -T -) | (cd "$COPY_ROOT" && tar -xf -)
printf '\n// source-only change\n' >> "$COPY_ROOT/cli/src/version.ts"
STDOUT4="$WORK_DIR/cuj4.stdout"
STDERR4="$WORK_DIR/cuj4.stderr"
run_mcp_exchange "$STDOUT4" "$STDERR4" 300 "$COPY_ROOT"
assert_exit_zero "$MCP_EXIT_CODE" "CUJ 4 exit"
assert_json_rpc_stdout "$STDOUT4" "CUJ 4 stdout に build の出力が漏れている ($STDERR4 を参照)"
if grep -qx 'pecot-tools: installing dependencies' "$STDERR4"; then
  fail "CUJ 4 でソースだけの変更なのに install が実行された ($STDERR4 を参照)"
fi
if ! grep -qx 'pecot-tools: building' "$STDERR4"; then
  fail "CUJ 4 で build が実行されていない（stderr に 'pecot-tools: building' が無い）"
fi
if [ "$(readlink -f "$DATA_DIR/runtime/current")" = "$CURRENT_DIR" ]; then
  fail "CUJ 4 で current が新しいミラーに切り替わっていない"
fi
if [ ! -f "$CURRENT_DIR/cli/dist/cli.js" ]; then
  fail "CUJ 4 が旧ミラーを壊した: $CURRENT_DIR"
fi
if [ -e "$COPY_ROOT/node_modules" ] || [ -e "$COPY_ROOT/cli/dist" ]; then
  fail "CUJ 4 が複製したプラグインルートに node_modules / cli/dist を作った"
fi
echo "[bootstrap-test] CUJ 4 pass"

# CUJ 5: クライアントが置き場を渡さない起動（Bash から呼ぶ・単体配布）は、標準の場所に実行用ミラーを作る。
# CLAUDE_PLUGIN_DATA / PLUGIN_DATA を外し、XDG_DATA_HOME を一時ディレクトリへ向ける。
# その状態で標準の場所を確かめる（実ホームの ~/.local/share には書かない）。
# XDG_DATA_HOME は pnpm の store の置き場も動かす。
# そのため子プロセスだけに、元の store を npm_config_store_dir で渡す。
echo "[bootstrap-test] CUJ 5: default data directory when no variable is given"
PNPM_CMD="$(resolve_pnpm "$PLUGIN_ROOT")"
# shellcheck disable=SC2086
PNPM_STORE="$(cd "$PLUGIN_ROOT" && $PNPM_CMD store path)" || fail "CUJ 5 pnpm の store を調べられない"
XDG_DIR="$WORK_DIR/xdg-share"
STDERR5="$WORK_DIR/cuj5.stderr"
set +e
env -u CLAUDE_PLUGIN_DATA -u PLUGIN_DATA XDG_DATA_HOME="$XDG_DIR" npm_config_store_dir="$PNPM_STORE" \
  CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" "$PLUGIN_ROOT/bin/pecot-tools" --help >/dev/null 2>"$STDERR5"
code=$?
set -e
assert_exit_zero "$code" "CUJ 5 exit ($STDERR5 を参照)"
DEFAULT_CURRENT="$(readlink -f "$XDG_DIR/pecot/pecot-tools/runtime/current")"
if [ ! -f "$DEFAULT_CURRENT/cli/dist/cli.js" ]; then
  fail "CUJ 5 が既定の場所にミラーを作っていない: $XDG_DIR/pecot/pecot-tools/runtime"
fi
echo "[bootstrap-test] CUJ 5 pass"

# CUJ 6: pnpm 無し / corepack 無し / npx あり（Node.js 25 以降の corepack 非同梱環境）。
# node + npm + npx だけの bin dir で起動し、install と build が npx 経由の pnpm で完走することを確かめる。
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
    "$PLUGIN_ROOT/bin/pecot-tools" --help >/dev/null 2>"$STDERR6"
  code=$?
  set -e
  if [ "$code" -ne 0 ]; then
    sed -n '1,40p' "$STDERR6" >&2
    fail "CUJ 6 exit=$code (expected 0)"
  fi
  grep -q '^pecot-tools: installing dependencies$' "$STDERR6" || fail "CUJ 6 が npx 経由で install していない"
  grep -q '^pecot-tools: building$' "$STDERR6" || fail "CUJ 6 が npx 経由で build していない"
fi
echo "[bootstrap-test] CUJ 6 pass"

echo "[bootstrap-test] all CUJ passed"
