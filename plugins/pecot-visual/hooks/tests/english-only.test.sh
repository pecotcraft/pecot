#!/bin/bash
# hooks が返す固定の文言が英語であることを確かめる（spec 021 FR-014 / SC-007）。
# コメント行は除く。ただし .sh の heredoc と複数行の引用符の中は出力の本文になりうるので調べる。

set -u
export LC_ALL=C.UTF-8

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
# shellcheck source=../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

JA_RE='[\x{3000}-\x{30FF}\x{3400}-\x{9FFF}\x{F900}-\x{FAFF}\x{FF00}-\x{FFEF}]'

# 例外: エージェントへのメッセージではなく、利用者の .gitignore へ書き出す内容（heredoc の中のコメント行）。
# 書き換えると、書き出した .gitignore との差が出る。ファイルと行の内容で名指しする。
EXC_FILE='hooks/lib/core/pecotv-gitignore-ensure.sh'
EXC_TEXT='# pecotv の生成物を管理外にする許可の一覧。追跡する設定は無い。'

# .sh の非コメント行を `path:line:text` で出す。
# 状態: 通常 / 単一引用符 / 二重引用符 / heredoc。
# 引用符の状態は行をまたいで持ち、その中の行はコメントとみなさない。
SH_AWK='
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
FNR == 1 { sq = 0; dq = 0; ansi = 0; hd = "" }
{
    line = $0
    if (hd != "") {
        print FILENAME ":" FNR ":" line
        if (trim(line) == hd) { hd = "" }
        next
    }
    if (!sq && !dq && trim(line) ~ /^#/) { next }
    print FILENAME ":" FNR ":" line
    n = length(line)
    i = 1
    while (i <= n) {
        c = substr(line, i, 1)
        if (sq) {
            if (ansi && c == "\\") { i += 2; continue }
            if (c == "\047") { sq = 0; ansi = 0 }
        } else if (dq) {
            if (c == "\\") { i += 2; continue }
            if (c == "\"") { dq = 0 }
        } else {
            if (c == "\\") { i += 2; continue }
            if (c == "\047") { sq = 1; ansi = (i > 1 && substr(line, i - 1, 1) == "$") }
            else if (c == "\"") { dq = 1 }
            else if (c == "#" && (i == 1 || substr(line, i - 1, 1) ~ /[ \t]/)) { break }
            else if (c == "<" && substr(line, i, 2) == "<<" && substr(line, i, 3) != "<<<") {
                rest = substr(line, i + 2)
                if (match(rest, /^-?[ \t]*["\047]?[A-Za-z_][A-Za-z0-9_]*/)) {
                    w = substr(rest, RSTART, RLENGTH)
                    sub(/^-?[ \t]*["\047]?/, "", w)
                    hd = w
                    i += 2 + RLENGTH
                    c2 = substr(line, i, 1)
                    if (c2 == "\"" || c2 == "\047") { i++ }
                    continue
                }
            }
        }
        i++
    }
}
'

# .mjs の非コメント行
MJS_AWK='
function trim(s) { sub(/^[ \t]+/, "", s); return s }
{ t = trim($0); if (t ~ /^(\/\/|\/\*|\*)/) { next } print FILENAME ":" FNR ":" $0 }
'

cd "$PLUGIN_ROOT" || exit 2

# 範囲のファイル（相対パス）。hooks/tests/ は外す。
FILES_SH="$TMP/files.sh.txt"
FILES_MJS="$TMP/files.mjs.txt"
FILES_JSON="$TMP/files.json.txt"
find hooks -path hooks/tests -prune -o -type f -name '*.sh' -print | LC_ALL=C sort >"$FILES_SH"
find hooks -path hooks/tests -prune -o -type f -name '*.mjs' -print | LC_ALL=C sort >"$FILES_MJS"
printf '%s\n' hooks/hooks.json com.github.copilot/hooks/hooks.json >"$FILES_JSON"

for f in "$FILES_SH" "$FILES_JSON"; do
    if [ -s "$f" ]; then
        bt_pass "調べるファイルの一覧が空でない: ${f##*/}"
    else
        bt_fail "調べるファイルの一覧が空でない: ${f##*/}" "一覧が空"
    fi
done
for f in hooks/hooks.json com.github.copilot/hooks/hooks.json; do
    if [ -f "$f" ]; then
        bt_pass "範囲のファイルがある: $f"
    else
        bt_fail "範囲のファイルがある: $f" "ファイルが無い"
    fi
done

CANDIDATES="$TMP/candidates.txt"
: >"$CANDIDATES"
# 候補を作れなかったときは、日本語の有無を判定できないので落とす。
ERRS=""

if [ -s "$FILES_SH" ]; then
    # shellcheck disable=SC2046
    awk "$SH_AWK" $(cat "$FILES_SH") >>"$CANDIDATES"
    rc=$?
    [ "$rc" -eq 0 ] || ERRS="${ERRS}awk（.sh）がエラー: rc=$rc; "
fi
if [ -s "$FILES_MJS" ]; then
    # shellcheck disable=SC2046
    awk "$MJS_AWK" $(cat "$FILES_MJS") >>"$CANDIDATES"
    rc=$?
    [ "$rc" -eq 0 ] || ERRS="${ERRS}awk（.mjs）がエラー: rc=$rc; "
fi
# shellcheck disable=SC2046
awk '{ print FILENAME ":" FNR ":" $0 }' $(cat "$FILES_JSON") >>"$CANDIDATES"
rc=$?
[ "$rc" -eq 0 ] || ERRS="${ERRS}awk（.json）がエラー: rc=$rc; "

HITS="$TMP/hits.txt"
grep -P "$JA_RE" "$CANDIDATES" >"$HITS" 2>"$TMP/grep.err"
rc=$?

if [ "$rc" -ge 2 ]; then
    GREP_ERR=$(cat "$TMP/grep.err")
    ERRS="${ERRS}grep がエラー: rc=${rc}: ${GREP_ERR}; "
fi
if [ -n "$ERRS" ]; then
    bt_fail "hooks の非コメント行に日本語が無い" "$ERRS"
else
    # 例外の行を、ファイルと行の内容で名指しして外す
    FILTERED="$TMP/filtered.txt"
    : >"$FILTERED"
    while IFS= read -r hit; do
        path="${hit%%:*}"
        rest="${hit#*:}"
        text="${rest#*:}"
        if [ "$path" = "$EXC_FILE" ] && [ "$text" = "$EXC_TEXT" ]; then
            continue
        fi
        printf '%s\n' "$hit" >>"$FILTERED"
    done <"$HITS"

    if [ -s "$FILTERED" ]; then
        HIT_COUNT=$(wc -l <"$FILTERED")
        # path:line: text の形で並べる
        bt_fail "hooks の非コメント行に日本語が無い" \
            "日本語が残っている (${HIT_COUNT} 行)"$'\n'"$(sed -E 's/^([^:]*):([0-9]+):/    \1:\2: /' "$FILTERED")"
    else
        bt_pass "hooks の非コメント行に日本語が無い"
    fi
fi

bt_finish
