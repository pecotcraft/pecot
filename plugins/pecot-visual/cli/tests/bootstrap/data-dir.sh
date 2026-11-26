#!/usr/bin/env bash
# bin/pecotv のデータ置き場の解決順と止まる条件を、stub の pnpm で確かめる。
# 解決順は SKIP → CLAUDE_PLUGIN_DATA → PLUGIN_DATA → ${XDG_DATA_HOME}/pecot/pecot-visual。
#   bash plugins/pecot-visual/cli/tests/bootstrap/data-dir.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=stub-root.sh
. "$SCRIPT_DIR/stub-root.sh"
stub_root_init data-dir

PROJECT=pecot-visual
SKIP_VAR=PECOTV_BOOTSTRAP_SKIP
OTHER="$BASE/other-data"
SECOND="$BASE/second-data"
XDG="$BASE/xdg-share"
FAKE_HOME="$BASE/fake-home"
mkdir -p "$OTHER" "$FAKE_HOME"

built_in() { find "$1" -mindepth 2 -maxdepth 2 -name .complete 2>/dev/null | wc -l | tr -d ' '; }
tree_of_base() { (cd "$BASE" && find . -mindepth 1 ! -name stdout ! -name stderr ! -name calls | LC_ALL=C sort); }
reported() { node -e 'const v = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; console.log(v === undefined ? "undefined" : v)' "$OUT" "$1"; }

# --- 解決順 ---
stub_run -- mcp
bt_eq "CLAUDE_PLUGIN_DATA だけ: そこに作る" 1 "$(built_in "$DATA/runtime")"

rm -rf "$DATA/runtime"
stub_run CLAUDE_PLUGIN_DATA= PLUGIN_DATA="$OTHER" -- mcp
bt_eq "PLUGIN_DATA だけ: そこに作る" 1 "$(built_in "$OTHER/runtime")"
bt_eq "PLUGIN_DATA だけ: ほかには作らない" 0 "$(built_in "$DATA/runtime")"

rm -rf "$OTHER/runtime"
stub_run PLUGIN_DATA="$OTHER" -- mcp
bt_eq "両方あり: CLAUDE_PLUGIN_DATA が勝つ" 1 "$(built_in "$DATA/runtime")"
bt_eq "両方あり: PLUGIN_DATA 側には作らない" 0 "$(built_in "$OTHER/runtime")"

for invalid in '${CLAUDE_PLUGIN_DATA}' '' 'relative/dir'; do
  rm -rf "$OTHER/runtime"
  stub_run CLAUDE_PLUGIN_DATA="$invalid" PLUGIN_DATA="$OTHER" -- mcp
  bt_eq "CLAUDE_PLUGIN_DATA が無効（${invalid:-空}）: PLUGIN_DATA へ切り替わる" 1 "$(built_in "$OTHER/runtime")"
done

rm -rf "$OTHER/runtime"
stub_run PLUGIN_DATA='${PLUGIN_DATA}' -- mcp
bt_eq "PLUGIN_DATA が未展開でも CLAUDE_PLUGIN_DATA が有効なら動く" 0 "$RC"

# 実在しない絶対パスは作って使う（既定の場所へ落とすと置き場が 2 か所に割れる）
stub_run CLAUDE_PLUGIN_DATA="$BASE/not-yet/created/data" -- mcp
bt_eq "実在しない絶対パス: 作って使う" 1 "$(built_in "$BASE/not-yet/created/data/runtime")"

rm -rf "$OTHER/runtime"
stub_run CLAUDE_PLUGIN_DATA="$OTHER/" -- mcp
bt_eq "末尾のスラッシュ付きの値も有効" 1 "$(built_in "$OTHER/runtime")"

rm -rf "$OTHER/runtime"
stub_run CLAUDE_PLUGIN_DATA="$OTHER"$'\n' -- mcp
bt_eq "末尾の改行は許容する" 1 "$(built_in "$OTHER/runtime")"
rm -rf "$OTHER/runtime"
stub_run CLAUDE_PLUGIN_DATA="$OTHER"$'\r\n' -- mcp
bt_eq "CRLF は許容する" 1 "$(built_in "$OTHER/runtime")"
rm -rf "$OTHER/runtime"

# cli へはミラーの変数だけを渡す（データ置き場の変数は作らない）
stub_run -- mcp
bt_eq "cli に渡すのは PECOTV_RUNTIME_DIR（置き場の runtime/ 配下）" yes "$(case "$(reported runtime)" in "$DATA/runtime/"*) echo yes ;; *) echo no ;; esac)"
bt_eq "cli に渡す PECOTV_DEPENDENCY_ROOT は runtime/current" "$DATA/runtime/current" "$(reported dependencyRoot)"
bt_eq "cli の子プロセスの環境に *_DATA_DIR が無い" "[]" "$(reported dataDirVars)"

# --- 標準の場所（クライアントが置き場を渡さない起動） ---
# CLAUDE_PLUGIN_DATA / PLUGIN_DATA を空にする。
# XDG_DATA_HOME と HOME は子プロセスだけに渡す。
default_run() { stub_run CLAUDE_PLUGIN_DATA= PLUGIN_DATA= "$@" -- mcp; }

default_run XDG_DATA_HOME="$XDG" HOME="$FAKE_HOME"
bt_eq "XDG_DATA_HOME が有効: \${XDG_DATA_HOME}/pecot/$PROJECT に作る" 1 "$(built_in "$XDG/pecot/$PROJECT/runtime")"
bt_eq "XDG_DATA_HOME が有効: HOME 側には作らない" no "$([ -e "$FAKE_HOME/.local" ] && echo yes || echo no)"
rm -rf "$XDG"

