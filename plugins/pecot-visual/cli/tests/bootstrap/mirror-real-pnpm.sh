#!/usr/bin/env bash
# 実 pnpm と実 build の結合テスト。ハードリンクの複製であるミラーの中で、pnpm が install をやり直さないことを確かめる。
# 初回の install は pnpm の store から入れるので、store が空の環境ではネットワークが要る。
#   bash plugins/pecot-visual/cli/tests/bootstrap/mirror-real-pnpm.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT_SRC="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT_SRC/../.." && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"

WORK_DIR="$REPO_ROOT/.pecot/tmp/bootstrap-test"
mkdir -p "$WORK_DIR"
BASE="$(mktemp -d "$WORK_DIR/mirror-real-pnpm-XXXXXX")"
trap 'chmod -R u+w "$BASE" 2>/dev/null || true; rm -rf "$BASE"' EXIT
ROOT="$BASE/plugin"
DATA="$BASE/data"
mkdir -p "$ROOT" "$DATA"

# 入力の集合（wrapper と同じ関数で出す）と、wrapper・plugin.json を複製する。
# shellcheck source=../../../bin/_lib.sh
. "$PLUGIN_ROOT_SRC/bin/_lib.sh"
{
  plugin_runtime_deps_files "$PLUGIN_ROOT_SRC"
  plugin_runtime_src_files "$PLUGIN_ROOT_SRC"
  printf '%s\n' bin/pecotv bin/_lib.sh .claude-plugin/plugin.json
} | LC_ALL=C sort -u | (cd "$PLUGIN_ROOT_SRC" && tar -cf - -T -) | (cd "$ROOT" && tar -xf -)

run_mcp() {
  RC=0
  env -u CLAUDE_PLUGIN_ROOT -u CLAUDE_PLUGIN_DATA -u PECOTV_RUNTIME_DIR -u PECOTV_DEPENDENCY_ROOT -u PECOTV_BOOTSTRAP_SKIP \
    -u PECOTV_BOOTSTRAP_FORCE -u PLUGIN_DATA \
    CLAUDE_PLUGIN_DATA="$DATA" "$ROOT/bin/pecotv" mcp >"$BASE/stdout" 2>"$BASE/stderr" </dev/null || RC=$?
}
events() { grep -cE "$1" "$BASE/stderr" || true; }
current() { readlink -f "$DATA/runtime/current"; }

run_mcp
bt_eq "初回: exit 0" 0 "$RC"
bt_eq "初回: install 1 行" 1 "$(events '^pecotv: installing dependencies$')"
bt_eq "初回: build 1 行" 1 "$(events '^pecotv: building$')"
FIRST="$(current)"
for built in cli/dist/cli.js assets/slidev/scripts/eslint/_shared/dist/index.js assets/slidev/scripts/eslint/validate-references/dist/lib/schema.json; do
  bt_eq "初回: ミラーに build 成果物がある（$built）" yes "$([ -f "$FIRST/$built" ] && echo yes || echo no)"
done
bt_eq "初回: 本体に node_modules を作らない" no "$([ -e "$ROOT/node_modules" ] && echo yes || echo no)"
bt_eq "初回: 本体に cli/dist を作らない" no "$([ -e "$ROOT/cli/dist" ] && echo yes || echo no)"
cp "$FIRST/node_modules/.modules.yaml" "$BASE/modules-before.yaml"

# ソースだけを変える（lockfile・package.json は変えない）。
printf '\n// source-only change\n' >> "$ROOT/cli/src/version.ts"
run_mcp
bt_eq "ソースだけ: exit 0" 0 "$RC"
bt_eq "ソースだけ: install 0 行" 0 "$(events '^pecotv: installing dependencies$')"
bt_eq "ソースだけ: build 1 行" 1 "$(events '^pecotv: building$')"
bt_eq "ソースだけ: pnpm の install 出力（Packages: 行）が出ない" 0 "$(events '^Packages:')"
bt_eq "ソースだけ: pnpm の install 出力（Progress: 行）が出ない" 0 "$(events '^Progress:')"
SECOND="$(current)"
bt_ne "ソースだけ: 新しいミラーへ current を切り替える" "$FIRST" "$SECOND"
bt_eq "ソースだけ: .modules.yaml が変わらない" "" "$(diff "$BASE/modules-before.yaml" "$SECOND/node_modules/.modules.yaml" || true)"
bt_eq "ソースだけ: 旧ミラーの .modules.yaml も変わらない" "" "$(diff "$BASE/modules-before.yaml" "$FIRST/node_modules/.modules.yaml" || true)"
bt_eq "ソースだけ: node_modules の実体はハードリンク（同じ inode）" \
  "$(stat -c %i "$FIRST/node_modules/commander/package.json" 2>/dev/null || stat -c %i "$FIRST/cli/node_modules/commander/package.json")" \
  "$(stat -c %i "$SECOND/node_modules/commander/package.json" 2>/dev/null || stat -c %i "$SECOND/cli/node_modules/commander/package.json")"
