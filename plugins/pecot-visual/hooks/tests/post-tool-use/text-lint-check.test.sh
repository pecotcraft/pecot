#!/bin/bash
# text-lint-check.sh の単体テスト
#
# 検証の軸は 2 つ。
#
# 1. 分岐の分類。「確認していない」ことと「違反があった」ことを混同しない。
#    対象外 (skip)、未実施 (not-checked)、pass、違反 (violation) を、それぞれ固定する。
#    違反とするのは、exit 1 で出力があるときだけ。
#    それ以外の非 0 と、exit 1 で出力が空のときは、未実施として扱う。
# 2. 出力チャネル。model 向けの通知は stdout の JSON、開発者向けの trace は stderr に出す。
#    stdout は全ての分岐で、空または妥当な JSON にする。
#
# bin は実物（libs/text-rules/dist/bin/pecot-text-lint.js）を使う。
# 偽のミラーの node_modules/.bin/pecot-text-lint から、その実物へリンクする。
# exit code の分類だけは、同じ位置に置いたスタブで再現する（timeout を実際の sleep で作らない）。
# 違反文は、text-rules のテストと同じ辞書から組み立てる。辞書は ai-words-ja の最初の名詞。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/../../lib/post-tool-use/text-lint-check.sh"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT/../.." && pwd)"
REAL_BIN="$REPO_ROOT/libs/text-rules/dist/bin/pecot-text-lint.js"
# shellcheck source=mirror-helper.sh
. "$SCRIPT_DIR/mirror-helper.sh"

# build 済みの bin が無いと全ケースが空振りする。skip にはせず FAIL にする。
[ -f "$REAL_BIN" ] || { echo "FAIL: bin が無い（先に text-rules を build すること）: $REAL_BIN"; exit 1; }

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

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
TMP=$(CDPATH= cd -P "$TMP" && pwd -P)

ERRFILE="$TMP/hook-stderr.txt"
BAD_STDOUT=""

# 辞書の語から違反文を組み立てる（文字列として直書きしない）。
WORD=$(node -e "import('$REPO_ROOT/libs/text-rules/tests/helpers/dictionary.ts').then(m => process.stdout.write(m.pickWord()))")
[ -n "$WORD" ] || { echo "FAIL: 辞書から語を取れない"; exit 1; }
VIOLATION_LINE="${WORD}を使う。"
CLEAN_LINE="今日は晴れです。"

# $1 = パス, $2 = 3 行目に置く行
write_md() {
    printf '# 見出し\n\n%s\n' "$2" > "$1"
}

# bin の位置に置くスタブ。$1 = 名前, $2 = exit code, $3 = stdout, $4 = stderr
make_stub_bin() {
    local path="$TMP/$1.js"
    {
        printf 'const out = %s\n' "$(node -p 'JSON.stringify(process.argv[1])' "$3")"
        printf 'const err = %s\n' "$(node -p 'JSON.stringify(process.argv[1])' "$4")"
        printf '%s\n' 'if (out) process.stdout.write(out + "\n")'
        printf '%s\n' 'if (err) process.stderr.write(err + "\n")'
        echo "process.exit($2)"
    } > "$path"
    printf '%s' "$path"
}

# hook を 1 回起動し、stdout を $OUT / stderr を $ERR / 終了コードを $EXIT に入れる。
# MIRROR_TEXT_LINT_BIN は呼び出し側が環境変数で渡す。
# $1 = ラベル, $2 = 標準入力に渡す JSON
run_hook_json() {
    local label="$1" json="$2"
    OUT=$(printf '%s' "$json" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PLUGIN_DATA="$(mirror_data_for "$PLUGIN_ROOT")" bash "$HOOK" 2>"$ERRFILE")
    EXIT=$?
    ERR=$(cat "$ERRFILE")
    if [ -n "$OUT" ] && ! printf '%s\n' "$OUT" | jq empty 2>/dev/null; then
        BAD_STDOUT="${BAD_STDOUT}[$label] "
    fi
}

# $1 = ラベル, $2 = file_path
run_hook() {
    run_hook_json "$1" "{\"tool_input\":{\"file_path\":\"$2\"}}"
}

ctx_of() {
    printf '%s\n' "$1" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null
}

# 空出力の skip 系ケースの判定。$1 = 名前, $2 = stderr に含めるべき文字列
expect_silent() {
    if [ $EXIT -eq 0 ] && [ -z "$OUT" ] && printf '%s\n' "$ERR" | grep -qF "$2"; then
        pass "$1: exit 0 / stdout 空 / stderr に $2"
    else
        fail "$1: exit=$EXIT stdout='$OUT' stderr='$ERR'"
    fi
}

