# bin/pecot の bash テストが共有する helper（source 専用）。
# pnpm を記録だけの stub にした最小の plugin root を、stub_root_init <名前> で組む（ROOT / DATA / STUB_BIN / CALLS）。
# stub_run [VAR=値 ...] -- <引数...> で wrapper を動かし、RC / OUT / ERR を埋める。

PLUGIN_ROOT_SRC="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT_SRC/../.." && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"

# 標準エラーの先頭（失敗の理由に添える）。
show_err() { head -n 30 "$ERR"; }

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
  PNPM_XDG="$BASE/pnpm-xdg"
  OUT="$BASE/stdout"
  ERR="$BASE/stderr"
  mkdir -p "$ROOT/bin" "$ROOT/.claude-plugin" "$ROOT/cli/src" "$ROOT/cli/scripts" "$DATA" "$STUB_BIN" "$BASE/home"
  : > "$CALLS"
  : > "$PNPM_XDG"
  cp "$PLUGIN_ROOT_SRC/bin/pecot" "$PLUGIN_ROOT_SRC/bin/_lib.sh" "$ROOT/bin/"
  chmod +x "$ROOT/bin/pecot"
  printf '{"name":"pecot-w","version":"1.0.0"}\n' > "$ROOT/.claude-plugin/plugin.json"
  printf '# changelog 1\n' > "$ROOT/CHANGELOG.md"
  cat > "$ROOT/package.json" <<'JSON'
{ "name": "stub-root", "private": true, "packageManager": "pnpm@12.15.0+sha512.aaaa", "devEngines": { "packageManager": { "name": "pnpm", "version": "12.15.0", "onFail": "download" } } }
JSON
  printf 'lock: 1\n' > "$ROOT/runtime-lock.yaml"
  printf 'packages:\n  - cli\n' > "$ROOT/runtime-workspace.yaml"
  printf '{ "name": "@pecot/pecot-workflow-cli", "version": "0.0.0" }\n' > "$ROOT/cli/package.json"
  printf '{}\n' > "$ROOT/cli/tsconfig.json"
  printf '{}\n' > "$ROOT/cli/tsconfig.build.json"
  printf 'v1\n' > "$ROOT/cli/src/index.ts"
  printf '// tsc\n' > "$ROOT/cli/scripts/tsc.mjs"

  # pnpm の stub。呼び出しを「cwd|引数」で CALLS に、受け取った XDG_DATA_HOME を「種類|値」で PNPM_XDG に記録する。
  # 標準出力へ雑音を出すのは、wrapper が bootstrap の標準出力を JSON-RPC から外していること（MCP 起動）を見るため。
  cat > "$STUB_BIN/pnpm" <<SH
#!/usr/bin/env bash
printf '%s|%s\n' "\$PWD" "\$*" >> "$CALLS"
case "\$*" in *"install --frozen-lockfile"*) kind=install ;; *" run build"*) kind=build ;; *) kind=other ;; esac
printf '%s|%s\n' "\$kind" "\${XDG_DATA_HOME-<unset>}" >> "$PNPM_XDG"
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
  *"@pecot/pecot-workflow-cli run build"*)
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
    runtime: path.resolve(__dirname, "..", ".."),
    pluginRoot: process.env.CLAUDE_PLUGIN_ROOT,
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

# stub_spawn <stdout> <stderr> [VAR=値 ...] -- <引数...>: 親の置き場・*_DATA_DIR・SKIP/FORCE を落とし、wrapper を 1 回起動する。
# DATA と $BASE/home を渡す。VAR=値 は後に書いた方が勝つ。RUN_ROOT があれば、そのルートの wrapper を起動する。
stub_spawn() {
  local out="$1" err="$2"
  shift 2
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  env -u CLAUDE_PLUGIN_ROOT -u CLAUDE_PLUGIN_DATA -u PLUGIN_DATA -u XDG_DATA_HOME -u PECOT_DATA_DIR -u PECOTV_DATA_DIR -u PECOT_RUNTIME_DIR \
    -u PECOT_BOOTSTRAP_SKIP -u PECOT_BOOTSTRAP_FORCE \
    HOME="$BASE/home" PATH="$STUB_BIN:$PATH" \
    CLAUDE_PLUGIN_DATA="$DATA" STUB_CALLS="$CALLS" \
    "${envs[@]+"${envs[@]}"}" \
    "${RUN_ROOT:-$ROOT}/bin/pecot" "$@" >"$out" 2>"$err" </dev/null
}

# stub_run [VAR=値 ...] -- <引数...>: stub_spawn の結果を OUT / ERR / RC に入れる。
stub_run() {
  RC=0
  : > "$CALLS"
  : > "$PNPM_XDG"
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
