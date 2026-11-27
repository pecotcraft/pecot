# hooks スクリプト（エントリポイント + lib 配下）と hooks 設定 command の `.sh` 参照が実在することを確かめる（#870）。
# 実行時の 3 段解決が通ることまでは保証しない。実物の hooks の走査は setup_file で 1 回だけ行い、結果をファイルで渡す。

# 本テストは `$SCRIPT_DIR` 等を「展開せずリテラル文字列として」扱うのが目的のため、
# 単一引用符内の `$` は全て意図的（SC2016 はファイル全域で抑止する）。
# shellcheck disable=SC2016

bats_require_minimum_version 1.5.0

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

# `..` を含むパスだと、find の `! -path '*/tests/*'` が lib 配下まで外すため、末尾を削って組む。
HOOKS_DIR="${BATS_TEST_DIRNAME%/tests}"
PLUGIN_ROOT="${HOOKS_DIR%/hooks}"

# 参照トークンの基底プレフィックス。case パターン・${var#...} の両方で使うため
# 変数に置く（リテラルを直接書くと引用の取り扱いが読みにくくなる）。
PFX_PLUGIN_BRACE='${CLAUDE_PLUGIN_ROOT}/'
PFX_PLUGIN_PLAIN='$CLAUDE_PLUGIN_ROOT/'
PFX_PARENT='${SCRIPT_DIR%/*}/'
PFX_SCRIPT_BRACE='${SCRIPT_DIR}/'
PFX_SCRIPT_PLAIN='$SCRIPT_DIR/'
PFX_LIB_BRACE='${LIB_DIR}/'
PFX_LIB_PLAIN='$LIB_DIR/'

setup_file() {
    if ! command -v jq > /dev/null 2>&1; then
        echo "jq が無いため、hooks 設定の command を確かめられない（skip は許容しない）" >&2
        return 1
    fi
    # 走査の関数は grep の 0 件（rc 1）を正常として扱うので、set -e の外で動かし、結果の行で判定する。
    (
        set +eET
        scan_hooks "$BATS_FILE_TMPDIR"
    )
}

setup() {
    bats_load_library pecot-bats
}

# --- `.sh` / `.mjs` 参照トークンの抽出 ---
# 語を欲張って取り、`.sh` / `.mjs` で終わらない語を捨てる（ERE は否定先読みを使えない）。日本語のため LC_ALL=C。
# `start.mjs` は利用者の talk-dir のマーカーで、plugin 内の資産ではないので外す。
extract_sh_tokens() {
    LC_ALL=C sed -E -e '/^[[:space:]]*#/d' -e 's/[[:space:]]#.*$//' \
        | LC_ALL=C grep -oE '[A-Za-z0-9._/${}%*-]*\.(sh|mjs)[A-Za-z0-9_.-]*' \
        | LC_ALL=C grep -E '\.(sh|mjs)$' \
        | LC_ALL=C grep -vE '(^|/)start\.mjs$' || true
}

# ファイル内の `LIB_DIR="$SCRIPT_DIR/<subdir>"` 代入から LIB_DIR を解決する。
# 代入行がちょうど 1 件でない場合・SCRIPT_DIR 起点でない場合は空を返す（未解決扱い）。
resolve_lib_dir() {
    local file="$1" script_dir="$2"
    local count line val
    count=$(LC_ALL=C grep -cE '^[[:space:]]*LIB_DIR=' "$file" || true)
    [ "$count" = "1" ] || return 0
    line=$(LC_ALL=C grep -E '^[[:space:]]*LIB_DIR=' "$file")
    val=$(printf '%s\n' "$line" | LC_ALL=C sed -E 's/^[[:space:]]*LIB_DIR=//; s/^"//; s/"[[:space:]]*$//')
    if [ "${val#"$PFX_SCRIPT_PLAIN"}" != "$val" ]; then
        printf '%s/%s\n' "$script_dir" "${val#"$PFX_SCRIPT_PLAIN"}"
    elif [ "${val#"$PFX_SCRIPT_BRACE"}" != "$val" ]; then
        printf '%s/%s\n' "$script_dir" "${val#"$PFX_SCRIPT_BRACE"}"
    fi
}

