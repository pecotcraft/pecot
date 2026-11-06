#!/usr/bin/env bash
# bin/pecotv が実行用ミラー（${データ置き場}/runtime/<deps-hash>-<src-hash>/）をいつ作り直すかの軽量テスト。
# 実 pnpm と実 build は使わない。
# pnpm を記録だけの stub に差し替えた最小の plugin root を使う。
# wrapper の固定行（`pecotv: installing dependencies` / `pecotv: building`）の数と、pnpm の呼び出しを数える。
#
#   回数（install/build）は次のとおり。
#   同一なら 0/0、版だけなら 0/0（報告される版は新版）、ソースだけなら 0/1、依存の変更なら 1/1、2 回目は 0/0。
#   vendor/text-rules の版だけの更新では install しない（0/1）。
#   CHANGELOG などだけの更新では build もしない（0/0）。
#   途中で止まったディレクトリは作り直す。current は切り替えず、非 0 で終わる。
#   同時に 2 本起動しても、install 行は合計 1 行にする。
#   世代削除は、使用中の世代と current を消さない。
#   プラグインルートが読み取り専用でも準備が通る。本体配下には何も作らない。
#   MCP 起動の標準出力は、bootstrap の出力で汚れない。
#
#   bash plugins/pecot-visual/cli/tests/bootstrap/install-record.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=stub-root.sh
. "$SCRIPT_DIR/stub-root.sh"
stub_root_init install-record

INSTALL='installing dependencies$'
BUILD='building$'

# check <名前> <install 行の数> <build 行の数>（直前の stub_run の結果）
check_counts() {
  local name="$1" want_install="$2" want_build="$3" got_install got_build
  got_install="$(count_events "$INSTALL")"
  got_build="$(count_events "$BUILD")"
  if [ "$RC" = 0 ] && [ "$got_install" = "$want_install" ] && [ "$got_build" = "$want_build" ]; then
    ok "$name (install=$got_install build=$got_build)"
  else
    ng "$name" "exit=$RC install=$got_install (want $want_install) build=$got_build (want $want_build)"
    show_err
  fi
}

reported() { node -e 'const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8").trim().split("\n").pop()); process.stdout.write(String(j[process.argv[2]]))' "$OUT" "$1"; }

# --- 初回 ---
stub_run -- mcp
check_counts "初回: install 1 / build 1" 1 1
assert_eq "初回: 完成印のあるミラーが 1 つ" 1 "$(mirrors | wc -l | tr -d ' ')"
assert_eq "初回: current がそのミラーを指す" "$(mirrors | head -n 1)" "$(current_target)"
assert_eq "初回: 実行した cli の版は plugin.json の版" 1.0.0 "$(reported version)"
assert_eq "初回: cli に PECOTV_RUNTIME_DIR でミラーを渡す" "$(mirrors | head -n 1)" "$(reported runtime)"
assert_eq "初回: cli に PECOTV_DEPENDENCY_ROOT で current を渡す" "$DATA/runtime/current" "$(reported dependencyRoot)"
assert_eq "初回: 本体に node_modules を作らない" no "$([ -e "$ROOT/node_modules" ] && echo yes || echo no)"
assert_eq "初回: 本体に cli/dist を作らない" no "$([ -e "$ROOT/cli/dist" ] && echo yes || echo no)"
assert_eq "初回: 本体に旧配置のロックを作らない" no "$([ -e "$ROOT/.pecotv-bootstrap.lock" ] && echo yes || echo no)"
FIRST="$(mirrors | head -n 1)"
assert_eq "初回: ミラーの pnpm-lock.yaml は runtime-lock.yaml の中身" "$(cat "$ROOT/runtime-lock.yaml")" "$(cat "$FIRST/pnpm-lock.yaml")"
assert_eq "初回: ミラーの pnpm-workspace.yaml は runtime-workspace.yaml の中身" "$(cat "$ROOT/runtime-workspace.yaml")" "$(cat "$FIRST/pnpm-workspace.yaml")"
assert_eq "初回: ミラーに runtime-*.yaml の名前を残さない" no "$([ -e "$FIRST/runtime-lock.yaml" ] || [ -e "$FIRST/runtime-workspace.yaml" ] && echo yes || echo no)"
assert_eq "初回: build のとき --config.verify-deps-before-run=false を付ける" 1 "$(count_calls 'verify-deps-before-run=false --filter @pecot/pecotv-cli run build')"

