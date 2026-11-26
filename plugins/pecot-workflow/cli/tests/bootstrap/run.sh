#!/usr/bin/env bash
# bin/pecot と .mcp.json の CUJ テスト（実 pnpm と実 build。pecot-tools の run.sh と同型）。
# 登録・初回の build・2 回目・ソースだけの変更・既定の置き場・npx だけの環境・Node の無い環境・ルートの解決・旧方式の venv の片づけを確かめる。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT/../.." && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
MCP_JSON="$PLUGIN_ROOT/.mcp.json"
TOOL_COUNT=45

WORK_DIR="$REPO_ROOT/.pecot/tmp/pecot-workflow-bootstrap-test"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

unset PECOT_BOOTSTRAP_SKIP PECOT_BOOTSTRAP_FORCE PLUGIN_DATA
DATA_DIR="$WORK_DIR/data"
mkdir -p "$DATA_DIR"
export CLAUDE_PLUGIN_DATA="$DATA_DIR"

HOLDER_PID=""
MCP_PID=""
LAST_STDERR=""
cleanup() {
  local exit_code=$?
  [ -z "$HOLDER_PID" ] || kill "$HOLDER_PID" 2>/dev/null || true
  [ -z "$MCP_PID" ] || kill "$MCP_PID" 2>/dev/null || true
  # $WORK_DIR を消すと CI から読めなくなるため、失敗時は最後に書いた stderr を先に出す。
  if [ "$exit_code" -ne 0 ] && [ -f "$LAST_STDERR" ]; then
    echo "--- $LAST_STDERR (末尾 40 行) ---" >&2
    tail -n 40 "$LAST_STDERR" >&2
  fi
  chmod -R u+w "$WORK_DIR" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR" >/dev/null 2>&1 || true
  exit "$exit_code"
}
trap cleanup EXIT

# 前提が崩れたら止める。bt_finish まで届かないので、broken として出る。
die() {
  echo "[bootstrap-test] $*" >&2
  exit 1
}

# ファイルにロックを保持する子プロセスを起こす（$1 = ロックするファイル、$2 = flock の種類 -s か -x）。
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
  die "ロックの保持者がロックを取れなかった: $1"
}

