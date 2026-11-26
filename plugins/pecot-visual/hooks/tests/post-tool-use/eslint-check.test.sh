#!/bin/bash
# eslint-check.sh の単体テスト。「lint していない」と「違反があった」を混同しないことと、
# stdout が空か妥当な JSON であることを確かめる。stdout と stderr は混ぜずに分けて取る。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
HOOK="$SCRIPT_DIR/../../lib/post-tool-use/eslint-check.sh"
MERGE="$SCRIPT_DIR/../../lib/core/merge-hook-outputs.sh"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=mirror-helper.sh
. "$SCRIPT_DIR/mirror-helper.sh"
ASSETS_DIR="$PLUGIN_ROOT/assets/slidev"
# テーマの宣言は実 CLI でなく、ミラーの stub CLI（mirror-helper.sh）が返す。
# 参照 yaml は fixture テーマのものを talk-dir の references/ に複写して使う。
FIXTURE_THEME="$PLUGIN_ROOT/cli/tests/fixtures/themes/with-declaration"
# ASSETS_DIR が無いのはリポの異常なので、skip にはせず止める（runner が broken にする）。
[ -d "$ASSETS_DIR" ] || { echo "FAIL: ASSETS_DIR 不在: $ASSETS_DIR" >&2; exit 1; }
[ -d "$FIXTURE_THEME/references" ] || { echo "FAIL: FIXTURE_THEME 不在: $FIXTURE_THEME" >&2; exit 1; }

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

# 参照 YAML が無いと text-constraints は評価を諦め、真の pass と区別できない。$1 = talk root
copy_references() {
    cp -r "$FIXTURE_THEME/references" "$1/references"
}

# 偽 plugin root に、package.json の bin から辿れるスタブ eslint を置き、そのパスを返す。
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
NO_ESLINT_REASON="$ASSETS_DIR から eslint を解決できない"
[ -n "$REAL_ESLINT_BIN" ] && [ -f "$REAL_ESLINT_BIN" ] && HAVE_ESLINT=true

# --- ケース1: talk-dir マーカー不在 → stdout 空 / stderr に skip trace ---
NON_TALK="$TMP/non-talk"
mkdir -p "$NON_TALK"
echo "# foo" > "$NON_TALK/foo.md"
run_hook "marker-absent" "$NON_TALK/foo.md" "$PLUGIN_ROOT"
if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[eslint-check\] skip:"; then
    bt_pass "talk-dir マーカー不在: exit 0 / stdout 空 / stderr skip trace"
else
    bt_fail "talk-dir マーカー不在: exit 0 / stdout 空 / stderr skip trace" "exit=$EXIT stdout='$OUT' stderr='$ERR'"
fi

# --- ケース2: 非 .md → stdout 空 / stderr に skip trace ---
run_hook "non-md" "$NON_TALK/foo.txt" "$PLUGIN_ROOT"
if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[eslint-check\] skip: not a .md file"; then
    bt_pass "非 .md: exit 0 / stdout 空 / stderr skip trace"
else
    bt_fail "非 .md: exit 0 / stdout 空 / stderr skip trace" "exit=$EXIT stdout='$OUT' stderr='$ERR'"
fi

# --- ケース3: file_path 空 → stdout 空 / stderr に skip trace ---
run_hook_json "no-file-path" '{}' "$PLUGIN_ROOT"
if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && echo "$ERR" | grep -q "\[eslint-check\] skip: tool_input.file_path"; then
    bt_pass "file_path 空: exit 0 / stdout 空 / stderr skip trace"
else
    bt_fail "file_path 空: exit 0 / stdout 空 / stderr skip trace" "exit=$EXIT stdout='$OUT' stderr='$ERR'"
fi

# --- ケース4: 設定不備（plugin root は解決できるが assets/slidev が無い） ---
# pass と区別できるよう、「未実施」を model に伝える。
TALK="$TMP/talk"
mkdir -p "$TALK/pages"
touch "$TALK/slides.md"
echo "# foo" > "$TALK/pages/01.md"
run_hook "assets-missing" "$TALK/pages/01.md" "$TMP/no-such-plugin"
CTX=$(ctx_of "$OUT")
if ! echo "$CTX" | head -n 1 | grep -q "^warning: eslint not run: "; then
    bt_fail "assets 不在: 未実施通知 + theme: 表記 + bootstrap 案内" "未実施通知が出ていない stdout='$OUT'"
elif ! echo "$CTX" | grep -q "theme: $TALK/node_modules/stub-theme"; then
    bt_fail "assets 不在: 未実施通知 + theme: 表記 + bootstrap 案内" "通知に theme: の表記（解決済みのテーマ root）が無い ctx='$CTX'"
elif echo "$CTX" | grep -q "template:"; then
    bt_fail "assets 不在: 未実施通知 + theme: 表記 + bootstrap 案内" "通知が旧表記の template: を使っている ctx='$CTX'"
elif ! echo "$CTX" | grep -q "pecotv"; then
    bt_fail "assets 不在: 未実施通知 + theme: 表記 + bootstrap 案内" "bootstrap 案内 (pecotv コマンド) が通知に無い ctx='$CTX'"
elif echo "$CTX" | grep -q "warning: eslint violations:"; then
    bt_fail "assets 不在: 未実施通知 + theme: 表記 + bootstrap 案内" "違反として報告している ctx='$CTX'"
elif ! echo "$ERR" | grep -q "\[eslint-check\] not-linted:"; then
    bt_fail "assets 不在: 未実施通知 + theme: 表記 + bootstrap 案内" "stderr trace が not-linted でない stderr='$ERR'"
else
    bt_pass "assets 不在: 未実施通知 + theme: 表記 + bootstrap 案内"
fi

# --- ケース4b: 実行用ミラーが無い（初回の build 中・データ置き場を解決できない） ---
# 未実施の通知に倒し、違反とは報告しない。
MIRROR_ABSENT=1 run_hook "mirror-absent" "$TALK/pages/01.md" "$PLUGIN_ROOT"
CTX=$(ctx_of "$OUT")
if ! echo "$CTX" | grep -q "warning: eslint not run:"; then
    bt_fail "ミラー不在: 未実施通知 + bootstrap 案内" "未実施通知が出ていない stdout='$OUT'"