# --- 同一の 2 回目 ---
stub_run -- mcp
check_counts "同一の 2 回目: install 0 / build 0" 0 0
assert_eq "同一の 2 回目: ミラーは増えない" 1 "$(mirrors | wc -l | tr -d ' ')"
assert_eq "同一の 2 回目: pnpm を呼ばない" 0 "$(wc -l < "$CALLS" | tr -d ' ')"

# --- 版だけの更新（plugin.json と CHANGELOG だけ） ---
printf '{"name":"pecot-v","version":"1.1.0"}\n' > "$ROOT/.claude-plugin/plugin.json"
printf '# changelog 2\n' > "$ROOT/CHANGELOG.md"
stub_run -- mcp
check_counts "版だけの更新: install 0 / build 0" 0 0
assert_eq "版だけの更新: ディレクトリ名は変わらない" "$FIRST" "$(mirrors | head -n 1)"
assert_eq "版だけの更新: 報告される版は新版" 1.1.0 "$(reported version)"

# --- ソースだけの更新 ---
printf 'v2\n' > "$ROOT/cli/src/index.ts"
stub_run -- mcp
check_counts "ソースだけの更新: install 0 / build 1" 0 1
SECOND="$(current_target)"
[ "$SECOND" != "$FIRST" ] && ok "ソースだけの更新: 新しいミラーへ current を切り替える" || ng "ソースだけの更新: current が動かない"
assert_eq "ソースだけの更新: 新しい cli で実行する" v2 "$(reported built)"
assert_eq "ソースだけの更新: node_modules は旧ミラーと同じ inode（ハードリンク複製）" \
  "$(stat -c %i "$FIRST/cli/node_modules/pkg.js")" "$(stat -c %i "$SECOND/cli/node_modules/pkg.js")"
assert_eq "ソースだけの更新: pnpm の状態ファイルは複製しない" no "$([ -e "$SECOND/node_modules/.pnpm-workspace-state-v1.json" ] && echo yes || echo no)"
assert_eq "ソースだけの更新: 実行時キャッシュは複製しない" no "$([ -e "$SECOND/node_modules/.vite" ] && echo yes || echo no)"
assert_eq "ソースだけの更新: .modules.yaml は複製する" yes "$([ -e "$SECOND/node_modules/.modules.yaml" ] && echo yes || echo no)"
stub_run -- mcp
check_counts "ソースだけの更新の 2 回目: install 0 / build 0" 0 0