stop_holder() {
  [ -z "$HOLDER_PID" ] || kill "$HOLDER_PID" 2>/dev/null || true
  wait "$HOLDER_PID" 2>/dev/null || true
  HOLDER_PID=""
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

# has_line <ファイル> <行>: yes / no
has_line() { if grep -qx -- "$2" "$1"; then echo yes; else echo no; fi; }
# exists <パス>: yes / no
exists() { if [ -e "$1" ] || [ -L "$1" ]; then echo yes; else echo no; fi; }

INITIALIZE_REQUEST='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"bootstrap-test","version":"0.0.0"}}}'
INITIALIZED_NOTIFICATION='{"jsonrpc":"2.0","method":"notifications/initialized"}'
TOOLS_LIST_REQUEST='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# 応答 2 行（initialize と tools/list）が揃うまで待って stdin を閉じ、終了コードを MCP_EXIT_CODE に残す。
# 第 4 引数でプラグインルートを差し替えられる。EXCHANGE_ENV に `VAR=値` を並べると、wrapper の環境に足す。
MCP_EXIT_CODE=0
EXCHANGE_ENV=()
run_mcp_exchange() {
  local stdout_file="$1"; local stderr_file="$2"; local wait_seconds="$3"
  local root="${4:-$PLUGIN_ROOT}"
  local fifo="$WORK_DIR/mcp.stdin.fifo"
  local pid deadline exit_deadline

  rm -f "$fifo" "$stdout_file" "$stderr_file"
  LAST_STDERR="$stderr_file"
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
  # EOF の後に終わらないものは、30 秒で止めて終了コードの確かめで落とす。
  exit_deadline=$(( $(date +%s) + 30 ))
  while kill -0 "$pid" 2>/dev/null && [ "$(date +%s)" -le "$exit_deadline" ]; do
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid"
    MCP_EXIT_CODE="stdin の EOF の後も終わらない（stderr: $stderr_file）"
  else
    wait "$pid"
    MCP_EXIT_CODE=$?
  fi
  MCP_PID=""
  set -e

  rm -f "$fifo"
}

# expect_json_rpc_stdout <題> <stdout のファイル>: 全行が JSON-RPC で、tools/list が $TOOL_COUNT 件を返す。
expect_json_rpc_stdout() {
  local title="$1" stdout_file="$2" reason
  if reason="$(node -e '
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
    for (const required of ["board_show", "issue_show", "pr_create"]) {
      if (!names.includes(required)) { console.error(`tools/list lacks ${required}`); process.exit(1); }
    }
  ' "$stdout_file" "$TOOL_COUNT" 2>&1)"; then
    bt_pass "$title"
  else
    bt_fail "$title" "$reason"
  fi
}

echo "[bootstrap-test] CUJ 1: .mcp.json registration"
MCP_COMMAND="$(node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const server = (manifest.mcpServers || {})["pecot-workflow"];
  if (!server) { console.error("mcpServers.pecot-workflow がありません"); process.exit(1); }
  process.stdout.write(String(server.command));
' "$MCP_JSON")" || die "CUJ 1 .mcp.json を読めない"
MCP_ARGS="$(node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(JSON.stringify((manifest.mcpServers || {})["pecot-workflow"].args));
' "$MCP_JSON")" || die "CUJ 1 .mcp.json を読めない"

# shellcheck disable=SC2016 # 置換前の文字列そのものと比べる
bt_eq 'CUJ 1: command は ${CLAUDE_PLUGIN_ROOT}/bin/pecot' '${CLAUDE_PLUGIN_ROOT}/bin/pecot' "$MCP_COMMAND"
bt_eq 'CUJ 1: args は ["mcp"]' '["mcp"]' "$MCP_ARGS"
RESOLVED_COMMAND="${MCP_COMMAND/'${CLAUDE_PLUGIN_ROOT}'/$PLUGIN_ROOT}"
if [ -x "$RESOLVED_COMMAND" ]; then
  bt_pass "CUJ 1: 置換後のパスが実行可能"
else
  bt_fail "CUJ 1: 置換後のパスが実行可能" "実行できない: $RESOLVED_COMMAND"
fi

# pnpm の store の位置は、HOME / XDG_DATA_HOME を付け替える起動の前に調べておく。
# shellcheck source=../../../bin/_lib.sh
. "$PLUGIN_ROOT/bin/_lib.sh"
PNPM_CMD="$(resolve_pnpm "$PLUGIN_ROOT")"
# shellcheck disable=SC2086
PNPM_STORE="$(cd "$PLUGIN_ROOT" && $PNPM_CMD store path)" || die "pnpm の store を調べられない"

echo "[bootstrap-test] CUJ 2: first bin/pecot mcp builds the runtime mirror without python/uv and removes the old venvs"
NOPY_BIN="$WORK_DIR/nopy-bin"
make_filtered_bin "$NOPY_BIN" 'python*' 'uv' 'uvx' 'pip*'
if env PATH="$NOPY_BIN" bash --noprofile --norc -c 'command -v python3 python uv uvx' >/dev/null 2>&1; then
  die "CUJ 2 の PATH に python / uv が残っている"
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
bt_eq "CUJ 2: stdin の EOF の後に 0 で終わる" 0 "$MCP_EXIT_CODE"
expect_json_rpc_stdout "CUJ 2: stdout は JSON-RPC 専有" "$STDOUT2"
bt_eq "CUJ 2: install を実行する（stderr に pecot: installing dependencies）" yes "$(has_line "$STDERR2" 'pecot: installing dependencies')"
bt_eq "CUJ 2: build を実行する（stderr に pecot: building）" yes "$(has_line "$STDERR2" 'pecot: building')"
CURRENT_DIR="$(readlink -f "$DATA_DIR/runtime/current")"
bt_eq "CUJ 2: 完成したミラーがある" yes "$([ -f "$CURRENT_DIR/.complete" ] && [ -f "$CURRENT_DIR/cli/dist/cli.js" ] && echo yes || echo no)"
PLUGIN_STATE_AFTER="$(git -C "$REPO_ROOT" status --porcelain --ignored -- plugins/pecot-workflow)"
if [ "$PLUGIN_STATE_BEFORE" = "$PLUGIN_STATE_AFTER" ]; then
  bt_pass "CUJ 2: 本体へ書き込まない"
else
  PLUGIN_STATE_DIFF="$(diff <(printf '%s\n' "$PLUGIN_STATE_BEFORE") <(printf '%s\n' "$PLUGIN_STATE_AFTER") || true)"
  bt_fail "CUJ 2: 本体へ書き込まない" "git status が変わった: $PLUGIN_STATE_DIFF"
fi
for generation in aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb cccccccccccccccc-dddddddddddddddd; do
  bt_eq "CUJ 2: 解決した置き場の venv の世代 $generation を消す" no "$(exists "$DATA_DIR/venv/$generation")"
done
bt_eq "CUJ 2: 解決した置き場の空の venv を消す" no "$(exists "$DATA_DIR/venv")"
bt_eq "CUJ 2: 既定の場所の使用中でない venv の世代を消す" no "$(exists "$DEFAULT_DATA/venv/aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb")"
if [ -n "$HOLDER_PID" ]; then
  bt_eq "CUJ 2: 使用中の世代は消さない" yes "$([ -d "$HOLD_DIR" ] && echo yes || echo no)"
  stop_holder
  # 使用中でなくなった世代は、次回の起動で消える（この起動は準備済みなので、片づけだけを行う）。
  EXCHANGE_ENV=("${CUJ2_ENV[@]}")
  run_mcp_exchange "$WORK_DIR/cuj2b.stdout" "$WORK_DIR/cuj2b.stderr" 60
  EXCHANGE_ENV=()
  bt_eq "CUJ 2: 次回の起動が 0 で終わる" 0 "$MCP_EXIT_CODE"
  bt_eq "CUJ 2: 次回の起動で、使用中でなくなった世代を消す" no "$(exists "$HOLD_DIR")"
else
  for title in "CUJ 2: 使用中の世代は消さない" "CUJ 2: 次回の起動が 0 で終わる" "CUJ 2: 次回の起動で、使用中でなくなった世代を消す"; do
    bt_skip "$title" "flock(1) が無く、使用中の世代を作れない"
  done
fi

echo "[bootstrap-test] CUJ 3: second bin/pecot mcp does not install or build"
STDOUT3="$WORK_DIR/cuj3.stdout"
STDERR3="$WORK_DIR/cuj3.stderr"
run_mcp_exchange "$STDOUT3" "$STDERR3" 60
bt_eq "CUJ 3: stdin の EOF の後に 0 で終わる" 0 "$MCP_EXIT_CODE"
expect_json_rpc_stdout "CUJ 3: stdout は JSON-RPC 専有" "$STDOUT3"
bt_eq "CUJ 3: 準備（install / build）をやり直さない" 0 "$(grep -cE '^pecot: (installing dependencies|building)$' "$STDERR3" || true)"
bt_eq "CUJ 3: current は動かない" "$CURRENT_DIR" "$(readlink -f "$DATA_DIR/runtime/current")"

echo "[bootstrap-test] CUJ 4: source-only change builds without install and keeps stdout JSON-RPC only"
COPY_ROOT="$WORK_DIR/plugin-copy"
mkdir -p "$COPY_ROOT"
{
  plugin_runtime_deps_files "$PLUGIN_ROOT"
  plugin_runtime_src_files "$PLUGIN_ROOT"
  printf '%s\n' bin/pecot bin/_lib.sh .claude-plugin/plugin.json
} | LC_ALL=C sort -u | (cd "$PLUGIN_ROOT" && tar -cf - -T -) | (cd "$COPY_ROOT" && tar -xf -)
printf '\n// source-only change\n' >> "$COPY_ROOT/cli/src/cli.ts"
STDOUT4="$WORK_DIR/cuj4.stdout"
STDERR4="$WORK_DIR/cuj4.stderr"
run_mcp_exchange "$STDOUT4" "$STDERR4" 300 "$COPY_ROOT"
bt_eq "CUJ 4: stdin の EOF の後に 0 で終わる" 0 "$MCP_EXIT_CODE"
expect_json_rpc_stdout "CUJ 4: stdout に build の出力が漏れない" "$STDOUT4"
bt_eq "CUJ 4: ソースだけの変更では install しない" no "$(has_line "$STDERR4" 'pecot: installing dependencies')"
bt_eq "CUJ 4: build を実行する（stderr に pecot: building）" yes "$(has_line "$STDERR4" 'pecot: building')"
bt_ne "CUJ 4: current が新しいミラーに切り替わる" "$CURRENT_DIR" "$(readlink -f "$DATA_DIR/runtime/current")"
bt_eq "CUJ 4: 旧ミラーを壊さない" yes "$([ -f "$CURRENT_DIR/cli/dist/cli.js" ] && echo yes || echo no)"
bt_eq "CUJ 4: 複製したプラグインルートに node_modules / cli/dist を作らない" no \
  "$([ -e "$COPY_ROOT/node_modules" ] || [ -e "$COPY_ROOT/cli/dist" ] && echo yes || echo no)"

# CUJ 5: クライアントが置き場を渡さない起動は、標準の場所（${XDG_DATA_HOME}/pecot/pecot-workflow）に実行用ミラーを作る。
echo "[bootstrap-test] CUJ 5: default data directory when no variable is given"
XDG_DIR="$WORK_DIR/xdg-share"
STDERR5="$WORK_DIR/cuj5.stderr"
LAST_STDERR="$STDERR5"
set +e
env -u CLAUDE_PLUGIN_DATA -u PLUGIN_DATA XDG_DATA_HOME="$XDG_DIR" npm_config_store_dir="$PNPM_STORE" \
  CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" "$PLUGIN_ROOT/bin/pecot" --help >/dev/null 2>"$STDERR5"
code=$?
set -e
bt_eq "CUJ 5: 終了コードは 0" 0 "$code"
DEFAULT_CURRENT="$(readlink -f "$XDG_DIR/pecot/pecot-workflow/runtime/current" || true)"
bt_eq "CUJ 5: 既定の場所にミラーを作る" yes "$([ -f "$DEFAULT_CURRENT/cli/dist/cli.js" ] && echo yes || echo no)"

# CUJ 6: pnpm 無し / corepack 無し / npx あり（Node.js 25 以降の corepack 非同梱環境）。
# 隔離 HOME のため npx は pnpm の tarball を毎回取得する（ネット依存）。
echo "[bootstrap-test] CUJ 6: npx fallback (no pnpm, no corepack)"
NPM_PATH="$(command -v npm 2>/dev/null || true)"
NPX_PATH="$(command -v npx 2>/dev/null || true)"
if [ -z "$NPM_PATH" ] || [ -z "$NPX_PATH" ]; then
  for title in "CUJ 6: 終了コードは 0" "CUJ 6: npx 経由で install する" "CUJ 6: npx 経由で build する"; do
    bt_skip "$title" "npm / npx が無い環境"
  done
else
  ISO_BIN_NODE_NPX="$WORK_DIR/iso-bin-node-npx"
  ISO_HOME="$WORK_DIR/iso-home-npx"
  DATA_DIR_6="$WORK_DIR/data-npx"
  mkdir -p "$ISO_BIN_NODE_NPX" "$ISO_HOME" "$DATA_DIR_6"
  ln -s "$(command -v node)" "$ISO_BIN_NODE_NPX/node"
  ln -s "$NPM_PATH" "$ISO_BIN_NODE_NPX/npm"
  ln -s "$NPX_PATH" "$ISO_BIN_NODE_NPX/npx"
  STDERR6="$WORK_DIR/cuj6.stderr"
  LAST_STDERR="$STDERR6"
  set +e
  env -i CLAUDE_PLUGIN_DATA="$DATA_DIR_6" HOME="$ISO_HOME" PATH="$ISO_BIN_NODE_NPX:/usr/bin:/bin" \
    "$PLUGIN_ROOT/bin/pecot" --help >/dev/null 2>"$STDERR6"
  code=$?
  set -e
  if [ "$code" -eq 0 ]; then
    bt_pass "CUJ 6: 終了コードは 0"
  else
    bt_fail "CUJ 6: 終了コードは 0" "exit=$code
$(sed -n '1,40p' "$STDERR6")"
  fi
  bt_eq "CUJ 6: npx 経由で install する" yes "$(has_line "$STDERR6" 'pecot: installing dependencies')"
  bt_eq "CUJ 6: npx 経由で build する" yes "$(has_line "$STDERR6" 'pecot: building')"
fi

# CUJ 7: Node / npm / npx / pnpm / corepack の無い PATH では、理由の行を出して非 0 で止まる。何も実行しない。
echo "[bootstrap-test] CUJ 7: no Node on PATH stops with a reason"
NONODE_BIN="$WORK_DIR/nonode-bin"
make_filtered_bin "$NONODE_BIN" node npm npx pnpm corepack
DATA_DIR_7="$WORK_DIR/data-nonode"
STDERR7="$WORK_DIR/cuj7.stderr"
LAST_STDERR="$STDERR7"
set +e
env PATH="$NONODE_BIN" CLAUDE_PLUGIN_DATA="$DATA_DIR_7" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
  "$PLUGIN_ROOT/bin/pecot" --help >"$WORK_DIR/cuj7.stdout" 2>"$STDERR7"
code=$?
set -e
bt_ne "CUJ 7: Node の無い PATH では非 0 で終わる" 0 "$code"
bt_contains "CUJ 7: stderr に pnpm / corepack / npx not found がある" 'pnpm / corepack / npx not found' "$(sed -n '1,20p' "$STDERR7")"
bt_eq "CUJ 7: stdout に出力しない" "" "$(cat "$WORK_DIR/cuj7.stdout")"
bt_eq "CUJ 7: 完成したミラーを作らない" "" "$(find "$DATA_DIR_7/runtime" -name .complete 2>/dev/null || true)"

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
code=0
OUT_INVALID="$(run_version CLAUDE_PLUGIN_ROOT="$WORK_DIR/not-a-plugin" "$RESOLVE_ROOT/bin/pecot" --version)" || code=$?
bt_eq "CUJ 8: 無効な CLAUDE_PLUGIN_ROOT でも起動する" 0 "$code"
bt_contains "CUJ 8: 無効な CLAUDE_PLUGIN_ROOT では wrapper の位置から解決する" "$VERSION_OF_ROOT" "$OUT_INVALID"
# symlink 経由で起動しても、実体の位置から解決する。
mkdir -p "$WORK_DIR/link-bin"
ln -s "$RESOLVE_ROOT/bin/pecot" "$WORK_DIR/link-bin/pecot"
code=0
OUT_LINK="$(run_version "$WORK_DIR/link-bin/pecot" --version)" || code=$?
bt_eq "CUJ 8: symlink 経由で起動する" 0 "$code"
bt_contains "CUJ 8: symlink 経由では実体の位置から解決する" "$VERSION_OF_ROOT" "$OUT_LINK"
# 読み取り専用のルートでも、初回の準備ができる（本体には何も書かない）。
READONLY_DATA="$WORK_DIR/data-readonly"
chmod -R a-w "$RESOLVE_ROOT"
set +e
LAST_STDERR="$WORK_DIR/cuj8.stderr"
OUT_RO="$(env -u CLAUDE_PLUGIN_ROOT CLAUDE_PLUGIN_DATA="$READONLY_DATA" "$RESOLVE_ROOT/bin/pecot" --version 2>"$WORK_DIR/cuj8.stderr")"
code=$?
set -e
chmod -R u+w "$RESOLVE_ROOT"
bt_eq "CUJ 8: 読み取り専用のルートで起動する" 0 "$code"
bt_contains "CUJ 8: 読み取り専用のルートで版を返す" "$VERSION_OF_ROOT" "$OUT_RO"
bt_eq "CUJ 8: 読み取り専用のルートに node_modules を作らない" no "$(exists "$RESOLVE_ROOT/node_modules")"

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
LAST_STDERR="$WORK_DIR/cuj9.stderr"
# run_start [VAR=値 ...]: 完成済みのミラーで bin/pecot --version を起動する。結果は RS_CODE と cuj9.stdout / cuj9.stderr に残す。
run_start() {
  RS_CODE=0
  LAST_STDERR="$WORK_DIR/cuj9.stderr"
  env -u CLAUDE_PLUGIN_ROOT HOME="$CUJ9_HOME" XDG_DATA_HOME= npm_config_store_dir="$PNPM_STORE" "$@" \
    "$PLUGIN_ROOT/bin/pecot" --version >"$WORK_DIR/cuj9.stdout" 2>"$WORK_DIR/cuj9.stderr" </dev/null || RS_CODE=$?
}
# expect_started <題の頭>: 直前の run_start が起動して版を返した。
expect_started() {
  if [ "$RS_CODE" -eq 0 ]; then
    bt_pass "$1: 起動する"
  else
    bt_fail "$1: 起動する" "exit=$RS_CODE
$(sed -n '1,20p' "$WORK_DIR/cuj9.stderr")"
  fi
  bt_contains "$1: 版を返す" "$VERSION_OF_PLUGIN" "$(cat "$WORK_DIR/cuj9.stdout")"
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
  expect_started "CUJ 9 (a) 消せない世代がある"
  bt_eq "CUJ 9 (a): 消せない世代は残る" yes "$([ -d "$VENV/$GEN_A/locked" ] && echo yes || echo no)"
  bt_eq "CUJ 9 (a): 消せる世代は消える" no "$(exists "$VENV/$GEN_B")"
  bt_eq "CUJ 9 (a): 世代が残っている間は current を消さない" yes "$([ -L "$VENV/current" ] && echo yes || echo no)"
  chmod -R u+w "$VENV"
  run_start
  expect_started "CUJ 9 (a) 消せるようになった後"
  bt_eq "CUJ 9 (a): 消せるようになった次回の起動で venv を消す" no "$(exists "$VENV")"
else
  for title in "CUJ 9 (a) 消せない世代がある: 起動する" "CUJ 9 (a) 消せない世代がある: 版を返す" \
    "CUJ 9 (a): 消せない世代は残る" "CUJ 9 (a): 消せる世代は消える" "CUJ 9 (a): 世代が残っている間は current を消さない" \
    "CUJ 9 (a) 消せるようになった後: 起動する" "CUJ 9 (a) 消せるようになった後: 版を返す" \
    "CUJ 9 (a): 消せるようになった次回の起動で venv を消す"; do
    bt_skip "$title" "root は権限を無視するので、消せない世代を作れない"
  done
fi

# (b) venv が symlink なら、リンク先には何もしない。
reset_venv
mkdir -p "$WORK_DIR/venv-target"
make_generation "$WORK_DIR/venv-target/$GEN_A"
ln -s "$GEN_A" "$WORK_DIR/venv-target/current"
: > "$WORK_DIR/venv-target/.lock"
ln -s "$WORK_DIR/venv-target" "$VENV"
run_start
expect_started "CUJ 9 (b) venv が symlink"
bt_eq "CUJ 9 (b): symlink の先の世代を消さない" yes "$([ -f "$WORK_DIR/venv-target/$GEN_A/.pecot-complete" ] && echo yes || echo no)"
bt_eq "CUJ 9 (b): symlink の先の current と .lock を消さない" yes \
  "$([ -L "$WORK_DIR/venv-target/current" ] && [ -e "$WORK_DIR/venv-target/.lock" ] && echo yes || echo no)"

# (c) 旧方式でないものは消さない。旧方式の世代と同居するときは、世代だけを消す。
reset_venv
mkdir -p "$VENV/notes" "$VENV/.stage-user"
: > "$VENV/README"
: > "$VENV/notes/memo"
run_start
expect_started "CUJ 9 (c) 旧方式でない venv"
bt_eq "CUJ 9 (c): 旧方式でないものを消さない" yes \
  "$([ -f "$VENV/README" ] && [ -f "$VENV/notes/memo" ] && [ -d "$VENV/.stage-user" ] && echo yes || echo no)"
make_generation "$VENV/$GEN_A"
ln -s "$GEN_A" "$VENV/current"
run_start
expect_started "CUJ 9 (c) 旧方式と同居"
bt_eq "CUJ 9 (c): 同居する旧方式の世代を消す" no "$(exists "$VENV/$GEN_A")"
bt_eq "CUJ 9 (c): 同居する旧方式でないものを消さない" yes "$([ -f "$VENV/README" ] && [ -f "$VENV/notes/memo" ] && echo yes || echo no)"

# (d) 旧版のロックを持つプロセスがいる間は消さない。放すと次回に消える。
if command -v flock >/dev/null 2>&1; then
  reset_venv
  make_generation "$VENV/$GEN_A"
  mkdir -p "$VENV/.stage-building"
  : > "$VENV/.lock"
  start_holder "$VENV/.lock" -x
  run_start
  expect_started "CUJ 9 (d) 旧版のロックが取られている"
  bt_eq "CUJ 9 (d): 旧版がロックを持つ間は、作成中のものを消さない" yes \
    "$([ -d "$VENV/$GEN_A" ] && [ -d "$VENV/.stage-building" ] && echo yes || echo no)"
  stop_holder
  run_start
  expect_started "CUJ 9 (d) 旧版のロックが放された後"
  bt_eq "CUJ 9 (d): 旧版のロックが放された次回の起動で venv を消す" no "$(exists "$VENV")"

  # (e) flock の無い環境では、ロックを見ずに消す（使用中でも消える）。
  reset_venv
  make_generation "$VENV/$GEN_A"
  : > "$VENV/.lock"
  start_holder "$VENV/$GEN_A/.inuse" -s
  NOFLOCK_BIN="$WORK_DIR/noflock-bin"
  make_filtered_bin "$NOFLOCK_BIN" flock
  if env PATH="$NOFLOCK_BIN" bash --noprofile --norc -c 'command -v flock' >/dev/null 2>&1; then
    die "CUJ 9 の PATH に flock が残っている"
  fi
  run_start PATH="$NOFLOCK_BIN"
  expect_started "CUJ 9 (e) flock の無い環境"
  bt_eq "CUJ 9 (e): flock の無い環境では、古い世代をロックを見ずに消す" no "$(exists "$VENV")"
  stop_holder
else
  for title in "CUJ 9 (d) 旧版のロックが取られている: 起動する" "CUJ 9 (d) 旧版のロックが取られている: 版を返す" \
    "CUJ 9 (d): 旧版がロックを持つ間は、作成中のものを消さない" \
    "CUJ 9 (d) 旧版のロックが放された後: 起動する" "CUJ 9 (d) 旧版のロックが放された後: 版を返す" \
    "CUJ 9 (d): 旧版のロックが放された次回の起動で venv を消す" \
    "CUJ 9 (e) flock の無い環境: 起動する" "CUJ 9 (e) flock の無い環境: 版を返す" \
    "CUJ 9 (e): flock の無い環境では、古い世代をロックを見ずに消す"; do
    bt_skip "$title" "flock(1) が無く、旧版のロックを持つプロセスを作れない"
  done
fi
reset_venv

bt_finish
