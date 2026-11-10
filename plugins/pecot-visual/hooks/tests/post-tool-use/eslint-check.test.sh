#!/bin/bash
# eslint-check.sh の単体テスト
#
# 検証の軸は 2 つ。
#
# 1. 分岐の分類: 「lint していない」と「違反があった」を混同しないこと。
#    対象外 (skip) / 設定不備・未実施 (not-linted) / pass / 違反検出 (violation) を
#    それぞれ固定する。exit 1 以外の非 0（config fatal の 2 / timeout の 124 等）と
#    非 0 かつ空出力を「違反」として model に流さないことが、本テストの主目的。
# 2. 出力チャネル: model 向け通知は stdout の JSON、開発者診断 trace は stderr。
#    stdout は全ての分岐で「空または妥当な JSON」であること。
#    呼び出し元 merge-hook-outputs.sh が、非 JSON stdout を additionalContext に丸めるため。
#
# 全ケースで stdout と stderr を分離して捕捉する。2>&1 で混ぜると trace 1 行が JSON
# パースを壊し、上記 2 の確認自体が成立しない。
#
# 併せて既存の退行ガードを維持する。
# - symlink を跨いだ logical パスでも違反を検出し、物理パス経由と同じ結果になること。
# - symlink トポロジ 4 種（A/A2/B/D）すべてで違反を検出すること。
# - eslint が base path 外と判定した場合に、カナリアが additionalContext で報告すること。
# - カナリアが grep する eslint の文言が、実 eslint で生きていること（ピン留め）。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/../../lib/post-tool-use/eslint-check.sh"
MERGE="$SCRIPT_DIR/../../lib/core/merge-hook-outputs.sh"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=mirror-helper.sh
. "$SCRIPT_DIR/mirror-helper.sh"
ASSETS_DIR="$PLUGIN_ROOT/assets/slidev"
# テーマの宣言は実 CLI でなく、ミラーの stub CLI（mirror-helper.sh）が返す。
# 参照 yaml は fixture テーマのものを talk-dir の references/ に複写して使う。
FIXTURE_THEME="$PLUGIN_ROOT/cli/tests/fixtures/themes/with-declaration"
# ASSETS_DIR 自体の不在は、リポジトリ内では常に異常（移動の取り残し）。
# eslint の解決不能（bootstrap 前）と違い、SKIP にすると全ケースが何も知らせず空振りする。
# そのため FAIL にする。
[ -d "$ASSETS_DIR" ] || { echo "FAIL: ASSETS_DIR 不在: $ASSETS_DIR"; exit 1; }
[ -d "$FIXTURE_THEME/references" ] || { echo "FAIL: FIXTURE_THEME 不在: $FIXTURE_THEME"; exit 1; }

PASS=0
FAIL=0
fail() {
    echo "FAIL: $1"
    FAIL=$((FAIL + 1))
}
pass() {
    echo "PASS: $1"
    PASS=$((PASS + 1))
}

# mktemp の返り値を物理正規化する。macOS の mktemp は /var → /private/var の symlink
# 配下を返すため、正規化しないとパリティケースが「物理パス」の対照群として機能しない。
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
TMP=$(CDPATH= cd -P "$TMP" && pwd -P)

ERRFILE="$TMP/hook-stderr.txt"
# 非 JSON の stdout を出したケースをここに溜め、最後にまとめて 1 件の assert にする。
BAD_STDOUT=""

# hook を 1 回起動し、stdout を $OUT / stderr を $ERR / 終了コードを $EXIT に入れる。
# $1 = ラベル（ガードレール違反時の表示用）, $2 = 標準入力に渡す JSON, $3 = CLAUDE_PLUGIN_ROOT
run_hook_json() {
    local label="$1" json="$2" root="$3"
    OUT=$(printf '%s' "$json" | CLAUDE_PLUGIN_ROOT="$root" CLAUDE_PLUGIN_DATA="$(mirror_data_for "$root")" bash "$HOOK" 2>"$ERRFILE")
    EXIT=$?
    ERR=$(cat "$ERRFILE")
    if [ -n "$OUT" ] && ! printf '%s\n' "$OUT" | jq empty 2>/dev/null; then
        BAD_STDOUT="${BAD_STDOUT}[$label] "
    fi
}

# $1 = ラベル, $2 = file_path, $3 = CLAUDE_PLUGIN_ROOT
run_hook() {
    run_hook_json "$1" "{\"tool_input\":{\"file_path\":\"$2\"}}" "$3"
}

ctx_of() {
    printf '%s\n' "$1" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null
}

# no-content-before-frontmatter 違反（参照 YAML 非依存。symlink / トポロジ系の
# 対照群として使う）
write_violation() {
    cat > "$1" <<'EOF'
本文 before frontmatter

---
layout: foo
---
EOF
}

# 違反 fixture の talk-dir に参照 YAML を同梱する。text-constraints 系は references/ を
# 見つけられないと、何も知らせず評価を諦める。
# そのため参照 YAML が無い fixture は、max_chars 超過でも exit 0 / 空出力になる（空振り）。
# これでは真の pass と区別できない。
# stub CLI の参照 dir は、初期状態で「<talk>/references」。そこへ fixture テーマの references/ を複写する。
# $1 = talk root
copy_references() {
    cp -r "$FIXTURE_THEME/references" "$1/references"
}

# 偽 plugin root にスタブ eslint パッケージを置き、そのパスを返す。
# 実 eslint に依存せず、exit code と出力の組み合わせを再現する（timeout を実 sleep で作らない）。
# hook は assets/slidev 基準で `eslint/package.json` を引いて、bin を node で起動する。
# そのためスタブも package.json の bin から辿れる形（node_modules/eslint/{package.json,bin/eslint.js}）にする。
# $1 = ディレクトリ名, $2 = スタブの exit code, $3 = スタブの出力（空なら無出力）
make_stub_plugin() {
    local name="$1" code="$2" out="$3"
    local tpl="$TMP/$name/assets/slidev"
    mkdir -p "$tpl/node_modules/eslint/bin"
    printf '{"name":"eslint","version":"10.13.0","bin":{"eslint":"bin/eslint.js"}}\n' \
        > "$tpl/node_modules/eslint/package.json"
    {
        printf 'const out = %s\n' "$(node -p 'JSON.stringify(process.argv[1])' "$out")"
        echo 'if (out) process.stdout.write(out + "\n")'
        echo "process.exit($code)"
    } > "$tpl/node_modules/eslint/bin/eslint.js"
    printf '{"devDependencies":{"eslint":"^10.13.0"}}\n' > "$tpl/package.json"
    touch "$tpl/deck-lint.env.config.js"
    printf '%s' "$TMP/$name"
}