elif ! echo "$CTX" | grep -q "pecotv"; then
    bt_fail "ミラー不在: 未実施通知 + bootstrap 案内" "bootstrap 案内 (pecotv コマンド) が通知に無い ctx='$CTX'"
elif echo "$CTX" | grep -q "warning: eslint violations:"; then
    bt_fail "ミラー不在: 未実施通知 + bootstrap 案内" "違反として報告している ctx='$CTX'"
elif ! echo "$ERR" | grep -q "\[eslint-check\] not-linted: runtime mirror is missing"; then
    bt_fail "ミラー不在: 未実施通知 + bootstrap 案内" "stderr trace が not-linted でない stderr='$ERR'"
else
    bt_pass "ミラー不在: 未実施通知 + bootstrap 案内"
fi

# --- ケース5: plugin root 解決不能 → 対象外（stdout 空 / stderr skip） ---
# 逆算できない配置にする。共有ライブラリは hook の 1 段上の core/ から読むので、$TMP/core に置く。
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
    bt_pass "plugin root 解決不能: exit 0 / stdout 空 / stderr skip trace"
else
    bt_fail "plugin root 解決不能: exit 0 / stdout 空 / stderr skip trace" \
        "exit=$EXIT stdout='$OUT' stderr='$ERR'"
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
        bt_pass "真の pass: stdout 空 / stderr pass trace"
    else
        bt_fail "真の pass: stdout 空 / stderr pass trace" "exit=$EXIT stdout='$OUT' stderr='$ERR'"
    fi
else
    bt_skip "真の pass: stdout 空 / stderr pass trace" "$NO_ESLINT_REASON"
fi

# --- ケース7: 実 assets/slidev で違反検出（ERR_MODULE_NOT_FOUND が出ないこと） ---
if [ "$HAVE_ESLINT" = true ]; then
    write_violation "$REAL/pages/violation.md"
    run_hook "real-violation" "$REAL/pages/violation.md" "$PLUGIN_ROOT"
    CTX=$(ctx_of "$OUT")
    if echo "$OUT$ERR" | grep -q "ERR_MODULE_NOT_FOUND"; then
        bt_fail "実 assets: 違反検出 + hookEventName 正常 + violation trace" \
            "ERR_MODULE_NOT_FOUND が出ている stdout='$OUT' stderr='$ERR'"
    elif ! echo "$CTX" | grep -q "slidev-pages-lint/no-content-before-frontmatter"; then
        bt_fail "実 assets: 違反検出 + hookEventName 正常 + violation trace" \
            "違反 rule id が additionalContext に含まれない stdout='$OUT'"
    elif ! echo "$CTX" | head -n 1 | grep -q "^warning: eslint violations: "; then
        bt_fail "実 assets: 違反検出 + hookEventName 正常 + violation trace" "違反見出しが無い ctx='$CTX'"
    elif ! printf '%s\n' "$OUT" | jq -e '.hookSpecificOutput.hookEventName == "PostToolUse"' > /dev/null 2>&1; then
        bt_fail "実 assets: 違反検出 + hookEventName 正常 + violation trace" \
            "hookSpecificOutput.hookEventName が PostToolUse でない stdout='$OUT'"
    elif ! echo "$ERR" | grep -q "\[eslint-check\] violation:"; then
        bt_fail "実 assets: 違反検出 + hookEventName 正常 + violation trace" \
            "stderr trace が violation でない stderr='$ERR'"
    else
        bt_pass "実 assets: 違反検出 + hookEventName 正常 + violation trace"
    fi
else
    bt_skip "実 assets: 違反検出 + hookEventName 正常 + violation trace" "$NO_ESLINT_REASON"
fi

# --- ケース8: 参照 YAML 依存の違反 ---
# 参照 YAML を同梱した fixture でだけ違反が出ることで、以降の fixture が空振りしていないと分かる。
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
        bt_pass "参照 YAML 依存の違反: text-constraints/max-chars を検出（fixture が空振りしていない）"
    else
        bt_fail "参照 YAML 依存の違反: text-constraints/max-chars を検出（fixture が空振りしていない）" \
            "text-constraints/max-chars が出ない（references/ の同梱忘れの疑い）stdout='$OUT'"
    fi
else
    bt_skip "参照 YAML 依存の違反: text-constraints/max-chars を検出（fixture が空振りしていない）" "$NO_ESLINT_REASON"
fi

# --- ケース8b: 文面違反（textlint） ---
# hook から起動しても synckit worker を解決でき、違反が additionalContext まで届く。
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
        bt_pass "文面違反: text-constraints/textlint を additionalContext に含む"
    else
        bt_fail "文面違反: text-constraints/textlint を additionalContext に含む" \
            "text-constraints/textlint が出ない stdout='$OUT' stderr='$ERR'"
    fi
else
    bt_skip "文面違反: text-constraints/textlint を additionalContext に含む" "$NO_ESLINT_REASON"
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
        bt_fail "本文・ノートの文面違反: text-constraints/textlint-body を本文行とノート行で additionalContext に含む" \
            "text-constraints/textlint-body が出ない stdout='$OUT' stderr='$ERR'"
    elif ! echo "$CTX" | grep -q "body L6:"; then
        bt_fail "本文・ノートの文面違反: text-constraints/textlint-body を本文行とノート行で additionalContext に含む" \
            "本文の違反がファイル行 6 で出ない ctx='$CTX'"
    elif ! echo "$CTX" | grep -q "speaker notes L9:"; then
        bt_fail "本文・ノートの文面違反: text-constraints/textlint-body を本文行とノート行で additionalContext に含む" \
            "ノートの違反がファイル行 9 で出ない ctx='$CTX'"
    elif echo "$CTX" | grep -q "warning: eslint not run:"; then
        bt_fail "本文・ノートの文面違反: text-constraints/textlint-body を本文行とノート行で additionalContext に含む" \
            "未実施に化けている ctx='$CTX'"
    else
        bt_pass "本文・ノートの文面違反: text-constraints/textlint-body を本文行とノート行で additionalContext に含む"
    fi
