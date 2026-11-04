# shellcheck shell=bash
# post-tool-use hook のテストが共有する helper（source 専用）。
# *.test.sh ではないので、単体では動かさない。
#
# hook は lint の供給元を、プラグイン本体ではなく、データ置き場の実行用ミラーから取る。
# 供給元は eslint 本体、本体の deck-lint.env.config.js、ルールの dist、テーマの宣言を解釈する CLI のこと。
# ミラーは ${DATA}/runtime/<hash>/ または current にある。
# テストは、プラグインルートを装うディレクトリごとに、assets を差すだけの最小のミラーを作る。
# 作る場所は一時ディレクトリで、そのデータ置き場を CLAUDE_PLUGIN_DATA で hook に渡す。
# これで hook は、テストが用意した `<root>/assets/slidev` を使う。
#
# ミラーの cli/dist/cli.js は、`slide theme --dir <x> --json` に固定の JSON を返す stub にする。
# 本物の CLI は、テーマの宣言を解釈して lint の入力を返す。hook のテストは、その結果を受けた後の振る舞いだけを見る。
# stub は環境変数で振る舞いを変える（hook に引き継がれる）。
#   STUB_THEME_REFERENCES  カンマ区切りの参照 dir。省くと「<talk>/references」だけ。
#   STUB_THEME_RULES       lint.rules の JSON。省くと 15 本すべて error。
#   STUB_THEME_LOG         ファイルのパス。stub が起動されるたびに 1 行追記する（起動していないことの確認用）。
#   STUB_THEME_STDERR      stderr に書く 1 行。crash のときの原因を再現する。
#   STUB_THEME_FAIL        失敗させる reason（theme-unlinked / theme-none / theme-invalid-shape など）。crash は出力なしで exit 3。
# 本物の CLI を通すケースは、build 済みの cli/dist が要る。テスト側で REAL_CLI_DIST を渡して mirror_data_for が dist ごとリンクする。
#
# 使い方は mirror_data_for <プラグインルート> で、データ置き場のパスを stdout に出す。
#   MIRROR_ABSENT=1 のときはミラーを作らず、実在しないデータ置き場のパスを出す。
#   ミラーが無い状態を作るため。空を渡すと既定の場所に解決され、実ホームのミラーを拾ってしまう。
#   MIRROR_TMP に作業ディレクトリを渡す。既定は TMP。
#   MIRROR_REAL_CLI_DIST に build 済みの cli/dist のパスを渡すと、stub の代わりにそれをリンクする。
#   MIRROR_TEXT_LINT_BIN にファイルのパスを渡すと、ミラーの node_modules/.bin/pecot-text-lint を、そのファイルへのリンクにする。
#   実物のミラーと同じ形で、渡さなければ bin の無いミラーになる。呼ぶたびに指定どおりへ張り直す。

mirror_data_for() {
    local root="$1" base data mirror
    base="${MIRROR_TMP:-${TMP:?}}/mirror-data"
    if [ -n "${MIRROR_ABSENT:-}" ]; then
        printf '%s' "$base/absent"
        return 0
    fi
    data="$base/$(printf '%s' "$root" | tr '/ ' '__')"
    mirror="$data/runtime/mirror"
    if [ ! -e "$data/runtime/current" ]; then
        mkdir -p "$mirror/cli"
        : > "$mirror/.complete"
        ln -s "$root/assets" "$mirror/assets"
        ln -s mirror "$data/runtime/current"
    fi
    # 呼ぶたびに指定どおりへ作り直す。stub と実物のどちらかになる。
    rm -rf "$mirror/cli/dist"
    if [ -n "${MIRROR_REAL_CLI_DIST:-}" ]; then
        ln -s "$MIRROR_REAL_CLI_DIST" "$mirror/cli/dist"
    else
        mkdir -p "$mirror/cli/dist"
        write_stub_cli "$mirror/cli/dist/cli.js"
    fi
    rm -f "$mirror/node_modules/.bin/pecot-text-lint"
    if [ -n "${MIRROR_TEXT_LINT_BIN:-}" ]; then
        mkdir -p "$mirror/node_modules/.bin"
        ln -s "$MIRROR_TEXT_LINT_BIN" "$mirror/node_modules/.bin/pecot-text-lint"
    fi
    printf '%s' "$data"
}

# slide theme --json の固定応答を返す stub の cli.js を書く。
# $1 = 書き出し先
write_stub_cli() {
    cat > "$1" <<'STUB'
const args = process.argv.slice(2)
const dir = args[args.indexOf('--dir') + 1]
const fail = process.env.STUB_THEME_FAIL
if (process.env.STUB_THEME_LOG) require('node:fs').appendFileSync(process.env.STUB_THEME_LOG, dir + '\n')
if (process.env.STUB_THEME_STDERR) process.stderr.write(process.env.STUB_THEME_STDERR + '\n')
if (fail === 'crash') process.exit(3)
if (fail) {
  const detail = {
    'theme-unlinked': 'テーマ stub-theme が node_modules に張られていません。slide sync --dir ' + dir + ' --node-modules-only で張り直してください',
    'theme-none': dir + ' はテーマを参照していません。slide sync --theme <theme-spec> を実行してください',
  }[fail] ?? 'stub の失敗'
  process.stdout.write(JSON.stringify({ event: 'slide.theme.error', reason: fail, detail }) + '\n')
  process.exit(1)
}
const themeDirectory = dir + '/node_modules/stub-theme'
const references = process.env.STUB_THEME_REFERENCES
  ? process.env.STUB_THEME_REFERENCES.split(',')
  : [dir + '/references']
const allRules = [
  'slidev-pages-lint/one-slide-per-file', 'slidev-pages-lint/no-content-before-frontmatter',
  'slidev-pages-lint/validate-clicks', 'slidev-pages-lint/no-unknown-props',
  'slidev-pages-lint/require-slides-entry', 'slidev-pages-lint/no-triple-hyphen-in-frontmatter',
  'slidev-pages-lint/no-numeric-filename-prefix', 'slidev-pages-lint/no-numeric-asset-prefix',
  'slidev-pages-lint/require-matching-length', 'slidev-pages-lint/no-missing-marker-cell',
  'slidev-pages-lint/no-scaled-drawio', 'slidev-pages-lint/no-missing-page',
  'text-constraints/max-chars', 'text-constraints/textlint', 'text-constraints/textlint-body',
]
const rules = process.env.STUB_THEME_RULES
  ? JSON.parse(process.env.STUB_THEME_RULES)
  : Object.fromEntries(allRules.map((id) => [id, 'error']))
process.stdout.write(JSON.stringify({
  event: 'slide.theme.done',
  theme: { name: 'stub-theme', spec: 'file:../stub-theme', declared: true, directory: themeDirectory },
  lint: { referencesDirectories: references, panels: {}, markerLayouts: [], rules },
  warnings: [],
}) + '\n')
STUB
}
