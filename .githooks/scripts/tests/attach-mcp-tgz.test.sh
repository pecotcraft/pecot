#!/bin/bash
# attach-mcp-tgz.sh（npm pack から gh の 3 回の呼び出しまで）の検証。gh は PATH 先頭のスタブで差し替え、npm pack は本物を使う。
# `set -e` は使わない。失敗の検証で、非ゼロ終了を意図的に発生させるため。
set -u

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ATTACH="$SCRIPT_DIR/../attach-mcp-tgz.sh"
# shellcheck source=../test_report/bash-test.sh
. "$SCRIPT_DIR/../test_report/bash-test.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 失敗の補足に使う。末尾 N 行を 1 行にまとめて返す。
log_tail() {
    tail -n "$2" "$TMP/$1" | tr '\n' ' '
}

# gh スタブ。呼び出しの引数を 1 行ずつ記録する。GH_STUB_NO_RELEASE=1 のとき release view は標準エラーを出して失敗する。
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" << 'STUB_GH'
#!/bin/bash
printf '%s\n' "$*" >> "$GH_STUB_LOG"
if [ "$1 $2" = "release view" ] && [ "${GH_STUB_NO_RELEASE:-}" = 1 ]; then
    echo "gh: HTTP 401 stub failure" >&2
    exit 1
fi
exit 0
STUB_GH
chmod +x "$TMP/bin/gh"
export GH_STUB_LOG="$TMP/gh.log"
: > "$GH_STUB_LOG"
export PATH="$TMP/bin:$PATH"
gh_reset() {
    : > "$GH_STUB_LOG"
}
gh_lines() {
    wc -l < "$GH_STUB_LOG" | tr -d ' '
}

# 配布ツリーと、origin を持つ使い捨てリポ。
DIST="$TMP/dist"
mkdir -p "$DIST"
printf '{"name":"@example/attach-test","version":"1.2.3","files":["package.json"]}\n' > "$DIST/package.json"
REPO="$TMP/repo"
git init --quiet --initial-branch=main "$REPO" || exit 1
set_origin() {
    git -C "$REPO" remote remove origin 2> /dev/null
    git -C "$REPO" remote add origin "$1" || exit 1
}

TAG="example-v1.2.3"
run_attach() {
    bash "$ATTACH" --dist="$DIST" --tag="$TAG" --package="@example/attach-test" --version=1.2.3 \
        --repo-root="$REPO" "$@"
}

# --- 1. origin の URL から owner/name を求める（dry-run の表示で見る） ---
SLUG="acme-labs/example-repo"
check_origin() {
    local label="$1" url="$2"
    set_origin "$url"
    gh_reset
    local title="origin が $label でも -R が owner/name になる"
    if run_attach --dry-run > "$TMP/origin.log" 2>&1; then
        if grep -qxF "    gh release view $TAG -R $SLUG" "$TMP/origin.log"; then
            bt_pass "$title"
        else
            bt_fail "$title" "-R が違う ($(log_tail origin.log 3))"
        fi
    else
        bt_fail "$title" "失敗した ($(log_tail origin.log 2))"
    fi
    bt_eq "origin が $label でも dry-run は gh を呼ばない" "0" "$(gh_lines)"
}
check_origin "https" "https://github.com/$SLUG.git"
check_origin "https（.git 無し）" "https://github.com/$SLUG"
check_origin "https（認証情報つき）" "https://user:token@github.com/$SLUG.git"
check_origin "https（末尾 /）" "https://github.com/$SLUG/"
check_origin "https（末尾 .git/）" "https://github.com/$SLUG.git/"
check_origin "scp 形式" "git@github.com:$SLUG.git"
check_origin "scp 形式（.git 無し）" "git@github.com:$SLUG"
check_origin "ssh://" "ssh://git@github.com/$SLUG.git"
check_origin "ssh://（ポート付き）" "ssh://git@github.com:22/$SLUG.git"
check_origin "ssh://（ポート付き・末尾 /）" "ssh://git@github.com:2222/$SLUG/"

reject_origin() {
    local label="$1" url="$2"
    set_origin "$url"
    gh_reset
    local title="origin が $label のとき止まる"
    if run_attach --dry-run > "$TMP/reject.log" 2>&1; then
        bt_fail "$title" "通った"
    elif grep -qF "origin の URL から owner/name を求められません" "$TMP/reject.log"; then
        bt_pass "$title"
    else
        bt_fail "$title" "別の理由で失敗した ($(log_tail reject.log 2))"
    fi
    bt_eq "origin が $label のとき gh を呼ばない" "0" "$(gh_lines)"
}
reject_origin "3 階層のパス" "https://github.com/a/b/c.git"
reject_origin "1 階層のパス" "https://github.com/onlyone"
reject_origin "URL でも scp 形式でもない文字列" "not-a-url"
reject_origin "ローカルパス" "/srv/git/repo.git"

# --- 2. dry-run ---
set_origin "https://github.com/$SLUG.git"
gh_reset
if run_attach --dry-run > "$TMP/dry.log" 2>&1; then
    bt_pass "dry-run が正常終了する"
