# check-pm-guard.sh の PECOTV_PM_GUARD_BEHAVIOR による挙動確認の切り替えを確かめる (#1080)。
# npm / yarn / pnpm を含まない PATH で起動し、挙動確認を即 SKIP させて見出しの有無だけを見る。

bats_require_minimum_version 1.5.0

GUARD="$BATS_TEST_DIRNAME/../check-pm-guard.sh"
# check-pm-guard.sh が出す見出しと同じ文字列にする。
BEHAVIOR_HEADING="check-pm-guard: 挙動確認"
STATIC_HEADING="check-pm-guard: 静的確認"

setup_file() {
    # 静的確認に要る外部コマンドだけを集めた PATH を作る（npm / yarn / pnpm は入れない）。
    local bin="$BATS_FILE_TMPDIR/bin" tool src
    mkdir -p "$bin"
    for tool in bash dirname basename node awk grep sed cat mktemp rm cp find sort timeout git; do
        src="$(command -v "$tool" 2> /dev/null)" || continue
        ln -s "$src" "$bin/$tool"
    done
    if [ ! -e "$bin/node" ]; then
        echo "ERROR: node が PATH に無いため check-pm-guard.sh の静的確認を起動できない" >&2
        return 1
    fi
}

setup() {
    bats_load_library pecot-bats
}

# $1=PECOTV_PM_GUARD_BEHAVIOR の値（空なら未設定で起動）。結果を $status・$output に置く。
run_guard() {
    if [ -z "$1" ]; then
        run_attached env -u PECOTV_PM_GUARD_BEHAVIOR PATH="$BATS_FILE_TMPDIR/bin" bash "$GUARD"
    else
        run_attached env PECOTV_PM_GUARD_BEHAVIOR="$1" PATH="$BATS_FILE_TMPDIR/bin" bash "$GUARD"
    fi
}

@test "PECOTV_PM_GUARD_BEHAVIOR が未設定なら、静的確認と挙動確認の両方をして成功する" {
    explains "\`PECOTV_PM_GUARD_BEHAVIOR\` を設定せずに \`check-pm-guard.sh\` を起動するテストです。終了コード 0 で、静的確認と挙動確認の両方の見出しが出力されることを確認します。"
    run_guard ""
    assert_success
    assert_output --partial "$STATIC_HEADING"
    assert_output --partial "$BEHAVIOR_HEADING"
}

@test "PECOTV_PM_GUARD_BEHAVIOR が 1 なら、未設定と同じく両方の確認をして成功する" {
    explains "\`PECOTV_PM_GUARD_BEHAVIOR=1\` で \`check-pm-guard.sh\` を起動するテストです。未設定の場合と同じく、終了コード 0 で両方の見出しが出力されることを確認します。"
    run_guard 1
    assert_success
    assert_output --partial "$STATIC_HEADING"
    assert_output --partial "$BEHAVIOR_HEADING"
}

@test "PECOTV_PM_GUARD_BEHAVIOR が 0 なら、静的確認だけをして挙動確認を飛ばした理由をログに出す" {
    explains "\`PECOTV_PM_GUARD_BEHAVIOR=0\` で \`check-pm-guard.sh\` を起動するテストです。終了コード 0 で静的確認の見出しだけが出力され、挙動確認を省いた理由がログに表示されることを確認します。"
    run_guard 0
    assert_success
    assert_output --partial "$STATIC_HEADING"
    refute_output --partial "$BEHAVIOR_HEADING"
    assert_output --partial "PECOTV_PM_GUARD_BEHAVIOR=0"
}