# --- vendor/text-rules の版上げ ---
# text-rules は repo 共通のライブラリ。
# リリースのたびに、package.json の version と CHANGELOG.md などが変わる。
# 依存の宣言は runtime-lock.yaml が持つので、版上げで利用者の導入をやり直さない。
mkdir -p "$ROOT/vendor/text-rules"
printf '{ "name": "@pecot/text-rules", "version": "1.0.0" }\n' > "$ROOT/vendor/text-rules/package.json"
printf 'export const rule = 1;\n' > "$ROOT/vendor/text-rules/index.ts"
printf '# text-rules changelog 1\n' > "$ROOT/vendor/text-rules/CHANGELOG.md"
printf 'lock: 1\n' > "$ROOT/vendor/text-rules/package-lock.json"
printf '{ "name": "text-rules" }\n' > "$ROOT/vendor/text-rules/project.json"
printf 'packages:\n  - cli\n  - vendor/text-rules\n' > "$ROOT/runtime-workspace.yaml"
stub_run -- mcp
check_counts "text-rules を workspace に加える: install 1 / build 1" 1 1
stub_run -- mcp
check_counts "text-rules を加えた後の 2 回目: install 0 / build 0" 0 0
DEPS_BEFORE="$(basename "$(current_target)" | cut -d- -f1)"
printf '{ "name": "@pecot/text-rules", "version": "1.1.0" }\n' > "$ROOT/vendor/text-rules/package.json"
printf '# text-rules changelog 2\n' > "$ROOT/vendor/text-rules/CHANGELOG.md"
stub_run -- mcp
check_counts "text-rules の版だけを上げる: install 0 / build 1" 0 1
assert_eq "text-rules の版だけを上げる: deps-hash は変わらない" "$DEPS_BEFORE" "$(basename "$(current_target)" | cut -d- -f1)"
SRC_BEFORE="$(basename "$(current_target)")"
printf '# text-rules changelog 3\n' > "$ROOT/vendor/text-rules/CHANGELOG.md"
printf 'lock: 2\n' > "$ROOT/vendor/text-rules/package-lock.json"
printf '{ "name": "text-rules", "tags": [] }\n' > "$ROOT/vendor/text-rules/project.json"
stub_run -- mcp
check_counts "text-rules の CHANGELOG・package-lock・project.json だけを変える: install 0 / build 0" 0 0
assert_eq "text-rules の CHANGELOG などだけを変える: ミラーは変わらない" "$SRC_BEFORE" "$(basename "$(current_target)")"
printf 'export const rule = 2;\n' > "$ROOT/vendor/text-rules/index.ts"
stub_run -- mcp
check_counts "text-rules のソースを変える: install 0 / build 1" 0 1

# --- 依存の変更（lock） ---
printf 'lock: 2\n' > "$ROOT/runtime-lock.yaml"
stub_run -- mcp
check_counts "依存の変更: install 1 / build 1" 1 1
stub_run -- mcp
check_counts "依存の変更の 2 回目: install 0 / build 0" 0 0

# --- node のメジャー版 / pnpm の版 / runtime の manifest の変化でも install する ---
cat > "$STUB_BIN/node" <<SH
#!/usr/bin/env bash
if [ "\${1:-}" = "-p" ] && [[ "\${2:-}" == *versions.node* ]]; then
  echo "\${STUB_NODE_MAJOR:-24}"
  exit 0
fi
exec "$(command -v node)" "\$@"
SH
chmod +x "$STUB_BIN/node"
stub_run STUB_NODE_MAJOR=26 -- mcp
check_counts "node のメジャー版が変わる: install 1 / build 1" 1 1
stub_run STUB_NODE_MAJOR=26 -- mcp
check_counts "node のメジャー版が変わった後の 2 回目: 0 / 0" 0 0
sed -i 's/pnpm@12.15.0+sha512.aaaa/pnpm@12.16.0+sha512.bbbb/' "$ROOT/package.json"
stub_run STUB_NODE_MAJOR=26 -- mcp
check_counts "pnpm の版が変わる: install 1 / build 1" 1 1
# runtime の manifest は workspace のメンバーなので、依存の入力に入る。
mkdir -p "$ROOT/assets/slidev/runtime"
printf '{ "name": "@pecot/slidev-runtime", "version": "0.0.0", "private": true }\n' > "$ROOT/assets/slidev/runtime/package.json"
printf 'packages:\n  - cli\n  - assets/slidev/runtime\n' > "$ROOT/runtime-workspace.yaml"
stub_run STUB_NODE_MAJOR=26 -- mcp
check_counts "runtime の manifest が workspace に加わる: install 1 / build 1" 1 1
printf '{ "name": "@pecot/slidev-runtime", "version": "0.0.0", "private": true, "dependencies": { "left-pad": "1.3.0" } }\n' > "$ROOT/assets/slidev/runtime/package.json"
stub_run STUB_NODE_MAJOR=26 -- mcp
check_counts "runtime の manifest の中身が変わる: install 1 / build 1" 1 1
stub_run STUB_NODE_MAJOR=26 -- mcp
check_counts "runtime の manifest が変わった後の 2 回目: 0 / 0" 0 0