# 1 スクリプトの `.sh` 参照を `<OK|MISSING|UNRESOLVED><TAB><トークン><TAB><解決先>` で 1 行ずつ出す。
# 参照に現れた基底だけを逆引きし、既知のイディオム以外はすべて UNRESOLVED にする（fail-closed）。
scan_file() {
    local file="$1" plugin_root="$2"
    local script_dir lib_dir has_script_dir tok base rest resolved status
    script_dir="$(cd "$(dirname "$file")" && pwd)"
    lib_dir="$(resolve_lib_dir "$file" "$script_dir")"
    # SCRIPT_DIR 起点の参照は、ファイル内に SCRIPT_DIR の代入（$0 形・BASH_SOURCE 形）があるときだけ解決する。
    if LC_ALL=C grep -qE '^[[:space:]]*SCRIPT_DIR=' "$file"; then
        has_script_dir=1
    else
        has_script_dir=0
    fi

    while IFS= read -r tok; do
        [ -n "$tok" ] || continue
        base=""
        rest=""
        if [ "${tok#"$PFX_PLUGIN_BRACE"}" != "$tok" ]; then
            base="$plugin_root"
            rest="${tok#"$PFX_PLUGIN_BRACE"}"
        elif [ "${tok#"$PFX_PLUGIN_PLAIN"}" != "$tok" ]; then
            base="$plugin_root"
            rest="${tok#"$PFX_PLUGIN_PLAIN"}"
        elif [ "${tok#"$PFX_PARENT"}" != "$tok" ] && [ "$has_script_dir" -eq 1 ]; then
            base="${script_dir%/*}"
            rest="${tok#"$PFX_PARENT"}"
        elif [ "${tok#"$PFX_SCRIPT_BRACE"}" != "$tok" ] && [ "$has_script_dir" -eq 1 ]; then
            base="$script_dir"
            rest="${tok#"$PFX_SCRIPT_BRACE"}"
        elif [ "${tok#"$PFX_SCRIPT_PLAIN"}" != "$tok" ] && [ "$has_script_dir" -eq 1 ]; then
            base="$script_dir"
            rest="${tok#"$PFX_SCRIPT_PLAIN"}"
        elif [ "${tok#"$PFX_LIB_BRACE"}" != "$tok" ] && [ -n "$lib_dir" ]; then
            base="$lib_dir"
            rest="${tok#"$PFX_LIB_BRACE"}"
        elif [ "${tok#"$PFX_LIB_PLAIN"}" != "$tok" ] && [ -n "$lib_dir" ]; then
            base="$lib_dir"
            rest="${tok#"$PFX_LIB_PLAIN"}"
        fi

        if [ -z "$base" ] || [ -z "$rest" ]; then
            printf 'UNRESOLVED\t%s\t\n' "$tok"
            continue
        fi
        # 解決後に変数展開・glob が残っていれば、未解決として扱う。
        # F-04: `*` `%` を取りこぼすと、glob 参照を「実在しない」と誤判定する。
        case "$rest" in
            *'$'* | *'{'* | *'}'* | *'*'* | *'%'*)
                printf 'UNRESOLVED\t%s\t\n' "$tok"
                continue
                ;;
        esac
        resolved="$base/$rest"
        if [ -f "$resolved" ]; then
            status="OK"
        else
            status="MISSING"
        fi
        printf '%s\t%s\t%s\n' "$status" "$tok" "$resolved"
    done < <(extract_sh_tokens < "$file")
}

