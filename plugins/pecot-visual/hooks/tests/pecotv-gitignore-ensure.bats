# pecotv-gitignore-ensure.sh の単体テスト。--print・無いときの書き込み・旧い中身の書き換え・
# 追跡中のファイルを書き換えないこと・git 外の書き込み・実 git の除外を確かめる。

bats_require_minimum_version 1.5.0

# 親リポの GIT_DIR が漏れると、このリポが追跡する .pecotv/.gitignore を一時ディレクトリも追跡中と判定する。
# そのため git の操作もスクリプトの起動も、GIT_* を外して行う。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

ENSURE="$BATS_TEST_DIRNAME/../lib/core/pecotv-gitignore-ensure.sh"

_GIT_ISOLATE=(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
    -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES)
_git() {
    "${_GIT_ISOLATE[@]}" git "$@"
}
_run_ensure() {
    "${_GIT_ISOLATE[@]}" "$@" bash "$ENSURE"
}

setup() {
    bats_load_library pecot-bats
    DEFINITION="$("${_GIT_ISOLATE[@]}" bash "$ENSURE" --print)"
    T="$BATS_TEST_TMPDIR"
}

@test "--print を渡すと、何も作らずに定義を出す" {
    explains '`CLAUDE_PROJECT_DIR` を外した空のディレクトリで `--print` を渡すテストです。終了コード 0 で定義が stdout に出て、`*` を含み、ディレクトリに何も作られないことを確認します。'
    mkdir -p "$T/c1"
    cd "$T/c1"
    run --separate-stderr "${_GIT_ISOLATE[@]}" -u CLAUDE_PROJECT_DIR bash "$ENSURE" --print
    assert_success
    assert_output "$DEFINITION"
    run grep -x '\*' <<< "$output"
    assert_success
    assert [ -z "$(ls -A "$T/c1")" ]
}

@test "CLAUDE_PROJECT_DIR が未設定だと、何もせず正常終了する" {
    explains '`CLAUDE_PROJECT_DIR` を外して引数なしで動かすテストです。終了コード 0 で、作業ディレクトリに何も作られないことを確認します。'
    mkdir -p "$T/c2"
    cd "$T/c2"
    run "${_GIT_ISOLATE[@]}" -u CLAUDE_PROJECT_DIR bash "$ENSURE"
    assert_success
    assert [ -z "$(ls -A "$T/c2")" ]
}

@test "git 外でファイルが無いと、--print と同じ中身を書き、一時ファイルを残さない" {
    explains 'git 外のプロジェクトで `.pecotv/.gitignore` が無いときに動かすテストです。`--print` と同じ中身が書かれ、`.pecotv` に一時ファイルが残らないことを確認します。'
    mkdir -p "$T/p3"
    run _run_ensure CLAUDE_PROJECT_DIR="$T/p3" GIT_CEILING_DIRECTORIES="$T"
    assert_success
    assert_equal "$(cat "$T/p3/.pecotv/.gitignore")" "$DEFINITION"
    assert_equal "$(find "$T/p3/.pecotv" -mindepth 1 | wc -l)" 1
}

@test "追跡していない旧い中身は、定義へ書き換える" {
    explains '追跡していない旧い `.pecotv/.gitignore` を持つ git リポで動かすテストです。中身が `--print` の定義に書き換わることを確認します。'
    mkdir -p "$T/p4/.pecotv"
    _git -C "$T/p4" init -q
    printf 'state/\ntmp/\n/.gitignore\n' > "$T/p4/.pecotv/.gitignore"
    run _run_ensure CLAUDE_PROJECT_DIR="$T/p4"
    assert_success
    assert_equal "$(cat "$T/p4/.pecotv/.gitignore")" "$DEFINITION"
}

@test "追跡しているファイルは、書き換えない" {
    explains '`.pecotv/.gitignore` をコミットして追跡させた git リポで動かすテストです。中身が元のままで、`git diff` に差が出ないことを確認します。'
    mkdir -p "$T/p5/.pecotv"
    _git -C "$T/p5" init -q
    _git -C "$T/p5" config user.email t@t
    _git -C "$T/p5" config user.name t
    printf '# local\n' > "$T/p5/.pecotv/.gitignore"
    _git -C "$T/p5" add -f .pecotv/.gitignore
    _git -C "$T/p5" commit -q -m "track"
    run _run_ensure CLAUDE_PROJECT_DIR="$T/p5"
    assert_success
    assert_equal "$(cat "$T/p5/.pecotv/.gitignore")" "# local"
    run _git -C "$T/p5" diff --quiet
    assert_success
}

@test "実 git のリポでは、生成物と設定と .gitignore 自身が除外され、status が空になる" {
    explains '実 git のリポで動かし、`.pecotv` に生成物と設定のファイルを置くテストです。すべてが ignore されて `git status` が空になることを確認します。'
    local p="$T/p6" f
    mkdir -p "$p"
    _git -C "$p" init -q
    _run_ensure CLAUDE_PROJECT_DIR="$p"
    mkdir -p "$p/.pecotv/work/drawio" "$p/.pecotv/work/evidence" "$p/.pecotv/state" "$p/.pecotv/tmp" "$p/.pecotv/config"
    for f in work/drawio/x.drawio work/evidence/x.xlsx state/s.json tmp/t README.md CHANGELOG.md config/hooks-config.json; do
        touch "$p/.pecotv/$f"
    done
    run _git -C "$p" status --porcelain -uall
    assert_output ""
    for f in work/drawio/x.drawio work/evidence/x.xlsx state/ tmp/ README.md CHANGELOG.md config/hooks-config.json .gitignore; do
        run _git -C "$p" check-ignore -q -- ".pecotv/$f"
        assert_success
    done
}