else
    bt_skip "本文・ノートの文面違反: text-constraints/textlint-body を本文行とノート行で additionalContext に含む" "$NO_ESLINT_REASON"
fi

# 本文にクラッシュバナーと同じ文字列があっても、stylish 出力は本文を出さないので違反として報告される。
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
        bt_fail "本文にバナー文言: 違反として報告される（クラッシュ判定が誤射しない）" "違反が未実施に化けている（stylish 出力に本文が混入した疑い）ctx='$CTX'"
    elif ! echo "$CTX" | grep -q "slidev-pages-lint/no-content-before-frontmatter"; then
        bt_fail "本文にバナー文言: 違反として報告される（クラッシュ判定が誤射しない）" "違反として報告されていない stdout='$OUT' stderr='$ERR'"
    else
        bt_pass "本文にバナー文言: 違反として報告される（クラッシュ判定が誤射しない）"
    fi
else
    bt_skip "本文にバナー文言: 違反として報告される（クラッシュ判定が誤射しない）" "$NO_ESLINT_REASON"
fi

# --- ケース9: exit 0 で出力が空でない場合の振り分け ---
# 設定対象外は、lint 対象パスなら未実施を通知し、talk-dir 内の対象外パスなら skip する。
IGNORED_MSG="  0:0  warning  File ignored because no matching configuration was supplied"
STUB_IGNORED=$(make_stub_plugin stub-ignored 0 "$IGNORED_MSG")
run_hook "ignored-lint-target" "$TALK/pages/01.md" "$STUB_IGNORED"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "warning: eslint not run:" && ! echo "$CTX" | grep -q "warning: eslint violations:"; then
    bt_pass "設定対象外 (lint 対象パス pages/): 未実施を通知"
else
    bt_fail "設定対象外 (lint 対象パス pages/): 未実施を通知" "未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
fi

# slides.md も deck-lint の設定が宣言する lint 対象。case 分岐の未確認のアームを塞ぐ。
echo "# slides" > "$TALK/slides.md"
run_hook "ignored-slides-md" "$TALK/slides.md" "$STUB_IGNORED"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "warning: eslint not run:"; then
    bt_pass "設定対象外 (lint 対象パス slides.md): 未実施を通知"
else
    bt_fail "設定対象外 (lint 対象パス slides.md): 未実施を通知" "未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
fi

# talk-dir 内だが lint 対象パス外（README.md）。実 eslint が同じ文言を返す。
# model には何も出さず、stderr のみになること。
if [ "$HAVE_ESLINT" = true ]; then
    echo "# readme" > "$REAL/README.md"
    run_hook "ignored-non-target" "$REAL/README.md" "$PLUGIN_ROOT"
    if [ -z "$OUT" ] && echo "$ERR" | grep -q "\[eslint-check\] skip: not a lint target path"; then
        bt_pass "設定対象外 (lint 対象パス外 README.md): stdout 空 / stderr skip trace"
    else
        bt_fail "設定対象外 (lint 対象パス外 README.md): stdout 空 / stderr skip trace" "stdout='$OUT' stderr='$ERR'"
    fi
else
    bt_skip "設定対象外 (lint 対象パス外 README.md): stdout 空 / stderr skip trace" "$NO_ESLINT_REASON"
fi

# exit 0 で未知の出力（node の ExperimentalWarning など）は pass として飲み込む。#849 と同じ誤報を防ぐ。
STUB_WARN=$(make_stub_plugin stub-node-warning 0 \
    "(node:1234) ExperimentalWarning: Type Stripping is an experimental feature")
run_hook "exit0-unknown-output" "$TALK/pages/01.md" "$STUB_WARN"
if [ -n "$OUT" ]; then
    bt_fail "exit 0 + 未知の非空出力: stdout 空 / stderr pass trace に出力先頭を残す" \
        "model に通知している（node warning を違反/未実施に昇格させた疑い）stdout='$OUT'"
elif ! echo "$ERR" | grep -q "\[eslint-check\] pass: exit 0 with unrecognized output"; then
    bt_fail "exit 0 + 未知の非空出力: stdout 空 / stderr pass trace に出力先頭を残す" "stderr trace が pass でない stderr='$ERR'"
elif ! echo "$ERR" | grep -q "ExperimentalWarning"; then
    bt_fail "exit 0 + 未知の非空出力: stdout 空 / stderr pass trace に出力先頭を残す" "出力の先頭が trace に残っていない stderr='$ERR'"
else
    bt_pass "exit 0 + 未知の非空出力: stdout 空 / stderr pass trace に出力先頭を残す"
fi

# --- ケース10: exit 1 以外の非 0 / 非 0 かつ空出力 → 未実施（違反と報告しない） ---
# #849。eslint 10 は config fatal で exit 2 を返す。timeout はスタブの exit 124 で再現する。
expect_not_linted() {
    local label="$1" root="$2" expect="$3" ctx
    run_hook "$label" "$TALK/pages/01.md" "$root"
    ctx=$(ctx_of "$OUT")
    if echo "$ctx" | grep -q "warning: eslint violations:"; then
        bt_fail "$label: 未実施へ振り分け（違反と報告しない）" "違反として報告している ctx='$ctx'"
    elif ! echo "$ctx" | grep -q "warning: eslint not run:"; then
        bt_fail "$label: 未実施へ振り分け（違反と報告しない）" "未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
    elif ! echo "$ctx" | grep -q "$expect"; then
        bt_fail "$label: 未実施へ振り分け（違反と報告しない）" "期待する理由 ('$expect') が通知に無い ctx='$ctx'"
    elif ! echo "$ERR" | grep -q "\[eslint-check\] not-linted:"; then
        bt_fail "$label: 未実施へ振り分け（違反と報告しない）" "stderr trace が not-linted でない stderr='$ERR'"
    else
        bt_pass "$label: 未実施へ振り分け（違反と報告しない）"
    fi
}

