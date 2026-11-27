#!/usr/bin/env bash
# bats の report formatter。拡張 TAP のストリームを読み、@test ごとの Allure の結果を 1 行の JSON で stdout に出す。
# stdout は bats が --output の report.log に書き、run.sh が結果のファイルに分ける。

_FMT_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)"
# shellcheck source=../allure-result.sh
. "$_FMT_ROOT/.githooks/scripts/test_report/allure-result.sh"
# shellcheck source=/dev/null
. "$BATS_ROOT/$BATS_LIBDIR/bats-core/formatter.bash"

suite_rel=""
suite_layer=""
begun_index=""
begun_ms=""
description=""
severity=""
pending=""
pending_status=""
pending_title=""
pending_message=""
pending_start=""
pending_stop=""
pending_description=""
pending_severity=""
pending_lines=()

# 説明の欄に入れるコメント。helpers.bash の explains が fd 3 に書く。
_DESCRIPTION_PREFIX="pecot-description: "
# 重大度の段階。pecot-bats の severity が fd 3 に書く。
_SEVERITY_PREFIX="pecot-severity: "

_finish() { # <status> <題> <理由>
    local now
    now="$(allure_result_now_ms)"
    pending=1
    pending_status="$1"
    pending_title="$2"
    pending_message="$3"
    pending_stop="$now"
    if [ -n "${BATS_FORMATTER_TEST_DURATION:-}" ]; then
        pending_start=$((now - BATS_FORMATTER_TEST_DURATION))
    else
        pending_start="${begun_ms:-$now}"
    fi
    pending_description="$description"
    pending_severity="$severity"
    pending_lines=()
    begun_index=""
    description=""
    severity=""
}

# not ok の後のコメントから、bats-assert の見出し（-- … --）か、落ちたコマンドの行を理由にする。
_failure_message() {
    local line first=""
    for line in "${pending_lines[@]}"; do
        if [[ "$line" =~ ^--\ (.+)\ --$ ]]; then
            printf '%s' "${BASH_REMATCH[1]}"
            return
        fi
    done
    for line in "${pending_lines[@]}"; do
        [ -n "$first" ] || first="$line"
        if [[ "$line" == *"' failed"* ]]; then
            line="${line#"${line%%[![:space:]]*}"}"
            printf '%s' "$line"
            return
        fi
    done
    printf '%s' "$first"
}

# bats-assert の「expected : 値」の 1 行の形と、「expected (N lines):」の後に 2 字下げで続く形を読む。
_assert_value() { # <キー>
    local key="$1" line value="" reading=""
    for line in "${pending_lines[@]}"; do
        if [ -n "$reading" ]; then
            if [[ "$line" == "  "* ]]; then
                value+="${value:+$'\n'}${line#  }"
                continue
            fi
            break
        fi
        if [[ "$line" =~ ^${key}\ +:\ (.*)$ ]]; then
            printf '%s' "${BASH_REMATCH[1]}"
            return 0
        fi
        if [[ "$line" =~ ^${key}\ \([0-9]+\ lines\):$ ]]; then
            reading=1
        fi
    done
    [ -n "$reading" ] || return 1
    printf '%s' "$value"
}

_flush() {
    [ -n "$pending" ] || return 0
    pending=""
    local message="$pending_message" trace="" line expected actual
    for line in "${pending_lines[@]}"; do
        trace+="${trace:+$'\n'}$line"
    done
    if [ "$pending_status" = failed ] && [ -z "$message" ]; then
        message="$(_failure_message)"
    fi
    local compared=()
    if expected="$(_assert_value expected)" && actual="$(_assert_value actual)"; then
        compared=("$expected" "$actual")
    fi
    allure_result_write - "$suite_rel" bats "$pending_status" "$pending_title" "$message" \
        "$pending_start" "$pending_stop" "$pending_description" "$trace" "$suite_layer" "$pending_severity" "${compared[@]}"
    if [ "$pending_status" = passed ] && [ -z "$pending_description" ]; then
        printf 'missing-description: %s: %s\n' "$suite_rel" "$pending_title"
    fi
}

bats_tap_stream_plan() { :; }

bats_tap_stream_suite() {
    _flush
    suite_rel="$(allure_result_relpath "$1" "$_FMT_ROOT")"
    suite_layer="$(allure_result_layer "$suite_rel" "$_FMT_ROOT")"
}

bats_tap_stream_begin() {
    _flush
    begun_index="$1"
    begun_ms="$(allure_result_now_ms)"
    description=""
    severity=""
}

bats_tap_stream_ok() {
    _flush
    _finish passed "$2" ""
}

# begin の無い not ok は、setup_file・teardown_file・setup_suite などのファイルの単位の失敗。
bats_tap_stream_not_ok() {
    _flush
    local status=failed message=""
    if [ "$begun_index" != "$1" ]; then
        status=broken
        begun_ms=""
    fi
    if [ -n "${BATS_FORMATTER_TEST_TIMEOUT:-}" ]; then
        status=broken
        message="${BATS_FORMATTER_TEST_TIMEOUT} 秒で打ち切られた"
    fi
    _finish "$status" "$2" "$message"
}

bats_tap_stream_skipped() {
    _flush
    _finish skipped "$2" "$3"
}

bats_tap_stream_comment() { # <コメント> <scope>
    case "$2" in
        begin)
            if [[ "$1" == "$_DESCRIPTION_PREFIX"* ]]; then
                description="${1#"$_DESCRIPTION_PREFIX"}"
            elif [[ "$1" == "$_SEVERITY_PREFIX"* ]]; then
                severity="${1#"$_SEVERITY_PREFIX"}"
            fi
            ;;
        not_ok) pending_lines+=("$1") ;;
    esac
}

bats_tap_stream_unknown() { # <行> <scope>
    if [ "$2" = not_ok ]; then
        pending_lines+=("$1")
    fi
}

bats_parse_internal_extended_tap
_flush