# --- 途中で止まったディレクトリ ---
before="$(current_target)"
printf 'v3\n' > "$ROOT/cli/src/index.ts"
stub_run STUB_NODE_MAJOR=26 STUB_FAIL_BUILD=1 -- mcp
if [ "$RC" != 0 ]; then ok "build が失敗: 非 0 で終わる (exit=$RC)"; else ng "build が失敗しても exit 0"; fi
assert_eq "build が失敗: current は切り替えない" "$before" "$(current_target)"
incomplete=0
for d in $(mirrors); do [ -e "$d/.complete" ] || incomplete=$((incomplete + 1)); done
assert_eq "build が失敗: 完成印の無いディレクトリが 1 つ残る（次の起動で作り直す）" 1 "$incomplete"
assert_eq "build が失敗: 標準出力は空（stub の雑音を出さない）" 0 "$(wc -c < "$OUT" | tr -d ' ')"
stub_run STUB_NODE_MAJOR=26 -- mcp
check_counts "失敗の次の起動: 作り直す（install 0 / build 1）" 0 1
assert_eq "失敗の次の起動: 新しい cli で実行する" v3 "$(reported built)"
assert_eq "失敗の次の起動: 完成印の無いディレクトリは残らない" 0 \
  "$(for d in $(mirrors); do [ -e "$d/.complete" ] || echo "$d"; done | wc -l | tr -d ' ')"
stub_run STUB_NODE_MAJOR=26 STUB_FAIL_INSTALL=1 -- mcp
check_counts "失敗した起動の後でも完成済みは 0 / 0" 0 0

# --- install が失敗する依存の変更 ---
before="$(current_target)"
printf 'lock: 3\n' > "$ROOT/runtime-lock.yaml"
stub_run STUB_NODE_MAJOR=26 STUB_FAIL_INSTALL=1 -- mcp
if [ "$RC" != 0 ]; then ok "install が失敗: 非 0 で終わる (exit=$RC)"; else ng "install が失敗しても exit 0"; fi
assert_eq "install が失敗: current は切り替えない" "$before" "$(current_target)"
assert_eq "install が失敗: build を実行しない" 0 "$(count_events "$BUILD")"
stub_run STUB_NODE_MAJOR=26 -- mcp
check_counts "install 失敗の次の起動: install 1 / build 1" 1 1

# --- SKIP / 実行中のミラーの引き継ぎ ---
mkdir -p "$ROOT/cli/dist"
printf 'console.log(JSON.stringify({ skipped: true, runtime: process.env.PECOTV_RUNTIME_DIR || null, dependencyRoot: process.env.PECOTV_DEPENDENCY_ROOT || null }))\n' > "$ROOT/cli/dist/cli.js"
rm -rf "$DATA/runtime/.before"
ls -A "$DATA/runtime" > "$BASE/runtime-before"
stub_run STUB_NODE_MAJOR=26 PECOTV_BOOTSTRAP_SKIP=1 PECOTV_RUNTIME_DIR="$FIRST" PECOTV_DEPENDENCY_ROOT="$DATA/runtime/current" -- mcp
assert_eq "SKIP=1: 本体ツリーの cli/dist を実行する" true "$(reported skipped)"
assert_eq "SKIP=1: 受け継いだミラーの変数を渡さない（runtime）" null "$(reported runtime)"
assert_eq "SKIP=1: 受け継いだミラーの変数を渡さない（dependencyRoot）" null "$(reported dependencyRoot)"
ls -A "$DATA/runtime" > "$BASE/runtime-after"
assert_eq "SKIP=1: データ置き場に何も作らない" "$(cat "$BASE/runtime-before")" "$(cat "$BASE/runtime-after")"
assert_eq "SKIP=1: install / build をしない" 0 "$(count_events 'installing dependencies|building')"
rm -rf "$ROOT/cli/dist"