STUB_FATAL=$(make_stub_plugin stub-exit2 2 "Oops! Something went wrong! Cannot read config file")
expect_not_linted "exit 2 (config fatal 相当)" "$STUB_FATAL" "exit 2"
# 実行異常時は原因追跡のため eslint 出力の先頭を通知に添える
run_hook "exit2-output-head" "$TALK/pages/01.md" "$STUB_FATAL"
if ctx_of "$OUT" | grep -q "Cannot read config file"; then
    bt_pass "exit 2: eslint 出力の先頭を通知に添えている"
else
    bt_fail "exit 2: eslint 出力の先頭を通知に添えている" "eslint 出力が通知に含まれない stdout='$OUT'"
fi

STUB_TIMEOUT=$(make_stub_plugin stub-exit124 124 "")
expect_not_linted "exit 124 (timeout)" "$STUB_TIMEOUT" "timed out"

STUB_EXIT1_EMPTY=$(make_stub_plugin stub-exit1-empty 1 "")
expect_not_linted "exit 1 かつ出力空" "$STUB_EXIT1_EMPTY" "exit 1"

# exit 1 でも出力がクラッシュバナーならクラッシュとみなす。現行の eslint では起こらない（ケース15 で固定）。
STUB_EXIT1_CRASH=$(make_stub_plugin stub-exit1-crash 1 \
    "Oops! Something went wrong! :( ESLint: 10.13.0 Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@v-slidev/eslint-plugin-slidev-pages-lint'")
expect_not_linted "exit 1 + クラッシュバナー" "$STUB_EXIT1_CRASH" "crashed"

# 偽 plugin root に実 eslint の symlink と、無い module を import する config を置いてクラッシュさせる。
if [ "$HAVE_ESLINT" = true ]; then
    CRASH_PLUGIN="$TMP/crash-plugin"
    CRASH_TPL="$CRASH_PLUGIN/assets/slidev"
    mkdir -p "$CRASH_TPL/node_modules"
    ln -s "$(dirname "$(dirname "$REAL_ESLINT_BIN")")" "$CRASH_TPL/node_modules/eslint"
    printf '{"devDependencies":{"eslint":"^10.13.0"}}\n' > "$CRASH_TPL/package.json"
    echo 'import x from "@no/such-module-for-crash-pin"; export default []' \
        > "$CRASH_PLUGIN/assets/slidev/deck-lint.env.config.js"
    expect_not_linted "実 eslint のクラッシュ (ERR_MODULE_NOT_FOUND)" "$CRASH_PLUGIN" "crashed"
else
    bt_skip "実 eslint のクラッシュ (ERR_MODULE_NOT_FOUND): 未実施へ振り分け（違反と報告しない）" "$NO_ESLINT_REASON"
fi

# --- ケース10b: eslint のメジャー違い → 未実施 ---
# require.resolve は親の node_modules まで遡る。メジャー違いは lint せず未実施にする。
STUB_MAJOR=$(make_stub_plugin stub-major-mismatch 0 "")
printf '{"name":"eslint","version":"9.30.0","bin":{"eslint":"bin/eslint.js"}}\n' \
    > "$STUB_MAJOR/assets/slidev/node_modules/eslint/package.json"
run_hook "major-mismatch" "$TALK/pages/01.md" "$STUB_MAJOR"
CTX=$(ctx_of "$OUT")
if ! echo "$CTX" | grep -q "warning: eslint not run:"; then
    bt_fail "メジャー不一致: 未実施へ振り分け + 理由を trace に残す" "未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
elif ! echo "$CTX" | grep -q "node_modules/eslint"; then
    bt_fail "メジャー不一致: 未実施へ振り分け + 理由を trace に残す" "不足として eslint が挙がっていない ctx='$CTX'"
elif ! echo "$ERR" | grep -q "\[eslint-check\] eslint resolution failed: .*9.30.0.*differs in major version"; then
    bt_fail "メジャー不一致: 未実施へ振り分け + 理由を trace に残す" "理由が trace に無い stderr='$ERR'"
else
    bt_pass "メジャー不一致: 未実施へ振り分け + 理由を trace に残す"
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
    bt_fail "eslint 解決不能: 未実施 + 解決失敗の理由を trace に残す" "未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
elif ! echo "$ERR" | grep -q "\[eslint-check\] eslint resolution failed: .*eslint"; then
    bt_fail "eslint 解決不能: 未実施 + 解決失敗の理由を trace に残す" "解決失敗の理由が trace に無い stderr='$ERR'"
else
    bt_pass "eslint 解決不能: 未実施 + 解決失敗の理由を trace に残す"
fi

# --- ケース11: symlink 経由の logical パス ---
# 違反を検出し、物理パスと同じ結果になる。本番の例は worktree の .pecot/work と macOS の /private/var。
# merge-hook-outputs.sh は hook の exit code を捨てるので、stdout の JSON で確かめる。
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
        # stylish の問題行から rule id だけを取る。ヘッダのパスは symlink 経由か物理かで変わるので拾わない。
        ctx_of "$1" | \
            awk '/^[[:space:]]+[0-9]+:[0-9]+[[:space:]]+(error|warning)/{print $NF}' | sort -u
    }

    run_hook "symlink-violation" "$TMP/link-talk/pages/violation.md" "$PLUGIN_ROOT"
    LINK_OUT="$OUT"
    if ! ctx_of "$LINK_OUT" | grep -q "slidev-pages-lint/no-content-before-frontmatter"; then
        bt_fail "symlink 経由: logical パスでも違反検出" "違反 rule id が additionalContext に含まれない stdout='$LINK_OUT'"
    else
        bt_pass "symlink 経由: logical パスでも違反検出"
    fi

    # パリティ: 同一内容を物理パスで流し、同じ rule id 集合が返ること
    run_hook "physical-violation" "$PARITY/pages/violation.md" "$PLUGIN_ROOT"
    PHYS_OUT="$OUT"
    LINK_RULES=$(rule_ids "$LINK_OUT")
    PHYS_RULES=$(rule_ids "$PHYS_OUT")
    if [ -z "$PHYS_RULES" ]; then
        bt_fail "パリティ: symlink 経由と物理パスで rule id 集合が一致" "物理パス経由で rule id が 1 件も取れない stdout='$PHYS_OUT'"
    elif [ "$LINK_RULES" != "$PHYS_RULES" ]; then
        bt_fail "パリティ: symlink 経由と物理パスで rule id 集合が一致" \
            "rule id 集合が不一致 symlink='$LINK_RULES' phys='$PHYS_RULES'"
    else
        bt_pass "パリティ: symlink 経由と物理パスで rule id 集合が一致"
    fi