# 未実施通知の判定。$1 = 名前, $2 = 期待する理由の行（固定文字列）, $3 = file_path
expect_not_checked() {
    local ctx
    ctx=$(ctx_of "$OUT")
    local want
    want=$(printf 'warning: text lint not run: %s\n%s\nThe writing rules were not applied to this file, so no violations were detected.' "$3" "$2" | sed '2,$s/^/  /')
    if [ $EXIT -ne 0 ]; then
        fail "$1: exit=$EXIT"
    elif [ "$ctx" != "$want" ]; then
        fail "$1: 通知が期待と違う
want: $want
got:  $ctx"
    elif ! printf '%s\n' "$ERR" | grep -q "\[text-lint-check\] not-checked"; then
        fail "$1: stderr に not-checked trace が無い stderr='$ERR'"
    else
        pass "$1: 未実施通知（理由の行まで一致）"
    fi
}

MD="$TMP/note.md"
write_md "$MD" "$VIOLATION_LINE"
CLEAN_MD="$TMP/clean.md"
write_md "$CLEAN_MD" "$CLEAN_LINE"

# --- ケース1: .md の違反 → marker / 行 / 規則名 / 結びの一文 ---
MIRROR_TEXT_LINT_BIN="$REAL_BIN" run_hook "md-violation" "$MD"
CTX=$(ctx_of "$OUT")
FIRST=$(printf '%s\n' "$CTX" | head -n 1)
LAST=$(printf '%s\n' "$CTX" | tail -n 1)
if [ "$FIRST" != "warning: text lint violations: $MD" ]; then
    fail ".md の違反: 先頭行が違う first='$FIRST' stdout='$OUT'"
elif ! printf '%s\n' "$CTX" | grep -q "^  $MD:3:1 no-ai-words "; then
    fail ".md の違反: bin の出力の行（3 行目・規則名）が無い ctx='$CTX'"
elif [ "$LAST" != "  The text above does not satisfy the writing rules. The rules stay enabled." ]; then
    fail ".md の違反: 結びの一文が違う last='$LAST'"
elif ! printf '%s\n' "$ERR" | grep -q "\[text-lint-check\] violation"; then
    fail ".md の違反: stderr に violation trace が無い stderr='$ERR'"
elif ! printf '%s\n' "$ERR" | grep -q "node_modules/.bin/pecot-text-lint"; then
    fail ".md の違反: stderr に使った bin のパスが無い stderr='$ERR'"
else
    pass ".md の違反: marker / 3 行目の no-ai-words / 結びの一文 / trace"
fi

# --- ケース2: 違反の無い .md → 無出力 / pass trace ---
MIRROR_TEXT_LINT_BIN="$REAL_BIN" run_hook "md-clean" "$CLEAN_MD"
expect_silent "違反の無い .md" "[text-lint-check] pass"

# --- ケース3: talk-dir の外の pages/x.md の違反（talk-dir のマーカーが無いので対象） ---
mkdir -p "$TMP/outside/pages"
write_md "$TMP/outside/pages/x.md" "$VIOLATION_LINE"
MIRROR_TEXT_LINT_BIN="$REAL_BIN" run_hook "outside-pages" "$TMP/outside/pages/x.md"
if printf '%s\n' "$(ctx_of "$OUT")" | head -n 1 | grep -q "^warning: text lint violations: $TMP/outside/pages/x.md\$"; then
    pass "talk-dir の外の pages/x.md の違反: 検出する"
else
    fail "talk-dir の外の pages/x.md の違反: stdout='$OUT' stderr='$ERR'"
fi

# --- ケース4: talk-dir の README.md の違反（lint 対象パスでないので対象） ---
DECK="$TMP/deck"
mkdir -p "$DECK/pages"
touch "$DECK/slides.md"
write_md "$DECK/README.md" "$VIOLATION_LINE"
MIRROR_TEXT_LINT_BIN="$REAL_BIN" run_hook "deck-readme" "$DECK/README.md"
if printf '%s\n' "$(ctx_of "$OUT")" | head -n 1 | grep -q "^warning: text lint violations: $DECK/README.md\$"; then
    pass "talk-dir の README.md の違反: 検出する"
else
    fail "talk-dir の README.md の違反: stdout='$OUT' stderr='$ERR'"
fi

# --- ケース5: talk-dir の pages/*.md と slides.md → 無出力（eslint-check の担当） ---
write_md "$DECK/pages/zz.md" "$VIOLATION_LINE"
write_md "$DECK/slides.md" "$VIOLATION_LINE"
MIRROR_TEXT_LINT_BIN="$REAL_BIN" run_hook "deck-pages" "$DECK/pages/zz.md"
expect_silent "talk-dir の pages/*.md" "[text-lint-check] skip"
MIRROR_TEXT_LINT_BIN="$REAL_BIN" run_hook "deck-slides" "$DECK/slides.md"
expect_silent "talk-dir の slides.md" "[text-lint-check] skip"

