#!/bin/bash
# Require a version plan when a feature branch changes files of a release group.
# Hook stage: pre-push
# branch 全体 (merge-base(default, local)..local) の変更を判定する。
# 判定は nx の「持ち主の project」と release group による。
# 数えないファイルは nx.json の ignorePatternsForPlanCheck から読む。判定できない環境は WARN で skip する。
# range の author が dependabot[bot]（と github-actions[bot]）だけなら素通しする。
# env PECOT_VERSION_PLAN_STRICT=1 では、判定できないときの WARN での skip を失敗にする。

set -e

# base/head 解決は affected テストのチェックと共有する lib を source する（同じ push range を評価するため）。
# shellcheck source=../lib/push-range.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/push-range.sh"
# shellcheck source=../lib/nx-lanes.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/nx-lanes.sh"

RELEASE_RE="${PECOT_VERSION_PLAN_RELEASE_RE:-^chore\\(release\\)}"

# 変更ファイル（stdin, NUL 区切り）が触れた release group を stdout へ出す。
# 引数: nx.json・graph JSON・group 名一覧の書き出し先・repo root・nx 実行ファイル。
# 終了コードは 0 = 判定済み、3 = 解析失敗、4 = 入れ子の project（stdout に名前）、5 = ignore を解決できない。
touched_release_groups() {
    node -e '
        const fs = require("fs");
        const path = require("path");
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
                const globsOf = (cfg) => {
                    const vp = cfg.versionPlans ?? (nx.release || {}).versionPlans;
                    const g = vp && typeof vp === "object" ? vp.ignorePatternsForPlanCheck : null;
                    return Array.isArray(g) ? g : [];
                };
                const globs = Object.fromEntries(Object.entries(groups).map(([g, cfg]) => [g, globsOf(cfg)]));
                const matchers = {};
                if (Object.values(globs).some((g) => g.length)) {
                    let ignore;
                    try {
                        let nxReal = null;
                        try { nxReal = path.dirname(fs.realpathSync(process.argv[5])); } catch (e) {}
                        const nxDir = path.dirname(require.resolve("nx/package.json", { paths: [process.argv[4], nxReal].filter(Boolean) }));
                        ignore = require(require.resolve("ignore", { paths: [nxDir] }));
                    } catch (e) {
                        process.exit(5);
                    }
                    for (const [g, list] of Object.entries(globs)) {
                        if (list.length) matchers[g] = ignore().add(list);
                    }
                }
                const touched = new Set();
                for (const f of Buffer.concat(chunks).toString("utf8").split("\0")) {
                    if (!f) continue;
                    const project = owner(f);
                    if (!project) continue;
                    for (const [g, cfg] of Object.entries(groups)) {
                        if (!(cfg.projects || []).includes(project)) continue;
                        if (matchers[g] && matchers[g].ignores(f)) continue;
                        touched.add(g);
                    }
                }
                if (touched.size) process.stdout.write([...touched].sort().join("\n") + "\n");
            } catch (e) {
                process.exit(3);
            }
        });
    ' "$1" "$2" "$3" "$4" "$5"
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

# 判定不能のとき、通常は WARN を出して skip（0）、strict では失敗（1）にする。
skip_or_fail() {
    if [ "${PECOT_VERSION_PLAN_STRICT:-}" = 1 ]; then
        echo "ERROR: $1。PECOT_VERSION_PLAN_STRICT=1 のため失敗にします" >&2
        return 1
    fi
    echo "WARN: $1" >&2
    return 0
}