else
    bt_skip "symlink 経由: logical パスでも違反検出" "$NO_ESLINT_REASON"
    bt_skip "パリティ: symlink 経由と物理パスで rule id 集合が一致" "$NO_ESLINT_REASON"
fi

# --- ケース12: symlink トポロジ 4 種 ---
# symlink の置き所: A = pages/、A2 = pages/<sub>/、B = 祖先 dir（#836）、D = 編集対象ファイル。
expect_detected() {
    local label="$1" target="$2"
    run_hook "topo-$label" "$target" "$PLUGIN_ROOT"
    if ctx_of "$OUT" | grep -q "slidev-pages-lint/no-content-before-frontmatter"; then
        bt_pass "トポロジ $label: 違反検出"
    else
        bt_fail "トポロジ $label: 違反検出" "違反 rule id が additionalContext に含まれない stdout='$OUT' stderr='$ERR'"
    fi
}

if [ "$HAVE_ESLINT" = true ]; then
    TOPO="$TMP/topo"

    mkdir -p "$TOPO/A/talk" "$TOPO/A/elsewhere"
    touch "$TOPO/A/talk/slides.md"
    write_violation "$TOPO/A/elsewhere/violation.md"
    ln -s "$TOPO/A/elsewhere" "$TOPO/A/talk/pages"
    copy_references "$TOPO/A/talk"
    expect_detected "A (pages 自体が symlink)" "$TOPO/A/talk/pages/violation.md"

    mkdir -p "$TOPO/A2/talk/pages" "$TOPO/A2/shared"
    touch "$TOPO/A2/talk/slides.md"
    write_violation "$TOPO/A2/shared/violation.md"
    ln -s "$TOPO/A2/shared" "$TOPO/A2/talk/pages/shared"
    copy_references "$TOPO/A2/talk"
    expect_detected "A2 (pages/<sub> が symlink)" "$TOPO/A2/talk/pages/shared/violation.md"

    mkdir -p "$TOPO/B/real/talk/pages"
    touch "$TOPO/B/real/talk/slides.md"
    write_violation "$TOPO/B/real/talk/pages/violation.md"
    copy_references "$TOPO/B/real/talk"
    ln -s "$TOPO/B/real" "$TOPO/B/link"
    expect_detected "B (祖先 dir が symlink)" "$TOPO/B/link/talk/pages/violation.md"

    mkdir -p "$TOPO/D/talk/pages" "$TOPO/D/out"
    touch "$TOPO/D/talk/slides.md"
    write_violation "$TOPO/D/out/violation.md"
    copy_references "$TOPO/D/talk"
    ln -s "$TOPO/D/out/violation.md" "$TOPO/D/talk/pages/violation.md"
    expect_detected "D (編集対象ファイルが symlink)" "$TOPO/D/talk/pages/violation.md"
else
    bt_skip "トポロジ A (pages 自体が symlink): 違反検出" "$NO_ESLINT_REASON"
    bt_skip "トポロジ A2 (pages/<sub> が symlink): 違反検出" "$NO_ESLINT_REASON"
    bt_skip "トポロジ B (祖先 dir が symlink): 違反検出" "$NO_ESLINT_REASON"
    bt_skip "トポロジ D (編集対象ファイルが symlink): 違反検出" "$NO_ESLINT_REASON"
fi

# --- ケース13: カナリア ---
# スタブ eslint に "outside of base path" と exit 0 を返させる。実 eslint に依存しない。
CANARY_TALK="$TMP/canary-talk"
mkdir -p "$CANARY_TALK/pages"
touch "$CANARY_TALK/slides.md"
echo "# foo" > "$CANARY_TALK/pages/a.md"
STUB_CANARY=$(make_stub_plugin stub-canary 0 "  0:0  warning  File ignored because outside of base path")
run_hook "canary" "$CANARY_TALK/pages/a.md" "$STUB_CANARY"
CANARY_CTX=$(ctx_of "$OUT")
if echo "$CANARY_CTX" | grep -q "eslint skipped:"; then
    bt_pass "カナリア: base path 外判定を additionalContext で報告"
else
    bt_fail "カナリア: base path 外判定を additionalContext で報告" "スキップ検出が出力されない stdout='$OUT' stderr='$ERR'"
fi

# base path 外と設定対象外の文言は、どちらも "File ignored because" で始まる。カナリアが未実施へ流れないこと。
if echo "$CANARY_CTX" | grep -q "warning: eslint not run:"; then
    bt_fail "カナリア: 設定対象外の分岐と衝突しない" "設定対象外（未実施）分岐に流れている（grep が広すぎる疑い）ctx='$CANARY_CTX'"
else
    bt_pass "カナリア: 設定対象外の分岐と衝突しない"
fi

# eslint に渡す引数が talk root 相対であること。basename だけになると talk root 直下に
# 無いファイルが lint されなくなるので、カナリアの表示経由で形を固定する。
if echo "$CANARY_CTX" | grep -q "eslint argument: pages/a.md"; then
    bt_pass "eslint 引数: talk root 相対パス (pages/a.md) を渡している"
else
    bt_fail "eslint 引数: talk root 相対パス (pages/a.md) を渡している" "talk root 相対パスになっていない ctx='$CANARY_CTX'"
fi

# --- ケース14: merge 経由 ---
# merge は非 JSON の stdout を additionalContext に丸める。skip のとき stdout が空であること。
MERGE_IN="{\"hook_event_name\":\"PostToolUse\",\"tool_input\":{\"file_path\":\"$NON_TALK/foo.md\"}}"
MERGE_OUT=$(printf '%s' "$MERGE_IN" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PLUGIN_DATA="$(mirror_data_for "$PLUGIN_ROOT")" bash "$MERGE" "$HOOK" 2>"$ERRFILE")
MERGE_ERR=$(cat "$ERRFILE")
if [ -n "$MERGE_OUT" ]; then
    bt_fail "merge 経由 (skip 時): stdout が空 / stderr に trace が出る" \
        "stdout が空でない（trace が additionalContext に丸められた疑い）stdout='$MERGE_OUT'"
