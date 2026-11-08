# shellcheck shell=bash
# nx affected の `-t` に渡すレーン名（target 名）を project graph から集める共通 lib。
#
# run-affected-tests.sh（pre-push）と run-affected-lint.sh（pre-commit）が source して使う。
#
# なぜ `-t test` / `-t lint` でなくレーン名を並べるのか (#1232)。
#   nx 24 のタスク単位 affected は、変更が届いた「要求 target のタスク」だけを選ぶ。
#   選んだタスクの依存は、丸ごと実行対象に足される。
#   起点（`test` / `lint` の nx:noop）を要求すると、起点自身が project 全体を入力にして affected になる。
#   その結果、全レーンが残る。
#   レーンを直接要求すれば、変更が届いたレーンだけが選ばれる。
#   target 名の glob（`-t 'test-*'`）は完全一致で 0 件になるため使えない。
#   レーン名は project.json の定義から実行時に集める。
#   これでレーンを足してもフックを直さずに済む。
#
# 方針:
#   - この lib は `set` しない。source 元のオプションを尊重する。
#   - graph が取れないとき、またはレーンが 1 つも無いときは fail-closed とする。
#     終了コードは非 0 で、ERROR は stderr へ出す。
#     空の `-t` で nx を起動すると全 target を評価しうる。
#     そのため、呼び出し側は非 0 で止める。
#   - `nx graph --file` の計算 1 回分の所要は、この repo（3 project + nx-release）で約 0.3 秒。
#     測定条件は 2026-10-26、nx 24.0.1 で、workspace-data を空にした場合も同じ。
#
# 提供する関数:
#   require_repo_node_nx <ci|push>   → グローバル repo_root と nx_bin を設定する。
#                                      解決できなければ引数に合わせた案内を stderr へ出し、非 0 を return する。
#   nx_graph_json <nx_bin> <repo_root> <out_file> <log_file>
#                                    → graph の JSON を out_file へ書く。
#                                      nx の出力は log_file へ書く。失敗で非 0。
#       失敗時の扱いは呼び出し側に任せる。
#       レーン収集は ERROR で止め、version plan のチェックは skip する。
#       check-version-plan-required.sh もこの関数で graph を取る。
#   nx_lane_targets <nx_bin> <repo_root> <test|lint>
#                                    → 該当 target 名をカンマ区切り 1 行で stdout へ出す。失敗で非 0。
#       名前が `^test(-|$)`（test）または `^lint(-|$)`（lint）に当たる target を集める。
#       ただし executor が nx:noop または nx:run-script の target は除く。
#       - nx:noop（レーンを束ねる起点）は除く。起点を `-t` に入れると、起点自身が affected になる。
#       - nx:run-script（package.json の scripts 由来。例: postinstall）は、名前が合っても
#         チェックの対象ではないので除く。
#       - 実体の `test` / `lint` target（pecot-tools の `lint` など）は集まる。

# repo root・node・nx を fail-closed で解決する。呼び出し側は失敗で exit する。
# 引数は案内の文言を決める（ci: CI の一覧づくり、push: pre-push のチェック）。
require_repo_node_nx() {
    local ctx="$1" what="レーンの一覧を作れません"
    [ "$ctx" != "push" ] || what="affected テストを実行できません"
    repo_root=$(git rev-parse --show-toplevel 2> /dev/null || echo "")
    if [ -z "$repo_root" ]; then
        echo "ERROR: repo root を解決できません（git rev-parse --show-toplevel 失敗）。" >&2
        [ "$ctx" != "push" ] || echo "       git 管理下のディレクトリから push してください。" >&2
        return 1
    fi
    if ! command -v node > /dev/null 2>&1; then
        echo "ERROR: node が見つからないため${what}。" >&2
        if [ "$ctx" = "push" ]; then
            echo "       node をインストールしてから再度 push してください。" >&2
            echo '       緊急で回避する場合のみ `git push --no-verify` を使ってください。' >&2
        fi
        return 1
    fi
    if ! nx_bin=$(resolve_nx "$repo_root"); then
        echo "ERROR: nx 実行ファイルが見つからないため${what}。" >&2
        if [ "$ctx" = "push" ]; then
            echo "       リポジトリルートで依存を導入してください:" >&2
            echo "         pnpm install --frozen-lockfile" >&2
            echo '       緊急で回避する場合のみ `git push --no-verify` を使ってください。' >&2
        else
            echo "       pnpm install --frozen-lockfile を先に実行してください。" >&2
        fi
        return 1
    fi
}