for invalid in '' 'relative/share' '${XDG_DATA_HOME}'; do
  default_run XDG_DATA_HOME="$invalid" HOME="$FAKE_HOME"
  bt_eq "XDG_DATA_HOME が無効（${invalid:-空}）: \${HOME}/.local/share/pecot/$PROJECT に作る" 1 "$(built_in "$FAKE_HOME/.local/share/pecot/$PROJECT/runtime")"
  rm -rf "$FAKE_HOME/.local"
done

default_run XDG_DATA_HOME= HOME="$FAKE_HOME"
bt_eq "既定の場所に作ったミラーで起動できる" 0 "$RC"
bt_eq "既定の場所: cli に渡す PECOTV_RUNTIME_DIR は置き場の runtime/ 配下" yes "$(case "$(reported runtime)" in "$FAKE_HOME/.local/share/pecot/$PROJECT/runtime/"*) echo yes ;; *) echo no ;; esac)"
rm -rf "$FAKE_HOME/.local"

# --- 止まる（HOME と有効な XDG_DATA_HOME のどちらも無い） ---
before="$(tree_of_base)"
default_run XDG_DATA_HOME= HOME=
bt_eq "解決できない: 非 0 で終わる" yes "$([ "$RC" != 0 ] && echo yes || echo no)"
bt_eq "解決できない: stdout は空" 0 "$(wc -c < "$OUT" | tr -d ' ')"
bt_eq "解決できない: stderr は 1 行" 1 "$(wc -l < "$ERR" | tr -d ' ')"
bt_eq "解決できない: 理由に project 名と HOME がある" 1 "$(grep -c -F "$PROJECT: cannot decide the data directory because HOME is unset" "$ERR" || true)"
bt_eq "解決できない: install / build をしない" 0 "$(wc -l < "$CALLS" | tr -d ' ')"
bt_eq "解決できない: 本体配下とデータ置き場のどちらにも何も作らない" "$before" "$(tree_of_base)"

# 相対パスの HOME は使わない（置き場が cwd 相対になるため）。
# 有効な XDG_DATA_HOME が無ければ止まる。
before="$(tree_of_base)"
default_run XDG_DATA_HOME= HOME=relative/home
bt_eq "相対パスの HOME: 非 0 で終わる" yes "$([ "$RC" != 0 ] && echo yes || echo no)"
bt_eq "相対パスの HOME: 理由に project 名と HOME がある" 1 "$(grep -c -F "$PROJECT: cannot decide the data directory because HOME is unset" "$ERR" || true)"
bt_eq "相対パスの HOME: 何も作らない" "$before" "$(tree_of_base)"

# HOME が無くても有効な XDG_DATA_HOME があれば動く
default_run XDG_DATA_HOME="$XDG" HOME=
bt_eq "HOME が無くても有効な XDG_DATA_HOME で動く" 1 "$(built_in "$XDG/pecot/$PROJECT/runtime")"
rm -rf "$XDG"

# --- SKIP はデータ置き場の解決より先（置き場を決められなくても動き、何も作らない） ---
mkdir -p "$ROOT/cli/dist"
printf 'console.log("skip-ran")\n' > "$ROOT/cli/dist/cli.js"
before="$(tree_of_base)"
stub_run CLAUDE_PLUGIN_DATA= PLUGIN_DATA= XDG_DATA_HOME= HOME= "$SKIP_VAR=1" -- mcp
bt_eq "SKIP=1: データ置き場を決められなくても停止せず本体ツリーを実行する" skip-ran "$(cat "$OUT")"
bt_eq "SKIP=1: 何も作らない" "$before" "$(tree_of_base)"

# SKIP は受け継いだミラーの変数を外す（導入済み版のミラーを使わない）
printf 'console.log(JSON.stringify({ runtime: process.env.PECOTV_RUNTIME_DIR || null, dependencyRoot: process.env.PECOTV_DEPENDENCY_ROOT || null }))\n' > "$ROOT/cli/dist/cli.js"
stub_run "$SKIP_VAR=1" PECOTV_RUNTIME_DIR="$BASE/inherited/runtime/abc" PECOTV_DEPENDENCY_ROOT="$BASE/inherited/runtime/current" -- mcp
bt_eq "SKIP=1: PECOTV_RUNTIME_DIR を cli に渡さない" null "$(reported runtime)"
bt_eq "SKIP=1: PECOTV_DEPENDENCY_ROOT を cli に渡さない" null "$(reported dependencyRoot)"

# 受け継いだ完成済みミラーがあれば再準備せずそのまま実行する（子プロセスの再入。置き場は見ない）
rm -rf "$ROOT/cli/dist"
stub_run -- mcp
inherited_runtime="$(reported runtime)"
: > "$CALLS"
stub_run CLAUDE_PLUGIN_DATA= PLUGIN_DATA= XDG_DATA_HOME= HOME= PECOTV_RUNTIME_DIR="$inherited_runtime" -- mcp
bt_eq "再入: 完成済みミラーを受け継げば置き場を決められなくても動く" 0 "$RC"
bt_eq "再入: install / build をしない" 0 "$(wc -l < "$CALLS" | tr -d ' ')"
bt_eq "再入: 受け継いだミラーで実行する" "$inherited_runtime" "$(reported runtime)"

bt_finish