elif ! echo "$MERGE_ERR" | grep -q "\[eslint-check\] skip:"; then
    bt_fail "merge 経由 (skip 時): stdout が空 / stderr に trace が出る" "stderr に trace が出ていない stderr='$MERGE_ERR'"
else
    bt_pass "merge 経由 (skip 時): stdout が空 / stderr に trace が出る"
fi

# 未実施通知は merge を通っても additionalContext として model に届くこと
MERGE_IN="{\"hook_event_name\":\"PostToolUse\",\"tool_input\":{\"file_path\":\"$TALK/pages/01.md\"}}"
MERGE_OUT=$(printf '%s' "$MERGE_IN" | CLAUDE_PLUGIN_ROOT="$STUB_FATAL" CLAUDE_PLUGIN_DATA="$(mirror_data_for "$STUB_FATAL")" bash "$MERGE" "$HOOK" 2>"$ERRFILE")
MERGE_CTX=$(ctx_of "$MERGE_OUT")
if ! printf '%s\n' "$MERGE_OUT" | jq empty 2>/dev/null; then
    bt_fail "merge 経由 (未実施時): additionalContext + hookEventName 正常" \
        "stdout が妥当な JSON でない stdout='$MERGE_OUT'"
elif ! echo "$MERGE_CTX" | grep -q "warning: eslint not run:"; then
    bt_fail "merge 経由 (未実施時): additionalContext + hookEventName 正常" \
        "additionalContext に未実施通知が無い stdout='$MERGE_OUT'"
elif ! printf '%s\n' "$MERGE_OUT" | jq -e '.hookSpecificOutput.hookEventName == "PostToolUse"' > /dev/null 2>&1; then
    bt_fail "merge 経由 (未実施時): additionalContext + hookEventName 正常" \
        "hookEventName が PostToolUse でない stdout='$MERGE_OUT'"
else
    bt_pass "merge 経由 (未実施時): additionalContext + hookEventName 正常"
fi

# --- ケース15: ピン留め — 実 eslint の 3 つの文言と、クラッシュ時の exit code ---
# 分岐が頼る eslint の文言を、実 eslint で固定する。
if [ "$HAVE_ESLINT" = true ]; then
    OUTSIDE="$TMP/outside-base-path.md"
    echo "x" > "$OUTSIDE"
    PIN_LINT='{"referencesDirectories":[],"panels":{},"markerLayouts":[],"rules":{}}'
    PIN_OUT=$(cd "$ASSETS_DIR" && PECOTV_DECK_LINT="$PIN_LINT" timeout 30 node "$REAL_ESLINT_BIN" \
        --no-fix --config "$ASSETS_DIR/deck-lint.env.config.js" "$OUTSIDE" 2>&1)
    if echo "$PIN_OUT" | grep -q "outside of base path"; then
        bt_pass "ピン留め: 実 eslint が 'outside of base path' 文言を出す"
    else
        bt_fail "ピン留め: 実 eslint が 'outside of base path' 文言を出す" \
            "'outside of base path' が出ない（eslint 側の文言変更の可能性。カナリアの grep を更新すること）out='$PIN_OUT'"
    fi

    # 設定対象外側は talk-dir 内の lint 対象パス外ファイルで再現する
    echo '{}' > "$TALK/readme.json"
    PIN_OUT=$(cd "$TALK" && PECOTV_DECK_LINT="$PIN_LINT" timeout 30 node "$REAL_ESLINT_BIN" \
        --no-fix --config "$ASSETS_DIR/deck-lint.env.config.js" ./readme.json 2>&1)
    if echo "$PIN_OUT" | grep -q "no matching configuration"; then
        bt_pass "ピン留め: 実 eslint が 'no matching configuration' 文言を出す"
    else
        bt_fail "ピン留め: 実 eslint が 'no matching configuration' 文言を出す" \
            "'no matching configuration' が出ない（eslint 側の文言変更の可能性。設定対象外の分岐の grep を更新すること）out='$PIN_OUT'"
    fi

    # eslint 10 のクラッシュはバナー + exit 2。exit 1 に変わると hook の判定の保険側が使われるので固定する。
    PIN_OUT=$(CDPATH= cd -P "$TALK" && timeout 30 \
        node "$REAL_ESLINT_BIN" --no-fix \
        --config "$CRASH_PLUGIN/assets/slidev/deck-lint.env.config.js" pages/01.md 2>&1)
    PIN_EXIT=$?
    if ! echo "$PIN_OUT" | grep -q "Oops! Something went wrong"; then
        bt_fail "ピン留め: 実 eslint のクラッシュはバナー + exit 2（バナーと exit 1 は併発しない）" \
            "実 eslint のクラッシュでバナー文言が出ない（eslint 側の文言変更の可能性。hook の CRASH_BANNER を更新すること）out='$PIN_OUT'"
    elif [ $PIN_EXIT -ne 2 ]; then
        bt_fail "ピン留め: 実 eslint のクラッシュはバナー + exit 2（バナーと exit 1 は併発しない）" \
            "クラッシュ時の exit code が 2 でない (exit=$PIN_EXIT)。exit 1 に変わった場合は、hook のクラッシュ判定が保険から実際に使われる側へ変わる。eslint-check.sh のコメントを見直すこと"
    else
        bt_pass "ピン留め: 実 eslint のクラッシュはバナー + exit 2（バナーと exit 1 は併発しない）"
    fi
else
    bt_skip "ピン留め: 実 eslint が 'outside of base path' 文言を出す" "$NO_ESLINT_REASON"
    bt_skip "ピン留め: 実 eslint が 'no matching configuration' 文言を出す" "$NO_ESLINT_REASON"
    bt_skip "ピン留め: 実 eslint のクラッシュはバナー + exit 2（バナーと exit 1 は併発しない）" "$NO_ESLINT_REASON"
fi