# assets/slidev 基準で eslint/package.json を引き、bin.eslint の絶対パスを返す（hook と同じ解決）。
# $1 = assets/slidev のディレクトリ
resolve_eslint_bin() {
    (cd "$1" 2> /dev/null && node -p "
const path = require('node:path')
const manifestPath = require.resolve('eslint/package.json')
const bin = require(manifestPath).bin
path.resolve(path.dirname(manifestPath), typeof bin === 'string' ? bin : bin.eslint)" 2> /dev/null)
}

REAL_ESLINT_BIN=$(resolve_eslint_bin "$ASSETS_DIR")
HAVE_ESLINT=false
[ -n "$REAL_ESLINT_BIN" ] && [ -f "$REAL_ESLINT_BIN" ] && HAVE_ESLINT=true

# --- ケース1: talk-dir マーカー不在 → stdout 空 / stderr に skip trace ---
NON_TALK="$TMP/non-talk"
mkdir -p "$NON_TALK"
echo "# foo" > "$NON_TALK/foo.md"
run_hook "marker-absent" "$NON_TALK/foo.md" "$PLUGIN_ROOT"
if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[eslint-check\] skip:"; then
    pass "talk-dir マーカー不在: exit 0 / stdout 空 / stderr skip trace"
else
    fail "talk-dir マーカー不在: exit=$EXIT stdout='$OUT' stderr='$ERR'"
fi

# --- ケース2: 非 .md → stdout 空 / stderr に skip trace ---
run_hook "non-md" "$NON_TALK/foo.txt" "$PLUGIN_ROOT"
if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[eslint-check\] skip: not a .md file"; then
    pass "非 .md: exit 0 / stdout 空 / stderr skip trace"
else
    fail "非 .md: exit=$EXIT stdout='$OUT' stderr='$ERR'"
fi

# --- ケース3: file_path 空 → stdout 空 / stderr に skip trace ---
run_hook_json "no-file-path" '{}' "$PLUGIN_ROOT"
if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[eslint-check\] skip: tool_input.file_path"; then
    pass "file_path 空: exit 0 / stdout 空 / stderr skip trace"
else
    fail "file_path 空: exit=$EXIT stdout='$OUT' stderr='$ERR'"
fi

# --- ケース4: 設定不備（plugin root は解決できるが assets/slidev が無い） ---
# 旧仕様は何も知らせず exit 0 だった。lint されていないのに pass と区別できないため、
# 「未実施」を additionalContext で model に伝える。
TALK="$TMP/talk"
mkdir -p "$TALK/pages"
touch "$TALK/slides.md"
echo "# foo" > "$TALK/pages/01.md"
run_hook "assets-missing" "$TALK/pages/01.md" "$TMP/no-such-plugin"
CTX=$(ctx_of "$OUT")
if ! echo "$CTX" | head -n 1 | grep -q "^warning: eslint not run: "; then
    fail "assets 不在: 未実施通知が出ていない stdout='$OUT'"
elif ! echo "$CTX" | grep -q "theme: $TALK/node_modules/stub-theme"; then
    fail "assets 不在: 通知に theme: の表記（解決済みのテーマ root）が無い ctx='$CTX'"
elif echo "$CTX" | grep -q "template:"; then
    fail "assets 不在: 通知が旧表記の template: を使っている ctx='$CTX'"
elif ! echo "$CTX" | grep -q "pecotv"; then
    fail "assets 不在: bootstrap 案内 (pecotv コマンド) が通知に無い ctx='$CTX'"
elif echo "$CTX" | grep -q "warning: eslint violations:"; then
    fail "assets 不在: 違反として報告している ctx='$CTX'"
elif ! echo "$ERR" | grep -q "\[eslint-check\] not-linted:"; then
    fail "assets 不在: stderr trace が not-linted でない stderr='$ERR'"
else
    pass "assets 不在: 未実施通知 + theme: 表記 + bootstrap 案内"
fi

# --- ケース4b: 実行用ミラーが無い（初回の build 中・データ置き場を解決できない） ---
# 未実施の通知に倒し、違反とは報告しない。
MIRROR_ABSENT=1 run_hook "mirror-absent" "$TALK/pages/01.md" "$PLUGIN_ROOT"
CTX=$(ctx_of "$OUT")
if ! echo "$CTX" | grep -q "warning: eslint not run:"; then
    fail "ミラー不在: 未実施通知が出ていない stdout='$OUT'"
elif ! echo "$CTX" | grep -q "pecotv"; then
    fail "ミラー不在: bootstrap 案内 (pecotv コマンド) が通知に無い ctx='$CTX'"
elif echo "$CTX" | grep -q "warning: eslint violations:"; then
    fail "ミラー不在: 違反として報告している ctx='$CTX'"
elif ! echo "$ERR" | grep -q "\[eslint-check\] not-linted: runtime mirror is missing"; then
    fail "ミラー不在: stderr trace が not-linted でない stderr='$ERR'"
else
    pass "ミラー不在: 未実施通知 + bootstrap 案内"
fi

# --- ケース5: plugin root 解決不能 → 対象外（stdout 空 / stderr skip） ---
# env 未設定かつ SCRIPT_DIR からの逆算も成立しない配置。設定不備（解決できたが
# binary/config が無い = ケース4）と区別され、model には何も出さない。
# 共有ライブラリは hook の dir の 1 段上の core/ から source される。
# 逆算不能を確かめたいので、hook 自体は $TMP/detached に置く。
# ライブラリは兄弟の $TMP/core に置く（$TMP/detached/../core）。
# ここを欠くと「共有ライブラリを解決できない」で先に失敗し、plugin root 逆算の分岐に到達しない。
mkdir -p "$TMP/core"
cp "$SCRIPT_DIR/../../lib/core/hook-paths.sh" "$TMP/core/hook-paths.sh"
DETACHED="$TMP/detached"
mkdir -p "$DETACHED"
cp "$HOOK" "$DETACHED/eslint-check.sh"
OUT=$(printf '%s' "{\"tool_input\":{\"file_path\":\"$TALK/pages/01.md\"}}" | \
    env -u CLAUDE_PLUGIN_ROOT -u PLUGIN_HOOKS bash "$DETACHED/eslint-check.sh" 2>"$ERRFILE")
EXIT=$?
ERR=$(cat "$ERRFILE")
if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[eslint-check\] skip: plugin root"; then
    pass "plugin root 解決不能: exit 0 / stdout 空 / stderr skip trace"
else
    fail "plugin root 解決不能: exit=$EXIT stdout='$OUT' stderr='$ERR'"
fi

# --- ケース6: 真の pass（fixture テーマの正常な page を lint して違反ゼロ） ---
# 「lint が動いて違反ゼロ」を「lint されていない」と区別する対照群。
if [ "$HAVE_ESLINT" = true ]; then
    REAL="$TMP/real-talk"
    mkdir -p "$REAL/pages"
    printf '%s\n' '---' 'theme: stub-theme' '---' '' '---' 'src: ./pages/agenda.md' '---' > "$REAL/slides.md"
    copy_references "$REAL"
    printf '%s\n' '---' 'layout: plain' 'heading: アジェンダ' 'body: 本日の流れ' '---' > "$REAL/pages/agenda.md"
    run_hook "true-pass" "$REAL/pages/agenda.md" "$PLUGIN_ROOT"
    if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[eslint-check\] pass:"; then
        pass "真の pass: stdout 空 / stderr pass trace"
    else
        fail "真の pass: exit=$EXIT stdout='$OUT' stderr='$ERR'"
    fi
else
    echo "SKIP: $ASSETS_DIR から eslint を解決できないので真の pass ケースを skip"
fi

# --- ケース7: 実 assets/slidev で違反検出（ERR_MODULE_NOT_FOUND が出ないこと） ---
if [ "$HAVE_ESLINT" = true ]; then
    write_violation "$REAL/pages/violation.md"
    run_hook "real-violation" "$REAL/pages/violation.md" "$PLUGIN_ROOT"
    CTX=$(ctx_of "$OUT")
    if echo "$OUT$ERR" | grep -q "ERR_MODULE_NOT_FOUND"; then
        fail "実 assets: ERR_MODULE_NOT_FOUND が出ている stdout='$OUT' stderr='$ERR'"
    elif ! echo "$CTX" | grep -q "slidev-pages-lint/no-content-before-frontmatter"; then
        fail "実 assets: 違反 rule id が additionalContext に含まれない stdout='$OUT'"
    elif ! echo "$CTX" | head -n 1 | grep -q "^warning: eslint violations: "; then
        fail "実 assets: 違反見出しが無い ctx='$CTX'"
    elif ! printf '%s\n' "$OUT" | jq -e '.hookSpecificOutput.hookEventName == "PostToolUse"' > /dev/null 2>&1; then
        fail "実 assets: hookSpecificOutput.hookEventName が PostToolUse でない stdout='$OUT'"
    elif ! echo "$ERR" | grep -q "\[eslint-check\] violation:"; then
        fail "実 assets: stderr trace が violation でない stderr='$ERR'"
    else
        pass "実 assets: 違反検出 + hookEventName 正常 + violation trace"
    fi
else
    echo "SKIP: $ASSETS_DIR から eslint を解決できないので実起動チェックを skip"
fi

# --- ケース8: 参照 YAML 依存の違反 ---
# _references を同梱しないと、text-constraints は max_chars 超過でも exit 0 / 空出力になる。
# 同梱した fixture でだけ違反が出ることを固定する。
# これで以降の違反 fixture が、「lint が実際に評価している」状態であることを担保する。
if [ "$HAVE_ESLINT" = true ]; then
    cat > "$REAL/pages/toolong.md" <<'EOF'
---
layout: plain
heading: "これは max_chars 20 を大幅に超過する非常に長いセクションタイトルです"
---
EOF
    run_hook "text-constraints" "$REAL/pages/toolong.md" "$PLUGIN_ROOT"
    CTX=$(ctx_of "$OUT")
    if echo "$CTX" | grep -q "text-constraints/max-chars"; then
        pass "参照 YAML 依存の違反: text-constraints/max-chars を検出（fixture が空振りしていない）"
    else
        fail "参照 YAML 依存の違反: text-constraints/max-chars が出ない（references/ の同梱忘れの疑い）stdout='$OUT'"
    fi
else
    echo "SKIP: $ASSETS_DIR から eslint を解決できないので参照 YAML 依存ケースを skip"
fi

# --- ケース8b: 文面違反（textlint） ---
# text-constraints/textlint は synckit worker 経由で動く。
# hook から起動した場合でも worker が解決でき、違反が additionalContext まで届くことを固定する。
if [ "$HAVE_ESLINT" = true ]; then
    cat > "$REAL/pages/hype.md" <<'EOF'
---
layout: plain
heading: "基盤の話"
body: "ゲームチェンジャーとなる基盤です。"
---
EOF
    run_hook "text-constraints-textlint" "$REAL/pages/hype.md" "$PLUGIN_ROOT"
    CTX=$(ctx_of "$OUT")
    if echo "$CTX" | grep -q "text-constraints/textlint"; then
        pass "文面違反: text-constraints/textlint を additionalContext に含む"
    else
        fail "文面違反: text-constraints/textlint が出ない stdout='$OUT' stderr='$ERR'"
    fi
else
    echo "SKIP: $ASSETS_DIR から eslint を解決できないので文面違反ケースを skip"
fi

# --- ケース8c: 本文とノートの文面違反（textlint-body）の行付き掲載 ---
# 違反文は literal で持たず、語を分けて組み立てる。
if [ "$HAVE_ESLINT" = true ]; then
    HYPE_SENTENCE="ゲーム""チェンジャー""となる基盤です。"
    {
        printf '%s\n' '---' 'layout: plain' 'heading: "基盤の話"' '---' ''
        printf '%s\n' "$HYPE_SENTENCE" '' '<!--' "$HYPE_SENTENCE" '-->'
    } > "$REAL/pages/body-hype.md"
    run_hook "text-constraints-textlint-body" "$REAL/pages/body-hype.md" "$PLUGIN_ROOT"
    CTX=$(ctx_of "$OUT")
    if ! echo "$CTX" | grep -q "text-constraints/textlint-body"; then
        fail "本文・ノートの文面違反: text-constraints/textlint-body が出ない stdout='$OUT' stderr='$ERR'"
    elif ! echo "$CTX" | grep -q "body L6:"; then
        fail "本文・ノートの文面違反: 本文の違反がファイル行 6 で出ない ctx='$CTX'"
    elif ! echo "$CTX" | grep -q "speaker notes L9:"; then
        fail "本文・ノートの文面違反: ノートの違反がファイル行 9 で出ない ctx='$CTX'"
    elif echo "$CTX" | grep -q "warning: eslint not run:"; then
        fail "本文・ノートの文面違反: 未実施に化けている ctx='$CTX'"
    else
        pass "本文・ノートの文面違反: text-constraints/textlint-body を本文行とノート行で additionalContext に含む"
    fi
else
    echo "SKIP: $ASSETS_DIR から eslint を解決できないので本文・ノートの文面違反ケースを skip"
fi

# クラッシュ判定の誤判定ガード: md 本文にクラッシュバナーと同じ文字列があっても、
# eslint の stylish 出力はファイル本文を echo しない。そのため出力に混入せず、違反として報告され続けること。
# 混入するようになると、違反が「未実施」と判定されて何も出なくなる。
if [ "$HAVE_ESLINT" = true ]; then
    cat > "$REAL/pages/banner-in-body.md" <<'EOF'
Oops! Something went wrong! :( これは本文であり eslint のクラッシュではない

---
layout: plain
heading: "本文にバナー文言を含む違反 fixture"
---
EOF
    run_hook "banner-in-body" "$REAL/pages/banner-in-body.md" "$PLUGIN_ROOT"
    CTX=$(ctx_of "$OUT")
    if echo "$CTX" | grep -q "warning: eslint not run:"; then
        fail "本文にバナー文言: 違反が未実施に化けている（stylish 出力に本文が混入した疑い）ctx='$CTX'"
    elif ! echo "$CTX" | grep -q "slidev-pages-lint/no-content-before-frontmatter"; then
        fail "本文にバナー文言: 違反として報告されていない stdout='$OUT' stderr='$ERR'"
    else
        pass "本文にバナー文言: 違反として報告される（クラッシュ判定が誤射しない）"
    fi
else
    echo "SKIP: $ASSETS_DIR から eslint を解決できないのでバナー誤射ガードを skip"
fi

# --- ケース9: exit 0 で出力が空でない場合の振り分け ---
# 設定対象外（no matching configuration）の扱いは、パスで分ける。
# lint 対象パス（pages/**/*.md・slides.md）なら、config 側の不整合で lint が行われなかったことになる。
# この場合は未実施を通知する。talk-dir 内でも対象外パスなら、正当なスキップとする。
IGNORED_MSG="  0:0  warning  File ignored because no matching configuration was supplied"
STUB_IGNORED=$(make_stub_plugin stub-ignored 0 "$IGNORED_MSG")
run_hook "ignored-lint-target" "$TALK/pages/01.md" "$STUB_IGNORED"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "warning: eslint not run:" && ! echo "$CTX" | grep -q "warning: eslint violations:"; then
    pass "設定対象外 (lint 対象パス pages/): 未実施を通知"
else
    fail "設定対象外 (lint 対象パス pages/): 未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
fi

# slides.md も deck-lint の設定が宣言する lint 対象。case 分岐の未確認のアームを塞ぐ。
echo "# slides" > "$TALK/slides.md"
run_hook "ignored-slides-md" "$TALK/slides.md" "$STUB_IGNORED"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "warning: eslint not run:"; then
    pass "設定対象外 (lint 対象パス slides.md): 未実施を通知"
else
    fail "設定対象外 (lint 対象パス slides.md): 未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
fi

# talk-dir 内だが lint 対象パス外（README.md）。実 eslint が同じ文言を返す。
# model には何も出さず、stderr のみになること。
if [ "$HAVE_ESLINT" = true ]; then
    echo "# readme" > "$REAL/README.md"
    run_hook "ignored-non-target" "$REAL/README.md" "$PLUGIN_ROOT"
    if [ -z "$OUT" ] && echo "$ERR" | grep -q "\[eslint-check\] skip: not a lint target path"; then
        pass "設定対象外 (lint 対象パス外 README.md): stdout 空 / stderr skip trace"
    else
        fail "設定対象外 (lint 対象パス外 README.md): stdout='$OUT' stderr='$ERR'"
    fi
else
    echo "SKIP: $ASSETS_DIR から eslint を解決できないので lint 対象パス外ケースを skip"
fi

# exit 0 かつ未知の非空出力は pass 扱い。hook は eslint を 2>&1 で捕捉する。
# そのため node の ExperimentalWarning 等が出力に含まれる。
# これを違反として model に流すと、#849 と同型の誤報になる。そこで意図的に飲み込んでいる。
# 飲み込む唯一の分岐なので、将来ここを「違反検出」に昇格させる変更を、退行として捕まえられるよう固定する。
# 診断のため、出力の先頭は stderr trace に残る。
STUB_WARN=$(make_stub_plugin stub-node-warning 0 \
    "(node:1234) ExperimentalWarning: Type Stripping is an experimental feature")
run_hook "exit0-unknown-output" "$TALK/pages/01.md" "$STUB_WARN"
if [ -n "$OUT" ]; then
    fail "exit 0 + 未知の非空出力: model に通知している（node warning を違反/未実施に昇格させた疑い）stdout='$OUT'"
elif ! echo "$ERR" | grep -q "\[eslint-check\] pass: exit 0 with unrecognized output"; then
    fail "exit 0 + 未知の非空出力: stderr trace が pass でない stderr='$ERR'"
elif ! echo "$ERR" | grep -q "ExperimentalWarning"; then
    fail "exit 0 + 未知の非空出力: 出力の先頭が trace に残っていない stderr='$ERR'"
else
    pass "exit 0 + 未知の非空出力: stdout 空 / stderr pass trace に出力先頭を残す"
fi

# --- ケース10: exit 1 以外の非 0 / 非 0 かつ空出力 → 未実施（違反と報告しない） ---
# #849 の本題。eslint 10 は config fatal で exit 2 を返す。旧仕様は非 0 を全数
# 違反の通知に振り分けたため、lint されていない md の修正指示が model に
# 届く誤報が出ていた。timeout はスタブの exit 124 で再現する（実 sleep 30 秒を使わない）。
assert_not_linted() {
    local label="$1" root="$2" expect="$3" ctx
    run_hook "$label" "$TALK/pages/01.md" "$root"
    ctx=$(ctx_of "$OUT")
    if echo "$ctx" | grep -q "warning: eslint violations:"; then
        fail "$label: 違反として報告している ctx='$ctx'"
    elif ! echo "$ctx" | grep -q "warning: eslint not run:"; then
        fail "$label: 未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
    elif ! echo "$ctx" | grep -q "$expect"; then
        fail "$label: 期待する理由 ('$expect') が通知に無い ctx='$ctx'"
    elif ! echo "$ERR" | grep -q "\[eslint-check\] not-linted:"; then
        fail "$label: stderr trace が not-linted でない stderr='$ERR'"
    else
        pass "$label: 未実施へ振り分け（違反と報告しない）"
    fi
}

STUB_FATAL=$(make_stub_plugin stub-exit2 2 "Oops! Something went wrong! Cannot read config file")
assert_not_linted "exit 2 (config fatal 相当)" "$STUB_FATAL" "exit 2"
# 実行異常時は原因追跡のため eslint 出力の先頭を通知に添える
run_hook "exit2-output-head" "$TALK/pages/01.md" "$STUB_FATAL"
if ctx_of "$OUT" | grep -q "Cannot read config file"; then
    pass "exit 2: eslint 出力の先頭を通知に添えている"
else
    fail "exit 2: eslint 出力が通知に含まれない stdout='$OUT'"
fi

STUB_TIMEOUT=$(make_stub_plugin stub-exit124 124 "")
assert_not_linted "exit 124 (timeout)" "$STUB_TIMEOUT" "timed out"

STUB_EXIT1_EMPTY=$(make_stub_plugin stub-exit1-empty 1 "")
assert_not_linted "exit 1 かつ出力空" "$STUB_EXIT1_EMPTY" "exit 1"

# exit 1 でも、出力がクラッシュバナーならクラッシュとして扱う。
# exit code は eslint 側の割り当てに依存するため、バナー文言でも判定して二重化する。
# 現行 eslint ではクラッシュは exit 2 なので、この組み合わせは起こらない。下のピン留めでその前提を固定している。
STUB_EXIT1_CRASH=$(make_stub_plugin stub-exit1-crash 1 \
    "Oops! Something went wrong! :( ESLint: 10.13.0 Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@v-slidev/eslint-plugin-slidev-pages-lint'")
assert_not_linted "exit 1 + クラッシュバナー" "$STUB_EXIT1_CRASH" "crashed"

# 実 eslint のクラッシュを hook 経由で起こす。本体の assets を汚さずにクラッシュさせるため、
# 偽 plugin root に実 eslint パッケージの symlink を置く。
# あわせて、存在しない module を import する config を置く（node_modules 破損で plugin が引けない状況の再現）。
if [ "$HAVE_ESLINT" = true ]; then
    CRASH_PLUGIN="$TMP/crash-plugin"
    CRASH_TPL="$CRASH_PLUGIN/assets/slidev"
    mkdir -p "$CRASH_TPL/node_modules"
    ln -s "$(dirname "$(dirname "$REAL_ESLINT_BIN")")" "$CRASH_TPL/node_modules/eslint"
    printf '{"devDependencies":{"eslint":"^10.13.0"}}\n' > "$CRASH_TPL/package.json"
    echo 'import x from "@no/such-module-for-crash-pin"; export default []' \
        > "$CRASH_PLUGIN/assets/slidev/deck-lint.env.config.js"
    assert_not_linted "実 eslint のクラッシュ (ERR_MODULE_NOT_FOUND)" "$CRASH_PLUGIN" "crashed"
else
    echo "SKIP: $ASSETS_DIR から eslint を解決できないので実クラッシュケースを skip"
fi

# --- ケース10b: eslint のメジャー違い → 未実施 ---
# require.resolve は親の node_modules や NODE_PATH まで遡る。
# そのため、assets/slidev が想定しない版の eslint を拾いうる。
# メジャーが外れたら lint せず未実施にし、理由を trace に残す。
STUB_MAJOR=$(make_stub_plugin stub-major-mismatch 0 "")
printf '{"name":"eslint","version":"9.30.0","bin":{"eslint":"bin/eslint.js"}}\n' \
    > "$STUB_MAJOR/assets/slidev/node_modules/eslint/package.json"
run_hook "major-mismatch" "$TALK/pages/01.md" "$STUB_MAJOR"
CTX=$(ctx_of "$OUT")
if ! echo "$CTX" | grep -q "warning: eslint not run:"; then
    fail "メジャー不一致: 未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
elif ! echo "$CTX" | grep -q "node_modules/eslint"; then
    fail "メジャー不一致: 不足として eslint が挙がっていない ctx='$CTX'"
elif ! echo "$ERR" | grep -q "\[eslint-check\] eslint resolution failed: .*9.30.0.*differs in major version"; then
    fail "メジャー不一致: 理由が trace に無い stderr='$ERR'"
else
    pass "メジャー不一致: 未実施へ振り分け + 理由を trace に残す"
fi

# --- ケース10c: eslint を解決できない → 未実施 + 解決失敗の理由が trace に出る ---
NO_ESLINT="$TMP/stub-no-eslint"
mkdir -p "$NO_ESLINT/assets/slidev"
printf '{"devDependencies":{"eslint":"^10.13.0"}}\n' > "$NO_ESLINT/assets/slidev/package.json"
touch "$NO_ESLINT/assets/slidev/deck-lint.env.config.js"
# 親の node_modules から拾われないよう、実 eslint を持たない $TMP 配下に置く
run_hook "eslint-unresolvable" "$TALK/pages/01.md" "$NO_ESLINT"
CTX=$(ctx_of "$OUT")
if ! echo "$CTX" | grep -q "warning: eslint not run:"; then
    fail "eslint 解決不能: 未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
elif ! echo "$ERR" | grep -q "\[eslint-check\] eslint resolution failed: .*eslint"; then
    fail "eslint 解決不能: 解決失敗の理由が trace に無い stderr='$ERR'"
else
    pass "eslint 解決不能: 未実施 + 解決失敗の理由を trace に残す"
fi

# --- ケース11: symlink 経由の logical パスでも違反を検出し、物理パスと同一結果になること ---
# 本番で起きた構成は 2 つある。
# 1 つ目は、talk-dir が worktree 側の .pecot/work（base への symlink）配下にある場合。
# 2 つ目は、macOS の /var → /private/var symlink 配下にある場合。
# eslint (Node) は base path を物理 cwd で解決する。
# そのため logical パスを渡すと、"outside of base path" で何も知らせずスキップする。
# assert は exit code ではなく stdout JSON で行う。
# 呼び出し元 merge-hook-outputs.sh が hook の exit code を破棄するため。
# 該当するのは、`RESULT=$(echo "$INPUT" | "$script") || true` の箇所。
if [ "$HAVE_ESLINT" = true ]; then
    PARITY="$TMP/parity-talk"
    mkdir -p "$PARITY/pages"
    touch "$PARITY/slides.md"
    copy_references "$PARITY"
    # ファイル名は数字始まりを避ける（no-numeric-filename-prefix にファイル名だけで
    # 抵触し、検出された rule id の帰属が曖昧になるため）
    write_violation "$PARITY/pages/violation.md"
    ln -s "$PARITY" "$TMP/link-talk"

    rule_ids() {
        # eslint stylish の問題行から rule id（最終フィールド）だけを取る。
        # additionalContext ヘッダには編集時のパスがそのまま入り symlink 経由と
        # 物理経由で異なるので、パス成分を拾わない抽出にする。
        ctx_of "$1" | \
            awk '/^[[:space:]]+[0-9]+:[0-9]+[[:space:]]+(error|warning)/{print $NF}' | sort -u
    }

    run_hook "symlink-violation" "$TMP/link-talk/pages/violation.md" "$PLUGIN_ROOT"
    LINK_OUT="$OUT"
    if ! ctx_of "$LINK_OUT" | grep -q "slidev-pages-lint/no-content-before-frontmatter"; then
        fail "symlink 経由: 違反 rule id が additionalContext に含まれない stdout='$LINK_OUT'"
    else
        pass "symlink 経由: logical パスでも違反検出"
    fi

    # パリティ: 同一内容を物理パスで流し、同じ rule id 集合が返ること
    run_hook "physical-violation" "$PARITY/pages/violation.md" "$PLUGIN_ROOT"
    PHYS_OUT="$OUT"
    LINK_RULES=$(rule_ids "$LINK_OUT")
    PHYS_RULES=$(rule_ids "$PHYS_OUT")
    if [ -z "$PHYS_RULES" ]; then
        fail "パリティ: 物理パス経由で rule id が 1 件も取れない stdout='$PHYS_OUT'"
    elif [ "$LINK_RULES" != "$PHYS_RULES" ]; then
        fail "パリティ: rule id 集合が不一致 symlink='$LINK_RULES' phys='$PHYS_RULES'"
    else
        pass "パリティ: symlink 経由と物理パスで rule id 集合が一致"
    fi
else
    echo "SKIP: $ASSETS_DIR から eslint を解決できないので symlink ケースを skip"
fi

# --- ケース12: symlink トポロジ 4 種 ---
# A  = pages/ 自体が talk-dir 外への symlink。
# A2 = pages/<sub>/ が talk-dir 外への symlink（共有素材のディレクトリを張る）。
# B  = 祖先 dir が symlink（#836 の本番で起きた構成: worktree の .pecot/work → base）。
# D  = 編集対象ファイル自体が talk-dir 外への symlink。
# 探索を物理化すると A/A2 が、logical のまま絶対パスを eslint に渡すと B が、
# それぞれ何も知らせないスキップになる。そのため 4 種を同時に固定する。
assert_detected() {
    local label="$1" target="$2"
    run_hook "topo-$label" "$target" "$PLUGIN_ROOT"
    if ctx_of "$OUT" | grep -q "slidev-pages-lint/no-content-before-frontmatter"; then
        pass "トポロジ $label: 違反検出"
    else
        fail "トポロジ $label: 違反 rule id が additionalContext に含まれない stdout='$OUT' stderr='$ERR'"
    fi
}

if [ "$HAVE_ESLINT" = true ]; then
    TOPO="$TMP/topo"

    mkdir -p "$TOPO/A/talk" "$TOPO/A/elsewhere"
    touch "$TOPO/A/talk/slides.md"
    write_violation "$TOPO/A/elsewhere/violation.md"
    ln -s "$TOPO/A/elsewhere" "$TOPO/A/talk/pages"
    copy_references "$TOPO/A/talk"
    assert_detected "A (pages 自体が symlink)" "$TOPO/A/talk/pages/violation.md"

    mkdir -p "$TOPO/A2/talk/pages" "$TOPO/A2/shared"
    touch "$TOPO/A2/talk/slides.md"
    write_violation "$TOPO/A2/shared/violation.md"
    ln -s "$TOPO/A2/shared" "$TOPO/A2/talk/pages/shared"
    copy_references "$TOPO/A2/talk"
    assert_detected "A2 (pages/<sub> が symlink)" "$TOPO/A2/talk/pages/shared/violation.md"

    mkdir -p "$TOPO/B/real/talk/pages"
    touch "$TOPO/B/real/talk/slides.md"
    write_violation "$TOPO/B/real/talk/pages/violation.md"
    copy_references "$TOPO/B/real/talk"
    ln -s "$TOPO/B/real" "$TOPO/B/link"
    assert_detected "B (祖先 dir が symlink)" "$TOPO/B/link/talk/pages/violation.md"

    mkdir -p "$TOPO/D/talk/pages" "$TOPO/D/out"
    touch "$TOPO/D/talk/slides.md"
    write_violation "$TOPO/D/out/violation.md"
    copy_references "$TOPO/D/talk"
    ln -s "$TOPO/D/out/violation.md" "$TOPO/D/talk/pages/violation.md"
    assert_detected "D (編集対象ファイルが symlink)" "$TOPO/D/talk/pages/violation.md"
else
    echo "SKIP: $ASSETS_DIR から eslint を解決できないのでトポロジケースを skip"
fi

# --- ケース13: カナリア ---
# 偽 CLAUDE_PLUGIN_ROOT にスタブ eslint を置き、"outside of base path" と exit 0 を返させる。
# これで分岐に到達することを確認する。実 eslint に依存しないので、SKIP ガードは不要。
CANARY_TALK="$TMP/canary-talk"
mkdir -p "$CANARY_TALK/pages"
touch "$CANARY_TALK/slides.md"
echo "# foo" > "$CANARY_TALK/pages/a.md"
STUB_CANARY=$(make_stub_plugin stub-canary 0 "  0:0  warning  File ignored because outside of base path")
run_hook "canary" "$CANARY_TALK/pages/a.md" "$STUB_CANARY"
CANARY_CTX=$(ctx_of "$OUT")
if echo "$CANARY_CTX" | grep -q "eslint skipped:"; then
    pass "カナリア: base path 外判定を additionalContext で報告"
else
    fail "カナリア: スキップ検出が出力されない stdout='$OUT' stderr='$ERR'"
fi

# 分岐衝突ガード: 2 つのメッセージは、どちらも "File ignored because" で始まる。
# 対象は、base path 外メッセージと設定対象外メッセージ。
# hook が広い "File ignored" で拾うと、この入力が設定対象外（未実施）分岐へ回る。
# するとカナリアが何も知らせずに機能しなくなる。カナリアとして分類されていることを固定する。
if echo "$CANARY_CTX" | grep -q "warning: eslint not run:"; then
    fail "カナリア: 設定対象外（未実施）分岐に流れている（grep が広すぎる疑い）ctx='$CANARY_CTX'"
else
    pass "カナリア: 設定対象外の分岐と衝突しない"
fi

# eslint に渡す引数が talk root 相対であること。basename だけになると talk root 直下に
# 無いファイルが lint されなくなるので、カナリアの表示経由で形を固定する。
if echo "$CANARY_CTX" | grep -q "eslint argument: pages/a.md"; then
    pass "eslint 引数: talk root 相対パス (pages/a.md) を渡している"
else
    fail "eslint 引数: talk root 相対パスになっていない ctx='$CANARY_CTX'"
fi

# --- ケース14: merge 経由 ---
# 本番では、post-tool-use-edit.sh と post-tool-use-write.sh が merge 経由で hook を起動する。
# merge は非 JSON の stdout を additionalContext に丸める。
# trace を stdout に出していたら、skip のときも毎回 model に文字列が届く。
# skip のとき merge の stdout が空であること（= trace が stdout を汚していないこと）が、本ケースの主眼となる。
# merge は `"$script"` を直接起動するので、hook の実行ビットも同時に確認される。
MERGE_IN="{\"hook_event_name\":\"PostToolUse\",\"tool_input\":{\"file_path\":\"$NON_TALK/foo.md\"}}"
MERGE_OUT=$(printf '%s' "$MERGE_IN" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PLUGIN_DATA="$(mirror_data_for "$PLUGIN_ROOT")" bash "$MERGE" "$HOOK" 2>"$ERRFILE")
MERGE_ERR=$(cat "$ERRFILE")
if [ -n "$MERGE_OUT" ]; then
    fail "merge 経由 (skip 時): stdout が空でない（trace が additionalContext に丸められた疑い）stdout='$MERGE_OUT'"
elif ! echo "$MERGE_ERR" | grep -q "\[eslint-check\] skip:"; then
    fail "merge 経由 (skip 時): stderr に trace が出ていない stderr='$MERGE_ERR'"
else
    pass "merge 経由 (skip 時): stdout が空 / stderr に trace が出る"
fi

# 未実施通知は merge を通っても additionalContext として model に届くこと
MERGE_IN="{\"hook_event_name\":\"PostToolUse\",\"tool_input\":{\"file_path\":\"$TALK/pages/01.md\"}}"
MERGE_OUT=$(printf '%s' "$MERGE_IN" | CLAUDE_PLUGIN_ROOT="$STUB_FATAL" CLAUDE_PLUGIN_DATA="$(mirror_data_for "$STUB_FATAL")" bash "$MERGE" "$HOOK" 2>"$ERRFILE")
MERGE_CTX=$(ctx_of "$MERGE_OUT")
if ! printf '%s\n' "$MERGE_OUT" | jq empty 2>/dev/null; then
    fail "merge 経由 (未実施時): stdout が妥当な JSON でない stdout='$MERGE_OUT'"
elif ! echo "$MERGE_CTX" | grep -q "warning: eslint not run:"; then
    fail "merge 経由 (未実施時): additionalContext に未実施通知が無い stdout='$MERGE_OUT'"
elif ! printf '%s\n' "$MERGE_OUT" | jq -e '.hookSpecificOutput.hookEventName == "PostToolUse"' > /dev/null 2>&1; then
    fail "merge 経由 (未実施時): hookEventName が PostToolUse でない stdout='$MERGE_OUT'"
else
    pass "merge 経由 (未実施時): additionalContext + hookEventName 正常"
fi

# --- ケース15: ピン留め — 実 eslint の 3 つの文言と、クラッシュ時の exit code ---
# hook は次の 3 つを別分岐に振り分ける。
# カナリア（base path 外）、設定対象外（no matching configuration）、クラッシュ（Oops と始まるバナー）。
# いずれの文言も eslint 側の実装に依存する。バンプで変わると、分岐が何も知らせず機能しなくなる。
# assets/slidev の eslint を直接実行して確認する。設定は env 経由の入力（PECOTV_DECK_LINT）が要る。
if [ "$HAVE_ESLINT" = true ]; then
    OUTSIDE="$TMP/outside-base-path.md"
    echo "x" > "$OUTSIDE"
    PIN_LINT='{"referencesDirectories":[],"panels":{},"markerLayouts":[],"rules":{}}'
    PIN_OUT=$(cd "$ASSETS_DIR" && PECOTV_DECK_LINT="$PIN_LINT" timeout 30 node "$REAL_ESLINT_BIN" \
        --no-fix --config "$ASSETS_DIR/deck-lint.env.config.js" "$OUTSIDE" 2>&1)
    if echo "$PIN_OUT" | grep -q "outside of base path"; then
        pass "ピン留め: 実 eslint が 'outside of base path' 文言を出す"
    else
        fail "ピン留め: 'outside of base path' が出ない（eslint 側の文言変更の可能性。カナリアの grep を更新すること）out='$PIN_OUT'"
    fi

    # 設定対象外側は talk-dir 内の lint 対象パス外ファイルで再現する
    echo '{}' > "$TALK/readme.json"
    PIN_OUT=$(cd "$TALK" && PECOTV_DECK_LINT="$PIN_LINT" timeout 30 node "$REAL_ESLINT_BIN" \
        --no-fix --config "$ASSETS_DIR/deck-lint.env.config.js" ./readme.json 2>&1)
    if echo "$PIN_OUT" | grep -q "no matching configuration"; then
        pass "ピン留め: 実 eslint が 'no matching configuration' 文言を出す"
    else
        fail "ピン留め: 'no matching configuration' が出ない（eslint 側の文言変更の可能性。設定対象外の分岐の grep を更新すること）out='$PIN_OUT'"
    fi

    # クラッシュバナーと exit code の対応を確かめる。
    # eslint 10 では、bin/eslint.js の onFatalError だけがバナーを出す。
    # 同時に exitCode 2 を立てて、lint 結果の 1/0 で上書きされないようガードする。
    # したがって「バナー + exit 1」は現行では起こらない。hook のクラッシュ判定の exit 1 側は保険として置いてある。
    # ここが exit 1 に変わると、保険が実際に使われる側へ昇格する。気付けるよう、exit code ごと固定する。
    # CRASH_PLUGIN はケース10 で作成済み（実 eslint binary の symlink と、不正な config）。
    PIN_OUT=$(CDPATH= cd -P "$TALK" && timeout 30 \
        node "$REAL_ESLINT_BIN" --no-fix \
        --config "$CRASH_PLUGIN/assets/slidev/deck-lint.env.config.js" pages/01.md 2>&1)
    PIN_EXIT=$?
    if ! echo "$PIN_OUT" | grep -q "Oops! Something went wrong"; then
        fail "ピン留め: 実 eslint のクラッシュでバナー文言が出ない（eslint 側の文言変更の可能性。hook の CRASH_BANNER を更新すること）out='$PIN_OUT'"
    elif [ $PIN_EXIT -ne 2 ]; then
        fail "ピン留め: クラッシュ時の exit code が 2 でない (exit=$PIN_EXIT)。exit 1 に変わった場合は、hook のクラッシュ判定が保険から実際に使われる側へ変わる。eslint-check.sh のコメントを見直すこと"
    else
        pass "ピン留め: 実 eslint のクラッシュはバナー + exit 2（バナーと exit 1 は併発しない）"
    fi
else
    echo "SKIP: $ASSETS_DIR から eslint を解決できないのでピン留めチェックを skip"
fi

# --- ケース16: slide theme の結果で動く ---
# 16a: 解釈済みの lint が、PECOTV_DECK_LINT に JSON のまま渡る。
# eslint を、受けた PECOTV_DECK_LINT をそのまま出して exit 1 で終わる stub にする。
# 通知の本文で、渡った値を確かめる。
STUB_ENV=$(make_stub_plugin stub-env 1 "")
printf 'process.stdout.write("  1:1  error  ENV=" + process.env.PECOTV_DECK_LINT + "  stub/rule\\n"); process.exit(1)\n' \
    > "$STUB_ENV/assets/slidev/node_modules/eslint/bin/eslint.js"
STUB_RULES='{"slidev-pages-lint/no-missing-page":"error","text-constraints/max-chars":"warn"}'
STUB_THEME_RULES="$STUB_RULES" STUB_THEME_REFERENCES="$TALK/references,$TMP/theme-refs" \
    run_hook "deck-lint-env" "$TALK/pages/01.md" "$STUB_ENV"
CTX=$(ctx_of "$OUT")
ENV_JSON=$(printf '%s\n' "$CTX" | sed -n 's/.*ENV=\(.*\)  stub\/rule.*/\1/p')
if ! printf '%s\n' "$ENV_JSON" | jq -e --arg talk "$TALK" --arg refs "$TMP/theme-refs" \
    '.referencesDirectories == [($talk + "/references"), $refs] and .rules == {"slidev-pages-lint/no-missing-page":"error","text-constraints/max-chars":"warn"} and .panels == {} and .markerLayouts == []' > /dev/null 2>&1; then
    fail "PECOTV_DECK_LINT: slide theme の lint が JSON のまま渡っていない env='$ENV_JSON' ctx='$CTX'"
elif ! echo "$CTX" | grep -q "warning: eslint violations:"; then
    fail "PECOTV_DECK_LINT: 違反として報告されていない ctx='$CTX'"
else
    pass "PECOTV_DECK_LINT: slide theme の lint（参照 dir・rules）が eslint に JSON で渡る"
fi

# 16b: テーマを引けない talk-dir は lint せず、未実施として原因別に案内する。
STUB_NOCALL=$(make_stub_plugin stub-nocall 1 "SHOULD-NOT-RUN")
STUB_THEME_FAIL=theme-unlinked run_hook "theme-unlinked" "$TALK/pages/01.md" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if ! echo "$CTX" | grep -q "warning: eslint not run:"; then
    fail "theme-unlinked: 未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
elif ! echo "$CTX" | grep -q "Relinking node_modules with slide_sync (node_modules_only: true)"; then
    fail "theme-unlinked: slide_sync の node_modules_only の案内が無い ctx='$CTX'"
elif echo "$CTX" | grep -q "SHOULD-NOT-RUN\|warning: eslint violations:"; then
    fail "theme-unlinked: eslint を起動した/違反として報告している ctx='$CTX'"
elif echo "$CTX" | grep -q "テンプレートを同期"; then
    fail "theme-unlinked: 旧文言（テンプレートを同期）が残っている ctx='$CTX'"
elif ! echo "$ERR" | grep -q "\[eslint-check\] not-linted: theme is not linked"; then
    fail "theme-unlinked: stderr trace が not-linted でない stderr='$ERR'"
else
    pass "theme-unlinked: 未実施 + slide_sync（node_modules_only: true）の案内（eslint は起動しない）"
fi

STUB_THEME_FAIL=theme-none run_hook "theme-none" "$TALK/pages/01.md" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "warning: eslint not run:" && echo "$CTX" | grep -q "theme-none" \
    && echo "$CTX" | grep -q "slide sync --theme <theme-spec>" && ! echo "$CTX" | grep -q "SHOULD-NOT-RUN"; then
    pass "theme-none: 未実施 + slide sync --theme の案内"
else
    fail "theme-none: 案内が通知に無い stdout='$OUT' stderr='$ERR'"
fi

STUB_THEME_FAIL=theme-unknown-rule run_hook "theme-unknown-rule" "$TALK/pages/01.md" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "warning: eslint not run:" && echo "$CTX" | grep -q "theme-unknown-rule"; then
    pass "theme-unknown-rule: 未実施 + reason を通知"
else
    fail "theme-unknown-rule: reason が通知に無い stdout='$OUT' stderr='$ERR'"
fi

STUB_THEME_FAIL=crash run_hook "theme-crash" "$TALK/pages/01.md" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "warning: eslint not run:" && echo "$CTX" | grep -q "slide theme exited with 3" && ! echo "$CTX" | grep -q "SHOULD-NOT-RUN"; then
    pass "slide theme の異常終了: 未実施（原因の exit code を通知）"
else
    fail "slide theme の異常終了: 未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
fi

# 16c: CLI（cli/dist/cli.js）が無い実行用ミラーは、ミラーの準備が済んでいないものとして未実施にする。
# bin/_lib.sh の plugin_runtime_dir_for_hooks が、cli/dist/cli.js を持たないミラーを採らないため。
NO_CLI_ROOT="$PLUGIN_ROOT"
NO_CLI_DATA="$(mirror_data_for "$NO_CLI_ROOT")"
rm -f "$NO_CLI_DATA/runtime/mirror/cli/dist/cli.js"
OUT=$(printf '%s' "{\"tool_input\":{\"file_path\":\"$TALK/pages/01.md\"}}" | CLAUDE_PLUGIN_ROOT="$NO_CLI_ROOT" CLAUDE_PLUGIN_DATA="$NO_CLI_DATA" bash "$HOOK" 2>"$ERRFILE")
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "warning: eslint not run:" && echo "$CTX" | grep -q "the runtime mirror has not been created yet"; then
    pass "CLI 不在のミラー: ミラー未準備として未実施"
else
    fail "CLI 不在のミラー: 未実施の通知が無い stdout='$OUT'"
fi

# 16e: 対象外の編集（README.md）は、slide theme を起こさず、通知しない。
# テーマ未リンクの talk-dir でも、対象外の編集まで未実施の通知にしない。
THEME_LOG="$TMP/theme-spawn.log"
rm -f "$THEME_LOG"
echo "# readme" > "$TALK/README.md"
STUB_THEME_LOG="$THEME_LOG" STUB_THEME_FAIL=theme-unlinked run_hook "non-target-no-theme" "$TALK/README.md" "$STUB_NOCALL"
if [ -z "$OUT" ] && [ ! -e "$THEME_LOG" ] && echo "$ERR" | grep -q "\[eslint-check\] skip: not a lint target path"; then
    pass "対象外の編集: slide theme を起こさず、通知しない（テーマ未リンクでも）"
else
    THEME_LOG_TEXT=$(cat "$THEME_LOG" 2>/dev/null)
    fail "対象外の編集: slide theme を起こした/通知した stdout='$OUT' stderr='$ERR' log='${THEME_LOG_TEXT:-}'"
fi
# 対象の編集では起こす（上の確認が、常に起こさないだけの退行を見逃さないための対照）。
rm -f "$THEME_LOG"
STUB_THEME_LOG="$THEME_LOG" run_hook "target-spawns-theme" "$TALK/pages/01.md" "$STUB_ENV"
if [ -s "$THEME_LOG" ]; then
    pass "対象の編集: slide theme を起こす"
else
    fail "対象の編集: slide theme を起こしていない stdout='$OUT' stderr='$ERR'"
fi

# 16f: slide theme が JSON を出せずに終了したとき、stderr の先頭 1 行を通知と trace に添える。
STUB_THEME_FAIL=crash STUB_THEME_STDERR="Node.js 24.22.1 以上が要ります" run_hook "theme-crash-stderr" "$TALK/pages/01.md" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "stderr: Node.js 24.22.1 以上が要ります" && echo "$ERR" | grep -q "stderr: Node.js 24.22.1 以上が要ります"; then
    pass "slide theme の stderr: 先頭 1 行を通知と trace に添える"
else
    fail "slide theme の stderr: 通知か trace に無い ctx='$CTX' stderr='$ERR'"
fi

# 16d: マーカーは slides.md + pages/。start.mjs だけの dir は talk-dir とみなさない。
OLD_MARKER="$TMP/old-marker"
mkdir -p "$OLD_MARKER/pages"
touch "$OLD_MARKER/start.mjs"
echo "# foo" > "$OLD_MARKER/pages/a.md"
run_hook "old-marker" "$OLD_MARKER/pages/a.md" "$PLUGIN_ROOT"
if [ -z "$OUT" ] && echo "$ERR" | grep -q "\[eslint-check\] skip: talk-dir marker (slides.md + pages/)"; then
    pass "start.mjs だけの dir: talk-dir とみなさず skip"
else
    fail "start.mjs だけの dir: skip していない stdout='$OUT' stderr='$ERR'"
fi

# --- ケース17: 実 CLI（cli/dist）を通す ---
# 他のケースはミラーの stub CLI を使う。ここだけは build 済みの cli/dist の実物で slide theme を起こす。
# fixture テーマを node_modules/<name> に symlink した talk-dir で、宣言の lint.rules（max-chars）が働くことを見る。
# cli/dist に slide theme（commands/slidev-project/theme.js）が無い環境（build 前、または古い build）では SKIP する。
# 最新のソースで build してから実行すること。
REAL_CLI_DIST="${PECOTV_TEST_CLI_DIST:-$PLUGIN_ROOT/cli/dist}"
if [ "$HAVE_ESLINT" = true ] && [ -f "$REAL_CLI_DIST/commands/slidev-project/theme.js" ]; then
    REAL_CLI_TALK="$TMP/real-cli-talk"
    mkdir -p "$REAL_CLI_TALK/pages" "$REAL_CLI_TALK/node_modules"
    ln -s "$FIXTURE_THEME" "$REAL_CLI_TALK/node_modules/slidev-theme-pecotv-test-declared"
    printf '%s\n' '---' 'theme: slidev-theme-pecotv-test-declared' '---' '' '---' 'src: ./pages/long.md' '---' > "$REAL_CLI_TALK/slides.md"
    printf '{"name":"real-cli-talk","dependencies":{"slidev-theme-pecotv-test-declared":"file:%s"}}\n' "$FIXTURE_THEME" > "$REAL_CLI_TALK/package.json"
    printf '%s\n' '---' 'layout: plain' 'heading: "二十文字を超える見出しの例をここに置いています"' '---' > "$REAL_CLI_TALK/pages/long.md"
    MIRROR_REAL_CLI_DIST="$REAL_CLI_DIST" run_hook "real-cli" "$REAL_CLI_TALK/pages/long.md" "$PLUGIN_ROOT"
    CTX=$(ctx_of "$OUT")
    if echo "$CTX" | grep -q "text-constraints/max-chars" && echo "$ERR" | grep -q "\[eslint-check\] violation:"; then
        pass "実 CLI: テーマの宣言（fixture）の規則で違反を検出"
    else
        fail "実 CLI: 宣言の規則で違反が出ない stdout='$OUT' stderr='$ERR'"
    fi

    # テーマを張っていない talk-dir は、実 CLI の theme-unlinked が未実施通知になる。
    rm "$REAL_CLI_TALK/node_modules/slidev-theme-pecotv-test-declared"
    MIRROR_REAL_CLI_DIST="$REAL_CLI_DIST" run_hook "real-cli-unlinked" "$REAL_CLI_TALK/pages/long.md" "$PLUGIN_ROOT"
    CTX=$(ctx_of "$OUT")
    if echo "$CTX" | grep -q "theme-unlinked" && echo "$CTX" | grep -q "warning: eslint not run:"; then
        pass "実 CLI: 未リンクの talk-dir は theme-unlinked の未実施通知"
    else
        fail "実 CLI: theme-unlinked の未実施通知が出ない stdout='$OUT' stderr='$ERR'"
    fi
else
    echo "SKIP: cli/dist に slide theme が無い（build 前か古い build）か eslint を解決できないので、実 CLI のケースを skip"
fi

# --- 違反が多いとき: バイトの上限で切り、残りの件数を最後の行に書く ---
MANY_OUT=$(printf '/x/01.md\n'; for i in $(seq 1 120); do printf '  %d:1  error  violation number %d of the page  slidev/rule\n' "$i" "$i"; done)
STUB_MANY=$(make_stub_plugin stub-many 1 "$MANY_OUT")
run_hook "many-violations" "$TALK/pages/01.md" "$STUB_MANY"
CTX=$(ctx_of "$OUT")
SHOWN=$(printf '%s\n' "$CTX" | grep -cE '^ +[0-9]+:[0-9]+ ')
REST=$(printf '%s\n' "$CTX" | tail -n 1 | sed -nE 's/^ *Truncated at 3500 bytes: ([0-9]+) more violations not shown\.$/\1/p')
if [ "$(printf '%s' "$CTX" | wc -c)" -le 4000 ] && [ -n "$REST" ] && [ $((SHOWN + REST)) -eq 120 ]; then
    pass "違反 120 件: 上限に収まり、最後の行の N が残りの件数と合う 表示 $SHOWN 残り $REST"
else
    LAST=$(printf '%s\n' "$CTX" | tail -n 1)
    fail "違反 120 件: shown=$SHOWN rest='$REST' last='$LAST'"
fi

# --- ガードレール: 全ケースで stdout が「空または妥当な JSON」 ---
if [ -z "$BAD_STDOUT" ]; then
    pass "ガードレール: 全ケースの stdout が空または妥当な JSON"
else
    fail "ガードレール: stdout が非 JSON のケースがある: $BAD_STDOUT"
fi

echo ""
echo "===== summary: PASS=$PASS FAIL=$FAIL ====="
[ $FAIL -eq 0 ]