# 実物の hooks を走査し、結果を $1 に書く。targets.txt はガード対象のスクリプトの一覧。
# refs.tsv は `<相対パス><TAB><scan_file の行>` の一覧。
# entry-refs.tsv は、hooks/ 直下のエントリポイントごとの `<相対パス><TAB><解決済み参照の数>` の一覧。
scan_hooks() {
    local out="$1" target rel file_ok st tok resolved
    {
        find "$HOOKS_DIR" -maxdepth 1 -type f -name '*.sh'
        find "$HOOKS_DIR/lib" -type f -name '*.sh' ! -path '*/tests/*'
    } | LC_ALL=C sort > "$out/targets.txt"
    : > "$out/refs.tsv"
    : > "$out/entry-refs.tsv"
    while IFS= read -r target; do
        rel="${target#"$HOOKS_DIR"/}"
        file_ok=0
        while IFS=$'\t' read -r st tok resolved; do
            [ "$st" = "OK" ] && file_ok=$((file_ok + 1))
            printf '%s\t%s\t%s\t%s\n' "$rel" "$st" "$tok" "$resolved" >> "$out/refs.tsv"
        done < <(scan_file "$target" "$PLUGIN_ROOT")
        # hooks/ 直下のエントリポイントのみ記録する（lib/ 配下は対象外）。
        case "$rel" in
            */*) ;;
            *) printf '%s\t%s\n' "$rel" "$file_ok" >> "$out/entry-refs.tsv" ;;
        esac
    done < "$out/targets.txt"
}

# hooks 設定の command の一覧（$1）を読み、`${CLAUDE_PLUGIN_ROOT}/hooks/` 直下の実在エントリポイントでないものを 1 行ずつ出す。
hooks_command_problems() {
    local cmd toks tok rest
    while IFS= read -r cmd; do
        [ -n "$cmd" ] || continue
        # command は `"\"${CLAUDE_PLUGIN_ROOT}\"/hooks/x.sh"` のように変数をクォートする（#1229）。
        # クォートの有無は比較の対象外にして、取り除いてから抽出する
        toks="$(printf '%s\n' "${cmd//\"/}" | extract_sh_tokens)"
        if [ -z "$toks" ]; then
            echo "command に .sh 参照が無い: $cmd"
            continue
        fi
        while IFS= read -r tok; do
            [ -n "$tok" ] || continue
            rest="${tok#"$PFX_PLUGIN_BRACE"}"
            if [ "$rest" = "$tok" ]; then
                echo "command が \${CLAUDE_PLUGIN_ROOT}/ 起点でない: $tok"
                continue
            fi
            case "$rest" in
                hooks/*) ;;
                *)
                    echo "command が hooks/ 配下でない: $tok"
                    continue
                    ;;
            esac
            case "${rest#hooks/}" in
                */*)
                    echo "command が hooks/ 直下のエントリポイントでない: $tok"
                    continue
                    ;;
            esac
            if [ ! -f "$PLUGIN_ROOT/$rest" ]; then
                echo "command の参照先が存在しない: $tok -> $PLUGIN_ROOT/$rest"
            fi
        done <<< "$toks"
    done < "$1"
}

# $1=PLUGIN_ROOT からの hooks 設定のパス。command が 3 件あり、全件が hooks/ 直下の実在エントリポイントを指すこと。
assert_hooks_config() {
    local cmds="$BATS_TEST_TMPDIR/cmds.txt"
    run --separate-stderr jq -r '.hooks | to_entries[] | .value[] | .hooks[] | select(.type == "command") | .command' \
        "$PLUGIN_ROOT/$1"
    assert_success
    assert_equal "${#lines[@]}" 3
    printf '%s\n' "$output" > "$cmds"
    run hooks_command_problems "$cmds"
    assert_success
    refute_output
}

# セルフテストの plugin_root。解決先として実在するファイルを置く。
self_root() {
    SELF="$BATS_TEST_TMPDIR/self"
    mkdir -p "$SELF/sub" "$SELF/libsub"
    printf '#!/bin/bash\n' > "$SELF/real-target.sh"
    printf '#!/bin/bash\n' > "$SELF/up-target.sh"
    printf '#!/bin/bash\n' > "$SELF/libsub/lib-target.sh"
    printf '#!/usr/bin/env node\n' > "$SELF/real-helper.mjs"
}

# $1=合成スクリプト $2=トークン $3=期待する状態。本番の走査と同じ scan_file を通す（恒真化防止）。
assert_self_status() {
    run scan_file "$1" "$SELF"
    assert_success
    run awk -F'\t' -v t="$2" '$2 == t { print $1 }' <<< "$output"
    assert_output "$3"
}