else
    bt_fail "dry-run が正常終了する" "失敗した ($(log_tail dry.log 2))"
fi
if grep -qF "tgz: example-attach-test-1.2.3.tgz" "$TMP/dry.log"; then
    bt_pass "dry-run が tgz の名前を出力する"
else
    bt_fail "dry-run が tgz の名前を出力する" "出力しない ($(log_tail dry.log 4))"
fi
if grep -qxF "    package.json" "$TMP/dry.log"; then
    bt_pass "dry-run が tgz の中身の一覧を出力する"
else
    bt_fail "dry-run が tgz の中身の一覧を出力する" "出力しない"
fi
for needle in "gh release view $TAG -R $SLUG" \
    "gh release upload $TAG example-attach-test-1.2.3.tgz --clobber -R $SLUG" \
    "gh workflow run publish-npm.yml -f tag=$TAG --ref $TAG -R $SLUG"; do
    if grep -qxF "    $needle" "$TMP/dry.log"; then
        bt_pass "dry-run が表示する: ${needle%% -*}"
    else
        bt_fail "dry-run が表示する: ${needle%% -*}" "表示しない: $needle"
    fi
done
if grep -qF "版は version の段階より前の値です" "$TMP/dry.log"; then
    bt_pass "dry-run がタグの版は本実行で変わり得ると注記する"
else
    bt_fail "dry-run がタグの版は本実行で変わり得ると注記する" "版の注記が無い"
fi
bt_eq "dry-run は gh を呼ばない" "0" "$(gh_lines)"

# --- 3. 本実行 ---
gh_reset
if run_attach > "$TMP/real.log" 2>&1; then
    bt_pass "本実行が正常終了する"
else
    bt_fail "本実行が正常終了する" "失敗した ($(log_tail real.log 3))"
fi
bt_eq "gh の呼び出しは 3 回" "3" "$(gh_lines)"
bt_eq "1 回目は release view" "release view $TAG -R $SLUG" "$(sed -n 1p "$GH_STUB_LOG")"
UPLOAD_LINE="$(sed -n 2p "$GH_STUB_LOG")"
case "$UPLOAD_LINE" in
    "release upload $TAG /"*"/example-attach-test-1.2.3.tgz --clobber -R $SLUG") bt_pass "2 回目は release upload" ;;
    *) bt_fail "2 回目は release upload" "upload の形でない: $UPLOAD_LINE" ;;
esac
bt_eq "3 回目は workflow run" "workflow run publish-npm.yml -f tag=$TAG --ref $TAG -R $SLUG" \
    "$(sed -n 3p "$GH_STUB_LOG")"
if grep -qF "@example/attach-test v1.2.3 を Release に添え" "$TMP/real.log"; then
    bt_pass "完了の行にパッケージ名と版を出す"
else
    bt_fail "完了の行にパッケージ名と版を出す" "無い: $(log_tail real.log 1)"
fi

# release view が失敗したら、進捗の行と gh の出力を出して upload へ進む前に止まる。原因は言い切らない。
gh_reset
RC=0
GH_STUB_NO_RELEASE=1 run_attach > "$TMP/noview.log" 2>&1 || RC=$?
bt_eq "release view が失敗すると非ゼロ終了" "1" "$RC"
bt_eq "release view が失敗したら gh は 1 回だけ" "1" "$(gh_lines)"
if grep -qF "==> gh release view $TAG -R $SLUG" "$TMP/noview.log"; then
    bt_pass "release view の前に進捗の行を出す"
else
    bt_fail "release view の前に進捗の行を出す" "進捗の行が無い"
fi
if grep -qF "Release $TAG を確認できません: gh: HTTP 401 stub failure" "$TMP/noview.log"; then
    bt_pass "release view の失敗は gh の出力を添えて「確認できません」と出す"
else
    bt_fail "release view の失敗は gh の出力を添えて「確認できません」と出す" "文言が違う: $(log_tail noview.log 3)"
fi
if grep -qF "ありません" "$TMP/noview.log"; then
    bt_fail "release view の失敗で Release の不在を言い切らない" "「ありません」と言い切っている"
else
    bt_pass "release view の失敗で Release の不在を言い切らない"
fi

# --- 4. 引数 ---
if run_attach --bogus > "$TMP/arg.log" 2>&1; then
    bt_fail "未対応の引数は非ゼロ終了になる" "通った"
else
    bt_pass "未対応の引数は非ゼロ終了になる"
fi
if bash "$ATTACH" --dist="$DIST" --tag="$TAG" --package=x --version=1 > "$TMP/arg2.log" 2>&1; then
    bt_fail "必須の引数が欠けると非ゼロ終了になる" "--repo-root 無しが通った"
else
    bt_pass "必須の引数が欠けると非ゼロ終了になる"
fi
if run_attach --dry-run --dist="$TMP/no-such-dir" > "$TMP/arg3.log" 2>&1; then
    bt_fail "存在しない --dist は非ゼロ終了になる" "通った"
else
    bt_pass "存在しない --dist は非ゼロ終了になる"
fi

bt_finish
