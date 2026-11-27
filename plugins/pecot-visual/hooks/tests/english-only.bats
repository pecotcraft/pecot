# hooks が返す固定の文言が英語であることを確かめる (spec 021 FR-014 / SC-007)。
# コメント行は除く。ただし .sh の heredoc と複数行の引用符の中は出力の本文になりうるので調べる。

bats_require_minimum_version 1.5.0

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

PLUGIN_ROOT="$BATS_TEST_DIRNAME/../.."

JA_RE='[\x{3000}-\x{30FF}\x{3400}-\x{9FFF}\x{F900}-\x{FAFF}\x{FF00}-\x{FFEF}]'

# 例外: エージェントへのメッセージではなく、利用者の .gitignore へ書き出す内容（heredoc の中のコメント行）。
# 書き換えると、書き出した .gitignore との差が出る。ファイルと行の内容で名指しする。
EXC_FILE='hooks/lib/core/pecotv-gitignore-ensure.sh'
EXC_TEXT='# pecotv の生成物を管理外にする許可の一覧。追跡する設定は無い。'

# .sh の非コメント行を `path:line:text` で出す。
# 状態: 通常 / 単一引用符 / 二重引用符 / heredoc。
# 引用符の状態は行をまたいで持ち、その中の行はコメントとみなさない。
# shellcheck disable=SC2016
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
# shellcheck disable=SC2016
MJS_AWK='
function trim(s) { sub(/^[ \t]+/, "", s); return s }
{ t = trim($0); if (t ~ /^(\/\/|\/\*|\*)/) { next } print FILENAME ":" FNR ":" $0 }
'

setup() {
    bats_load_library pecot-bats
    export LC_ALL=C.UTF-8
}

# 調べる範囲の一覧が空なら、前提が成り立たないので、ファイルの単位で止める。
setup_file() {
    bats_load_library pecot-bats
    cd "$PLUGIN_ROOT" || fail "プラグインの根に入れない: $PLUGIN_ROOT"
    find hooks -path hooks/tests -prune -o -type f -name '*.sh' -print | LC_ALL=C sort > "$BATS_FILE_TMPDIR/files.sh.txt"
    find hooks -path hooks/tests -prune -o -type f -name '*.mjs' -print | LC_ALL=C sort > "$BATS_FILE_TMPDIR/files.mjs.txt"
    printf '%s\n' hooks/hooks.json com.github.copilot/hooks/hooks.json > "$BATS_FILE_TMPDIR/files.json.txt"
    [ -s "$BATS_FILE_TMPDIR/files.sh.txt" ] || fail "調べる .sh の一覧が空"
    [ -s "$BATS_FILE_TMPDIR/files.json.txt" ] || fail "調べる .json の一覧が空"
    [ -f hooks/hooks.json ] || fail "範囲のファイルが無い: hooks/hooks.json"
    [ -f com.github.copilot/hooks/hooks.json ] || fail "範囲のファイルが無い: com.github.copilot/hooks/hooks.json"
}

@test "hooks の非コメント行には、例外の 1 行を除いて日本語を含めない" {
    explains "\`hooks/\` の \`.sh\`・\`.mjs\` と 2 つの \`hooks.json\` を調べるテストです。コメント以外の行に日本語が無く、例外の 1 行だけが除かれることを確認します。"
    cd "$PLUGIN_ROOT" || fail "プラグインの根に入れない"
    local tmp="$BATS_TEST_TMPDIR" candidates="$BATS_TEST_TMPDIR/candidates.txt"
    : > "$candidates"
    # 候補を作れなかったときは、日本語の有無を判定できないので落とす。
    # shellcheck disable=SC2046
    awk "$SH_AWK" $(cat "$BATS_FILE_TMPDIR/files.sh.txt") >> "$candidates" || fail "awk の .sh 側がエラー"
    if [ -s "$BATS_FILE_TMPDIR/files.mjs.txt" ]; then
        # shellcheck disable=SC2046
        awk "$MJS_AWK" $(cat "$BATS_FILE_TMPDIR/files.mjs.txt") >> "$candidates" || fail "awk の .mjs 側がエラー"
    fi
    # shellcheck disable=SC2046
    awk '{ print FILENAME ":" FNR ":" $0 }' $(cat "$BATS_FILE_TMPDIR/files.json.txt") >> "$candidates" || fail "awk の .json 側がエラー"

    # grep は 1 件も当たらないと 1 を返す。2 以上だけをエラーとする。
    local rc=0
    grep -P "$JA_RE" "$candidates" > "$tmp/hits.txt" 2> "$tmp/grep.err" || rc=$?
    if [ "$rc" -ge 2 ]; then
        local err
        err=$(cat "$tmp/grep.err")
        fail "grep が失敗した rc=$rc ${err}"
    fi

    # 例外の行を、ファイルと行の内容で名指しして外す
    local filtered="$tmp/filtered.txt" hit path rest text
    : > "$filtered"
    while IFS= read -r hit; do
        path="${hit%%:*}"
        rest="${hit#*:}"
        text="${rest#*:}"
        if [ "$path" = "$EXC_FILE" ] && [ "$text" = "$EXC_TEXT" ]; then
            continue
        fi
        printf '%s\n' "$hit" >> "$filtered"
    done < "$tmp/hits.txt"

    if [ -s "$filtered" ]; then
        local listing
        listing=$(sed -E 's/^([^:]*):([0-9]+):/    \1:\2: /' "$filtered")
        fail "日本語が残っている"$'\n'"${listing}"
    fi
}
