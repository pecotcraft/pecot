#!/usr/bin/env bash
# bin/pecotv self-bootstrap の bash 統合テスト。
#
# devcontainer rebuild 直後にユーザーが初めて `bin/pecotv` を叩いたシナリオを再現する。
# 実行は 1 コマンド: `bash plugins/pecot-visual/cli/tests/bootstrap/run.sh`。
#
# - 一時 git worktree を作成し、データ置き場の runtime/ を消して clean state を組む。
# - 隔離 HOME ($WORK_DIR/iso-home-*) を立てる。
#   HOME 依存リソース (pnpm store / corepack tarball cache / ~/.cache/ms-playwright 等) を隔離した状態で pecotv を起動する。
#   real HOME とは一切共有しない。
# - 依存と build 成果物はプラグインのデータ置き場の実行用ミラー（$DATA_DIR/runtime/<hash>/）に作られる。
#   cold 化は $DATA_DIR/runtime を消して行う（本体のワークツリーには node_modules・cli/dist を作らない）
# - その上で CUJ 1-14 + 静的確認する。PECOTV_BOOTSTRAP_FORCE による強制再実行ルートと
#   self-bootstrap 全体を first-time-user reproduction として観測する
#
# CI 組み込み時は CUJ 1 の chromium DL コスト(~120MB)を再評価のこと。
# CUJ 6b / 6c は完全隔離下で corepack / pnpm tarball を毎回 DL するため、ネット瞬断で
# flaky 化するリスクがある。CI 組み込み時は retry / skip-on-network-error の
# 検討が必要。
# CUJ 9b は slidev build による Vite bundle + chromium export pipeline で
# 60〜90s 級の追加コストがかかる。harness 全体が分単位で延びるため CI 組み込み
# 時は再評価。
# CUJ 9c は PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1 で DL を強制失敗させるルート。
# playwright 1.49 の DL 実装変更や別 CDN フォールバック導入で、flaky 化する可能性がある。
# 失敗時は env strip 戦略への切替を検討する。
# CUJ 10 は cold 化のため node_modules / cli/dist を消して、install + build を再実行させる。
# chromium は ISO_HOME キャッシュ再利用で再 DL しない。
# install/build 相当の追加コストがかかるため、CI 組み込み時は CUJ 1 との統合を検討する。
# CUJ 12 も同じく cold 化して install + build を再走させる。chromium 未取得の ISO_HOME_C を
# 使う。CUJ 12a / 12b / 13b は DL を PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1 で必ず失敗させる。
# CUJ 9c と同じ前提のため、playwright 側の DL 実装変更で flaky 化するリスクも同じ。
# 実 DL は標準では CUJ 1 の 1 本のみ。
# setup ツール経由の実 DL（~120MB / 計測 33s）は、PECOTV_BOOTSTRAP_TEST_HEAVY=1 を立てたときだけ CUJ 13c で動く。
# 標準では ISO_HOME のキャッシュを複製して、setup の冪等（skip）ルートを観測する。
# 現状はローカル単発実行用途であり vitest e2e には混ぜない。
set -euo pipefail

# playwright 本体は PLAYWRIGHT_BROWSERS_PATH が立っていれば、bin/pecotv の chromium 検出ルートより優先する。
# 検出ルートは ~/.cache/ms-playwright。
# devcontainer 由来で同変数が export されていると、real HOME ルートに逃げて ISO_HOME 隔離が働かない。
# そのため明示的に unset。
unset PLAYWRIGHT_BROWSERS_PATH PLAYWRIGHT_DOWNLOAD_HOST

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT_SRC="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT_SRC/../.." && pwd)"

# .pecot/work/ 直下は Issue 番号のみ（CLAUDE.md「作業ファイルの置き場所」）。
# そのためタスク非紐付けのテストハーネス scratch は、システム中間領域 .pecot/tmp/ に置く。
WORK_DIR="$REPO_ROOT/.pecot/tmp/bootstrap-test"
mkdir -p "$WORK_DIR"
TMP_WORKTREE="$WORK_DIR/wt-$$-$(date +%s)"
TMP_BRANCH="bootstrap-test/$$-$(date +%s)"

# 隔離 HOME: pnpm store / corepack tarball cache / ~/.cache/ms-playwright を含む HOME 依存リソースを隔離する。
# real HOME とは一切共有しない。
# first-time-user reproduction を優先し、symlink による暗黙の cache hit を意図的に避ける。
# mkdir 失敗時にも部分作成された ISO_HOME を cleanup が拾えるよう、trap を mkdir
# より先に設置する。
ISO_HOME="$WORK_DIR/iso-home-$$-$(date +%s)"
# CUJ 9c 用の独立隔離 HOME。chromium キャッシュ無し状態を保つため ISO_HOME とは別 dir。
ISO_HOME_C="$WORK_DIR/iso-home-c-$$-$(date +%s)"
# プラグインのデータ置き場（実行用ミラーの置き場）。
DATA_DIR="$WORK_DIR/data-$$-$(date +%s)"
# CUJ 11b 用の独立したデータ置き場（ミラーを持たない状態を保つ）。
DATA_DIR_11B="$WORK_DIR/data-11b-$$-$(date +%s)"

