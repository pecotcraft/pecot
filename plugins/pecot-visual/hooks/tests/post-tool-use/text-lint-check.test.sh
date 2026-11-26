#!/bin/bash
# text-lint-check.sh の単体テスト。対象外・未実施・pass・違反の分岐と、stdout の JSON・stderr の trace を確かめる。
# bin は実物（libs/text-rules/dist）をミラーへリンクし、exit code の分類だけ同じ位置のスタブで再現する。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/../../lib/post-tool-use/text-lint-check.sh"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT/../.." && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
REAL_BIN="$REPO_ROOT/libs/text-rules/dist/bin/pecot-text-lint.js"
# shellcheck source=mirror-helper.sh
. "$SCRIPT_DIR/mirror-helper.sh"

# build 済みの bin が無いと全ケースが空振りする。skip にはせず止める（runner が broken にする）。
[ -f "$REAL_BIN" ] || { echo "FAIL: bin が無い（先に text-rules を build すること）: $REAL_BIN"; exit 1; }

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
        bt_pass "$1: exit 0 / stdout 空 / stderr に $2"
    else
        bt_fail "$1: exit 0 / stdout 空 / stderr に $2" "exit=$EXIT stdout='$OUT' stderr='$ERR'"
    fi
}

# 未実施通知の判定。$1 = 名前, $2 = 期待する理由の行（固定文字列）, $3 = file_path
expect_not_checked() {
    local ctx
    ctx=$(ctx_of "$OUT")
    local want
    want=$(printf 'warning: text lint not run: %s\n%s\nThe writing rules were not applied to this file, so no violations were detected.' "$3" "$2" | sed '2,$s/^/  /')
    if [ $EXIT -ne 0 ]; then
        bt_fail "$1: 未実施通知（理由の行まで一致）" "exit=$EXIT"
    elif [ "$ctx" != "$want" ]; then
        bt_fail "$1: 未実施通知（理由の行まで一致）" "通知が期待と違う
want: $want
got:  $ctx"
    elif ! printf '%s\n' "$ERR" | grep -q "\[text-lint-check\] not-checked"; then
        bt_fail "$1: 未実施通知（理由の行まで一致）" "stderr に not-checked trace が無い stderr='$ERR'"
    else
        bt_pass "$1: 未実施通知（理由の行まで一致）"
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
    bt_fail ".md の違反: marker / 3 行目の no-ai-words / 結びの一文 / trace" "先頭行が違う first='$FIRST' stdout='$OUT'"
elif ! printf '%s\n' "$CTX" | grep -q "^  $MD:3:1 no-ai-words "; then
    bt_fail ".md の違反: marker / 3 行目の no-ai-words / 結びの一文 / trace" "bin の出力の行（3 行目・規則名）が無い ctx='$CTX'"
elif [ "$LAST" != "  The text above does not satisfy the writing rules. The rules stay enabled." ]; then
    bt_fail ".md の違反: marker / 3 行目の no-ai-words / 結びの一文 / trace" "結びの一文が違う last='$LAST'"
elif ! printf '%s\n' "$ERR" | grep -q "\[text-lint-check\] violation"; then
    bt_fail ".md の違反: marker / 3 行目の no-ai-words / 結びの一文 / trace" \
        "stderr に violation trace が無い stderr='$ERR'"
elif ! printf '%s\n' "$ERR" | grep -q "node_modules/.bin/pecot-text-lint"; then
    bt_fail ".md の違反: marker / 3 行目の no-ai-words / 結びの一文 / trace" "stderr に使った bin のパスが無い stderr='$ERR'"
else
    bt_pass ".md の違反: marker / 3 行目の no-ai-words / 結びの一文 / trace"
fi

# --- ケース2: 違反の無い .md → 無出力 / pass trace ---
MIRROR_TEXT_LINT_BIN="$REAL_BIN" run_hook "md-clean" "$CLEAN_MD"
expect_silent "違反の無い .md" "[text-lint-check] pass"

# --- ケース3: talk-dir の外の pages/x.md の違反（talk-dir のマーカーが無いので対象） ---
mkdir -p "$TMP/outside/pages"
write_md "$TMP/outside/pages/x.md" "$VIOLATION_LINE"
MIRROR_TEXT_LINT_BIN="$REAL_BIN" run_hook "outside-pages" "$TMP/outside/pages/x.md"
if printf '%s\n' "$(ctx_of "$OUT")" | head -n 1 | grep -q "^warning: text lint violations: $TMP/outside/pages/x.md\$"; then
    bt_pass "talk-dir の外の pages/x.md の違反: 検出する"
else
    bt_fail "talk-dir の外の pages/x.md の違反: 検出する" "stdout='$OUT' stderr='$ERR'"
fi

# --- ケース4: talk-dir の README.md の違反（lint 対象パスでないので対象） ---
DECK="$TMP/deck"
mkdir -p "$DECK/pages"
touch "$DECK/slides.md"
write_md "$DECK/README.md" "$VIOLATION_LINE"
MIRROR_TEXT_LINT_BIN="$REAL_BIN" run_hook "deck-readme" "$DECK/README.md"
if printf '%s\n' "$(ctx_of "$OUT")" | head -n 1 | grep -q "^warning: text lint violations: $DECK/README.md\$"; then
    bt_pass "talk-dir の README.md の違反: 検出する"
else
    bt_fail "talk-dir の README.md の違反: 検出する" "stdout='$OUT' stderr='$ERR'"
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
        bt_fail "${CASE_FILE##*/} の文字列の違反: ${POSITION} の no-ai-words を返す" "先頭行が違う stdout='$OUT'"
    elif ! printf '%s\n' "$CTX" | grep -q "^  $CASE no-ai-words "; then
        bt_fail "${CASE_FILE##*/} の文字列の違反: ${POSITION} の no-ai-words を返す" "位置と規則名の行が無い ctx='$CTX'"
    else
        bt_pass "${CASE_FILE##*/} の文字列の違反: ${POSITION} の no-ai-words を返す"
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

# --- ケース11: リポのルートの .textlintignore で外したファイル → 無出力（入力の cwd がサブディレクトリでも） ---
REPO="$TMP/repo"
mkdir -p "$REPO/specs/001" "$REPO/docs"
git -C "$REPO" init -q
printf 'specs/**\n' > "$REPO/.textlintignore"
write_md "$REPO/specs/001/spec.md" "$VIOLATION_LINE"
write_md "$REPO/docs/note.md" "$VIOLATION_LINE"
for CWD in "$REPO" "$REPO/docs" ""; do
    MIRROR_TEXT_LINT_BIN="$REAL_BIN" run_hook_json "ignored" "{\"cwd\":\"$CWD\",\"tool_input\":{\"file_path\":\"$REPO/specs/001/spec.md\"}}"
    LABEL="cwd=${CWD#"$TMP"/}"
    expect_silent ".textlintignore で外したファイル $LABEL" "[text-lint-check] pass"
done
# git の外では、入力の cwd の .textlintignore を読む
PLAIN="$TMP/plain"
mkdir -p "$PLAIN/specs"
printf 'specs/**\n' > "$PLAIN/.textlintignore"
write_md "$PLAIN/specs/spec.md" "$VIOLATION_LINE"
MIRROR_TEXT_LINT_BIN="$REAL_BIN" run_hook_json "ignored-outside-git" "{\"cwd\":\"$PLAIN\",\"tool_input\":{\"file_path\":\"$PLAIN/specs/spec.md\"}}"
expect_silent "git の外で、入力の cwd の .textlintignore で外したファイル" "[text-lint-check] pass"
MIRROR_TEXT_LINT_BIN="$REAL_BIN" run_hook_json "not-ignored" "{\"cwd\":\"$REPO/docs\",\"tool_input\":{\"file_path\":\"$REPO/docs/note.md\"}}"
if [ "$(ctx_of "$OUT" | head -n 1)" = "warning: text lint violations: $REPO/docs/note.md" ]; then
    bt_pass ".textlintignore に当たらないファイル: 違反を返す"
else
    bt_fail ".textlintignore に当たらないファイル: 違反を返す" "stdout='$OUT' stderr='$ERR'"
fi

# --- 違反が多いとき: バイトの上限で切り、残りの件数を最後の行に書く ---
MANY_MD="$TMP/many.md"
{ printf '# 見出し\n\n'; for _ in $(seq 1 120); do printf '%s\n\n' "$VIOLATION_LINE"; done; } > "$MANY_MD"
MIRROR_TEXT_LINT_BIN="$REAL_BIN" run_hook "many-violations" "$MANY_MD"
CTX=$(ctx_of "$OUT")
SHOWN=$(printf '%s\n' "$CTX" | grep -c "^  $MANY_MD:")
REST=$(printf '%s\n' "$CTX" | tail -n 1 | sed -nE 's/^ *Truncated at 3000 bytes: ([0-9]+) more violations not shown\.$/\1/p')
if [ "$(printf '%s' "$CTX" | wc -c)" -le 3600 ] && [ -n "$REST" ] && [ $((SHOWN + REST)) -eq 120 ]; then
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