@test "ガード対象のスクリプトを 10 本以上列挙し、tests 配下を含めない" {
    explains "\`hooks/\` 直下と \`hooks/lib/\` 配下から、参照を調べるスクリプトを列挙するテストです。10 本以上が列挙され、\`tests/\` 配下のファイルが含まれないことを確認します。"
    local count
    count=$(wc -l < "$BATS_FILE_TMPDIR/targets.txt")
    ((count >= 10)) || fail "列挙が崩れている: count=$count"
    run grep '/tests/' "$BATS_FILE_TMPDIR/targets.txt"
    assert_failure 1
}

@test "hooks スクリプトの参照は、すべて解決でき、解決先が実在する" {
    explains "hooks のスクリプトに書かれた \`.sh\` と \`.mjs\` の参照を走査するテストです。すべての参照の基底が解決でき、解決先のファイルが存在することを確認します。"
    run awk -F'\t' '$2 != "OK" { print $1 ": " $2 ": " $3 " -> " $4 }' "$BATS_FILE_TMPDIR/refs.tsv"
    assert_success
    refute_output
}

@test "解決済みの参照の出現の総数が、下限の 10 件を満たす" {
    explains "抽出器の空振りを検知するため、解決できた参照の数を数えるテストです。同じ参照の重複も含めた出現の総数が、10 件以上であることを確認します。"
    local count
    count=$(awk -F'\t' '$2 == "OK"' "$BATS_FILE_TMPDIR/refs.tsv" | wc -l)
    ((count >= 10)) || fail "$count 件しかない。抽出器の空振りが原因の可能性がある"
}

@test "hooks 直下のエントリポイント 3 本が、それぞれ解決済みの参照を 1 件以上持つ" {
    explains "\`hooks/\` 直下のエントリポイントごとに、解決できた参照を数えるテストです。エントリポイントが 3 本あり、どれも 1 件以上の参照を持つことを確認します。"
    assert_equal "$(wc -l < "$BATS_FILE_TMPDIR/entry-refs.tsv")" 3
    run awk -F'\t' '$2 < 1 { print $1 ": 解決済み参照が 0 件" }' "$BATS_FILE_TMPDIR/entry-refs.tsv"
    assert_success
    refute_output
}

# 名指しの @test が確かめるのはこの 2 本だけなので、hooks*.json が増えたらここで落とす。
@test "hooks 設定のファイルは、command を確かめる 2 本だけを列挙する" {
    explains "Claude Code 向けと Copilot CLI 向けの hooks 設定のファイルを列挙するテストです。\`hooks*.json\` の一覧が、\`command\` を確かめる 2 本とちょうど一致することを確認します。2 本は \`hooks/hooks.json\` と \`com.github.copilot/hooks/hooks.json\` です。"
    local listed
    listed=$(
        {
            find "$HOOKS_DIR" -maxdepth 1 -type f -name 'hooks*.json'
            find "$PLUGIN_ROOT/com.github.copilot/hooks" -maxdepth 1 -type f -name 'hooks*.json' 2> /dev/null || true
        } | sed "s|^$PLUGIN_ROOT/||" | LC_ALL=C sort
    )
    assert_equal "$listed" "$(printf '%s\n' com.github.copilot/hooks/hooks.json hooks/hooks.json)"
}

@test "Claude Code 向けの hooks.json の command は、3 件とも hooks 直下の実在するエントリポイントを指す" {
    explains "\`hooks/hooks.json\` の \`command\` を読むテストです。\`command\` が 3 件あり、どれも \`\${CLAUDE_PLUGIN_ROOT}/hooks/\` 直下の実在するスクリプトを指すことを確認します。"
    assert_hooks_config hooks/hooks.json
}

@test "Copilot CLI 向けの hooks.json の command は、3 件とも hooks 直下の実在するエントリポイントを指す" {
    explains "\`com.github.copilot/hooks/hooks.json\` の \`command\` を読むテストです。\`command\` が 3 件あり、どれも \`hooks/\` 直下の実在するスクリプトを指すことを確認します。"
    assert_hooks_config com.github.copilot/hooks/hooks.json
}

