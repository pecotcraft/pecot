# pecotv-dir-init.sh の単体テスト。.pecotv 一式の作成・同期（mtime ガード）・.gitignore の生成を確かめる。
# 失敗の注入で、gitignore-ensure がコピーより先に終わること（untracked が残らない）も確かめる。

bats_require_minimum_version 1.5.0

# 親リポの GIT_DIR などが漏れると、一時リポの操作が親リポへ向き、フックの git ls-files も誤判定する。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

HOOK="$BATS_TEST_DIRNAME/../lib/core/pecotv-dir-init.sh"

# git の操作もフックの起動も GIT_* を外して行う。
_GIT_ISOLATE=(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
    -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES)
_git() {
    "${_GIT_ISOLATE[@]}" git "$@"
}

# $1=プロジェクトのディレクトリ
_run_hook() {
    "${_GIT_ISOLATE[@]}" CLAUDE_PROJECT_DIR="$1" PLUGIN_HOOKS="$FIXTURE/hooks" bash "$HOOK"
}

# $1=ディレクトリ。旧い .gitignore（tmp/ のみ）を持つ git リポにする。
_make_old_repo() {
    mkdir -p "$1/.pecotv"
    _git -C "$1" init -q
    _git -C "$1" config user.email t@t
    _git -C "$1" config user.name t
    printf '# 実行時生成ファイル (git管理外)\ntmp/\n' > "$1/.pecotv/.gitignore"
}

# 偽プラグイン root（同期元）。ケースごとに書き換えるため、@test ごとに作る。
setup() {
    bats_load_library pecot-bats
    FIXTURE="$BATS_TEST_TMPDIR/fixture"
    mkdir -p "$FIXTURE/hooks" "$FIXTURE/.claude-plugin"
    echo "# fixture hooks README" > "$FIXTURE/hooks/README.md"
    echo "# fixture CHANGELOG v1" > "$FIXTURE/CHANGELOG.md"
    echo '{"version": "0.0.1"}' > "$FIXTURE/.claude-plugin/plugin.json"
    PROJ="$BATS_TEST_TMPDIR/proj"
}

@test "初回に実行すると、.pecotv 一式を作り、全部を除外する .gitignore を置く" {
    explains '空のプロジェクトで `pecotv-dir-init.sh` を初回に動かすテストです。`work`・同期マーカー・README・CHANGELOG が作られ、`.gitignore` に全部を除外する `*` が書かれることを確認します。'
    mkdir -p "$PROJ"
    run_attached _run_hook "$PROJ"
    assert_success
    assert [ -d "$PROJ/.pecotv/work" ]
    assert [ -f "$PROJ/.pecotv/state/.plugin-sync-version" ]
    assert [ -f "$PROJ/.pecotv/README.md" ]
    assert [ -f "$PROJ/.pecotv/CHANGELOG.md" ]
    run read_output "$PROJ/.pecotv/.gitignore"
    assert_success
    assert_line '*'
}

@test "マーカーが plugin.json より新しいと、同期を skip する" {
    explains '初回の実行後に README を消して、もう一度動かすテストです。マーカーが `plugin.json` より新しいので同期が skip され、README が再コピーされないことを確認します。'
    mkdir -p "$PROJ"
    run_attached _run_hook "$PROJ"
    assert_success
    rm -f "$PROJ/.pecotv/README.md"
    run_attached _run_hook "$PROJ"
    assert_success
    assert [ ! -f "$PROJ/.pecotv/README.md" ]
}

@test "plugin.json が更新されると、README と CHANGELOG を再同期する" {
    explains '初回の実行後に `plugin.json` を更新し、CHANGELOG を v2 にして動かすテストです。README が再コピーされ、CHANGELOG が v2 に入れ替わることを確認します。'
    mkdir -p "$PROJ"
    run_attached _run_hook "$PROJ"
    assert_success
    rm -f "$PROJ/.pecotv/README.md"
    touch "$FIXTURE/.claude-plugin/plugin.json"
    echo "# fixture CHANGELOG v2" > "$FIXTURE/CHANGELOG.md"
    run_attached _run_hook "$PROJ"
    assert_success
    assert [ -f "$PROJ/.pecotv/README.md" ]
    run read_output "$PROJ/.pecotv/CHANGELOG.md"
    assert_success
    assert_output --partial "v2"
}

@test "CLAUDE_PROJECT_DIR が未定義だと、何もせず正常終了する" {
    explains '`CLAUDE_PROJECT_DIR` を外して `pecotv-dir-init.sh` を動かすテストです。終了コード 0 で、`.pecotv` が作られないことを確認します。'
    mkdir -p "$PROJ"
    cd "$PROJ"
    unset CLAUDE_PROJECT_DIR
    PLUGIN_HOOKS="$FIXTURE/hooks" run_attached bash "$HOOK"
    assert_success
    assert [ ! -d "$PROJ/.pecotv" ]
}

# 最終状態の確認で、旧順序でも通る。コピーより先に gitignore を終える順序は、失敗注入の 2 本が固定する。
@test "tmp/ だけの旧い .gitignore のリポでも、同期物と .gitignore 自身が untracked に出ない" {
    explains '`tmp/` だけの旧い `.gitignore` を持つ git リポで、`pecotv-dir-init.sh` を動かすテストです。同期された物と `.gitignore` 自身が `git status` の untracked に出ないことを確認します。'
    _make_old_repo "$PROJ"
    run_attached _run_hook "$PROJ"
    run _git -C "$PROJ" status --porcelain -uall -- .pecotv/
    assert_output ""
}

# README.md を dangling symlink にして cp を失敗させる。非 0 終了で注入が働いたことを、順序は untracked の空で見る。
@test "最初のコピー対象の README.md で失敗しても、untracked が残らない" {
    explains '`README.md` を宛先の無いシンボリックリンクにして、最初のコピーを失敗させるテストです。終了コードが 0 でなく、`.pecotv` に untracked が残らないことを確認します。'
    _make_old_repo "$PROJ"
    ln -s "$BATS_TEST_TMPDIR/nonexistent/target" "$PROJ/.pecotv/README.md"
    run_attached _run_hook "$PROJ"
    assert_failure
    run _git -C "$PROJ" status --porcelain -uall -- .pecotv/
    assert_output ""
}

# README.md はコピー済みの時点で CHANGELOG.md のコピーを失敗させる。
@test "コピー途中の CHANGELOG.md で失敗しても、untracked が残らない" {
    explains '`CHANGELOG.md` を宛先の無いシンボリックリンクにして、README のコピー後に失敗させるテストです。終了コードが 0 でなく、`.pecotv` に untracked が残らないことを確認します。'
    _make_old_repo "$PROJ"
    ln -s "$BATS_TEST_TMPDIR/nonexistent/target" "$PROJ/.pecotv/CHANGELOG.md"
    run_attached _run_hook "$PROJ"
    assert_failure
    run _git -C "$PROJ" status --porcelain -uall -- .pecotv/
    assert_output ""
}
