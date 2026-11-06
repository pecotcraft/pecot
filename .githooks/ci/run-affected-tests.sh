#!/usr/bin/env bash
# pre-push で nx affected の test target を実行する root 共通のチェック。
#
# Hook stage: pre-push
#
# テスト範囲の決定を nx project graph に一本化する。
# 従来の path 正規表現ベースの `<plugin>-run-tests`（`files: ^plugins/<plugin>/`）は廃止した。
# nx.json・ルート package.json 等の設定変更が plugin に波及するケースを取りこぼすため。
# 本フック 1 本で `nx affected -t <test レーン名の列挙>` を実行する。
# これにより project.json の test-* target 経由で dispatch する。
#
# 起点の `test`（nx:noop）ではなく、レーンを名前で要求する。
# その理由とレーン名の集め方は lib/nx-lanes.sh を参照（#1232）。
# nx 24 のタスク単位 affected は、起点を要求すると起点自身が affected になる。
# その結果、全レーンを連れてくる。
# 変更が届いたレーンだけを実行するには、レーンを要求する。
# 全 project のフォールバック（run-many）は、起点の `test` を要求する。
# これは全レーンを実行する流れで、affected の選択に左右されない。
#
# base/head の解決は、version-plan ガードと同一の共有 lib（lib/push-range.sh）を使う。
# これにより、両チェックが同じ push range を評価することを構造で保証する。
#
# 起動方法は次の 2 通り。
#   (a) pre-commit 経由 (env PRE_COMMIT_TO_REF / PRE_COMMIT_FROM_REF)。
#   (b) git pre-push stdin 直接 (<local_ref> <local_sha> <remote_ref> <remote_sha>)。
#   いずれも FROM は merge-base(base, local) で自前算出する（version-plan ガードと同じ）。
#
# 判定不能時の方針。ローカル pre-push が唯一のテストのチェックのため、fail-open は採らない。
#   - base / merge-base / push 情報が解決不能 → WARN + `nx run-many -t test`（全 project）へフォールバック。
#     フォールバックのテスト失敗（非 0）は握り潰さず、push をブロックする。
#     複数 tip が全てフォールバック条件に該当しても、run-many は 1 回だけ実行する。
#     フォールバック要求をフラグに集約し、tip ループ後にまとめて実行する。
#   - nx / node が解決不能 → fail-closed（復旧手順入り ERROR + exit 1）。
#     緊急回避は `git push --no-verify` が標準の逃げ道で、専用 skip env は設けない。
#   - ブランチ削除 push (to=ZERO_SHA) / from==to / tip が commit へ peel 不能 (annotated tag 等)
#     → exit 0（テスト実行なし）。
#
# lane は --parallel=N で並列に実行する（#1080）。
# build / install の共有生成物は各 lane の test target の dependsOn へ寄せてある。
# そのため、並列でも 1 push 1 回に収束する。
#
# 失敗時の出力方針 (#1079):
#   - nx へ `--nxBail` を渡し、最初に失敗したレーンで未着手のレーンを打ち切る。
#   - nx の stdout/stderr は端末に直接流さない。`<repo_root>/.pecot/tmp/pre-push/nx-affected-tests.log` へ書く。
#     pre-commit は hook の出力を完了まで捕捉するため、stream 出力は実行中の端末に届かない。
#     別端末から `tail -f` で進行を見られるように、ファイル名は固定にする。
#     truncate は最初の nx 呼び出しの直前に行う。
#     以降の tip ループとフォールバックは、同一ファイルへ追記する。
#     nx を起動しない push では、前回のログを残す。
#   - 非 0 終了時は、その nx 呼び出しがログへ書いた範囲だけを対象に報告する。
#     複数 tip の push では、先行 nx 実行の同名レーンの行が混在するため。
#     末尾要約（`Failed tasks:` 以降）から失敗 project を取る。
#     その project の接頭辞（`<project>: `）を持つ行と要約を、stderr へ出す。
#     並列実行でレーンの出力が交互に混在するため、位置でなく接頭辞で切り出す。
#     本文は末尾から、行数と byte の両上限で切り詰める。
#     失敗 project が取れなければ、最後の要約ブロック以降と、ログ末尾の一定行数を出す。
#     nx の exit code も端末へ出す。
#     nx の bail 由来 exit 130 は SIGINT と誤読されるため、exit 1 に正規化する。
#
# レーン別の所要の取得 (#1083):
#   - nx 起動時に `NX_PROFILE=.pecot/tmp/pre-push/nx-profile.json` を付ける。
#     task ごとの所要（trace JSON の `ph:"X"` 要素）を書かせるため。
#     nx は値を `path.join(cwd, 値)` で解決するため、相対パスが必須となる。
#     nx は repo root へ cd した subshell で起動する。
#     nx は失敗時も profile を書く。起動ごとに前回分を削除してから起動する。
#   - NX_PROFILE は task の子プロセスへ継承される。
#     将来レーン内で nx を入れ子起動すると、その nx もレーンの cwd 基準（plugins/<plugin>/.pecot/tmp/...）へ profile を書く。
#     入れ子起動を入れるときは、レーン側で NX_PROFILE を外す。
#
# 所要の記録 (#1083):
#   - `<repo_root>/.pecot/tmp/githooks-timing.tsv`（lib/timing.sh）へ追記する。
#     nx の task 1 件につき task 行を、nx の起動 1 回につき nx 行を書く。
#     nx 行の内容は parallel / lanes / longest / 記録処理の秒 rec。
#     profile が無い、または JSON として読めない場合は WARN を出し、nx 行は lanes=0 で残す。
#     記録の成否は exit code を変えない。
#     hook 行はラッパー（with-timing.sh）が書く。
#   - nx を 1 回以上起動して成功した push では、stdout へ 1 行を出す。
#     内容は合計秒・最長 test task・並列度・レーン数（重複除外のレーン名の数）。
#     skip 系と失敗 push では出さない。
#     先頭ラベルは、affected のみなら `nx affected tests:`、run-many を使ったなら `nx run-many tests:`。
#   - レーンに数える task は、args.target.target（無ければ task id の 2 要素目）が `test-*` のもの。
#     `test` は各 project のレーンを dependsOn で束ねる nx:noop の起点なので、数えない。
#     configuration 付き（`<project>:test-cli:ci`）も数える。レーン名は `<project>:<target>`。
#     所要は nx の壁時計差のため、負になり得る。その場合は 0 に丸める。