check_branch() {
    local to_sha="$1"

    # branch 全体 vs default の範囲は共有 lib で解決し、判定不能なら WARN して素通しする。
    local range from_sha rc
    range=$(resolve_push_range "$to_sha") && rc=0 || rc=$?
    case "$rc" in
        0) ;;
        10) return 0 ;;  # ブランチ削除 push (to=zero): 変更なし扱い
        11)
            skip_or_fail "base 解決失敗のため version plan check を skip"
            return $? ;;
        12)
            skip_or_fail "base 未解決のため version plan check を skip"
            return $? ;;
        13)
            skip_or_fail "merge-base 計算失敗のため version plan check を skip"
            return $? ;;
        14) return 0 ;;  # from==to（no-op or default そのもの）
        15)
            skip_or_fail "from/to sha が解決不能のため version plan check を skip"
            return $? ;;
        16) return 0 ;;  # tip が commit へ peel 不能 (annotated tag 等): 変更なし扱い
        *)
            skip_or_fail "push range 解決不能のため version plan check を skip"
            return $? ;;
    esac
    from_sha="${range%% *}"
    to_sha="${range##* }"

    # release commit 判定: range 内に release commit があれば release cycle として pass
    local commit_msgs
    commit_msgs=$(git log --format=%s "${from_sha}..${to_sha}" 2>/dev/null || echo "")
    if [ -n "$commit_msgs" ] && echo "$commit_msgs" | grep -qE "$RELEASE_RE"; then
        return 0
    fi

    # author 判定: dependabot の更新の version plan はリリース時に作るので素通しする。
    local authors
    authors=$(git log --no-merges --format=%an "${from_sha}..${to_sha}" 2>/dev/null || echo "")
    if [ -n "$authors" ] \
        && ! printf '%s\n' "$authors" | grep -qvxE 'dependabot\[bot\]|github-actions\[bot\]' \
        && printf '%s\n' "$authors" | grep -qxF 'dependabot[bot]'; then
        echo "dependabot の更新の version plan はリリース時に作るため、version plan check を skip" >&2
        return 0
    fi

    local repo_root
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    if [ -z "$repo_root" ]; then
        skip_or_fail "repo root 解決失敗のため version plan check を skip"
        return $?
    fi

    # nx / node の解決。どちらか欠ければ判定不能なので skip + warn。
    local nx_bin
    if ! nx_bin=$(resolve_nx "$repo_root"); then
        skip_or_fail "nx 実行ファイルが見つからないため version plan check を skip"
        return $?
    fi
    if ! command -v node > /dev/null 2>&1; then
        skip_or_fail "node が見つからないため version plan check を skip"
        return $?
    fi
    local nx_json="$repo_root/nx.json"
    if [ ! -f "$nx_json" ]; then
        skip_or_fail "nx.json が見つからないため version plan check を skip"
        return $?
    fi

    # graph JSON は途中で切れないよう、一時ファイルに受ける（CLI / hook 専用の .pecot/tmp に作り、終了時に消す）。
    local tmp_base="$repo_root/.pecot/tmp"
    mkdir -p "$tmp_base" 2>/dev/null || true
    local work
    if ! work=$(mktemp -d "$tmp_base/version-plan.XXXXXX" 2>/dev/null); then
        skip_or_fail "一時ディレクトリを作れないため version plan check を skip"
        return $?
    fi
    # shellcheck disable=SC2064
    trap "rm -rf '$work'" RETURN

    if ! nx_graph_json "$nx_bin" "$repo_root" "$work/graph.json" "$work/nx.log"; then
        skip_or_fail "nx graph 実行失敗のため version plan check を skip"
        return $?
    fi

    # NUL 区切りで受け、非 ASCII パスがクォートされないようにする。
    if ! git -C "$repo_root" diff -z --name-only --no-renames "${from_sha}..${to_sha}" \
        > "$work/changed" 2>/dev/null; then
        skip_or_fail "git diff 失敗のため version plan check を skip"
        return $?
    fi

    # 触れた release group を得る（glob に当たるファイルだけの group は除く）。group 名一覧も $work/groups へ書かせる。
    local releasable trc=0
    releasable=$(touched_release_groups "$nx_json" "$work/graph.json" "$work/groups" "$repo_root" "$nx_bin" \
        < "$work/changed") || trc=$?
    if [ "$trc" -eq 4 ]; then
        print_nested_error "$releasable"
        return 1
    elif [ "$trc" -eq 5 ]; then
        skip_or_fail "nx 配下の ignore を解決できないため version plan check を skip"
        return $?
    elif [ "$trc" -ne 0 ]; then
        skip_or_fail "nx graph 出力か nx.json の解析失敗のため version plan check を skip"
        return $?
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
    skip_or_fail "push 情報なし（pre-commit env と pre-push stdin のどちらからも取得できず）のため version plan check を skip" || exit 1
    exit 0
fi

for tip in "${TIPS[@]}"; do
    if ! check_branch "$tip"; then
        exit 1
    fi
done

exit 0