@test "実在しない sh の参照は、MISSING と判定する" {
    explains "存在しないファイルを \`\$SCRIPT_DIR/\` 起点で参照する合成スクリプトのテストです。走査の結果が \`MISSING\` になることを確認します。"
    self_root
    cat > "$SELF/s-missing.sh" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/does-not-exist.sh"
EOF
    assert_self_status "$SELF/s-missing.sh" '$SCRIPT_DIR/does-not-exist.sh' MISSING
}

@test "未知の変数で始まる参照は、UNRESOLVED と判定する" {
    explains "既知のイディオムに無い \`\$FOO_DIR/\` 起点の参照を持つ合成スクリプトのテストです。走査の結果が \`UNRESOLVED\` になることを確認します。"
    self_root
    cat > "$SELF/s-unknown-var.sh" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$FOO_DIR/probe.sh"
EOF
    assert_self_status "$SELF/s-unknown-var.sh" '$FOO_DIR/probe.sh' UNRESOLVED
}

@test "変数で始まらない裸の参照は、UNRESOLVED と判定する" {
    explains "\`lib/core/probe.sh\` のように変数を付けずに書いた参照を持つ合成スクリプトのテストです。走査の結果が \`UNRESOLVED\` になることを確認します。"
    self_root
    cat > "$SELF/s-bare.sh" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
bash lib/core/probe.sh
EOF
    assert_self_status "$SELF/s-bare.sh" 'lib/core/probe.sh' UNRESOLVED
}

@test "起動したスクリプトのパスから SCRIPT_DIR を代入したファイルでは、SCRIPT_DIR で始まる参照を解決する" {
    explains "\`\$0\` から \`SCRIPT_DIR\` を代入する合成スクリプトのテストです。実在するファイルへの \`\$SCRIPT_DIR/\` 起点の参照が \`OK\` になることを確認します。"
    self_root
    cat > "$SELF/s-dollar0.sh" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/real-target.sh"
EOF
    assert_self_status "$SELF/s-dollar0.sh" '$SCRIPT_DIR/real-target.sh' OK
}

@test "BASH_SOURCE の形で SCRIPT_DIR を代入したファイルでも、参照を解決する" {
    explains "\`\${BASH_SOURCE[0]}\` から \`SCRIPT_DIR\` を代入する合成スクリプトのテストです。\`\${SCRIPT_DIR}/\` 起点の参照が \`OK\` になることを確認します。"
    self_root
    cat > "$SELF/s-bash-source.sh" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${SCRIPT_DIR}/real-target.sh"
EOF
    assert_self_status "$SELF/s-bash-source.sh" '${SCRIPT_DIR}/real-target.sh' OK
}

@test "SCRIPT_DIR の末尾の 1 段を削った参照は、1 段上のディレクトリから解決する" {
    explains "\`\${SCRIPT_DIR%/*}/\` 起点の参照を持つ、サブディレクトリの合成スクリプトのテストです。1 段上にある実在するファイルとして \`OK\` になることを確認します。"
    self_root
    cat > "$SELF/sub/s-parent.sh" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/up-target.sh"
EOF
    assert_self_status "$SELF/sub/s-parent.sh" '${SCRIPT_DIR%/*}/up-target.sh' OK
}

@test "LIB_DIR の代入が 2 件あるファイルでは、LIB_DIR で始まる参照を UNRESOLVED と判定する" {
    explains "\`LIB_DIR\` を 2 回代入する合成スクリプトのテストです。代入がちょうど 1 件でない場合に、\`\$LIB_DIR/\` 起点の参照が \`UNRESOLVED\` になることを確認します。"
    self_root
    cat > "$SELF/s-lib-dup.sh" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/a"
LIB_DIR="$SCRIPT_DIR/b"
"$LIB_DIR/real-target.sh"
EOF
    assert_self_status "$SELF/s-lib-dup.sh" '$LIB_DIR/real-target.sh' UNRESOLVED
}