set -euo pipefail

# shellcheck source=../lib/timing.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/timing.sh"
hook_start_us=$(timing_now_us)

# nx の lane 並列度。N=4 で確定 (#1225)。
# 24 コアで N=2〜4 を各 3 回測り、中央値が最短（83.5 秒）だった。N=3 の 1 回は drawio export の flaky で失敗した。
# 値を変えるときは test_run_affected_tests.py の `--parallel=` と「並列 N」も直す。
NX_PARALLEL=4

# shellcheck source=../lib/push-range.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/push-range.sh"
# shellcheck source=../lib/nx-lanes.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/nx-lanes.sh"

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -z "$repo_root" ]; then
    echo "ERROR: repo root を解決できません（git rev-parse --show-toplevel 失敗）。" >&2
    echo "       git 管理下のディレクトリから push してください。" >&2
    exit 1
fi

# nx / node を fail-closed で解決（テストのチェックを素通しさせない）。
if ! command -v node > /dev/null 2>&1; then
    cat >&2 <<'EOF'
ERROR: node が見つからないため affected テストを実行できません。
       node をインストールしてから再度 push してください。
       緊急で回避する場合のみ `git push --no-verify` を使ってください。
EOF
    exit 1
fi
if ! nx_bin=$(resolve_nx "$repo_root"); then
    cat >&2 <<'EOF'
