# bin/pecot-tools の bash テストが共有する helper（source 専用。単体では実行しない）。
#
# 実 pnpm・実 build は使わない。
# pnpm を、呼び出しを記録するだけの stub に差し替える。
# その最小の plugin root を一時ディレクトリに組む。
# データ置き場（CLAUDE_PLUGIN_DATA）を別の一時ディレクトリに向けて、bin/pecot-tools を実行する。
# 観測は 3 系統ある。
#   wrapper の固定行（`pecot-tools: installing dependencies` / `pecot-tools: building`）の数。
#   stub pnpm の呼び出し記録。
#   データ置き場の runtime/ の中身。
#
# 使い方を次に示す。
#   source "$SCRIPT_DIR/stub-root.sh"
#   stub_root_init <名前> # ROOT / DATA / STUB_BIN / CALLS を作る。後始末は trap。
#   stub_run [VAR=値 ...] -- <pecot-tools の引数...>   # RC / OUT / ERR を埋める。
#   count_events <正規表現> / count_calls <正規表現> / ok / ng で集計する。

PLUGIN_ROOT_SRC="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT_SRC/../.." && pwd)"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "ok   $1"; }
ng() { FAIL=$((FAIL + 1)); echo "FAIL $1"; shift; [ "$#" -eq 0 ] || printf '     %s\n' "$@"; }

# assert_eq <名前> <期待> <実際>
assert_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else ng "$1" "want [$2]" "got  [$3]"; fi
}

# 標準エラーを見せる（失敗時の診断）。
show_err() { sed 's/^/     /' "$ERR" | head -n 30; }

stub_root_init() {
  local name="$1"
  local work="$REPO_ROOT/.pecot/tmp/bootstrap-test"
  mkdir -p "$work"
  BASE="$(mktemp -d "$work/${name}-XXXXXX")"
  trap 'chmod -R u+w "$BASE" 2>/dev/null || true; rm -rf "$BASE"' EXIT
  ROOT="$BASE/plugin"
  DATA="$BASE/data"
  STUB_BIN="$BASE/stub-bin"
  CALLS="$BASE/calls"
  OUT="$BASE/stdout"
  ERR="$BASE/stderr"
  mkdir -p "$ROOT/bin" "$ROOT/.claude-plugin" "$ROOT/cli/src" "$DATA" "$STUB_BIN" "$BASE/home"
  : > "$CALLS"
  cp "$PLUGIN_ROOT_SRC/bin/pecot-tools" "$PLUGIN_ROOT_SRC/bin/_lib.sh" "$ROOT/bin/"
  chmod +x "$ROOT/bin/pecot-tools"
  printf '{"name":"pecot-tools","version":"1.0.0"}\n' > "$ROOT/.claude-plugin/plugin.json"
  printf '# changelog 1\n' > "$ROOT/CHANGELOG.md"
  cat > "$ROOT/package.json" <<'JSON'
{ "name": "stub-root", "private": true, "packageManager": "pnpm@12.15.0+sha512.aaaa", "devEngines": { "packageManager": { "name": "pnpm", "version": "12.15.0", "onFail": "download" } } }
JSON
  printf 'lock: 1\n' > "$ROOT/pnpm-lock.yaml"
  printf 'packages:\n  - cli\n' > "$ROOT/pnpm-workspace.yaml"
  printf '{ "name": "@pecot/pecot-tools-cli", "version": "0.0.0" }\n' > "$ROOT/cli/package.json"
  printf '{}\n' > "$ROOT/cli/tsconfig.json"
  printf '{}\n' > "$ROOT/cli/tsconfig.build.json"
  printf 'v1\n' > "$ROOT/cli/src/index.ts"

  # pnpm の stub。呼び出しを「cwd|引数」で CALLS に記録する。標準出力へ雑音を出すのは、wrapper が
  # bootstrap の標準出力を JSON-RPC から外していること（MCP 起動）を見るため。
  cat > "$STUB_BIN/pnpm" <<SH
#!/usr/bin/env bash
printf '%s|%s\n' "\$PWD" "\$*" >> "$CALLS"
echo "stub-pnpm-stdout-noise"
case "\$*" in
  *"install --frozen-lockfile"*)
    sleep "\${STUB_PNPM_DELAY:-0}"
    [ -z "\${STUB_FAIL_INSTALL:-}" ] || exit 1
    mkdir -p node_modules/.pnpm cli/node_modules node_modules/.vite
    printf 'hoisted\n' > node_modules/.modules.yaml
    printf 'abs=%s\n' "\$PWD" > node_modules/.pnpm-workspace-state-v1.json
    printf 'cache\n' > node_modules/.vite/cache
    printf 'pkg\n' > cli/node_modules/pkg.js
    ;;
  *"@pecot/pecot-tools-cli run build"*)
    sleep "\${STUB_PNPM_DELAY:-0}"
    [ -z "\${STUB_FAIL_BUILD:-}" ] || exit 1
    mkdir -p cli/dist
    src="\$(cat cli/src/index.ts)"
    cat > cli/dist/cli.js <<JS
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (process.env.STUB_HOLD) {
  fs.writeFileSync(process.env.STUB_HOLD, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  const manifest = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  console.log(JSON.stringify({
    version: manifest.version,
    built: "\${src}",
    runtime: process.env.PECOT_TOOLS_RUNTIME_DIR,
    argv: args,
    dataDirVars: Object.keys(process.env).filter((k) => k.endsWith("_DATA_DIR")),
  }));
}
JS
    ;;
esac
SH
  chmod +x "$STUB_BIN/pnpm"
}

