#!/bin/bash
# Require a version plan when a feature branch changes files of a release group.
#
# Hook stage: pre-push
#
# PR ごとに、変更した release group の version plan を同じブランチで足すことを強制する。
# これはこのリポジトリのルールで、version plan 1 件が CHANGELOG の 1 行になる。
# `nx release plan:check` は、未リリースの version plan が 1 件でもあれば group を合格にする。
# ブランチで足したかどうかは見ない（nrwl/nx discussions #34719）。
# そのため、このガードで補う。
#
# 評価対象は、push される commit range (remote_sha..local_sha) ではない。
# branch 全体 (merge-base(default, local)..local) を評価する。
# follow-up push でも同じ判定になる。
# 最初の push で plan を同梱した後に追加 commit を push する場合を考える。
# range に plan が含まれなくても、branch 全体に plan があれば pass する。
#
# 判定ロジック:
#
#   1. release commit (`chore(release):`) を含む range は release cycle として無条件 pass する。
#      Nx Release が作る commit 群は素通しする。
#   2. range 内の変更ファイルを、nx の project graph の project root との最長一致で、
#      持ち主の project に割り当てる。
#      この考え方は、`nx release plan:check` の「持ち主の project」と同じ。
#      テストの inputs 経由で affected になるだけの project は数えない。
#      nx と違い、.gitignore / .nxignore に当たる変更は除外しない（git diff の全件を対象にする）。
#      README.md / CHANGELOG.md は数えない（version bump 不要な doc 変更を許容する）。
#      project root は作業ツリーの nx graph から取る。
#      そのため、作業ツリーが push 対象と食い違う場合は、作業ツリーの構成で判定される（nx graph の性質）。
#      release group に属さない project が、group に属する project の root 配下にある場合を考える。
#      その配下の変更は判定できない。
#      この場合は構成の誤りとして ERROR で止める（1 プラグイン = 1 nx project）。
#   3. touched な project を `release.groups[].projects` の membership で release group に割り当てる。
#   4. range 内に追加または変更された `.nx/version-plans/*.md` の frontmatter を読む。
#      その group の bump が宣言されているかを確かめる。
#      frontmatter は group 名キー（`pecot-workflow` / `pecot-visual` 等）のみ受理する。
#      宣言の無い group が 1 つでもあれば block する。
#
# 起動方法は次の 2 通り。
#   (a) pre-commit 経由 (env PRE_COMMIT_FROM_REF / PRE_COMMIT_TO_REF)。
#       → local_sha = PRE_COMMIT_TO_REF を使う（FROM は merge-base で再計算する）。
#   (b) git pre-push stdin 直接 (<local_ref> <local_sha> <remote_ref> <remote_sha>)。
#       → local_sha のみ使う（remote_sha は参照しない）。
#
# 上記以外の起動は、何を評価すべきか判らないため skip + warn とする。
#
# merge-base 計算用の base は、以下の順で解決する。
#   1. env PECOT_VERSION_PLAN_BASE が指定されていれば、それを採用する。
#   2. origin/HEAD が指す ref を使う。
# いずれも得られなければ skip + warn とする。
#
# nx 実体 / node / nx.json が解決できない環境では skip + warn とする（exit 0）。
# このファイルの他の解決失敗時と同じく、判定不能なら素通しする方針。
#
# 環境変数 PECOT_VERSION_PLAN_RELEASE_RE (既定 '^chore\(release\)') で、
# release commit 判定の regex を上書きできる。

set -e

# base/head 解決の関数は、affected テストのチェックと共有する lib に切り出してある。
# 対象は resolve_base_branch / resolve_nx / collect_push_tips / resolve_push_range。
# 同一の解決ロジックを構造的に共有することで、両チェックが同じ push range を評価することを保証する。
# 保証は複製でなく source で行う。
# shellcheck source=lib/push-range.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/push-range.sh"
# project graph の取得（run-affected-* のレーン名収集と共通）。
# shellcheck source=lib/nx-lanes.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/nx-lanes.sh"

RELEASE_RE="${PECOT_VERSION_PLAN_RELEASE_RE:-^chore\\(release\\)}"