# --- ケース16: slide theme の結果で動く ---
# 16a: 解釈済みの lint が PECOTV_DECK_LINT に JSON のまま渡る。stub の eslint が受けた値を通知に出す。
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
    bt_fail "PECOTV_DECK_LINT: slide theme の lint（参照 dir・rules）が eslint に JSON で渡る" \
        "slide theme の lint が JSON のまま渡っていない env='$ENV_JSON' ctx='$CTX'"
elif ! echo "$CTX" | grep -q "warning: eslint violations:"; then
    bt_fail "PECOTV_DECK_LINT: slide theme の lint（参照 dir・rules）が eslint に JSON で渡る" \
        "違反として報告されていない ctx='$CTX'"
else
    bt_pass "PECOTV_DECK_LINT: slide theme の lint（参照 dir・rules）が eslint に JSON で渡る"
fi

# 16b: テーマを引けない talk-dir は lint せず、未実施として原因別に案内する。
STUB_NOCALL=$(make_stub_plugin stub-nocall 1 "SHOULD-NOT-RUN")
STUB_THEME_FAIL=theme-unlinked run_hook "theme-unlinked" "$TALK/pages/01.md" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if ! echo "$CTX" | grep -q "warning: eslint not run:"; then
    bt_fail "theme-unlinked: 未実施 + slide_sync（node_modules_only: true）の案内（eslint は起動しない）" \
        "未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
elif ! echo "$CTX" | grep -q "Relinking node_modules with slide_sync (node_modules_only: true)"; then
    bt_fail "theme-unlinked: 未実施 + slide_sync（node_modules_only: true）の案内（eslint は起動しない）" \
        "slide_sync の node_modules_only の案内が無い ctx='$CTX'"
elif echo "$CTX" | grep -q "SHOULD-NOT-RUN\|warning: eslint violations:"; then
    bt_fail "theme-unlinked: 未実施 + slide_sync（node_modules_only: true）の案内（eslint は起動しない）" \
        "eslint を起動した/違反として報告している ctx='$CTX'"
elif echo "$CTX" | grep -q "テンプレートを同期"; then
    bt_fail "theme-unlinked: 未実施 + slide_sync（node_modules_only: true）の案内（eslint は起動しない）" \
        "旧文言（テンプレートを同期）が残っている ctx='$CTX'"
elif ! echo "$ERR" | grep -q "\[eslint-check\] not-linted: theme is not linked"; then
    bt_fail "theme-unlinked: 未実施 + slide_sync（node_modules_only: true）の案内（eslint は起動しない）" \
        "stderr trace が not-linted でない stderr='$ERR'"
else
    bt_pass "theme-unlinked: 未実施 + slide_sync（node_modules_only: true）の案内（eslint は起動しない）"
fi

STUB_THEME_FAIL=theme-none run_hook "theme-none" "$TALK/pages/01.md" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "warning: eslint not run:" && echo "$CTX" | grep -q "theme-none" \
    && echo "$CTX" | grep -q "slide sync --theme <theme-spec>" && ! echo "$CTX" | grep -q "SHOULD-NOT-RUN"; then
    bt_pass "theme-none: 未実施 + slide sync --theme の案内"
else
    bt_fail "theme-none: 未実施 + slide sync --theme の案内" "案内が通知に無い stdout='$OUT' stderr='$ERR'"
fi

STUB_THEME_FAIL=theme-unknown-rule run_hook "theme-unknown-rule" "$TALK/pages/01.md" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "warning: eslint not run:" && echo "$CTX" | grep -q "theme-unknown-rule"; then
    bt_pass "theme-unknown-rule: 未実施 + reason を通知"
else
    bt_fail "theme-unknown-rule: 未実施 + reason を通知" "reason が通知に無い stdout='$OUT' stderr='$ERR'"
fi

STUB_THEME_FAIL=crash run_hook "theme-crash" "$TALK/pages/01.md" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "warning: eslint not run:" && echo "$CTX" | grep -q "slide theme exited with 3" && ! echo "$CTX" | grep -q "SHOULD-NOT-RUN"; then
    bt_pass "slide theme の異常終了: 未実施（原因の exit code を通知）"
else
    bt_fail "slide theme の異常終了: 未実施（原因の exit code を通知）" "未実施通知が出ていない stdout='$OUT' stderr='$ERR'"
fi

# 16c: CLI（cli/dist/cli.js）が無い実行用ミラーは、ミラーの準備が済んでいないものとして未実施にする。
# bin/_lib.sh の plugin_runtime_dir_for_hooks が、cli/dist/cli.js を持たないミラーを採らないため。
NO_CLI_ROOT="$PLUGIN_ROOT"
NO_CLI_DATA="$(mirror_data_for "$NO_CLI_ROOT")"
rm -f "$NO_CLI_DATA/runtime/mirror/cli/dist/cli.js"
OUT=$(printf '%s' "{\"tool_input\":{\"file_path\":\"$TALK/pages/01.md\"}}" | CLAUDE_PLUGIN_ROOT="$NO_CLI_ROOT" CLAUDE_PLUGIN_DATA="$NO_CLI_DATA" bash "$HOOK" 2>"$ERRFILE")
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "warning: eslint not run:" && echo "$CTX" | grep -q "the runtime mirror has not been created yet"; then
    bt_pass "CLI 不在のミラー: ミラー未準備として未実施"
else
    bt_fail "CLI 不在のミラー: ミラー未準備として未実施" "未実施の通知が無い stdout='$OUT'"
fi

# 16e: 対象外の編集（README.md）は、slide theme を起こさず、通知しない。
# テーマ未リンクの talk-dir でも、対象外の編集まで未実施の通知にしない。
THEME_LOG="$TMP/theme-spawn.log"
rm -f "$THEME_LOG"
echo "# readme" > "$TALK/README.md"
STUB_THEME_LOG="$THEME_LOG" STUB_THEME_FAIL=theme-unlinked run_hook "non-target-no-theme" "$TALK/README.md" "$STUB_NOCALL"
if [ -z "$OUT" ] && [ ! -e "$THEME_LOG" ] && echo "$ERR" | grep -q "\[eslint-check\] skip: not a lint target path"; then
    bt_pass "対象外の編集: slide theme を起こさず、通知しない（テーマ未リンクでも）"