cleanup() {
  local exit_code=$?
  if [ -d "$TMP_WORKTREE" ]; then
    git -C "$REPO_ROOT" worktree remove --force "$TMP_WORKTREE" >/dev/null 2>&1 || true
  fi
  git -C "$REPO_ROOT" branch -D "$TMP_BRANCH" >/dev/null 2>&1 || true
  rm -rf "$ISO_HOME" >/dev/null 2>&1 || true
  rm -rf "$ISO_HOME_C" >/dev/null 2>&1 || true
  rm -rf "$DATA_DIR" "$DATA_DIR_11B" >/dev/null 2>&1 || true
  # 成功時は自分が WORK_DIR 直下へ書いた出力（cuj*・iso-bin-node*・minimal-slidev-9b）を消す。
  # 失敗時は原因調査のため残す。stub-root.sh・mirror-real-pnpm.sh の mktemp 領域には触れない。
  if [ "$exit_code" -eq 0 ]; then
    rm -rf "$WORK_DIR"/cuj* "$WORK_DIR"/iso-bin-node* "$WORK_DIR/minimal-slidev-9b" >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT

mkdir -p "$ISO_HOME/.cache" "$ISO_HOME/.local/share"

# プラグインのデータ置き場（実行用ミラーの置き場）。親シェルの値は使わず、一時ディレクトリを CLAUDE_PLUGIN_DATA に渡す。
# XDG_DATA_HOME は付け替えない（pnpm の store の置き場まで動く）。既定の場所を確かめる CUJ 1b だけが
# CLAUDE_PLUGIN_DATA を外して XDG_DATA_HOME / HOME を子プロセスに渡す。
unset PECOTV_RUNTIME_DIR PECOTV_DEPENDENCY_ROOT PECOTV_BOOTSTRAP_SKIP PECOTV_BOOTSTRAP_FORCE PLUGIN_DATA
mkdir -p "$DATA_DIR"
export CLAUDE_PLUGIN_DATA="$DATA_DIR"

echo "[bootstrap-test] preparing temp worktree at $TMP_WORKTREE"
git -C "$REPO_ROOT" worktree add -b "$TMP_BRANCH" "$TMP_WORKTREE" HEAD >/dev/null

# git worktree add は HEAD の commit 内容で worktree を作るため、未 commit のローカル
# 変更（本テストで検証したい当 PR の差分）が反映されない。源 worktree の plugins/pecot-visual
# を rsync で上書きし、編集中の bin/pecotv 等が tmp worktree で実行されるようにする。
# node_modules / cli/dist / lock は clean state を保つため除外。
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

assert_grep() {
  local pattern="$1"; local file="$2"; local label="${3:-grep $pattern}"
  if ! grep -qE "$pattern" "$file"; then
    echo "[bootstrap-test] FAIL: $label" >&2
    echo "  expected pattern: $pattern" >&2
    echo "  file: $file" >&2
    echo "  --- file content ---" >&2
    sed -n '1,80p' "$file" >&2 || true
    return 1
  fi
}

assert_no_grep() {
  local pattern="$1"; local file="$2"; local label="${3:-no-grep $pattern}"
  if grep -qE "$pattern" "$file"; then
    echo "[bootstrap-test] FAIL: $label" >&2
    echo "  unexpected pattern: $pattern" >&2
    echo "  file: $file" >&2
    return 1
  fi
}

assert_exit_zero() {
  local code="$1"; local label="${2:-exit code check}"
  if [ "$code" -ne 0 ]; then
    echo "[bootstrap-test] FAIL: $label (exit=$code)" >&2
    return 1
  fi
}

# `~/.cache/ms-playwright/chromium-*` 風のディレクトリ有無を判定する helper。
# ディレクトリ不在は `ls` の stderr を握りつぶし grep miss → exit 1 (= 不在) として扱う。
has_chromium_cache() {
  ls "$1" 2>/dev/null | grep -q "^chromium-"
}

# CUJ 6a/6b/11b 共通: nvm 配下では node / pnpm / corepack が同一ディレクトリに同居している。
# PATH からディレクトリを除外する方式では node も同時に消えるため、必要な binary のみを
# symlink した隔離 bindir を作って PATH を組み立てる。
ISO_BIN_NODE_ONLY="$WORK_DIR/iso-bin-node"
ISO_BIN_NODE_COREPACK="$WORK_DIR/iso-bin-node-corepack"
# CUJ 6c 用: node + npm + npx のみ（Node.js 25 以降の corepack 非同梱環境を再現）。
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

# HOME isolation self-check: 観測ルートを ISO_HOME 側に倒せていることを CUJ 群の前に確認する。
echo "[bootstrap-test] HOME isolation self-check"
if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  echo "[bootstrap-test] FAIL: PLAYWRIGHT_BROWSERS_PATH must not be set" >&2
  exit 1
fi
if [ -n "${PLAYWRIGHT_DOWNLOAD_HOST:-}" ]; then
  echo "[bootstrap-test] FAIL: PLAYWRIGHT_DOWNLOAD_HOST must not be set" >&2
  exit 1
fi
if has_chromium_cache "$ISO_HOME/.cache/ms-playwright"; then
  echo "[bootstrap-test] FAIL: ISO_HOME unexpectedly has chromium cache" >&2
  exit 1
fi
# real HOME 側の状態はログのみ（合否には使わない。real に chromium 有無どちらでも harness は動くべき）
if has_chromium_cache "$HOME/.cache/ms-playwright"; then
  echo "[bootstrap-test] isolation diverges from real HOME (real HAS chromium-*, ISO_HOME does NOT)"
else
  echo "[bootstrap-test] note: real HOME also lacks chromium-* (isolation still applied, divergence not observable here)"
fi

# CUJ 1: clean state で bin/pecotv --help が exit 0 で stderr に [pecotv bootstrap] が出る
echo "[bootstrap-test] CUJ 1: clean clone bootstrap"
STDERR1="$WORK_DIR/cuj1.stderr"
rm -rf "$DATA_DIR/runtime"
set +e
HOME="$ISO_HOME" "$BIN_PECOTV" --help >/dev/null 2>"$STDERR1"
code=$?
set -e
assert_exit_zero "$code" "CUJ 1 exit"
assert_grep '\[pecotv runtime\]' "$STDERR1" "CUJ 1 stderr has bootstrap log"
assert_grep '^pecotv: installing dependencies$' "$STDERR1" "CUJ 1 ran install"
assert_grep 'ready \([0-9]+s\)' "$STDERR1" "CUJ 1 ready line"
assert_grep 'running playwright install chromium' "$STDERR1" "CUJ 1 chromium install fired under ISO_HOME"
if ! has_chromium_cache "$ISO_HOME/.cache/ms-playwright"; then
  echo "[bootstrap-test] FAIL: CUJ 1 did not populate ISO_HOME chromium cache" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 1 pass"

# CUJ 1b: クライアントが置き場を渡さない起動（Bash から呼ぶ・単体配布）は既定の場所に依存を作る。
# CLAUDE_PLUGIN_DATA / PLUGIN_DATA を外し、XDG_DATA_HOME を空にする。
# これで ISO_HOME の ~/.local/share/pecot/pecot-visual を使わせる。
# pnpm の store と chromium は CUJ 1 で ISO_HOME に入っているので、ここでは依存の導入と build だけが動く。
echo "[bootstrap-test] CUJ 1b: default data directory when no variable is given"
STDERR1B="$WORK_DIR/cuj1b.stderr"
DEFAULT_DATA="$ISO_HOME/.local/share/pecot/pecot-visual"
set +e
env -u CLAUDE_PLUGIN_DATA -u PLUGIN_DATA XDG_DATA_HOME= HOME="$ISO_HOME" "$BIN_PECOTV" --help >/dev/null 2>"$STDERR1B"
code=$?
set -e
assert_exit_zero "$code" "CUJ 1b exit"
assert_grep '^pecotv: installing dependencies$' "$STDERR1B" "CUJ 1b ran install"
if [ ! -f "$DEFAULT_DATA/runtime/current/cli/dist/cli.js" ]; then
  echo "[bootstrap-test] FAIL: CUJ 1b did not build the mirror under $DEFAULT_DATA/runtime" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 1b pass"

# CUJ 10: cold state の `bin/pecotv mcp` で stdout が JSON-RPC 専有のまま保たれる。
# `.mcp.json` から stdio MCP サーバとして起動されるルートでは、bootstrap の子プロセスが stdout に 1 行でも書くと、
# クライアントのパースが破損する。子プロセスは pnpm install / tsc build。
# node 起動後は installStdoutGuard が守るため、ここで見たいのは node 起動前の bash 側。
# CUJ 1 の直後に置いて、ISO_HOME の chromium キャッシュを再利用する。
# cold 化のために node_modules / cli/dist は消すが、chromium の再 DL (~120MB) は発生しない。
echo "[bootstrap-test] CUJ 10: cold pecotv mcp keeps stdout JSON-RPC only"
STDERR10="$WORK_DIR/cuj10.stderr"
STDOUT10="$WORK_DIR/cuj10.stdout"
FIFO10="$WORK_DIR/cuj10.stdin.fifo"
rm -rf "$DATA_DIR/runtime"
rm -f "$FIFO10" "$STDOUT10" "$STDERR10"
mkfifo "$FIFO10"
# protocolVersion は SDK の LATEST_PROTOCOL_VERSION に追従させない。MCP サーバは未知の版を
# 受けても自身が話せる版を result で返す仕様のため、リテラル固定でも initialize は成立する。
MCP_INIT_REQUEST='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"bootstrap-test","version":"0.0.0"}}}'
set +e
HOME="$ISO_HOME" "$BIN_PECOTV" mcp <"$FIFO10" >"$STDOUT10" 2>"$STDERR10" &
mcp_pid=$!
# fd 7 を writer として保持し続けることで stdin の EOF を保留する。request を投げた直後に
# 閉じると、bootstrap 完了前に EOF が届いて server が応答前に close する可能性がある。
exec 7>"$FIFO10"
printf '%s\n' "$MCP_INIT_REQUEST" >&7
# cold bootstrap (install + build) 込みで応答を待つ。CUJ 1 で pnpm store が温まっている
# 前提でも数十秒かかるため 300s のマージンを取る。
mcp_deadline=$(( $(date +%s) + 300 ))
while [ ! -s "$STDOUT10" ] && [ "$(date +%s)" -le "$mcp_deadline" ]; do
  sleep 0.5
done
# 応答 1 行の write が途中で観測されないよう僅かに待ってから EOF を送る。
sleep 0.5
exec 7>&-
wait "$mcp_pid"
code=$?
set -e
rm -f "$FIFO10"
assert_exit_zero "$code" "CUJ 10 exit"
# ログが消えたのではなく stderr へ移ったことを確認する。
assert_grep '\[pecotv runtime\]' "$STDERR10" "CUJ 10 bootstrap log moved to stderr"
assert_grep '^pecotv: installing dependencies$' "$STDERR10" "CUJ 10 ran install (cold state)"
# pnpm / playwright の代表的な stdout 出力痕跡が JSON-RPC チャネルに抜けていないこと。
assert_no_grep 'Scope: all|Progress|postinstall|Downloading' "$STDOUT10" "CUJ 10 no pnpm output on stdout"
if ! node -e '
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
' "$STDOUT10"; then
  echo "[bootstrap-test] FAIL: CUJ 10 stdout is not pure JSON-RPC" >&2
  echo "  --- CUJ 10 stdout ---" >&2; sed -n '1,20p' "$STDOUT10" >&2
  echo "  --- CUJ 10 stderr ---" >&2; sed -n '1,40p' "$STDERR10" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 10 pass"

# CUJ 11: SKIP（開発・pre-push 専用）で本体ツリーの cli/dist が無いときは、半端な出力を出さずに即死する。
# PECOTV_BOOTSTRAP_SKIP=1 は本体ツリーの成果物を直接実行する（データ置き場は使わない）。
# 一時 worktree の本体には cli/dist が無い（bootstrap は本体に build 成果物を作らない）。
# そのため MCP クライアントから見て、「JSON-RPC でも何でもない文字列を stdout に流したまま生き続ける」ことがないのを確認する。
echo "[bootstrap-test] CUJ 11: SKIP without the tree's cli/dist fails fast without partial output"
STDERR11="$WORK_DIR/cuj11.stderr"
STDOUT11="$WORK_DIR/cuj11.stdout"
set +e
printf '' | PECOTV_BOOTSTRAP_SKIP=1 HOME="$ISO_HOME" "$BIN_PECOTV" mcp >"$STDOUT11" 2>"$STDERR11"
code=$?
set -e
if [ "$code" -eq 0 ]; then
  echo "[bootstrap-test] FAIL: CUJ 11 expected non-zero exit, got 0" >&2
  exit 1
fi
if [ -s "$STDOUT11" ]; then
  echo "[bootstrap-test] FAIL: CUJ 11 wrote to stdout (must stay empty)" >&2
  echo "  --- CUJ 11 stdout ---" >&2; sed -n '1,20p' "$STDOUT11" >&2
  exit 1
fi
assert_grep 'build する' "$STDERR11" "CUJ 11 stderr guides to build"
if [ -e "$PLUGIN_ROOT/cli/dist" ] || [ -e "$PLUGIN_ROOT/node_modules" ]; then
  echo "[bootstrap-test] FAIL: CUJ 11 / bootstrap created node_modules or cli/dist in the plugin root" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 11 pass (exit=$code)"

# CUJ 11b: 実利用者に起きる「bootstrap 不能」でも、stdout を汚さずに終了する。
# CUJ 11 は PECOTV_BOOTSTRAP_SKIP=1（テスト専用の抜け道）で条件を作るため、実利用者の
# 失敗形は通っていない。ここでは PATH から pnpm / corepack を外し、実行用ミラーを持たない
# 独立のデータ置き場で `pecotv mcp` を起動する（準備が必要な状態）。MCP クライアントから
# 見て「JSON-RPC でない文字列を stdout に流したまま生き続ける」ことがないのを直接観測する。
echo "[bootstrap-test] CUJ 11b: fail fast without partial output when pnpm/corepack are absent"
STDERR11B="$WORK_DIR/cuj11b.stderr"
STDOUT11B="$WORK_DIR/cuj11b.stdout"
mkdir -p "$DATA_DIR_11B"
set +e
env -i CLAUDE_PLUGIN_DATA="$DATA_DIR_11B" HOME="$ISO_HOME" PATH="$ISO_BIN_NODE_ONLY:/usr/bin:/bin" \
  "$BIN_PECOTV" mcp </dev/null >"$STDOUT11B" 2>"$STDERR11B"
code=$?
set -e
if [ "$code" -eq 0 ]; then
  echo "[bootstrap-test] FAIL: CUJ 11b expected non-zero exit, got 0" >&2
  exit 1
fi
if [ -s "$STDOUT11B" ]; then
  echo "[bootstrap-test] FAIL: CUJ 11b wrote to stdout (must stay empty)" >&2
  echo "  --- CUJ 11b stdout ---" >&2; sed -n '1,20p' "$STDOUT11B" >&2
  exit 1
fi
assert_grep 'pnpm / corepack / npx not found' "$STDERR11B" "CUJ 11b explicit error on stderr"
echo "[bootstrap-test] CUJ 11b pass (exit=$code)"

# CUJ 2: 2 回目は skip。real < 1000ms 目安、`installing dependencies` 不在
echo "[bootstrap-test] CUJ 2: skip on second invocation"
STDERR2="$WORK_DIR/cuj2.stderr"
TIMEFILE="$WORK_DIR/cuj2.time"
set +e
# LC_ALL=C で `time` の小数点を `.` 固定にする（カンマロケール環境での awk 計算崩れ対策）。
{ LC_ALL=C TIMEFORMAT='%R'; time HOME="$ISO_HOME" "$BIN_PECOTV" --help >/dev/null 2>"$STDERR2"; } 2>"$TIMEFILE"
code=$?
set -e
assert_exit_zero "$code" "CUJ 2 exit"
assert_no_grep '^pecotv: installing dependencies$' "$STDERR2" "CUJ 2 no install"
assert_no_grep '^pecotv: building$' "$STDERR2" "CUJ 2 no build"
real_ms=$(awk '{printf "%d", $1 * 1000}' "$TIMEFILE")
# 計測 ~300ms (入力ファイルのハッシュ計算 ~100ms + 完成済みミラーの hit)。1000ms は環境差を許容するマージン。
if [ "$real_ms" -gt 1000 ]; then
  echo "[bootstrap-test] FAIL: CUJ 2 second invocation took ${real_ms}ms > 1000ms" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 2 pass (real=${real_ms}ms)"

# CUJ 3: 依存（runtime-lock.yaml）の更新時は、同じ deps-hash の donor が無いので install + build を行う
echo "[bootstrap-test] CUJ 3: runtime-lock update triggers install + build into a new mirror"
STDERR3="$WORK_DIR/cuj3.stderr"
before_current="$(readlink -f "$DATA_DIR/runtime/current")"
printf '\n# cuj3 lock change\n' >> "$PLUGIN_ROOT/runtime-lock.yaml"
set +e
HOME="$ISO_HOME" "$BIN_PECOTV" --help >/dev/null 2>"$STDERR3"
code=$?
set -e
assert_exit_zero "$code" "CUJ 3 exit"
assert_grep '^pecotv: installing dependencies$' "$STDERR3" "CUJ 3 re-install"
assert_grep '^pecotv: building$' "$STDERR3" "CUJ 3 re-build"
if [ "$(readlink -f "$DATA_DIR/runtime/current")" = "$before_current" ]; then
  echo "[bootstrap-test] FAIL: CUJ 3 current did not move to the new mirror" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 3 pass"

# CUJ 4: cli/src/** の更新で、install なしの build だけが動き、node_modules は旧ミラーとハードリンクを共有する
echo "[bootstrap-test] CUJ 4: src update triggers re-build only"
STDERR4="$WORK_DIR/cuj4.stderr"
before_current="$(readlink -f "$DATA_DIR/runtime/current")"
printf '\n// cuj4 source change\n' >> "$PLUGIN_ROOT/cli/src/cli.ts"
set +e
HOME="$ISO_HOME" "$BIN_PECOTV" --help >/dev/null 2>"$STDERR4"
code=$?
set -e
assert_exit_zero "$code" "CUJ 4 exit"
assert_grep '^pecotv: building$' "$STDERR4" "CUJ 4 re-build"
assert_no_grep '^pecotv: installing dependencies$' "$STDERR4" "CUJ 4 no install"
after_current="$(readlink -f "$DATA_DIR/runtime/current")"
if [ "$after_current" = "$before_current" ]; then
  echo "[bootstrap-test] FAIL: CUJ 4 current did not move to the new mirror" >&2
  exit 1
fi
if [ "$(stat -c %i "$before_current/node_modules/.modules.yaml")" != "$(stat -c %i "$after_current/node_modules/.modules.yaml")" ]; then
  echo "[bootstrap-test] FAIL: CUJ 4 node_modules is not hard-linked from the previous mirror" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 4 pass"

# CUJ 4b: version だけの更新（plugin.json と CHANGELOG）では、install と build のどちらも動かない
echo "[bootstrap-test] CUJ 4b: version-only update does nothing"
STDERR4B="$WORK_DIR/cuj4b.stderr"
before_current="$(readlink -f "$DATA_DIR/runtime/current")"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.version = "99.0.0";
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$PLUGIN_ROOT/.claude-plugin/plugin.json"
printf '\n## 99.0.0\n' >> "$PLUGIN_ROOT/CHANGELOG.md"
set +e
HOME="$ISO_HOME" "$BIN_PECOTV" --version >"$WORK_DIR/cuj4b.stdout" 2>"$STDERR4B"
code=$?
set -e
assert_exit_zero "$code" "CUJ 4b exit"
assert_no_grep '^pecotv: (installing dependencies|building)$' "$STDERR4B" "CUJ 4b no install / build"
if [ "$(readlink -f "$DATA_DIR/runtime/current")" != "$before_current" ]; then
  echo "[bootstrap-test] FAIL: CUJ 4b current moved" >&2
  exit 1
fi
assert_grep '99\.0\.0' "$WORK_DIR/cuj4b.stdout" "CUJ 4b reports the new version"
echo "[bootstrap-test] CUJ 4b pass"

# CUJ 5: 並行起動で二重実行されない。
# 備考: A を background 起動した直後に B を起動する形のため、短いウィンドウが理論上存在する。
# そのウィンドウは、A が flock を取得する前に B が再判定 if へ進む区間。
# 現状の foreground 実行で flaky 化は観測されていない。
# CI 等で flaky になった場合は、A 起動後に sleep 0.05 を挟むことを検討する。
# 実 sleep は入れていない（無条件待ちで全体時間が延びるため）。
echo "[bootstrap-test] CUJ 5: concurrent invocations do not double-run"
rm -rf "$DATA_DIR/runtime"
STDERR5A="$WORK_DIR/cuj5a.stderr"
STDERR5B="$WORK_DIR/cuj5b.stderr"
set +e
HOME="$ISO_HOME" "$BIN_PECOTV" --help >/dev/null 2>"$STDERR5A" &
pid_a=$!
# A が flock を取りに行くまで僅かに待ってから B を起動（同時実行性は保つ）
HOME="$ISO_HOME" "$BIN_PECOTV" --help >/dev/null 2>"$STDERR5B" &
pid_b=$!
wait "$pid_a"; code_a=$?
wait "$pid_b"; code_b=$?
set -e
assert_exit_zero "$code_a" "CUJ 5 process A exit"
assert_exit_zero "$code_b" "CUJ 5 process B exit"

install_count=$(grep -c '^pecotv: installing dependencies$' "$STDERR5A" "$STDERR5B" 2>/dev/null | awk -F: '{sum += $2} END {print sum+0}')
build_count=$(grep -c '^pecotv: building$' "$STDERR5A" "$STDERR5B" 2>/dev/null | awk -F: '{sum += $2} END {print sum+0}')

if [ "$install_count" -ne 1 ]; then
  echo "[bootstrap-test] FAIL: CUJ 5 '^pecotv: installing dependencies$' total=$install_count (expected 1)" >&2
  echo "  --- A stderr ---" >&2; sed -n '1,40p' "$STDERR5A" >&2
  echo "  --- B stderr ---" >&2; sed -n '1,40p' "$STDERR5B" >&2
  exit 1
fi
if [ "$build_count" -ne 1 ]; then
  echo "[bootstrap-test] FAIL: CUJ 5 '^pecotv: building$' total=$build_count (expected 1)" >&2
  exit 1
fi
# 後発側に dedicated log が出ているか（waiting または skipping のいずれか）
if ! grep -qE 'waiting for concurrent bootstrap|already bootstrapped by another process, skipping' "$STDERR5A" "$STDERR5B"; then
  echo "[bootstrap-test] FAIL: CUJ 5 no follower-side log" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 5 pass (install_count=$install_count build_count=$build_count)"

# CUJ 6a: pnpm / corepack 両方無しで明示エラー + exit 1
echo "[bootstrap-test] CUJ 6a: missing pnpm and corepack"
rm -rf "$DATA_DIR/runtime"
STDERR6A="$WORK_DIR/cuj6a.stderr"
set +e
env -i CLAUDE_PLUGIN_DATA="$DATA_DIR" HOME="$ISO_HOME" PATH="$ISO_BIN_NODE_ONLY:/usr/bin:/bin" "$BIN_PECOTV" --help >/dev/null 2>"$STDERR6A"
code=$?
set -e
if [ "$code" -eq 0 ]; then
  echo "[bootstrap-test] FAIL: CUJ 6a expected non-zero exit, got 0" >&2
  echo "  --- CUJ 6a stderr ---" >&2; sed -n '1,40p' "$STDERR6A" >&2
  exit 1
fi
assert_grep 'pnpm / corepack / npx not found' "$STDERR6A" "CUJ 6a explicit error"
echo "[bootstrap-test] CUJ 6a pass (exit=$code)"

# CUJ 6b: pnpm 無し / corepack あり (fallback 動作確認)。
# 直前の CUJ 6a で runtime/ を rm している。
# そのため install + build の両方が corepack 経由で完走する形になる。
# Acceptance 6 後段の「pnpm が無くても corepack 経由で起動」を、強く検証するルート。
echo "[bootstrap-test] CUJ 6b: corepack fallback"
STDERR6B="$WORK_DIR/cuj6b.stderr"
rm -rf "$DATA_DIR/runtime"
if [ -z "$COREPACK_PATH" ]; then
  echo "[bootstrap-test] CUJ 6b skipped: corepack not present in environment" >&2
else
  set +e
  env -i CLAUDE_PLUGIN_DATA="$DATA_DIR" HOME="$ISO_HOME" PATH="$ISO_BIN_NODE_COREPACK:/usr/bin:/bin" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$BIN_PECOTV" --help >/dev/null 2>"$STDERR6B"
  code=$?
  set -e
  if [ "$code" -ne 0 ]; then
    echo "[bootstrap-test] FAIL: CUJ 6b exit=$code (expected 0)" >&2
    echo "  --- CUJ 6b stderr ---" >&2; sed -n '1,40p' "$STDERR6B" >&2
    exit 1
  fi
  assert_grep '^pecotv: building$' "$STDERR6B" "CUJ 6b ran build via fallback"
  echo "[bootstrap-test] CUJ 6b pass"
fi

# CUJ 6c: pnpm 無し / corepack 無し / npx あり (Node.js 25 以降の corepack 非同梱環境)。
# node_modules / cli/dist を消して install + build の両方が npx 経由の pnpm で完走する
# ことを確認する。隔離 HOME のため npx は pnpm tarball を毎回取得する（CUJ 6b と同じく
# ネット依存）。
echo "[bootstrap-test] CUJ 6c: npx fallback (no pnpm, no corepack)"
STDERR6C="$WORK_DIR/cuj6c.stderr"
rm -rf "$DATA_DIR/runtime"
if [ -z "$NPX_PATH" ]; then
  echo "[bootstrap-test] CUJ 6c skipped: npx not present in environment" >&2
else
  set +e
  env -i CLAUDE_PLUGIN_DATA="$DATA_DIR" HOME="$ISO_HOME" PATH="$ISO_BIN_NODE_NPX:/usr/bin:/bin" "$BIN_PECOTV" --help >/dev/null 2>"$STDERR6C"
  code=$?
  set -e
  if [ "$code" -ne 0 ]; then
    echo "[bootstrap-test] FAIL: CUJ 6c exit=$code (expected 0)" >&2
    echo "  --- CUJ 6c stderr ---" >&2; sed -n '1,40p' "$STDERR6C" >&2
    exit 1
  fi
  assert_grep '^pecotv: installing dependencies$' "$STDERR6C" "CUJ 6c ran install via npx fallback"
  assert_grep '^pecotv: building$' "$STDERR6C" "CUJ 6c ran build via npx fallback"
  echo "[bootstrap-test] CUJ 6c pass"
fi

# CUJ 7: clean state で skill loader を踏む subcommand
echo "[bootstrap-test] CUJ 7: skill subcommand without prior setup.sh"
rm -rf "$DATA_DIR/runtime"
STDERR7="$WORK_DIR/cuj7.stderr"
STDOUT7="$WORK_DIR/cuj7.stdout"
set +e
HOME="$ISO_HOME" "$BIN_PECOTV" slide --help >"$STDOUT7" 2>"$STDERR7"
code=$?
set -e
assert_exit_zero "$code" "CUJ 7 exit"
assert_grep 'slide' "$STDOUT7" "CUJ 7 slide help printed"
echo "[bootstrap-test] CUJ 7 pass"

# CUJ 8: 世代削除。ここまでに作ったミラーのうち、使用中でも current でもないものは直近 2 つを残して消える。
echo "[bootstrap-test] CUJ 8: old mirror generations are pruned to the most recent two"
mirror_count="$(find "$DATA_DIR/runtime" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | wc -l | tr -d ' ')"
if [ "$mirror_count" -gt 2 ]; then
  echo "[bootstrap-test] FAIL: CUJ 8 mirror generations=$mirror_count (expected <= 2)" >&2
  ls -la "$DATA_DIR/runtime" >&2
  exit 1
fi
if [ ! -f "$(readlink -f "$DATA_DIR/runtime/current")/.complete" ]; then
  echo "[bootstrap-test] FAIL: CUJ 8 current is not a complete mirror" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 8 pass (generations=$mirror_count)"

# CUJ 9a: 初回 drawio url が ISO_HOME で成功する。
# CUJ 1 で bootstrap 済 + chromium キャッシュが ISO_HOME に populated 済の状態を再利用する。
# screenshot.ts の chromium.launch を実際に通す。
# これで「初回ユーザーが drawio url を叩いて PNG が出る」CUJ を端から端まで検証する。
echo "[bootstrap-test] CUJ 9a: first-time drawio url succeeds under ISO_HOME"
STDERR9A="$WORK_DIR/cuj9a.stderr"
STDOUT9A="$WORK_DIR/cuj9a.stdout"
DRAWIO_FIXTURE="$PLUGIN_ROOT/cli/tests/fixtures/drawio/minimal.drawio"
CUJ9A_HTML="$WORK_DIR/cuj9a.drawio.html"
CUJ9A_PNG="$WORK_DIR/cuj9a.drawio.png"
rm -f "$CUJ9A_HTML" "$CUJ9A_PNG"
set +e
HOME="$ISO_HOME" "$BIN_PECOTV" drawio url "$DRAWIO_FIXTURE" --output "$CUJ9A_HTML" >"$STDOUT9A" 2>"$STDERR9A"
code=$?
set -e
assert_exit_zero "$code" "CUJ 9a exit"
assert_no_grep 'Playwright Chromium cannot launch' "$STDERR9A" "CUJ 9a no chromium launch failure"
if [ ! -s "$CUJ9A_HTML" ]; then
  echo "[bootstrap-test] FAIL: CUJ 9a HTML not generated at $CUJ9A_HTML" >&2
  exit 1
fi
if [ ! -s "$CUJ9A_PNG" ]; then
  echo "[bootstrap-test] FAIL: CUJ 9a PNG not generated at $CUJ9A_PNG" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 9a pass"

# CUJ 9b: 初回 slide convert (pptx) が ISO_HOME で成功する。
# slidev build + chromium export のルートを踏み、pptx が生成されることを確認する。
# 60-90s かかる可能性があるため timeout でラップせず素直に待つ。
echo "[bootstrap-test] CUJ 9b: first-time slide convert (pptx) succeeds under ISO_HOME"
STDERR9B="$WORK_DIR/cuj9b.stderr"
STDOUT9B="$WORK_DIR/cuj9b.stdout"
SLIDEV_SRC="$PLUGIN_ROOT/cli/tests/fixtures/minimal-slidev"
SLIDEV_DST="$WORK_DIR/minimal-slidev-9b"
CUJ9B_PPTX="$WORK_DIR/cuj9b.pptx"
rm -rf "$SLIDEV_DST"
rm -f "$CUJ9B_PPTX"
cp -a "$SLIDEV_SRC" "$SLIDEV_DST"
# slidev は theme/addon を slidev project の cwd から require する。
# そのため、隔離した fixture 単体では依存を引けない。
# 依存の実体は、bootstrap が作った実行用ミラー（$DATA_DIR/runtime/current/node_modules）にある。
# 注意:
# - ミラーの直下の項目を張るので、`pnpm-workspace.yaml` の `nodeLinker: hoisted` が前提になる。
#   `isolated` 等へ切り替えたら、この CUJ も直す。
# talk-dir はテーマを参照する形でなければ止まる（本体はテーマを持たない）。
# 固定のテスト用テーマ（with-declaration と、その依存の theme-only-dep）を複製し、file: で参照する。
# file: のテーマは install されないので、複製側の依存は、元の依存を指す symlink で用意する。
THEME9B_NAME="slidev-theme-pecotv-test-declared"
THEME9B_ROOT="$WORK_DIR/theme-9b"
rm -rf "$THEME9B_ROOT"
mkdir -p "$THEME9B_ROOT/node_modules"
cp -a "$PLUGIN_ROOT/cli/tests/fixtures/themes/with-declaration" "$THEME9B_ROOT/$THEME9B_NAME"
cp -a "$PLUGIN_ROOT/cli/tests/fixtures/themes/theme-only-dep" "$THEME9B_ROOT/theme-only-dep"
mkdir -p "$THEME9B_ROOT/$THEME9B_NAME/node_modules"
ln -sfn "$THEME9B_ROOT/theme-only-dep" "$THEME9B_ROOT/$THEME9B_NAME/node_modules/pecotv-test-theme-dep"
# talk-dir の node_modules は、ミラーの依存を 1 つずつ張った実ディレクトリにし、テーマの張り先を足す。
mkdir -p "$SLIDEV_DST/node_modules"
for entry in "$DATA_DIR/runtime/current/node_modules"/* "$DATA_DIR/runtime/current/node_modules"/.bin; do
  [ -e "$entry" ] && ln -sfn "$entry" "$SLIDEV_DST/node_modules/$(basename "$entry")"
done
ln -sfn "$THEME9B_ROOT/$THEME9B_NAME" "$SLIDEV_DST/node_modules/$THEME9B_NAME"
jq --arg n "$THEME9B_NAME" --arg p "file:$THEME9B_ROOT/$THEME9B_NAME" '.dependencies[$n] = $p | del(.dependencies["@slidev/theme-default"])' \
  "$SLIDEV_SRC/package.json" >"$SLIDEV_DST/package.json"
sed -i "s|^theme: default$|theme: \"$THEME9B_NAME\"|" "$SLIDEV_DST/slides.md"
set +e
HOME="$ISO_HOME" "$BIN_PECOTV" slide convert "$SLIDEV_DST" --out "$CUJ9B_PPTX" >"$STDOUT9B" 2>"$STDERR9B"
code=$?
set -e
assert_exit_zero "$code" "CUJ 9b exit"
assert_no_grep 'Playwright Chromium cannot launch' "$STDERR9B" "CUJ 9b no chromium launch failure"
if [ ! -s "$CUJ9B_PPTX" ]; then
  echo "[bootstrap-test] FAIL: CUJ 9b PPTX not generated at $CUJ9B_PPTX" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 9b pass"

# CUJ 9d: 既存 chromium キャッシュがある環境で再 DL が動かない。
# CUJ 9a/9b を通った ISO_HOME（chromium キャッシュ populated 済 + bootstrap 完走済）を使う。
# drawio url を再実行し、playwright install chromium が再発火しないことを確認する。
# CUJ 9c は node_modules を破壊するため、9c より前にこの CUJ を回す。
echo "[bootstrap-test] CUJ 9d: no re-DL when chromium cache exists"
STDERR9D="$WORK_DIR/cuj9d.stderr"
STDOUT9D="$WORK_DIR/cuj9d.stdout"
CUJ9D_HTML="$WORK_DIR/cuj9d.drawio.html"
CUJ9D_PNG="$WORK_DIR/cuj9d.drawio.png"
rm -f "$CUJ9D_HTML" "$CUJ9D_PNG"
set +e
HOME="$ISO_HOME" "$BIN_PECOTV" drawio url "$DRAWIO_FIXTURE" --output "$CUJ9D_HTML" >"$STDOUT9D" 2>"$STDERR9D"
code=$?
set -e
assert_exit_zero "$code" "CUJ 9d exit"
assert_no_grep 'running playwright install chromium' "$STDERR9D" "CUJ 9d no chromium re-download"
if [ ! -s "$CUJ9D_HTML" ]; then
  echo "[bootstrap-test] FAIL: CUJ 9d HTML not generated at $CUJ9D_HTML" >&2
  exit 1
fi
if [ ! -s "$CUJ9D_PNG" ]; then
  echo "[bootstrap-test] FAIL: CUJ 9d PNG not generated at $CUJ9D_PNG" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 9d pass"

# CUJ 9c: chromium DL 不能環境で bin/pecotv が fatal 化する。
# clean state + 独立 ISO_HOME_C（chromium キャッシュ無し）で bootstrap を回す。
# PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1 で DL を強制失敗させる。
# bin/pecotv が非 0 exit + 明示エラー（error: chromium + ネットワーク誘導）で落ちることを確認する。
echo "[bootstrap-test] CUJ 9c: bin/pecotv fatal when chromium DL fails"
STDERR9C="$WORK_DIR/cuj9c.stderr"
STDOUT9C="$WORK_DIR/cuj9c.stdout"
mkdir -p "$ISO_HOME_C/.cache" "$ISO_HOME_C/.local/share"
rm -rf "$DATA_DIR/runtime"
set +e
( PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1 HOME="$ISO_HOME_C" "$BIN_PECOTV" --help >"$STDOUT9C" 2>"$STDERR9C" )
code=$?
set -e
if [ "$code" -eq 0 ]; then
  echo "[bootstrap-test] FAIL: CUJ 9c expected non-zero exit, got 0" >&2
  echo "  --- CUJ 9c stderr ---" >&2; sed -n '1,80p' "$STDERR9C" >&2
  exit 1
fi
assert_grep 'running playwright install chromium' "$STDERR9C" "CUJ 9c chromium install fired"
assert_grep 'error: chromium' "$STDERR9C" "CUJ 9c explicit chromium error"
assert_grep 'PLAYWRIGHT_DOWNLOAD_HOST' "$STDERR9C" "CUJ 9c surface network/proxy guidance"
if has_chromium_cache "$ISO_HOME_C/.cache/ms-playwright"; then
  echo "[bootstrap-test] FAIL: CUJ 9c ISO_HOME_C unexpectedly has chromium cache after fatal" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 9c pass (exit=$code)"

CHROMIUM_INSTALL_LOG="$DATA_DIR/runtime/.pecotv-chromium-install.log"
CHROMIUM_INSTALL_LOCK="$DATA_DIR/runtime/.pecotv-chromium-install.lock"

# CUJ 12: chromium 未取得の cold state でも `pecotv mcp` が接続でき、chromium は取りに行かない。
# `.mcp.json` 経由の起動には Claude Code の MCP_TIMEOUT (標準 30000ms) がある。
# bootstrap で chromium (~120MB, 3 本) を同期 DL していた頃は、真 cold の合計が 52s に達して接続そのものが失敗していた。
# MCP ルートでは chromium を起動条件から外すことで、install + build だけで接続が成立する。
# あわせて「標準ではモデルの呼ぶルートから 120MB を通知なしに取得しない」ことも見る。
# CUJ 9c の直後に置き、chromium キャッシュを持たない ISO_HOME_C を再利用する。
echo "[bootstrap-test] CUJ 12: cold pecotv mcp connects without fetching chromium"
STDERR12="$WORK_DIR/cuj12.stderr"
STDOUT12="$WORK_DIR/cuj12.stdout"
FIFO12="$WORK_DIR/cuj12.stdin.fifo"
rm -rf "$DATA_DIR/runtime"
rm -f "$FIFO12" "$STDOUT12" "$STDERR12"
mkfifo "$FIFO12"
set +e
HOME="$ISO_HOME_C" "$BIN_PECOTV" mcp <"$FIFO12" >"$STDOUT12" 2>"$STDERR12" &
mcp12_pid=$!
exec 7>"$FIFO12"
printf '%s\n' "$MCP_INIT_REQUEST" >&7
mcp_deadline=$(( $(date +%s) + 300 ))
while [ ! -s "$STDOUT12" ] && [ "$(date +%s)" -le "$mcp_deadline" ]; do
  sleep 0.5
done
sleep 0.5
exec 7>&-
wait "$mcp12_pid"
code=$?
set -e
rm -f "$FIFO12"
assert_exit_zero "$code" "CUJ 12 exit"
assert_grep '^pecotv: installing dependencies$' "$STDERR12" "CUJ 12 ran install (cold state)"
# 同期 DL の痕跡（fatal 化するルート）とバックグラウンド取得のどちらも、MCP 起動で動かないこと。
assert_no_grep 'running playwright install chromium' "$STDERR12" "CUJ 12 no synchronous chromium install"
assert_no_grep 'バックグラウンドで取得します' "$STDERR12" "CUJ 12 no background chromium fetch by default"
assert_no_grep 'error: chromium' "$STDERR12" "CUJ 12 missing chromium is not fatal"
if ! node -e '
  const fs = require("fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter((l) => l !== "");
  if (lines.length === 0) { console.error("stdout has no lines"); process.exit(1); }
  let sawInitializeResult = false;
  for (const line of lines) {
    let message;
    try { message = JSON.parse(line); }
    catch { console.error("non-JSON line on stdout: " + line); process.exit(1); }
    if (message.id === 1 && message.result && message.result.serverInfo) sawInitializeResult = true;
  }
  if (!sawInitializeResult) { console.error("no initialize result on stdout"); process.exit(1); }
' "$STDOUT12"; then
  echo "[bootstrap-test] FAIL: CUJ 12 did not answer initialize on a JSON-RPC-only stdout" >&2
  echo "  --- CUJ 12 stdout ---" >&2; sed -n '1,20p' "$STDOUT12" >&2
  echo "  --- CUJ 12 stderr ---" >&2; sed -n '1,60p' "$STDERR12" >&2
  exit 1
fi
if has_chromium_cache "$ISO_HOME_C/.cache/ms-playwright"; then
  echo "[bootstrap-test] FAIL: CUJ 12 unexpectedly populated chromium cache" >&2
  exit 1
fi
if [ -f "$CHROMIUM_INSTALL_LOG" ]; then
  echo "[bootstrap-test] FAIL: CUJ 12 started a background chromium fetch without opt-in" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 12 pass"

# CUJ 12a: warm bootstrap + chromium 未取得の状態で、通常の CLI ルートが chromium を取りに行く。
# `.mcp.json` 登録により、初回 bootstrap が MCP ルートになるのが標準になった。
# そのため install / build は済んでいるが chromium だけ無い状態が、新しい定常状態になる。
# chromium 取得の判定を bootstrap 要否ブロックの内側に置くと、marker が書かれた時点で通常の CLI ルートが二度とここへ到達しない。
# すると #543 の Acceptance（初回 `drawio url` が chromium 不足で失敗しない）が破れる。
# 直前の CUJ 12 が ISO_HOME_C で install + build を済ませ、chromium だけ無い状態を作っている。
# DL は PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1 で必ず失敗させる。
# 実 DL を待たずに、「取得が発火したこと」と「失敗すれば fatal であること」の両方を観測できる。
echo "[bootstrap-test] CUJ 12a: warm bootstrap still fetches chromium on the plain CLI path"
STDERR12A="$WORK_DIR/cuj12a.stderr"
STDOUT12A="$WORK_DIR/cuj12a.stdout"
CUJ12A_HTML="$WORK_DIR/cuj12a.drawio.html"
rm -f "$CUJ12A_HTML"
set +e
PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1 HOME="$ISO_HOME_C" \
  "$BIN_PECOTV" drawio url "$DRAWIO_FIXTURE" --output "$CUJ12A_HTML" >"$STDOUT12A" 2>"$STDERR12A"
code=$?
set -e
if [ "$code" -eq 0 ]; then
  echo "[bootstrap-test] FAIL: CUJ 12a expected non-zero exit, got 0" >&2
  echo "  --- CUJ 12a stderr ---" >&2; sed -n '1,80p' "$STDERR12A" >&2
  exit 1
fi
assert_no_grep '^pecotv: installing dependencies$' "$STDERR12A" "CUJ 12a precondition: bootstrap is warm"
assert_grep 'running playwright install chromium' "$STDERR12A" "CUJ 12a chromium fetch fires on warm bootstrap"
assert_grep 'error: chromium' "$STDERR12A" "CUJ 12a chromium DL failure stays fatal"
if has_chromium_cache "$ISO_HOME_C/.cache/ms-playwright"; then
  echo "[bootstrap-test] FAIL: CUJ 12a ISO_HOME_C unexpectedly has chromium cache after fatal" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 12a pass (exit=$code)"

# CUJ 12b: PECOTV_AUTO_INSTALL_BROWSER=1 のときだけ起動時のバックグラウンド取得が動く。
# 取得は PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1 で必ず失敗させる。
# 実 DL を待たずに済み、かつ「バックグラウンド取得が失敗しても serve は続く」ことまで同時に確認できる。
# CUJ 12 で install / build 済みのため warm state で動く（判定は bootstrap 要否の外にある）。
echo "[bootstrap-test] CUJ 12b: opt-in env starts the background chromium fetch"
STDERR12B="$WORK_DIR/cuj12b.stderr"
STDOUT12B="$WORK_DIR/cuj12b.stdout"
FIFO12B="$WORK_DIR/cuj12b.stdin.fifo"
rm -f "$FIFO12B" "$STDOUT12B" "$STDERR12B" "$CHROMIUM_INSTALL_LOG"
mkfifo "$FIFO12B"
set +e
PECOTV_AUTO_INSTALL_BROWSER=1 PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1 HOME="$ISO_HOME_C" \
  "$BIN_PECOTV" mcp <"$FIFO12B" >"$STDOUT12B" 2>"$STDERR12B" &
mcp12b_pid=$!
exec 7>"$FIFO12B"
printf '%s\n' "$MCP_INIT_REQUEST" >&7
mcp_deadline=$(( $(date +%s) + 120 ))
while [ ! -s "$STDOUT12B" ] && [ "$(date +%s)" -le "$mcp_deadline" ]; do
  sleep 0.5
done
sleep 0.5
exec 7>&-
wait "$mcp12b_pid"
code=$?
set -e
rm -f "$FIFO12B"
assert_exit_zero "$code" "CUJ 12b exit"
assert_grep 'バックグラウンドで取得します' "$STDERR12B" "CUJ 12b background fetch fired under opt-in"
assert_no_grep 'error: chromium' "$STDERR12B" "CUJ 12b background DL failure is not fatal"
assert_no_grep 'Downloading|Progress' "$STDOUT12B" "CUJ 12b background fetch output stays off stdout"
# バックグラウンド取得のログが node_modules 配下（gitignore 済）に残ること。
# 取得プロセスは MCP サーバの終了を待たずに動くため、ログ生成を短時間だけ待つ。
log_deadline=$(( $(date +%s) + 30 ))
while [ ! -f "$CHROMIUM_INSTALL_LOG" ] && [ "$(date +%s)" -le "$log_deadline" ]; do
  sleep 0.5
done
if [ ! -f "$CHROMIUM_INSTALL_LOG" ]; then
  echo "[bootstrap-test] FAIL: CUJ 12b background chromium install log not found at $CHROMIUM_INSTALL_LOG" >&2
  exit 1
fi
# 取得プロセスの完走を待ってから中身を見る。
# 子シェルは `exec >"$LOG"` を先に実行する。
# そのためログファイル自体は 1 バイトも書けなくても必ず作られ、存在確認だけでは見逃す不具合がある。
# 見逃す例は、`--filter` の typo、cwd 誤り、pnpm 解決失敗。
# ここで待てば、後続 CUJ（13c の setup が同じロックをブロッキングで取りに来る）との順序依存も消える。
if command -v flock >/dev/null 2>&1; then
  flock "$CHROMIUM_INSTALL_LOCK" true
fi
assert_grep '[Cc]hromium|[Pp]laywright' "$CHROMIUM_INSTALL_LOG" "CUJ 12b background fetch actually ran playwright"
# 強制失敗させた DL 自体の失敗（ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL）は想定内なので除外する。
# 弾くのは、workspace filter / cwd / pnpm 解決の失敗形だけ。
assert_no_grep 'No projects matched|ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND|command not found' \
  "$CHROMIUM_INSTALL_LOG" "CUJ 12b background fetch resolved the workspace filter and cwd"
if has_chromium_cache "$ISO_HOME_C/.cache/ms-playwright"; then
  echo "[bootstrap-test] FAIL: CUJ 12b unexpectedly populated chromium cache (DL was forced to fail)" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 12b pass"

# CUJ 13: chromium が要るツールの案内と、`setup` ツールによる復旧。
# 未取得のまま drawio_export を呼ぶと setup ツールを案内され、setup を呼ぶと実際に取得できて
# 同じ引数が通るようになる、という一連の導線を実プロセスで通す。
# 13c は実 DL (~120MB / 計測 33s) を伴うため harness 全体が延びる。CI 組み込み時は再評価。
export BIN_PECOTV
MCP_CALL="$SCRIPT_DIR/mcp-call.mjs"

echo "[bootstrap-test] CUJ 13a: chromium-dependent tool guides to the setup tool"
RESULT13A="$WORK_DIR/cuj13a.json"
set +e
HOME="$ISO_HOME_C" node "$MCP_CALL" drawio_export \
  "{\"input_path\":\"$DRAWIO_FIXTURE\",\"icons_dir\":\"$PLUGIN_ROOT/assets/drawio-icons\"}" \
  >"$RESULT13A" 2>"$WORK_DIR/cuj13a.stderr"
code=$?
set -e
assert_exit_zero "$code" "CUJ 13a exit"
if ! node - "$RESULT13A" <<'NODE'
  const fs = require("fs");
  const message = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const result = message.result;
  if (!result || result.isError !== true) { console.error("expected isError: true"); process.exit(1); }
  const data = result.structuredContent && result.structuredContent.data;
  if (!data || data.reason !== "chromium-not-installed") {
    console.error("unexpected data: " + JSON.stringify(data)); process.exit(1);
  }
  if (!String(data.detail).includes("`setup` ツール")) {
    console.error("detail does not guide to the setup tool: " + data.detail); process.exit(1);
  }
NODE
then
  echo "[bootstrap-test] FAIL: CUJ 13a did not return the setup guidance" >&2
  sed -n '1,20p' "$RESULT13A" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 13a pass"

echo "[bootstrap-test] CUJ 13b: setup surfaces the reason when the download is unreachable"
RESULT13B="$WORK_DIR/cuj13b.json"
set +e
PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:1 HOME="$ISO_HOME_C" node "$MCP_CALL" setup \
  >"$RESULT13B" 2>"$WORK_DIR/cuj13b.stderr"
code=$?
set -e
assert_exit_zero "$code" "CUJ 13b exit"
if ! node -e '
  const fs = require("fs");
  const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result;
  if (!result || result.isError !== true) { console.error("expected isError: true"); process.exit(1); }
  const data = result.structuredContent.data;
  if (data.reason !== "chromium-install-failed") {
    console.error("unexpected reason: " + JSON.stringify(data)); process.exit(1);
  }
  for (const hint of ["HTTPS_PROXY", "PLAYWRIGHT_DOWNLOAD_HOST"]) {
    if (!String(data.detail).includes(hint)) {
      console.error("detail lacks " + hint + ": " + data.detail); process.exit(1);
    }
  }
' "$RESULT13B"; then
  echo "[bootstrap-test] FAIL: CUJ 13b did not surface the download failure" >&2
  sed -n '1,20p' "$RESULT13B" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 13b pass"

# CUJ 13c: setup がツールのブロックを解除する。
# 標準では ISO_HOME（CUJ 1 の実 DL で populated 済）から chromium キャッシュを複製し、
# setup の冪等ルート（取得済みなら DL せず成功）を観測する。実 DL を伴うルートは 2 本目の
# ~120MB になるため PECOTV_BOOTSTRAP_TEST_HEAVY=1 の opt-in にする。どちらのルートでも
# 「setup 後に 13a と同じ呼び出しが通る」ところまでは動く。
RESULT13C="$WORK_DIR/cuj13c.json"
if [ "${PECOTV_BOOTSTRAP_TEST_HEAVY:-}" = "1" ]; then
  echo "[bootstrap-test] CUJ 13c: setup actually downloads chromium and unblocks the tool (heavy)"
  EXPECT13C_EVENT="setup.done"
  EXPECT13C_DOWNLOADED="true"
else
  echo "[bootstrap-test] CUJ 13c: setup skips the download when chromium is already present"
  rm -rf "$ISO_HOME_C/.cache/ms-playwright"
  cp -a "$ISO_HOME/.cache/ms-playwright" "$ISO_HOME_C/.cache/ms-playwright"
  EXPECT13C_EVENT="setup.skipped"
  EXPECT13C_DOWNLOADED="false"
fi
set +e
HOME="$ISO_HOME_C" node "$MCP_CALL" setup >"$RESULT13C" 2>"$WORK_DIR/cuj13c.stderr"
code=$?
set -e
assert_exit_zero "$code" "CUJ 13c exit"
if ! node -e '
  const fs = require("fs");
  const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result;
  if (!result || result.isError !== undefined) {
    console.error("expected success, got: " + JSON.stringify(result && result.structuredContent)); process.exit(1);
  }
  const data = result.structuredContent.data;
  const expectedEvent = process.argv[2];
  const expectedDownloaded = process.argv[3] === "true";
  const chromium = data.chromium || {};
  if (data.event !== expectedEvent || chromium.installed !== true || chromium.downloaded !== expectedDownloaded) {
    console.error("unexpected data: " + JSON.stringify(data)); process.exit(1);
  }
' "$RESULT13C" "$EXPECT13C_EVENT" "$EXPECT13C_DOWNLOADED"; then
  echo "[bootstrap-test] FAIL: CUJ 13c setup did not report $EXPECT13C_EVENT" >&2
  sed -n '1,20p' "$RESULT13C" >&2
  exit 1
fi
if ! has_chromium_cache "$ISO_HOME_C/.cache/ms-playwright"; then
  echo "[bootstrap-test] FAIL: CUJ 13c setup reported success but chromium cache is empty" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 13c pass"

# CUJ 13d: 取得後は 13a と同じ呼び出しが通る（案内どおりに復旧できる）。ガードを抜けた先で
# 実際に Chromium が起動することまで見るため print_hash は使わず SVG を書き出す。
echo "[bootstrap-test] CUJ 13d: drawio_export works again once setup has fetched chromium"
RESULT13D="$WORK_DIR/cuj13d.json"
CUJ13D_SVG="$WORK_DIR/cuj13d.svg"
rm -f "$CUJ13D_SVG"
set +e
HOME="$ISO_HOME_C" node "$MCP_CALL" drawio_export \
  "{\"input_path\":\"$DRAWIO_FIXTURE\",\"icons_dir\":\"$PLUGIN_ROOT/assets/drawio-icons\",\"out_path\":\"$CUJ13D_SVG\"}" \
  >"$RESULT13D" 2>"$WORK_DIR/cuj13d.stderr"
code=$?
set -e
assert_exit_zero "$code" "CUJ 13d exit"
if ! node -e '
  const fs = require("fs");
  const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result;
  if (!result || result.isError !== undefined) {
    console.error("expected success after setup: "
      + JSON.stringify(result && result.structuredContent)); process.exit(1);
  }
' "$RESULT13D"; then
  echo "[bootstrap-test] FAIL: CUJ 13d drawio_export still blocked after setup" >&2
  sed -n '1,20p' "$RESULT13D" >&2
  exit 1
fi
if [ ! -s "$CUJ13D_SVG" ]; then
  echo "[bootstrap-test] FAIL: CUJ 13d SVG not generated at $CUJ13D_SVG" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 13d pass"

# CUJ 13e: icons_dir を省略しても plugin-root 同梱のカタログで icon:// が解決され SVG が出る。
# 単体配布ルート（npx）では展開先の hash が環境ごとに変わり、呼び出し側が icons_dir の
# 絶対パスを組み立てられない。既定が働かないと icon-unresolved で必ず落ちるルート。
echo "[bootstrap-test] CUJ 13e: drawio_export resolves icon:// with the bundled catalog by default"
DRAWIO_ICON_FIXTURE="$PLUGIN_ROOT/cli/tests/fixtures/drawio/icon-resolvable.drawio"
RESULT13E="$WORK_DIR/cuj13e.json"
CUJ13E_SVG="$WORK_DIR/cuj13e.svg"
rm -f "$CUJ13E_SVG"
set +e
HOME="$ISO_HOME_C" node "$MCP_CALL" drawio_export \
  "{\"input_path\":\"$DRAWIO_ICON_FIXTURE\",\"out_path\":\"$CUJ13E_SVG\"}" \
  >"$RESULT13E" 2>"$WORK_DIR/cuj13e.stderr"
code=$?
set -e
assert_exit_zero "$code" "CUJ 13e exit"
if ! node -e '
  const fs = require("fs");
  const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result;
  if (!result || result.isError !== undefined) {
    console.error("expected success without icons_dir: "
      + JSON.stringify(result && result.structuredContent)); process.exit(1);
  }
' "$RESULT13E"; then
  echo "[bootstrap-test] FAIL: CUJ 13e drawio_export failed without icons_dir" >&2
  sed -n '1,20p' "$RESULT13E" >&2
  exit 1
fi
if [ ! -s "$CUJ13E_SVG" ]; then
  echo "[bootstrap-test] FAIL: CUJ 13e SVG not generated at $CUJ13E_SVG" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 13e pass"

# CUJ 14: chromium 取得済みなら opt-in でも起動時のバックグラウンド取得は動かない。
# CUJ 12b は強制失敗 DL しか通しておらず、PECOTV_AUTO_INSTALL_BROWSER=1 の「取得済みなら
# 何もしない」側が未検証だった。判定基準が破損すると MCP 起動のたびに無用な install
# サブプロセスが立ち、バックグラウンド取得ログが毎回 truncate される。
# CUJ 13c 通過後の ISO_HOME_C は chromium 取得済みなので、追加 DL なしで観測できる。
echo "[bootstrap-test] CUJ 14: opt-in does not refetch chromium when it is already present"
STDERR14="$WORK_DIR/cuj14.stderr"
STDOUT14="$WORK_DIR/cuj14.stdout"
FIFO14="$WORK_DIR/cuj14.stdin.fifo"
rm -f "$FIFO14" "$STDOUT14" "$STDERR14" "$CHROMIUM_INSTALL_LOG"
mkfifo "$FIFO14"
set +e
PECOTV_AUTO_INSTALL_BROWSER=1 HOME="$ISO_HOME_C" \
  "$BIN_PECOTV" mcp <"$FIFO14" >"$STDOUT14" 2>"$STDERR14" &
mcp14_pid=$!
exec 7>"$FIFO14"
printf '%s\n' "$MCP_INIT_REQUEST" >&7
mcp_deadline=$(( $(date +%s) + 120 ))
while [ ! -s "$STDOUT14" ] && [ "$(date +%s)" -le "$mcp_deadline" ]; do
  sleep 0.5
done
sleep 0.5
exec 7>&-
wait "$mcp14_pid"
code=$?
set -e
rm -f "$FIFO14"
assert_exit_zero "$code" "CUJ 14 exit"
assert_no_grep 'バックグラウンドで取得します' "$STDERR14" "CUJ 14 no background fetch when chromium is present"
assert_no_grep 'running playwright install chromium' "$STDERR14" "CUJ 14 no synchronous chromium install"
if [ -f "$CHROMIUM_INSTALL_LOG" ]; then
  echo "[bootstrap-test] FAIL: CUJ 14 started a background chromium fetch despite an existing install" >&2
  exit 1
fi
echo "[bootstrap-test] CUJ 14 pass"

# 静的確認
echo "[bootstrap-test] static checks"
SETUP_SH="$PLUGIN_ROOT/setup.sh"

if grep -q 'pnpm --filter @pecot/pecotv-cli run build' "$SETUP_SH"; then
  echo "[bootstrap-test] FAIL: setup.sh still contains pnpm build invocation (should be shim'd to bin/pecotv)" >&2
  exit 1
fi
if ! grep -q 'bin/pecotv' "$SETUP_SH"; then
  echo "[bootstrap-test] FAIL: setup.sh does not delegate to bin/pecotv" >&2
  exit 1
fi
# bin/pecotv に chromium install 失敗時の exit 1 ルートがあること（warn-only への退行防止）。
# grep のマルチライン処理は難しいので、error: chromium 行の直近に exit 1 が居ることで代替する。
# -A 5 は将来エラーメッセージを 1-2 行追加しても検知が抜けないためのマージン。
if ! grep -A 5 'error: chromium' "$PLUGIN_ROOT/bin/pecotv" | grep -q 'exit 1'; then
  echo "[bootstrap-test] FAIL: bin/pecotv lacks 'exit 1' near 'error: chromium' (chromium install must be fatal)" >&2
  exit 1
fi
echo "[bootstrap-test] static checks pass"

echo "[bootstrap-test] all CUJ passed"