ERROR: nx 実行ファイルが見つからないため affected テストを実行できません。
       リポジトリルートで依存を導入してください:
         pnpm install --frozen-lockfile
       緊急で回避する場合のみ `git push --no-verify` を使ってください。
EOF
    exit 1
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

# nx 1 回分の profile を読み、task 行と nx 行を記録して push 全体の集計へ足す。
# 引数は <nx サブコマンド（affected|run-many）>、<nx の所要秒>、<nx の exit code> の 3 つ。
# 記録・解析の失敗は WARN に留め、呼び出し元の exit code を変えない。
# nx が profile を書く前に終了した場合（exit code 非 0 かつ profile 無し）は、失敗報告に任せる。
# この場合は WARN を出さない。
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

# 失敗レーンの本文として stderr へ出す上限。行数上限を先に当ててから byte 上限を
# 行境界で当てる（`tail -c` はマルチバイト文字を分断して端末を文字化けさせる）。
# 400 行の根拠は #1079 の計測にある。
# 最大の vitest レーン本文（pecot-visual の cli レーン, 351 行）は、丸ごと収まる。
# pytest レーン（pecot-workflow の hooks レーン, 1,728 行）は、進捗ドットが `<project>: .` として 1 行ずつ出る。
# そのため末尾の FAILURES 以降だけに切り詰まる。
nx_log_tail_lines=400
nx_log_tail_bytes=65536
# 失敗 project が要約から取れないときに出すログ末尾の行数。
nx_log_fallback_lines=80

# stdin の本文を末尾から切り詰めて stdout へ出す。行数上限 → byte 上限の順で、
# byte 上限も行境界で当てる（マルチバイト分断を避けるため）。
truncate_body_tail() {
    tail -n "$nx_log_tail_lines" \
        | tac \
        | LC_ALL=C awk -v max="$nx_log_tail_bytes" '{ n += length($0) + 1; if (n <= max) print }' \
        | tac
}