printf 'v4\n' > "$ROOT/cli/src/index.ts"
stub_run STUB_NODE_MAJOR=26 PECOTV_RUNTIME_DIR="$(current_target)" -- mcp
check_counts "実行中のミラーを引き継いだ子プロセス: 準備し直さない（ソースが変わっていても 0 / 0）" 0 0
assert_eq "実行中のミラーを引き継いだ子プロセス: 引き継いだミラーの cli で実行する" v3 "$(reported built)"
printf 'v3\n' > "$ROOT/cli/src/index.ts"

# --- 世代削除 ---
# 使用中の世代（cli が生きている）を 1 本立てたまま、ソースを 3 回変えて build する。
printf 'g0\n' > "$ROOT/cli/src/index.ts"
stub_run STUB_NODE_MAJOR=26 -- mcp
HELD_DIR="$(current_target)"
HOLD="$BASE/hold.pid"
rm -f "$HOLD"
stub_spawn /dev/null /dev/null STUB_NODE_MAJOR=26 STUB_HOLD="$HOLD" -- mcp &
HELD_PID=$!
for _ in $(seq 1 50); do [ -s "$HOLD" ] && break; sleep 0.1; done
assert_eq "世代削除の準備: 使用中の cli が起動している" yes "$([ -s "$HOLD" ] && echo yes || echo no)"
GEN=()
for generation in g1 g2 g3 g4; do
  printf '%s\n' "$generation" > "$ROOT/cli/src/index.ts"
  stub_run STUB_NODE_MAJOR=26 -- mcp
  GEN+=("$(basename "$(current_target)")")
done
mirror_names() { mirrors | while IFS= read -r d; do basename "$d"; done | LC_ALL=C sort; }
sorted_names() { printf '%s\n' "$@" | LC_ALL=C sort; }
if command -v flock >/dev/null 2>&1; then
  assert_eq "世代削除: 使用中の世代は消さない" yes "$([ -e "$HELD_DIR/.complete" ] && echo yes || echo no)"
  assert_eq "世代削除: 残るのは使用中の世代と、直近 2 つ（名前で突き合わせ）" \
    "$(sorted_names "$(basename "$HELD_DIR")" "${GEN[3]}" "${GEN[2]}")" "$(mirror_names)"
else
  echo "skip 世代削除: flock(1) が無い環境では使用中かを判定できないため、削除しない"
fi
assert_eq "世代削除: current の指す先は消さない" yes "$([ -e "$(current_target)/.complete" ] && echo yes || echo no)"
kill "$(cat "$HOLD")" 2>/dev/null || true
kill "$HELD_PID" 2>/dev/null || true
wait "$HELD_PID" 2>/dev/null || true
printf 'g5\n' > "$ROOT/cli/src/index.ts"
stub_run STUB_NODE_MAJOR=26 -- mcp
if command -v flock >/dev/null 2>&1; then
  assert_eq "世代削除: 使われなくなった世代は次の準備で消え、直近 2 つ（g5 と g4）が残る（名前で突き合わせ）" \
    "$(sorted_names "$(basename "$(current_target)")" "${GEN[3]}")" "$(mirror_names)"
fi

# --- 同時起動 ---
printf 'c0\n' > "$ROOT/cli/src/index.ts"
printf 'lock: 4\n' > "$ROOT/runtime-lock.yaml"
rm -rf "$DATA/runtime"
: > "$CALLS"
# stub pnpm の install / build に 1 秒の遅延を入れ、3 本の起動が必ず重なるようにする（ロックが無ければ二重になる）。
for i in 1 2 3; do
  stub_spawn "$BASE/par-out-$i" "$BASE/par-err-$i" STUB_NODE_MAJOR=26 STUB_PNPM_DELAY=1 -- mcp &