else
    THEME_LOG_TEXT=$(cat "$THEME_LOG" 2>/dev/null)
    bt_fail "対象外の編集: slide theme を起こさず、通知しない（テーマ未リンクでも）" \
        "slide theme を起こした/通知した stdout='$OUT' stderr='$ERR' log='${THEME_LOG_TEXT:-}'"
fi
# 対象の編集では起こす（上の確認が、常に起こさないだけの退行を見逃さないための対照）。
rm -f "$THEME_LOG"
STUB_THEME_LOG="$THEME_LOG" run_hook "target-spawns-theme" "$TALK/pages/01.md" "$STUB_ENV"
if [ -s "$THEME_LOG" ]; then
    bt_pass "対象の編集: slide theme を起こす"
else
    bt_fail "対象の編集: slide theme を起こす" "slide theme を起こしていない stdout='$OUT' stderr='$ERR'"
fi

# 16f: slide theme が JSON を出せずに終了したとき、stderr の先頭 1 行を通知と trace に添える。
STUB_THEME_FAIL=crash STUB_THEME_STDERR="Node.js 24.22.1 以上が要ります" run_hook "theme-crash-stderr" "$TALK/pages/01.md" "$STUB_NOCALL"
CTX=$(ctx_of "$OUT")
if echo "$CTX" | grep -q "stderr: Node.js 24.22.1 以上が要ります" && echo "$ERR" | grep -q "stderr: Node.js 24.22.1 以上が要ります"; then
    bt_pass "slide theme の stderr: 先頭 1 行を通知と trace に添える"
else
    bt_fail "slide theme の stderr: 先頭 1 行を通知と trace に添える" "通知か trace に無い ctx='$CTX' stderr='$ERR'"
fi

# 16d: マーカーは slides.md + pages/。start.mjs だけの dir は talk-dir とみなさない。
OLD_MARKER="$TMP/old-marker"
mkdir -p "$OLD_MARKER/pages"
touch "$OLD_MARKER/start.mjs"
echo "# foo" > "$OLD_MARKER/pages/a.md"
run_hook "old-marker" "$OLD_MARKER/pages/a.md" "$PLUGIN_ROOT"
if [ -z "$OUT" ] && echo "$ERR" | grep -q "\[eslint-check\] skip: talk-dir marker (slides.md + pages/)"; then
    bt_pass "start.mjs だけの dir: talk-dir とみなさず skip"
else
    bt_fail "start.mjs だけの dir: talk-dir とみなさず skip" "skip していない stdout='$OUT' stderr='$ERR'"
fi

# --- ケース17: 実 CLI（cli/dist）を通す ---
# ここだけ build 済みの cli/dist で slide theme を起こす。cli/dist が無いか古いときは skip する。
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
        bt_pass "実 CLI: テーマの宣言（fixture）の規則で違反を検出"
    else
        bt_fail "実 CLI: テーマの宣言（fixture）の規則で違反を検出" "宣言の規則で違反が出ない stdout='$OUT' stderr='$ERR'"
    fi

    # テーマを張っていない talk-dir は、実 CLI の theme-unlinked が未実施通知になる。
    rm "$REAL_CLI_TALK/node_modules/slidev-theme-pecotv-test-declared"
    MIRROR_REAL_CLI_DIST="$REAL_CLI_DIST" run_hook "real-cli-unlinked" "$REAL_CLI_TALK/pages/long.md" "$PLUGIN_ROOT"
    CTX=$(ctx_of "$OUT")
    if echo "$CTX" | grep -q "theme-unlinked" && echo "$CTX" | grep -q "warning: eslint not run:"; then
        bt_pass "実 CLI: 未リンクの talk-dir は theme-unlinked の未実施通知"
    else
        bt_fail "実 CLI: 未リンクの talk-dir は theme-unlinked の未実施通知" \
            "theme-unlinked の未実施通知が出ない stdout='$OUT' stderr='$ERR'"
    fi
else
    REAL_CLI_REASON="cli/dist に slide theme が無い（build 前か古い build）か、eslint を解決できない"
    bt_skip "実 CLI: テーマの宣言（fixture）の規則で違反を検出" "$REAL_CLI_REASON"
    bt_skip "実 CLI: 未リンクの talk-dir は theme-unlinked の未実施通知" "$REAL_CLI_REASON"
fi

# --- 違反が多いとき: バイトの上限で切り、残りの件数を最後の行に書く ---
MANY_OUT=$(printf '/x/01.md\n'; for i in $(seq 1 120); do printf '  %d:1  error  violation number %d of the page  slidev/rule\n' "$i" "$i"; done)
STUB_MANY=$(make_stub_plugin stub-many 1 "$MANY_OUT")
run_hook "many-violations" "$TALK/pages/01.md" "$STUB_MANY"
CTX=$(ctx_of "$OUT")
SHOWN=$(printf '%s\n' "$CTX" | grep -cE '^ +[0-9]+:[0-9]+ ')
REST=$(printf '%s\n' "$CTX" | tail -n 1 | sed -nE 's/^ *Truncated at 3500 bytes: ([0-9]+) more violations not shown\.$/\1/p')
if [ "$(printf '%s' "$CTX" | wc -c)" -le 4000 ] && [ -n "$REST" ] && [ $((SHOWN + REST)) -eq 120 ]; then
    bt_pass "違反 120 件: 上限に収まり、最後の行の N が残りの件数と合う"
else
    LAST=$(printf '%s\n' "$CTX" | tail -n 1)
    bt_fail "違反 120 件: 上限に収まり、最後の行の N が残りの件数と合う" "shown=$SHOWN rest='$REST' last='$LAST'"
fi

# --- ガードレール: 全ケースで stdout が「空または妥当な JSON」 ---
if [ -z "$BAD_STDOUT" ]; then
    bt_pass "ガードレール: 全ケースの stdout が空または妥当な JSON"
else
    bt_fail "ガードレール: 全ケースの stdout が空または妥当な JSON" "stdout が非 JSON のケースがある: $BAD_STDOUT"
fi

bt_finish