# 親シェルのデータ置き場、旧バージョンが配った *_DATA_DIR、実行用ミラーの変数、SKIP/FORCE は落とす。
# *_DATA_DIR を落とすのは、wrapper が export しないことを見るため、継承分を外す必要があるから。
# DATA を CLAUDE_PLUGIN_DATA に渡す。
# XDG_DATA_HOME は外し（親の値を引き継がない）、HOME は $BASE/home に固定する。
# 別の置き場や無効な値を試すには、CLAUDE_PLUGIN_DATA=<値> / PLUGIN_DATA=<値> / XDG_DATA_HOME=<値> / HOME=<値> を env に渡す。
# 後に書いた方が勝つ。
# stub_spawn <stdout の出力先> <stderr の出力先> [VAR=値 ...] -- <引数...>
# 環境を整えて wrapper を 1 回起動する（終了コードはそのまま返す）。バックグラウンド起動にも使う。
# RUN_ROOT があれば、ROOT の代わりにそのプラグインルートの wrapper を起動する（版の並走の再現）。
stub_spawn() {
  local out="$1" err="$2"
  shift 2
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  env -u CLAUDE_PLUGIN_ROOT -u CLAUDE_PLUGIN_DATA -u PLUGIN_DATA -u XDG_DATA_HOME -u PECOT_DATA_DIR -u PECOTV_DATA_DIR -u PECOT_TOOLS_DATA_DIR -u PECOT_TOOLS_RUNTIME_DIR \
    -u PECOT_TOOLS_BOOTSTRAP_SKIP -u PECOT_TOOLS_BOOTSTRAP_FORCE \
    HOME="$BASE/home" PATH="$STUB_BIN:$PATH" \
    CLAUDE_PLUGIN_DATA="$DATA" STUB_CALLS="$CALLS" \
    "${envs[@]+"${envs[@]}"}" \
    "${RUN_ROOT:-$ROOT}/bin/pecot-tools" "$@" >"$out" 2>"$err" </dev/null
}

# stub_run [VAR=値 ...] -- <引数...>: stub_spawn の結果を OUT / ERR / RC に入れる。
stub_run() {
  RC=0
  : > "$CALLS"
  stub_spawn "$OUT" "$ERR" "$@" || RC=$?
}

# PATH から flock(1) だけを外した bin を作り、その dir を NOFLOCK_BIN に入れる（flock が無い環境の再現）。
make_noflock_bin() {
  NOFLOCK_BIN="$BASE/noflock-bin"
  mkdir -p "$NOFLOCK_BIN"
  local dir entry name
  local IFS=:
  for dir in $PATH; do
    [ -d "$dir" ] || continue
    for entry in "$dir"/*; do
      name="${entry##*/}"
      [ "$name" != flock ] || continue
      [ -x "$entry" ] && [ ! -d "$entry" ] || continue
      [ -e "$NOFLOCK_BIN/$name" ] || ln -s "$entry" "$NOFLOCK_BIN/$name"
    done
  done
}

# 既にあっても成功を返す mkdir だけを置いた PATH 片（LAX_MKDIR_BIN）。同時に呼ぶと 2 人とも成功する
# 不可分でない mkdir（uutils coreutils）を、実行環境の coreutils に関係なく再現する。
make_lax_mkdir_bin() {
  LAX_MKDIR_BIN="$BASE/lax-mkdir-bin"
  mkdir -p "$LAX_MKDIR_BIN"
  printf '#!/bin/sh\n"%s" -p "$@" 2>/dev/null\nexit 0\n' "$(command -v mkdir)" > "$LAX_MKDIR_BIN/mkdir"
  chmod +x "$LAX_MKDIR_BIN/mkdir"
}

# 標準エラーの固定行の数。
count_events() { grep -cE "$1" "$ERR" || true; }
# stub pnpm の呼び出し記録の行数。
count_calls() { grep -cE "$1" "$CALLS" || true; }

# 完成済みミラーの数 / 名前の一覧。
mirrors() { find "$DATA/runtime" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | LC_ALL=C sort; }
current_target() { readlink -f "$DATA/runtime/current" 2>/dev/null || true; }