done
wait
events_install="$(cat "$BASE"/par-err-* | grep -cE "$INSTALL" || true)"
events_build="$(cat "$BASE"/par-err-* | grep -cE "$BUILD" || true)"
assert_eq "同時に 3 本起動（遅延つきで重なる）: install 行は合計 1" 1 "$events_install"
assert_eq "同時に 3 本起動: build 行は合計 1" 1 "$events_build"
assert_eq "同時に 3 本起動: ミラーは 1 つ" 1 "$(mirrors | wc -l | tr -d ' ')"
all_ok=yes
for i in 1 2 3; do grep -q '"built":"c0"' "$BASE/par-out-$i" || all_ok=no; done
assert_eq "同時に 3 本起動: どれも完成したミラーで実行する" yes "$all_ok"

# --- 読み取り専用のプラグインルート ---
rm -rf "$DATA/runtime"
printf 'ro0\n' > "$ROOT/cli/src/index.ts"
chmod -R a-w "$ROOT"
stub_run STUB_NODE_MAJOR=26 -- mcp
chmod -R u+w "$ROOT"
check_counts "プラグインルートが読み取り専用: 初回の準備が通る（install 1 / build 1）" 1 1
assert_eq "プラグインルートが読み取り専用: 実行できる" ro0 "$(reported built)"
stub_run STUB_NODE_MAJOR=26 -- mcp
check_counts "プラグインルートが読み取り専用でも 2 回目は 0 / 0" 0 0

# --- flock(1) が無い環境（macOS 標準）: ロックファイルで直列化し、世代削除はしない ---
make_noflock_bin
rm -rf "$DATA/runtime" "$BASE"/nf-err-*
printf 'nf0\n' > "$ROOT/cli/src/index.ts"
for i in 1 2; do
  stub_spawn "$BASE/nf-out-$i" "$BASE/nf-err-$i" STUB_NODE_MAJOR=26 STUB_PNPM_DELAY=1 PATH="$STUB_BIN:$NOFLOCK_BIN" -- mcp &
done
wait
assert_eq "flock 無しで同時に 2 本起動: install 行は合計 1" 1 "$(cat "$BASE"/nf-err-* | grep -cE "$INSTALL" || true)"
assert_eq "flock 無しで同時に 2 本起動: build 行は合計 1" 1 "$(cat "$BASE"/nf-err-* | grep -cE "$BUILD" || true)"
assert_eq "flock 無しで同時に 2 本起動: ミラーは 1 つ" 1 "$(mirrors | wc -l | tr -d ' ')"
all_ok=yes
for i in 1 2; do grep -q '"built":"nf0"' "$BASE/nf-out-$i" || all_ok=no; done
assert_eq "flock 無しで同時に 2 本起動: どちらも完成したミラーで実行する" yes "$all_ok"
assert_eq "flock 無し: ロックを残さない" no "$([ -e "$DATA/runtime/.bootstrap.lock.pid" ] && echo yes || echo no)"
# mkdir が不可分でなくても（同時に呼ぶと 2 人とも成功する）、ロックは 1 人にしか取れない
make_lax_mkdir_bin
rm -rf "$DATA/runtime" "$BASE"/lax-err-*
printf 'lax0\n' > "$ROOT/cli/src/index.ts"
for i in 1 2; do
  stub_spawn "$BASE/lax-out-$i" "$BASE/lax-err-$i" STUB_NODE_MAJOR=26 STUB_PNPM_DELAY=1 PATH="$STUB_BIN:$LAX_MKDIR_BIN:$NOFLOCK_BIN" -- mcp &