# nx 非 0 終了時に、原因が読み切れる範囲だけを stderr へ出す。
# 対象はこの nx 呼び出しがログへ書いた範囲（$nx_log_offset の次行以降）に限る。
# 末尾要約は範囲内の最後の `^ *NX ` 行から EOF まで。失敗 project は要約内の
# `Failed tasks:` 以降の `- <project>:<target>` 行から取る（`Tasks not run ...` の
# 列挙は含めない）。project の並びは要約の順序を保つ。
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
        failed_projects=$(tail -n "+$summary_start" "$nx_log" \
            | awk '/Failed tasks:/ { on = 1; next } on && /^[[:space:]]*-[[:space:]]+[^:[:space:]]+:/ { sub(/^[[:space:]]*-[[:space:]]+/, ""); sub(/:.*$/, ""); print }' \
            | awk '!seen[$0]++')
    fi
    {
        echo
        echo "nx exit code: $nx_rc"
        if [ -n "$failed_projects" ]; then
            while IFS= read -r project; do
                [ -n "$project" ] || continue
                echo "=== 失敗レーン: $project ==="
                # 接頭辞はリテラル一致で取る（project 名を正規表現として解釈しない）。
                body=$(tail -n "+$scope_start" "$nx_log" \
                    | awk -v p="$project" 'index($0, p ": ") == 1') || true
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

# nx を 1 回起動し、出力をログへ追記する。非 0 なら失敗レーンを報告して push をブロックする。
# 初回呼び出しでログを truncate し、呼び出しごとに開始オフセットを控える（報告範囲の限定用）。
# 色付けは NO_COLOR=1 と FORCE_COLOR の除去で止める（ANSI がログと端末の抽出を汚すため）。
# 終了後は成否によらず所要を記録してから判定する（失敗レーンの所要も残すため）。
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

# 全 project の test target を実行するフォールバック。
# nx の非 0（テスト失敗）は握り潰さず、報告のうえ exit 1 で push をブロックする。
# フォールバックでは PECOTV_PM_GUARD_BEHAVIOR を未設定（= 静的チェック + 挙動チェックの両方）で
# 起動する。push range が解決できていない以上、ガード対象の変更有無を判定できないため。
# unset は必須: 複数 tip の push で先行 tip が =0 を export した後に後続 tip が
# フォールバックへ落ちると、その値が run-many まで引き継がれてしまう。
run_all_tests() {
    unset PECOTV_PM_GUARD_BEHAVIOR
    run_nx "$nx_bin" run-many -t test --parallel="$NX_PARALLEL" --nxBail --output-style=stream
}

# push される tip を列挙。何も得られなければ push 情報なしとして全 project へフォールバック。
declare -a tips=()
while IFS= read -r tip; do
    [ -z "$tip" ] && continue
    tips+=("$tip")
done < <(collect_push_tips)

if [ "${#tips[@]}" -eq 0 ]; then
    echo "WARN: push 情報なし（pre-commit env と pre-push stdin のどちらからも取得できず）のため全 project の test を実行します。" >&2
    run_all_tests
    print_timing_summary
    exit 0
fi

# 複数 tip が全てフォールバック条件に該当しても run-many は 1 回だけ実行する。
# フォールバック要求をフラグへ集約し、WARN は初回のみ出す。affected が解決できた
# tip はその場で tip ごとに affected を実行する（従来どおり）。
fallback_requested=0
warn_once() {
    if [ "$fallback_requested" -eq 0 ]; then
        echo "$1" >&2
    fi
    fallback_requested=1
}

# affected に渡す test レーン名（nx graph から 1 回だけ集める。最初の affected の直前に埋める）。
test_lanes=""

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

    # rc=0 なら range は "<from> <to>" の 2 トークン。万一空なら BUG として即終了
    # （resolve_push_range の契約違反。空 range で affected を呼ぶと nx が全 project
    # 評価へ暴走しうるため防衛する）。
    [ -n "$range" ] || { echo "BUG: resolve_push_range が rc=0 で空 range を返しました。" >&2; exit 1; }

    from="${range%% *}"
    to="${range##* }"

    # pm-guard の挙動チェック（隔離 install と npx の確認、数秒）の結果は、
    # ガードの保護対象が push range で変わらない限り不変。
    # 対象は、各 package.json の devEngines / engines、.npmrc、pnpm-workspace.yaml のメンバー、チェックスクリプト自体。
    # 変更が無い push では、静的チェックだけに絞る (#1080)。
    # grep へはヒアストリングで渡す（パイプだと grep -q の早期終了が pipefail に拾われる）。
    changed_files=$(git -C "$repo_root" diff --name-only "$from" "$to" 2>/dev/null || true)
    if grep -qE '(^|/)(package\.json|\.npmrc|pnpm-workspace\.yaml)$|check-pm-guard\.sh$' \
        <<< "$changed_files"; then
        export PECOTV_PM_GUARD_BEHAVIOR=1
    else
        export PECOTV_PM_GUARD_BEHAVIOR=0
    fi

    # レーン名が取れなければ fail-closed（空の -t で nx を起動すると全 target を評価しうる）。
    # nx_lane_targets が ERROR を stderr へ出す。
    if [ -z "$test_lanes" ]; then
        test_lanes=$(nx_lane_targets "$nx_bin" "$repo_root" test) || exit 1
    fi

    # affected が 0 件なら nx は no-op で exit 0。テスト失敗時は失敗レーンの出力を
    # 報告して exit 1 で即終了する（push ブロック）。
    # 複数 tip の push では tip ごとに nx を起動するため、install / build も tip の数だけ実行される。
    run_nx "$nx_bin" affected -t "$test_lanes" \
        --base="$from" --head="$to" --parallel="$NX_PARALLEL" --nxBail --output-style=stream
done

# 1 件以上の tip がフォールバック条件に該当していたら run-many を 1 回だけ実行。
if [ "$fallback_requested" -eq 1 ]; then
    run_all_tests
fi

print_timing_summary
exit 0
