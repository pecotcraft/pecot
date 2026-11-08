#!/usr/bin/env bash
# pre-push で nx affected の test レーンを実行する root 共通のチェック（Hook stage: pre-push）。
# レーン名は lib/nx-lanes.sh で集めて要求する。起点の `test` を要求すると全レーンが選ばれる。

# shellcheck disable=SC2154  # repo_root と nx_bin は require_repo_node_nx が設定する
set -euo pipefail

# shellcheck source=../lib/timing.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/timing.sh"
hook_start_us=$(timing_now_us)

# 既定値 4。値を変えるときは test_run_affected_tests.py の `--parallel=` と「並列 N」も直す。
NX_PARALLEL="${PECOT_NX_PARALLEL:-4}"
if ! [[ $NX_PARALLEL =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: PECOT_NX_PARALLEL は正の整数です: $NX_PARALLEL" >&2
    exit 1
fi

# shellcheck source=../lib/push-range.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/push-range.sh"
# shellcheck source=../lib/nx-lanes.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/nx-lanes.sh"

# repo root・nx・node を fail-closed で解決（テストのチェックを素通しさせない）。
require_repo_node_nx push || exit 1

# CI の lane モード: PECOT_NX_LANE=<project>:<target> のレーン 1 本だけを動かす。
# PECOT_NX_CI=1 以外では無視する。手元の pre-push で、レーンが 1 本に狭まるのを防ぐ。
lane="${PECOT_NX_LANE:-}"
lane_project=""
lane_target=""
if [ -n "$lane" ] && [ "${PECOT_NX_CI:-}" != "1" ]; then
    echo "WARN: PECOT_NX_LANE は PECOT_NX_CI=1 のときだけ読みます。無視して affected を実行します: $lane" >&2
    lane=""
fi
if [ -n "$lane" ]; then
    if ! [[ $lane =~ ^([^:[:space:]]+):([^:[:space:]]+)$ ]]; then
        echo "ERROR: PECOT_NX_LANE は <project>:<target> の形です: $lane" >&2
        exit 1
    fi
    lane_project="${BASH_REMATCH[1]}"
    lane_target="${BASH_REMATCH[2]}"
    # まとめ役（<project>:test）は nx:noop で集合に入らない。入れると project の全レーンが動く。
    lane_set=$(nx_lane_targets "$nx_bin" "$repo_root" test) || exit 1
    if [[ ",$lane_set," != *",$lane_target,"* ]]; then
        echo "ERROR: PECOT_NX_LANE の target がテストのレーンにありません: $lane（レーン: $lane_set）" >&2
        exit 1
    fi
fi
# 直近の run の profile に lane の task があったか（record_lane_timings が立てる）。
lane_seen=0

# 失敗の切り出しと run-pr-checks.sh の skip 集計は、static の見出し `> nx run <project>:<target>` に依存する。
# 見出しの前に `::group::<icon> ` を伴う場合もある。
nx_static=0
nx_output_style="stream"
declare -a nx_bail_args=(--nxBail)
if [ "${PECOT_NX_CI:-}" = "1" ]; then
    nx_static=1
    nx_output_style="static"
    nx_bail_args=()
fi

# nx 出力の退避先。最初の nx 呼び出しの直前に truncate し、以降の呼び出しは追記する。
nx_log_dir="$repo_root/.pecot/tmp/pre-push"
nx_log="$nx_log_dir/nx-affected-tests.log"
# ログを初期化済みか（0 のあいだは nx 未起動 = 前回のログに触れていない）。
nx_log_started=0
# 直近の nx 呼び出しが書き始めたログ行のオフセット（その時点の行数）。
nx_log_offset=0

# nx の trace profile（repo root 相対。nx が cwd 基準で解決するため絶対パスにしない）。
nx_profile_rel=".pecot/tmp/pre-push/nx-profile.json"
nx_profile="$repo_root/$nx_profile_rel"
# push 全体の集計: nx 起動回数・最長 test task（秒は 0.1 秒単位の整数でも保持）・
# 重複除外のレーン名集合。
nx_runs=0
push_longest_name="-"
push_longest_sec=""
push_longest_tenths=-1
nx_used_run_many=0
declare -A push_lanes=()

# profile の task 要素（ph:"X"）を `<name>\t<秒(小数 1 桁)>\t<status>\t<target>` で 1 行 1 件出す。
# JSON として読めない・配列でない場合は非 0。
# shellcheck disable=SC2016  # node へ渡す JS 本文（$ は JS のテンプレート文字列）
nx_profile_tasks_js='
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!Array.isArray(data)) process.exit(2);
for (const e of data) {
    if (!e || e.ph !== "X") continue;
    const sec = (Math.max(0, Number(e.dur) || 0) / 1e6).toFixed(1);
    const status = (e.args && e.args.status) || "unknown";
    const target = (e.args && e.args.target && e.args.target.target) || String(e.name).split(":")[1] || "unknown";
    process.stdout.write(`${e.name}\t${sec}\t${status}\t${target}\n`);
}
'

# 記録・解析の失敗は WARN に留め、exit code を変えない。nx が profile を書く前に終了したときは WARN も出さない。
record_lane_timings() {
    local subcmd="$1" nx_sec="$2" nx_rc="$3"
    local rec_start_us tasks name sec status target tenths
    local lanes=0 longest="-" longest_sec="" longest_tenths=-1
    rec_start_us=$(timing_now_us)
    if [ -f "$nx_profile" ] && tasks=$(node -e "$nx_profile_tasks_js" "$nx_profile" 2> /dev/null); then
        while IFS=$'\t' read -r name sec status target; do
            [ -n "$name" ] || continue
            [[ $sec =~ ^[0-9]+\.[0-9]$ ]] || continue
            timing_record "$repo_root" task "$name" "$sec" "status=$status"
            [ -z "$lane" ] || [ "$(cut -d: -f1-2 <<< "$name")" != "$lane" ] || lane_seen=1
            if [[ $target == test-* ]]; then
                lanes=$((lanes + 1))
                push_lanes["$(cut -d: -f1-2 <<< "$name")"]=1
                tenths=$((10#${sec/./}))
                if [ "$tenths" -gt "$longest_tenths" ]; then
                    longest_tenths=$tenths
                    longest=$name
                    longest_sec=$sec
                fi
            fi
        done <<< "$tasks"
        if [ "$longest_tenths" -gt "$push_longest_tenths" ]; then
            push_longest_tenths=$longest_tenths
            push_longest_name=$longest
            push_longest_sec=$longest_sec
        fi
    elif [ -f "$nx_profile" ] || [ "$nx_rc" -eq 0 ]; then
        echo "WARN: nx の profile（$nx_profile）を読めないため、レーン別の所要を記録できませんでした。" >&2
    fi
    timing_record "$repo_root" nx "$subcmd" "$nx_sec" \
        "parallel=$NX_PARALLEL lanes=$lanes longest=$longest rec=$(timing_elapsed_sec "$rec_start_us")"
}

# 成功 push の合計行を stdout へ出す。nx を起動していなければ何も出さない。
print_timing_summary() {
    [ "$nx_runs" -gt 0 ] || return 0
    local total label="nx affected tests:"
    total=$(timing_elapsed_sec "$hook_start_us")
    [ "$nx_used_run_many" -eq 0 ] || label="nx run-many tests:"
    if [ "${#push_lanes[@]}" -gt 0 ]; then
        echo "$label 合計 ${total}s / 最長 $push_longest_name ${push_longest_sec}s" \
            "/ 並列 $NX_PARALLEL / レーン ${#push_lanes[@]}"
    else
        echo "$label 合計 ${total}s / 最長 - / 並列 $NX_PARALLEL / レーン 0"
    fi
}

# ログの $1 行目以降を出す。nx が末尾に書く `Performance Profile: <path>` 行は
# 失敗の原因と無関係なため除く。
nx_log_from() {
    tail -n "+$1" "$nx_log" | grep -v '^ *Performance Profile: ' || true
}

# 失敗レーンの本文の上限。byte は行境界で切る（`tail -c` はマルチバイト文字を分断する）。
nx_log_tail_lines=400
nx_log_tail_bytes=65536
# 失敗 project が要約から取れないときに出すログ末尾の行数。
nx_log_fallback_lines=80

truncate_body_tail() {
    tail -n "$nx_log_tail_lines" \
        | tac \
        | LC_ALL=C awk -v max="$nx_log_tail_bytes" '{ n += length($0) + 1; if (n <= max) print }' \
        | tac
}

# `Failed tasks:` の項目（列 0 の `- <id>`）だけを出す。字下げした性能レポートの推奨
# （`    - Cache: ...`）は項目でない。入力は最後まで読む（早期 exit は上流の tail を SIGPIPE で落とす）。
nx_failed_items_awk='
/Failed tasks:/ { on = 1; n = 0; next }
on == 1 && /^-[[:space:]]+[^:[:space:]]+:/ { n++; print; next }
on == 1 && n == 0 && /^[[:space:]]*$/ { next }
on == 1 { on = 2 }'

# 範囲は $nx_log_offset 以降（複数 tip の先行 run の行を混ぜない）。
# 失敗の単位は stream が project、static が `<project>:<target>`。
report_nx_failure() {
    local nx_rc="$1"
    local scope_start summary_offset summary_start failed_projects project
    local body body_lines shown shown_lines total start

    scope_start=$((nx_log_offset + 1))
    summary_offset=$(tail -n "+$scope_start" "$nx_log" | grep -n '^ *NX ' | tail -n 1 | cut -d: -f1) \
        || summary_offset=""
    summary_start=""
    failed_projects=""
    if [ -n "$summary_offset" ]; then
        summary_start=$((scope_start + summary_offset - 1))
        if [ "$nx_static" -eq 1 ]; then
            # `- <project>:<target>`（configuration 付きは `:ci` まで含めて 1 件）。
            failed_projects=$(tail -n "+$summary_start" "$nx_log" \
                | awk "$nx_failed_items_awk" \
                | sed -E 's/^-[[:space:]]+//; s/[[:space:]]+$//' \
                | awk '!seen[$0]++')
        else
            failed_projects=$(tail -n "+$summary_start" "$nx_log" \
                | awk "$nx_failed_items_awk" \
                | sed -E 's/^-[[:space:]]+//; s/:.*$//' \
                | awk '!seen[$0]++')
        fi
    fi
    {
        echo
        echo "nx exit code: $nx_rc"
        if [ -n "$failed_projects" ]; then
            while IFS= read -r project; do
                [ -n "$project" ] || continue
                echo "=== 失敗レーン: $project ==="
                if [ "$nx_static" -eq 1 ]; then
                    # 見出し（`> nx run <id>`、前に `::group::<icon> ` が付き得る）から、次の見出しか
                    # 最後の要約の手前までが task の塊。id は文字列の一致で判定する（正規表現にしない）。
                    body=$(tail -n "+$scope_start" "$nx_log" \
                        | awk -v id="$project" -v stop="$summary_start" -v base="$scope_start" '
                            {
                                if (stop != "" && base + NR - 1 >= stop) exit
                                line = $0
                                sub(/^::group::[^ ]+ /, "", line)
                                if (line ~ /^> nx run /) {
                                    cur = substr(line, 10)
                                    sub(/[ ].*$/, "", cur)
                                    on = (cur == id)
                                }
                                if (on && $0 != "::endgroup::") print
                            }') || true
                else
                    # 接頭辞はリテラル一致で取る（project 名を正規表現として解釈しない）。
                    body=$(tail -n "+$scope_start" "$nx_log" \
                        | awk -v p="$project" 'index($0, p ": ") == 1') || true
                fi
                body_lines=$(printf '%s\n' "$body" | wc -l)
                shown=$(printf '%s\n' "$body" | truncate_body_tail)
                shown_lines=$(printf '%s\n' "$shown" | wc -l)
                if [ "$shown_lines" -lt "$body_lines" ]; then
                    echo "... (先頭 $((body_lines - shown_lines)) 行を省略。上限 ${nx_log_tail_lines} 行 / ${nx_log_tail_bytes} bytes) ..."
                fi
                printf '%s\n' "$shown"
            done <<< "$failed_projects"
            nx_log_from "$summary_start"
        else
            # 要約が末尾から離れている（要約の後にレーン出力が続く）ケースでも要約を
            # 落とさないよう、ログ末尾 N 行と最後の要約ブロックの両方を含める。
            total=$(wc -l < "$nx_log")
            start=$((total - nx_log_fallback_lines + 1))
            [ "$start" -lt "$scope_start" ] && start=$scope_start
            if [ -n "$summary_start" ] && [ "$summary_start" -lt "$start" ]; then
                start=$summary_start
            fi
            [ "$start" -lt 1 ] && start=1
            echo "... (nx 要約から失敗 project を取れず。ログ末尾 ${nx_log_fallback_lines} 行と要約ブロック) ..."
            nx_log_from "$start"
        fi
        echo
        echo "全出力: $nx_log"
        echo "進行確認: tail -f $nx_log"
    } >&2
}

# NX_PROFILE は repo root 相対で渡す（nx が cwd 基準で解決する）。
run_nx() {
    local rc=0 nx_start_us nx_sec
    if [ "$nx_log_started" -eq 0 ]; then
        mkdir -p "$nx_log_dir"
        : > "$nx_log"
        nx_log_started=1
    fi
    nx_log_offset=$(wc -l < "$nx_log")
    rm -f "$nx_profile"
    nx_start_us=$(timing_now_us)
    (cd "$repo_root" && env -u FORCE_COLOR NO_COLOR=1 NX_PROFILE="$nx_profile_rel" "$@") >> "$nx_log" 2>&1 || rc=$?
    nx_sec=$(timing_elapsed_sec "$nx_start_us")
    nx_runs=$((nx_runs + 1))
    # $1 は nx 実行ファイル、$2 がサブコマンド（affected / run-many）。
    [ "$2" != "run-many" ] || nx_used_run_many=1
    record_lane_timings "$2" "$nx_sec" "$rc"
    if [ "$rc" -ne 0 ]; then
        report_nx_failure "$rc"
        exit 1
    fi
}

# 先行 tip が export した PECOTV_PM_GUARD_BEHAVIOR=0 を引き継がないよう unset する。
run_all_tests() {
    unset PECOTV_PM_GUARD_BEHAVIOR
    run_nx "$nx_bin" run-many -t test --parallel="$NX_PARALLEL" "${nx_bail_args[@]}" --output-style="$nx_output_style"
}

# lane モードの本体。nx run-many は target が無い project で 0 件のまま成功するため、task の有無を確かめる。
# $1 が空でなければ PECOTV_PM_GUARD_BEHAVIOR をその値で export し、空なら unset する。
run_lane() {
    if [ -n "$1" ]; then
        export PECOTV_PM_GUARD_BEHAVIOR="$1"
    else
        unset PECOTV_PM_GUARD_BEHAVIOR
    fi
    lane_seen=0
    run_nx "$nx_bin" run-many -t "$lane_target" -p "$lane_project" \
        --parallel="$NX_PARALLEL" "${nx_bail_args[@]}" --output-style="$nx_output_style"
    if [ "$lane_seen" -eq 0 ]; then
        echo "ERROR: $lane の task を nx の profile で見つけられません。project に target を定義したか確かめてください。" >&2
        exit 1
    fi
}

# push される tip を列挙。何も得られなければ push 情報なしとして全 project へフォールバック。
declare -a tips=()
while IFS= read -r tip; do
    [ -z "$tip" ] && continue
    tips+=("$tip")
done < <(collect_push_tips)

if [ "${#tips[@]}" -eq 0 ] && [ -n "$lane" ]; then
    # 判定を持たないと pm-guard は既定の動作になる（全 project の run と同じ）。
    echo "WARN: push 情報なしのため pm-guard の判定を省いて $lane を実行します。" >&2
    run_lane ""
    print_timing_summary
    exit 0
fi

if [ "${#tips[@]}" -eq 0 ]; then
    echo "WARN: push 情報なし（pre-commit env と pre-push stdin のどちらからも取得できず）のため全 project の test を実行します。" >&2
    run_all_tests
    print_timing_summary
    exit 0
fi

# 複数 tip がフォールバック条件に該当しても run-many は 1 回だけ実行する。
fallback_requested=0
warn_once() {
    if [ "$fallback_requested" -eq 0 ]; then
        echo "$1" >&2
    fi
    fallback_requested=1
}

# affected に渡す test レーン名（nx graph から 1 回だけ集める。最初の affected の直前に埋める）。
test_lanes=""
# lane モードで tip を通した pm-guard の判定（空は判定なし）。1 つでも 1 なら 1。
lane_guard=""

for tip in "${tips[@]}"; do
    range=$(resolve_push_range "$tip") && rc=0 || rc=$?
    case "$rc" in
        0) ;;
        10) continue ;;  # ブランチ削除 push (to=ZERO_SHA): テスト実行なし
        14) continue ;;  # from==to (no-op or default の祖先): テスト実行なし
        16) continue ;;  # tip が commit へ peel 不能 (annotated tag 等): テスト実行なし
        11)
            warn_once "WARN: base 解決失敗のため全 project の test を実行します。"
            continue ;;
        12)
            warn_once "WARN: base 未解決のため全 project の test を実行します。"
            continue ;;
        13)
            warn_once "WARN: merge-base 計算失敗のため全 project の test を実行します。"
            continue ;;
        15)
            warn_once "WARN: from/to sha が解決不能のため全 project の test を実行します。"
            continue ;;
        *)
            warn_once "WARN: push range 解決不能のため全 project の test を実行します。"
            continue ;;
    esac

    # 空 range で affected を呼ぶと nx が全 project を評価するため止める。
    [ -n "$range" ] || { echo "BUG: resolve_push_range が rc=0 で空 range を返しました。" >&2; exit 1; }

    from="${range%% *}"
    to="${range##* }"

    # pm-guard の挙動チェック（数秒）は、保護対象のファイルが変わった push だけで動かす。
    # grep へはヒアストリングで渡す（パイプだと grep -q の早期終了が pipefail に拾われる）。
    changed_files=$(git -C "$repo_root" diff --name-only "$from" "$to" 2>/dev/null || true)
    if grep -qE '(^|/)(package\.json|\.npmrc|pnpm-workspace\.yaml)$|check-pm-guard\.sh$' \
        <<< "$changed_files"; then
        guard=1
    else
        guard=0
    fi
    if [ -n "$lane" ]; then
        # レーンは繰り返しの外で 1 回だけ動かす。ここでは判定だけ残す。
        if [ "$guard" = 1 ] || [ -z "$lane_guard" ]; then lane_guard=$guard; fi
        continue
    fi
    export PECOTV_PM_GUARD_BEHAVIOR=$guard

    # レーン名が取れなければ止める（空の -t は全 target を評価する）。
    if [ -z "$test_lanes" ]; then
        test_lanes=$(nx_lane_targets "$nx_bin" "$repo_root" test) || exit 1
    fi

    run_nx "$nx_bin" affected -t "$test_lanes" \
        --base="$from" --head="$to" --parallel="$NX_PARALLEL" "${nx_bail_args[@]}" --output-style="$nx_output_style"
done

if [ -n "$lane" ]; then
    # フォールバック条件の tip があれば判定を空にする。判定を持たないと pm-guard は既定の動作になる。
    [ "$fallback_requested" -eq 0 ] || lane_guard=""
    run_lane "$lane_guard"
    print_timing_summary
    exit 0
fi

# 1 件以上の tip がフォールバック条件に該当していたら run-many を 1 回だけ実行。
if [ "$fallback_requested" -eq 1 ]; then
    run_all_tests
fi

print_timing_summary
exit 0