@test "CLAUDE_PLUGIN_ROOT で始まる参照は、プラグインの root から解決する" {
    explains "\`\${CLAUDE_PLUGIN_ROOT}/\` 起点の参照を持つ合成スクリプトのテストです。プラグインの root にある実在するファイルとして \`OK\` になることを確認します。"
    self_root
    cat > "$SELF/s-plugin-root.sh" << 'EOF'
#!/bin/bash
"${CLAUDE_PLUGIN_ROOT}/real-target.sh"
EOF
    assert_self_status "$SELF/s-plugin-root.sh" '${CLAUDE_PLUGIN_ROOT}/real-target.sh' OK
}

@test "LIB_DIR の代入が 1 件のファイルでは、LIB_DIR で始まる参照を解決する" {
    explains "\`LIB_DIR\` を \`\$SCRIPT_DIR/libsub\` に 1 回だけ代入する合成スクリプトのテストです。\`\$LIB_DIR/\` 起点の参照が \`OK\` になることを確認します。"
    self_root
    cat > "$SELF/s-lib-single.sh" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/libsub"
"$LIB_DIR/lib-target.sh"
EOF
    assert_self_status "$SELF/s-lib-single.sh" '$LIB_DIR/lib-target.sh' OK
}

@test "SCRIPT_DIR を代入しないファイルでは、SCRIPT_DIR で始まる参照を UNRESOLVED と判定する" {
    explains "\`SCRIPT_DIR\` の代入が無い合成スクリプトのテストです。実在するファイルを指していても、\`\$SCRIPT_DIR/\` 起点の参照が \`UNRESOLVED\` になることを確認します。"
    self_root
    cat > "$SELF/s-no-script-dir.sh" << 'EOF'
#!/bin/bash
"$SCRIPT_DIR/real-target.sh"
EOF
    assert_self_status "$SELF/s-no-script-dir.sh" '$SCRIPT_DIR/real-target.sh' UNRESOLVED
}

@test "mjs の参照も、実在するかを調べる対象にする" {
    explains "実在する \`.mjs\` を \`node\` で起動する合成スクリプトのテストです。\`.mjs\` の参照も抽出され、\`OK\` になることを確認します。"
    self_root
    cat > "$SELF/s-mjs-ok.sh" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/real-helper.mjs"
EOF
    assert_self_status "$SELF/s-mjs-ok.sh" '$SCRIPT_DIR/real-helper.mjs' OK
}

@test "実在しない mjs の参照は、MISSING と判定する" {
    explains "存在しない \`.mjs\` を \`node\` で起動する合成スクリプトのテストです。走査の結果が \`MISSING\` になることを確認します。"
    self_root
    cat > "$SELF/s-mjs-missing.sh" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/no-such-helper.mjs"
EOF
    assert_self_status "$SELF/s-mjs-missing.sh" '$SCRIPT_DIR/no-such-helper.mjs' MISSING
}

# 除外が外れると裸トークンとして UNRESOLVED になり、talk-dir 探索を持つ hook 3 本が一斉に失敗する。
@test "talk-dir のマーカーの start.mjs は、参照として抽出しない" {
    explains "talk-dir のマーカーの \`start.mjs\` を調べる合成スクリプトのテストです。プラグインの中の資産ではないので、参照として抽出されないことを確認します。"
    self_root
    cat > "$SELF/s-marker.sh" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$DIR/start.mjs" ]; then
    echo "talk-dir マーカー (start.mjs) を検出"
fi
EOF
    run extract_sh_tokens < "$SELF/s-marker.sh"
    assert_success
    refute_output
}

@test "SCRIPT_DIR に末尾の 1 段を削る形のほかの % の修飾を付けた参照は、UNRESOLVED と判定する" {
    explains "\`\${SCRIPT_DIR%/lib/*}/\` のように \`%/*\` 以外の修飾を持つ参照の合成スクリプトのテストです。走査の結果が \`UNRESOLVED\` になることを確認します。"
    self_root
    cat > "$SELF/s-percent-other.sh" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/lib/*}/x.sh"
EOF
    assert_self_status "$SELF/s-percent-other.sh" '${SCRIPT_DIR%/lib/*}/x.sh' UNRESOLVED
}