# project graph の JSON を out_file へ書く。nx の stdout / stderr は log_file へ。
# パイプ（--file=stdout）は、大きな JSON を途中で切ることがある。
# そのため、呼び出し側は out_file を一時ファイルにする。
# 色は端末依存の揺れ（ログの ANSI）を避けるため切る。
nx_graph_json() {
    local nx_bin="$1" repo_root="$2" out_file="$3" log_file="$4"
    (cd "$repo_root" && env -u FORCE_COLOR NO_COLOR=1 "$nx_bin" graph --file="$out_file") \
        > "$log_file" 2>&1
}

# graph の JSON から kind に当たる target 名を重複なし・昇順で 1 行 1 件出す。
# shellcheck disable=SC2016  # node へ渡す JS 本文
_nx_lane_names_js='
const fs = require("fs");
const kind = process.argv[2];
const pattern = kind === "test" ? /^test(-|$)/ : /^lint(-|$)/;
const skippedExecutors = new Set(["nx:noop", "nx:run-script"]);
const nodes = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).graph.nodes;
const names = new Set();
for (const node of Object.values(nodes)) {
    const targets = (node.data && node.data.targets) || {};
    for (const [target, config] of Object.entries(targets)) {
        if (!pattern.test(target)) continue;
        if (skippedExecutors.has(config && config.executor)) continue;
        names.add(target);
    }
}
process.stdout.write([...names].sort().join("\n") + (names.size ? "\n" : ""));
'

nx_lane_targets() {
    local nx_bin="$1" repo_root="$2" kind="$3"
    case "$kind" in
        test | lint) ;;
        *)
            echo "BUG: nx_lane_targets の kind は test か lint です（受け取った値: $kind）。" >&2
            return 2
            ;;
    esac

    # パイプ（--file=stdout）は、大きな JSON を途中で切ることがある。
    # そのため一時ファイルで受ける。
    # 一時ファイルは CLI / hook 専用の .pecot/tmp に作り、終了時に消す。
    local tmp_base="$repo_root/.pecot/tmp" work
    mkdir -p "$tmp_base" 2> /dev/null || true
    if ! work=$(mktemp -d "$tmp_base/nx-lanes.XXXXXX" 2> /dev/null); then
        echo "ERROR: 一時ディレクトリを作れないため nx のレーン名を集められません（$tmp_base）。" >&2
        return 1
    fi
    # shellcheck disable=SC2064
    trap "rm -rf '$work'" RETURN

    if ! nx_graph_json "$nx_bin" "$repo_root" "$work/graph.json" "$work/nx.log"; then
        {
            echo "ERROR: nx graph が失敗したため $kind のレーン名を集められません。"
            sed 's/^/       /' "$work/nx.log"
        } >&2
        return 1
    fi

    local names
    if ! names=$(node -e "$_nx_lane_names_js" "$work/graph.json" "$kind" 2> "$work/node.err"); then
        {
            echo "ERROR: nx graph の出力から $kind のレーン名を読めませんでした。"
            sed 's/^/       /' "$work/node.err"
        } >&2
        return 1
    fi
    if [ -z "$names" ]; then
        echo "ERROR: nx graph に $kind のレーン（target 名 ${kind} / ${kind}-*）が 1 つもありません。" >&2
        return 1
    fi
    # 改行をカンマへ（nx の -t はカンマ区切り 1 引数）。
    paste -sd, <<< "$names"
}