done
wait
assert_eq "flock 無し・不可分でない mkdir で同時に 2 本起動: install 行は合計 1" 1 "$(cat "$BASE"/lax-err-* | grep -cE "$INSTALL" || true)"
assert_eq "flock 無し・不可分でない mkdir で同時に 2 本起動: build 行は合計 1" 1 "$(cat "$BASE"/lax-err-* | grep -cE "$BUILD" || true)"
all_ok=yes
for i in 1 2; do grep -q '"built":"lax0"' "$BASE/lax-out-$i" || all_ok=no; done
assert_eq "flock 無し・不可分でない mkdir で同時に 2 本起動: どちらも完成したミラーで実行する" yes "$all_ok"
# stale ロック（保持者が死んでいる）は rename で掃除して先へ進む
printf '999999\n' > "$DATA/runtime/.bootstrap.lock.pid"
printf 'nf1\n' > "$ROOT/cli/src/index.ts"
stub_run STUB_NODE_MAJOR=26 PATH="$STUB_BIN:$NOFLOCK_BIN" -- mcp
check_counts "flock 無し: stale ロックを掃除して build する（install 0 / build 1）" 0 1
assert_eq "flock 無し: stale ロックの掃除の跡を残さない" 0 "$(find "$DATA/runtime" -maxdepth 1 -name '.bootstrap.lock.pid*' | wc -l | tr -d ' ')"
for generation in nf2 nf3 nf4; do
  printf '%s\n' "$generation" > "$ROOT/cli/src/index.ts"
  stub_run STUB_NODE_MAJOR=26 PATH="$STUB_BIN:$NOFLOCK_BIN" -- mcp
done
assert_eq "flock 無し: 世代削除はしない（使用中かを判定できないため。5 世代が残る）" 5 "$(mirrors | wc -l | tr -d ' ')"
assert_eq "flock 無し: current は最後の世代" nf4 "$(reported built)"

# --- 版の並走: 新→旧→新の起動で current が往復しない ---
# Claude は旧版のプラグインルートを残すので、旧版のセッションと新版のセッションが同じデータ置き場を使う。
rm -rf "$DATA/runtime"
printf 'old0\n' > "$ROOT/cli/src/index.ts"
OLD_ROOT="$BASE/plugin-old"
rm -rf "$OLD_ROOT"
cp -a "$ROOT" "$OLD_ROOT"
RUN_ROOT="$OLD_ROOT" stub_run STUB_NODE_MAJOR=26 -- mcp
OLD_MIRROR="$(current_target)"
printf 'new0\n' > "$ROOT/cli/src/index.ts"
stub_run STUB_NODE_MAJOR=26 -- mcp
NEW_MIRROR="$(current_target)"
[ "$NEW_MIRROR" != "$OLD_MIRROR" ] && ok "版の並走: 新版の起動で current が新しいミラーに移る" || ng "版の並走: current が動かない"
RUN_ROOT="$OLD_ROOT" stub_run STUB_NODE_MAJOR=26 -- mcp
check_counts "版の並走: 旧版の起動は準備し直さない（0 / 0）" 0 0
assert_eq "版の並走: 旧版の起動の後も current は新を指したまま" "$NEW_MIRROR" "$(current_target)"
assert_eq "版の並走: 旧版の起動は旧ミラーの cli で動く" old0 "$(reported built)"
stub_run STUB_NODE_MAJOR=26 -- mcp
assert_eq "版の並走: 新版の起動でも current は新を指したまま" "$NEW_MIRROR" "$(current_target)"
RUN_ROOT="$OLD_ROOT" stub_run STUB_NODE_MAJOR=26 -- mcp
RUN_ROOT="$OLD_ROOT" stub_run STUB_NODE_MAJOR=26 -- mcp
assert_eq "版の並走: 旧版を繰り返し起動しても current は往復しない" "$NEW_MIRROR" "$(current_target)"

# --- MCP 起動の標準出力 ---
rm -rf "$DATA/runtime"
printf 'mcp0\n' > "$ROOT/cli/src/index.ts"
stub_run STUB_NODE_MAJOR=26 -- mcp
if grep -q 'stub-pnpm-stdout-noise' "$OUT"; then
  ng "MCP 起動: bootstrap の出力が標準出力に入った" "$(cat "$OUT")"
else
  ok "MCP 起動: bootstrap の出力は標準出力に入らない"
fi
assert_eq "MCP 起動: 標準出力は cli の出力 1 行だけ" 1 "$(wc -l < "$OUT" | tr -d ' ')"
if grep -q 'stub-pnpm-stdout-noise' "$ERR"; then ok "MCP 起動: bootstrap の出力は標準エラーへ寄る"; else ng "MCP 起動: 雑音が標準エラーに無い"; fi

echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