# 変更ファイルが触れた release group を判定する。
#   $1: nx.json。
#   $2: `nx graph --file=<file>` が書いた JSON。
#   $3: 既知の release group 名一覧の書き出し先。
#   stdin: 変更ファイル（NUL 区切り）。
# stdout: 触れた release group（1 行 1 件）。
# 終了コード: 0 = 判定できた、3 = 解析失敗、4 = 構成の誤り。
#   4 は、group 所属 project の root 配下で、group 外の project が見つかったときの値。
#   このとき stdout にその project 名を 1 行 1 件で出す。
#   - 持ち主の project: project root との最長一致（nx の findProjectForPath と同じ）。
#   - README.md / CHANGELOG.md は数えない。
#   - group: nx.json の release.groups[].projects に project 名が含まれるもの。
#   - 変更一覧は NUL 区切りの stdin で受ける。非 ASCII パスのクォートと引数長の上限を避けるため。
touched_release_groups() {
    node -e '
        const fs = require("fs");
        const chunks = [];
        process.stdin.on("data", (c) => { chunks.push(c); });
        process.stdin.on("end", () => {
            try {
                const nodes = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).graph.nodes;
                const nx = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
                const groups = (nx.release && nx.release.groups) || {};
                fs.writeFileSync(process.argv[3], Object.keys(groups).join("\n"));
                const grouped = new Set();
                for (const cfg of Object.values(groups)) {
                    for (const p of cfg.projects || []) grouped.add(p);
                }
                const projects = Object.values(nodes).map((n) => [n.name, n.data.root]);
                const under = (f, r) => r === "." || f === r || f.startsWith(r + "/");
                const nested = projects
                    .filter(([name, root]) => !grouped.has(name) && root !== "." &&
                        projects.some(([o, r]) => grouped.has(o) && r !== "." && root !== r && under(root, r)))
                    .map(([name]) => name);
                if (nested.length) {
                    process.stdout.write(nested.sort().join("\n") + "\n");
                    process.exit(4);
                }
                const roots = projects.sort((a, b) => b[1].length - a[1].length);
                const owner = (f) => {
                    const hit = roots.find(([, r]) => under(f, r));
                    return hit && hit[0];
                };
                const touched = new Set();
                for (const f of Buffer.concat(chunks).toString("utf8").split("\0")) {
                    if (!f || /(^|\/)(README|CHANGELOG)\.md$/.test(f)) continue;
                    const project = owner(f);
                    if (!project) continue;
                    for (const [g, cfg] of Object.entries(groups)) {
                        if ((cfg.projects || []).includes(project)) touched.add(g);
                    }
                }
                if (touched.size) process.stdout.write([...touched].sort().join("\n") + "\n");
            } catch (e) {
                process.exit(3);
            }
        });
    ' "$1" "$2" "$3"
}

print_nested_error() {
    local names="$1"
    cat >&2 <<MSG
ERROR: release group に属さない nx project が、group に属するプラグイン project の
       配下にあるため、その配下の変更が version plan の判定から漏れます。

該当 project:
$(printf '%s\n' "$names" | sed 's/^/  - /')

1 プラグイン = 1 nx project の構成にしてください（プラグイン配下に別の project.json を
置かず、タスクはプラグイン root の project.json に集約する）。
MSG
}

print_error() {
    local groups="$1"
    cat >&2 <<EOF
ERROR: 次の push は release group [${groups}] のファイルを変更していますが、
       ブランチで足した version plan に該当 group の bump 宣言がありません。

対処:
  1. cp .nx/nx-release/version-plan-template.md .nx/version-plans/<番号>-<slug>.md
     （<番号> は Issue/PR 番号、<slug> は kebab-case 英字＋数字）
  2. frontmatter で影響を受けた release group (${groups}) の bump 種別
     (patch/minor/major) を宣言（キーは group 名）
  3. 本文を 1 段落の説明文で記述（CHANGELOG bullet 用の 1 文。WHY/HOW は PR description）
  4. commit して再度 push
EOF
}