bt_eq "ソースだけ: 依存のパッケージ数が変わらない" \
  "$(find "$FIRST/node_modules/.pnpm" -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')" \
  "$(find "$SECOND/node_modules/.pnpm" -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')"
bt_eq "ソースだけ: 旧ミラーが無傷（cli/dist が残る）" yes "$([ -f "$FIRST/cli/dist/cli.js" ] && echo yes || echo no)"

# 2 回目は何もしない。
run_mcp
bt_eq "2 回目: install 0 行・build 0 行" 0 "$(events '^pecotv: (installing dependencies|building)$')"

# 複製したミラーで実際に動く。
RC=0
env -u CLAUDE_PLUGIN_ROOT -u PECOTV_RUNTIME_DIR -u PECOTV_DEPENDENCY_ROOT -u PLUGIN_DATA PECOTV_RUNTIME_DIR= \
  CLAUDE_PLUGIN_DATA="$DATA" "$ROOT/bin/pecotv" --version >"$BASE/version.out" 2>"$BASE/version.err" </dev/null || RC=$?
bt_eq "複製したミラーの cli が動く: --version が plugin.json の版を返す" \
  "$(node -p 'require(process.argv[1]).version' "$ROOT/.claude-plugin/plugin.json")" "$(tail -n 1 "$BASE/version.out")"

# 文面 lint が、ミラーに入れた @pecot/text-rules の dist で動く。
# text-rules はリンクで載せたメンバー。ミラー内では、実ディレクトリの vendor/text-rules/dist/index.js に build される。
CURRENT_MIRROR="$(current)"
bt_eq "ミラーに @pecot/text-rules の dist がある" yes \
  "$([ -f "$CURRENT_MIRROR/vendor/text-rules/dist/index.js" ] && echo yes || echo no)"
bt_eq "ミラーに runtime の manifest がある" yes \
  "$([ -f "$CURRENT_MIRROR/assets/slidev/runtime/package.json" ] && echo yes || echo no)"

# lint が参照するテーマは、本体が持たない。固定のテーマを複製して使い、文面の rule だけを有効にする。
# 元の宣言は他のテストが固定しているので、複製側だけを書き換える。
THEME_NAME="slidev-theme-pecotv-test-declared"
THEME_DIR="$BASE/theme/$THEME_NAME"
mkdir -p "$BASE/theme"
cp -a "$PLUGIN_ROOT_SRC/cli/tests/fixtures/themes/with-declaration" "$THEME_DIR"
jq '.lint.rules = { "text-constraints/textlint": "error" }' \
  "$PLUGIN_ROOT_SRC/cli/tests/fixtures/themes/with-declaration/pecot-theme.json" >"$THEME_DIR/pecot-theme.json"

# section レイアウトの違反文は、literal で持たず連結で作る。
HYPE_SENTENCE="ゲーム""チェンジャー""となる基盤です。"
write_deck() {
  # $1: talk-dir、$2: description の文。
  # 文面の制約はレイアウト定義（references）から読まれる。lint は talk-dir が参照するテーマ（node_modules に張る）の宣言を読む。
  mkdir -p "$1/pages" "$1/node_modules"
  ln -sfn "$THEME_DIR" "$1/node_modules/$THEME_NAME"
  printf -- '{"name":"deck","dependencies":{"%s":"file:%s"}}\n' "$THEME_NAME" "$THEME_DIR" >"$1/package.json"
  printf -- '---\ntheme: "%s"\ntitle: deck\nsrc: ./pages/section.md\n---\n' "$THEME_NAME" >"$1/slides.md"
  printf -- "---\nlayout: section\nheading: 'テスト'\ndescription: '%s'\n---\n" "$2" >"$1/pages/section.md"
}
run_slide_lint() {
  RC=0
  env -u CLAUDE_PLUGIN_ROOT -u PECOTV_RUNTIME_DIR -u PECOTV_DEPENDENCY_ROOT -u PLUGIN_DATA PECOTV_RUNTIME_DIR= \
    CLAUDE_PLUGIN_DATA="$DATA" "$ROOT/bin/pecotv" slide lint --dir "$1" --json >"$BASE/lint.out" 2>"$BASE/lint.err" </dev/null || RC=$?
}

write_deck "$BASE/deck-clean" "基盤の構成を説明します。"
run_slide_lint "$BASE/deck-clean"
bt_eq "ミラー経由の slide lint: 問題のない文は exit 0" 0 "$RC"

write_deck "$BASE/deck-hype" "$HYPE_SENTENCE"
run_slide_lint "$BASE/deck-hype"
bt_eq "ミラー経由の slide lint: 誇張表現は exit 1" 1 "$RC"
bt_eq "ミラー経由の slide lint: text-constraints/textlint が違反を返す" 1 \
  "$(grep -c 'text-constraints/textlint' "$BASE/lint.out" || true)"

bt_finish
