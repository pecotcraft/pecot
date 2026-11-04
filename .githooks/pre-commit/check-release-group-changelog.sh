#!/bin/bash
# Require every release group's CHANGELOG file to exist, be non-empty and end
# with a newline.
#
# Hook stage: pre-commit
#
# 経緯 (#1087): 2026-09-08 の nx release で、Nx が新規 group (pecot-tools) の
# CHANGELOG を末尾改行なしで作成した。
# 対象は `plugins/pecot-tools/CHANGELOG.md` だった。
# pre-commit の `end-of-file-fixer` が exit 1 を返し、Nx は release commit を
# 作れずに中断した。
#
# Nx の `generateChangelogForProjects` は `interpolatedTreePath` へ書き込む。
# 対象ファイルが既に存在する場合だけ `新しい節 + "\n\n" + 既存本文` として結合する。
# 存在しなければ、新しい節だけを書く。
#
# よって「存在・非空・末尾改行」を満たす CHANGELOG が事前にあれば、
# CREATE 処理に入らず末尾改行も保たれる。それを commit 時に強制する。
#
# 判定条件。
# 対象は、`nx.json` の `release.groups[].changelog.file` が補間トークンを含まない文字列の group のみ。
#   1. ファイルが存在する
#   2. サイズ > 0（空ファイルは Nx の CREATE 処理と同じ結果になる）
#   3. 末尾 1 バイトが `\n`
#
# 確認対象外（いずれも WARN を stderr に出して exit 0）:
#   - `changelog.file` が `{projectRoot}` 等の補間トークンを含む。
#     この hook は nx の補間を再現しないため、パスを確定できない
#   - `changelog: true` / `changelog.file` 未定義。
#     既定パスが有効だが、パスは確定しない
#   - root の `release.changelog.projectChangelogs` が truthy（同上）
#
# 次の 3 つは project CHANGELOG そのものが無効なので WARN も出さない。
# `changelog: false` / `changelog.file: false` / group の `changelog` 未定義。
# root の `release.changelog.workspaceChangelog` も対象外。
#
# fail-open: nx.json 不在・node 不在・解析失敗は WARN を stderr に出して exit 0。
# `check-version-plan-required.sh` の skip 方針と揃える。

set -e

warn_skip() {
    echo "WARN: $1ため release group CHANGELOG check を skip" >&2
    exit 0
}

repo_root=$(git rev-parse --show-toplevel 2> /dev/null || echo "")
if [ -z "$repo_root" ]; then
    warn_skip "repo root 解決に失敗した"
fi

if ! command -v node > /dev/null 2>&1; then
    warn_skip "node が見つからない"
fi

nx_json="$repo_root/nx.json"
if [ ! -f "$nx_json" ]; then
    warn_skip "nx.json が見つからない"
fi

# `<kind>\t<group name>\t<changelog file path>` を 1 行 1 group で出力する。
# kind: CHECK=確認する / INTERP=補間トークンを含む / NONSTRING=既定パス扱い /
# ROOT=root の projectChangelogs が既定パスを有効化している。
#
# JS の処理は次のとおり。
# - changelog が false / 未定義の group は project CHANGELOG の無効化なので出力しない。
# - changelog.file が文字列で、nx の補間トークン（{projectRoot} 等）を含むなら INTERP にする。
#   この hook は補間を解決しない。含まなければ CHECK にする。
# - changelog.file が false / null の group は出力しない。それ以外は NONSTRING にする。
# - root の release.changelog.projectChangelogs が真なら ROOT を出力する。
if ! entries=$(node -e '
    const fs = require("fs");
    try {
        const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const release = j.release || {};
        const groups = release.groups || {};
        const lines = [];
        for (const [name, g] of Object.entries(groups)) {
            const changelog = g && g.changelog;
            if (!changelog) continue;
            const file = changelog === true ? undefined : changelog.file;
            if (typeof file === "string" && file.length > 0) {
                lines.push((file.includes("{") ? "INTERP\t" : "CHECK\t") + name + "\t" + file);
                continue;
            }
            if (file === false || file === null) continue;
            lines.push("NONSTRING\t" + name);
        }
        const rootChangelog = release.changelog;
        if (rootChangelog && rootChangelog.projectChangelogs) {
            lines.push("ROOT\trelease.changelog.projectChangelogs");
        }
        process.stdout.write(lines.join("\n"));
    } catch (e) {
        process.exit(3);
    }
' "$nx_json"); then
    warn_skip "nx.json release.groups の解析に失敗した"
fi

violations=()

while IFS=$'\t' read -r kind group file; do
    [ -z "$kind" ] && continue
    case "$kind" in
        INTERP)
            echo "WARN: $group: changelog.file に補間トークンを含むため確認対象外" >&2
            continue
            ;;
        NONSTRING)
            echo "WARN: $group: changelog.file が文字列でないため確認対象外（既定パスは確認しない）" >&2
            continue
            ;;
        ROOT)
            echo "WARN: $group が有効なため確認対象外（既定パスは確認しない）" >&2
            continue
            ;;
    esac
    path="$repo_root/$file"
    if [ -e "$path" ] && [ ! -f "$path" ]; then
        violations+=("$group: $file がファイルではありません")
        continue
    fi
    if [ ! -f "$path" ]; then
        violations+=("$group: $file が存在しません")
        continue
    fi
    if [ ! -s "$path" ]; then
        violations+=("$group: $file が空です")
        continue
    fi
    # コマンド置換は末尾改行を除去するため、末尾が `\n` なら空文字になる。
    if [ -n "$(tail -c 1 "$path")" ]; then
        violations+=("$group: $file の末尾が改行ではありません")
    fi
done <<< "$entries"

if [ "${#violations[@]}" -gt 0 ]; then
    echo ""
    echo "=========================================="
    echo "❌ release group の CHANGELOG が nx release の前提を満たしていません:"
    echo "=========================================="
    echo "（以下のパスはリポジトリルートからの相対パス）"
    for v in "${violations[@]}"; do
        echo "  - $v"
    done
    echo ""
    echo "📋 理由: Nx は CHANGELOG が既存のときだけ新しい節を先頭へ結合する。"
    echo "   不在・空だと末尾改行なしで新規作成し end-of-file-fixer が"
    echo "   release commit を落とす（#1087）。非空の 1 行を先に置いておく。"
    echo ""
    echo "📋 対処（リポジトリルートで、該当ファイルごとに実行）:"
    # 例示コマンドの `\n` はリテラルのまま見せるため printf %s を使う
    printf '%s\n' "  printf '<!-- この行は初回リリース前に必要。nx release は先頭へ追記する -->\\n' > <file>"
    echo "=========================================="
    echo ""
    exit 1
fi

exit 0