check_branch() {
    local to_sha="$1"

    # default branch との merge-base を from に取る（branch 全体 vs default）。
    # 範囲解決は共有 lib に委譲し、区分コードを WARN+skip 方針へマップする
    # （version-plan ガードは判定不能なら gate を素通しする fail-open 方針）。
    local range from_sha rc
    range=$(resolve_push_range "$to_sha") && rc=0 || rc=$?
    case "$rc" in
        0) ;;
        10) return 0 ;;  # ブランチ削除 push (to=zero): 変更なし扱い
        11)
            echo "WARN: base 解決失敗のため version plan check を skip" >&2
            return 0 ;;
        12)
            echo "WARN: base 未解決のため version plan check を skip" >&2
            return 0 ;;
        13)
            echo "WARN: merge-base 計算失敗のため version plan check を skip" >&2
            return 0 ;;
        14) return 0 ;;  # from==to（no-op or default そのもの）
        15)
            echo "WARN: from/to sha が解決不能のため version plan check を skip" >&2
            return 0 ;;
        16) return 0 ;;  # tip が commit へ peel 不能 (annotated tag 等): 変更なし扱い
        *)
            echo "WARN: push range 解決不能のため version plan check を skip" >&2
            return 0 ;;
    esac
    from_sha="${range%% *}"
    to_sha="${range##* }"

    # release commit 判定: range 内に release commit があれば release cycle として pass
    local commit_msgs
    commit_msgs=$(git log --format=%s "${from_sha}..${to_sha}" 2>/dev/null || echo "")
    if [ -n "$commit_msgs" ] && echo "$commit_msgs" | grep -qE "$RELEASE_RE"; then
        return 0
    fi

    local repo_root
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    if [ -z "$repo_root" ]; then
        echo "WARN: repo root 解決失敗のため version plan check を skip" >&2
        return 0
    fi

    # nx / node の解決。どちらか欠ければ判定不能なので skip + warn。
    local nx_bin
    if ! nx_bin=$(resolve_nx "$repo_root"); then
        echo "WARN: nx 実行ファイルが見つからないため version plan check を skip" >&2
        return 0
    fi
    if ! command -v node > /dev/null 2>&1; then
        echo "WARN: node が見つからないため version plan check を skip" >&2
        return 0
    fi
    local nx_json="$repo_root/nx.json"
    if [ ! -f "$nx_json" ]; then
        echo "WARN: nx.json が見つからないため version plan check を skip" >&2
        return 0
    fi

    # project root は nx の project graph から取る（touched の判定に使う）。
    # パイプ（--file=stdout）は、大きな JSON を途中で切ることがある。
    # そのため一時ファイルで受ける。
    # 一時ファイルは CLI / hook 専用の .pecot/tmp に作り、終了時に消す。
    local tmp_base="$repo_root/.pecot/tmp"
    mkdir -p "$tmp_base" 2>/dev/null || true
    local work
    if ! work=$(mktemp -d "$tmp_base/version-plan.XXXXXX" 2>/dev/null); then
        echo "WARN: 一時ディレクトリを作れないため version plan check を skip" >&2
        return 0
    fi
    # shellcheck disable=SC2064
    trap "rm -rf '$work'" RETURN

    if ! nx_graph_json "$nx_bin" "$repo_root" "$work/graph.json" "$work/nx.log"; then
        echo "WARN: nx graph 実行失敗のため version plan check を skip" >&2
        return 0
    fi

    # NUL 区切りで受け、非 ASCII パスがクォートされないようにする。
    if ! git -C "$repo_root" diff -z --name-only --no-renames "${from_sha}..${to_sha}" \
        > "$work/changed" 2>/dev/null; then
        echo "WARN: git diff 失敗のため version plan check を skip" >&2
        return 0
    fi

    # 変更ファイルが触れた release group（README.md / CHANGELOG.md だけの group は含まない）。
    # 既知の release group 名一覧（version plan の宣言キーの確認に使う）も同じ実行で
    # $work/groups に書かせる（nx.json は 1 回だけ読む）。
    local releasable trc=0
    releasable=$(touched_release_groups "$nx_json" "$work/graph.json" "$work/groups" \
        < "$work/changed") || trc=$?
    if [ "$trc" -eq 4 ]; then
        print_nested_error "$releasable"
        return 1
    elif [ "$trc" -ne 0 ]; then
        echo "WARN: nx graph 出力か nx.json の解析失敗のため version plan check を skip" >&2
        return 0
    fi
    local known_groups
    known_groups=$(cat "$work/groups")

    # 変更した release group が無ければ pass
    if [ -z "$(printf '%s' "$releasable" | tr -d '[:space:]')" ]; then
        return 0
    fi

    # range 内に追加/変更された version plan の frontmatter から宣言 group を収集
    local plan_files
    plan_files=$(git -C "$repo_root" diff --name-only --diff-filter=ACMR \
        "${from_sha}..${to_sha}" -- .nx/version-plans/ 2>/dev/null || echo "")
    local declared=""
    local pf
    while IFS= read -r pf; do
        [ -z "$pf" ] && continue
        case "$pf" in *.md) ;; *) continue ;; esac
        local content
        content=$(git -C "$repo_root" show "${to_sha}:${pf}" 2>/dev/null || echo "")
        [ -z "$content" ] && continue
        # frontmatter（最初の --- と 2 つ目の --- の間）から bump 宣言を抽出。
        # 値が妥当な semver ReleaseType の行のみ宣言扱い（空値・不正値は除外）。
        local keys
        keys=$(printf '%s\n' "$content" \
            | awk 'BEGIN{c=0} /^---[[:space:]]*$/{c++; next} c==1{print}' \
            | sed -n 's/^\([A-Za-z0-9_][A-Za-z0-9_-]*\)[[:space:]]*:[[:space:]]*\(major\|premajor\|minor\|preminor\|patch\|prepatch\|prerelease\)[[:space:]]*$/\1/p')
        # group 名キーのみ受理する。
        local k
        while IFS= read -r k; do
            [ -z "$k" ] && continue
            if printf '%s\n' "$known_groups" | grep -qxF "$k"; then
                declared+="$k"$'\n'
            fi
        done <<< "$keys"
    done <<< "$plan_files"

    # 変更した release group が宣言されているか突き合わせ
    local missing=""
    while IFS= read -r p; do
        [ -z "$p" ] && continue
        if ! printf '%s\n' "$declared" | grep -qxF "$p"; then
            missing+="$p "
        fi
    done <<< "$releasable"
    missing="${missing% }"

    if [ -n "$missing" ]; then
        print_error "$missing"
        return 1
    fi

    return 0
}

# Main: 評価対象の local_sha を列挙（remote_sha は参照しない — branch 全体を評価するため）
declare -a TIPS=()
while IFS= read -r tip; do
    [ -z "$tip" ] && continue
    TIPS+=("$tip")
done < <(collect_push_tips)

if [ "${#TIPS[@]}" -eq 0 ]; then
    echo "WARN: push 情報なし（pre-commit env と pre-push stdin のどちらからも取得できず）のため version plan check を skip" >&2
    exit 0
fi

for tip in "${TIPS[@]}"; do
    if ! check_branch "$tip"; then
        exit 1
    fi
done

exit 0