# --- ケース6: 対象外の拡張子 → 無出力（bin が拡張子を見て exit 0） ---
printf '%s\n' "$VIOLATION_LINE" > "$TMP/probe.txt"
MIRROR_TEXT_LINT_BIN="$REAL_BIN" run_hook "txt" "$TMP/probe.txt"
expect_silent "対象外の拡張子 .txt" "[text-lint-check] pass"

# --- ケース6b: .ts と .vue の文字列の違反（コメントだけでなく、文字列も bin が見る） ---
TS_FILE="$TMP/sample.ts"
printf "export const text = '%s'\n" "$VIOLATION_LINE" > "$TS_FILE"
VUE_FILE="$TMP/Sample.vue"
printf '<template>\n  <p>%s</p>\n</template>\n' "$VIOLATION_LINE" > "$VUE_FILE"
SETUP_FILE="$TMP/ScriptSetup.vue"
printf '<script setup lang="ts">\nconst text = '"'"'%s'"'"'\n</script>\n' "$VIOLATION_LINE" > "$SETUP_FILE"
for CASE in "$TS_FILE:1:22" "$VUE_FILE:2:6" "$SETUP_FILE:2:15"; do
    CASE_FILE="${CASE%%:*}"
    POSITION="${CASE#"$CASE_FILE":}"
    MIRROR_TEXT_LINT_BIN="$REAL_BIN" run_hook "string-violation" "$CASE_FILE"
    CTX=$(ctx_of "$OUT")
    if [ "$(printf '%s\n' "$CTX" | head -n 1)" != "warning: text lint violations: $CASE_FILE" ]; then
        fail "${CASE_FILE##*/} の文字列の違反: 先頭行が違う stdout='$OUT'"
    elif ! printf '%s\n' "$CTX" | grep -q "^  $CASE no-ai-words "; then
        fail "${CASE_FILE##*/} の文字列の違反: 位置と規則名の行が無い ctx='$CTX'"
    else
        pass "${CASE_FILE##*/} の文字列の違反: ${POSITION} の no-ai-words を返す"
    fi
done

# --- ケース7: file_path が無い → 無出力 ---
MIRROR_TEXT_LINT_BIN="$REAL_BIN" run_hook_json "no-file-path" '{}'
expect_silent "file_path 無し" "[text-lint-check] skip"

# --- ケース8: ミラーが無い → 未実施 ---
MIRROR_ABSENT=1 run_hook "mirror-absent" "$MD"
expect_not_checked "ミラー不在" "The runtime mirror is not ready yet. Run the pecotv command once to set it up." "$MD"

# --- ケース9: ミラーはあるが bin が無い → 未実施 ---
run_hook "bin-absent" "$MD"
expect_not_checked "bin 不在" "pecot-text-lint is missing from the runtime mirror. Run the pecotv command once to set it up." "$MD"

# --- ケース10: スタブの bin の exit code 分類 ---
STUB=$(make_stub_bin "exit2" 2 "" "boom: 設定を読めない")
MIRROR_TEXT_LINT_BIN="$STUB" run_hook "exit2" "$MD"
expect_not_checked "bin が exit 2" "pecot-text-lint failed (exit 2):
boom: 設定を読めない" "$MD"

STUB=$(make_stub_bin "exit124" 124 "" "")
MIRROR_TEXT_LINT_BIN="$STUB" run_hook "exit124" "$MD"
expect_not_checked "bin が exit 124" "pecot-text-lint timed out (over 20 seconds)." "$MD"

STUB=$(make_stub_bin "exit1empty" 1 "" "")
MIRROR_TEXT_LINT_BIN="$STUB" run_hook "exit1empty" "$MD"
expect_not_checked "bin が exit 1 で出力が空" "pecot-text-lint failed (exit 1):" "$MD"

# --- 違反が多いとき: バイトの上限で切り、残りの件数を最後の行に書く ---
MANY_MD="$TMP/many.md"
{ printf '# 見出し\n\n'; for _ in $(seq 1 120); do printf '%s\n\n' "$VIOLATION_LINE"; done; } > "$MANY_MD"
MIRROR_TEXT_LINT_BIN="$REAL_BIN" run_hook "many-violations" "$MANY_MD"
CTX=$(ctx_of "$OUT")
SHOWN=$(printf '%s\n' "$CTX" | grep -c "^  $MANY_MD:")
REST=$(printf '%s\n' "$CTX" | tail -n 1 | sed -nE 's/^ *Truncated at 3000 bytes: ([0-9]+) more violations not shown\.$/\1/p')
if [ "$(printf '%s' "$CTX" | wc -c)" -le 3600 ] && [ -n "$REST" ] && [ $((SHOWN + REST)) -eq 120 ]; then
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
