#!/usr/bin/env bash
# ルート直下に、許可の一覧に無い名前を追跡させない。一覧は .claude/rules/repo-root-layout.md の表と同じにする。

set -euo pipefail

ALLOWED=(
    .claude
    .claude-plugin
    .devcontainer
    .githooks
    .github
    .gitignore
    .gitlint
    .markdownlint-cli2.jsonc
    .npmrc
    .nx
    .nxignore
    .pecot
    .pre-commit-config.yaml
    .specify
    .yamllint
    CLAUDE.md
    LICENSE
    README.md
    SECURITY.md
    libs
    nx.json
    package.json
    plugins
    pnpm-lock.yaml
    pnpm-workspace.yaml
    pyproject.toml
    setup.sh
    specs
    uv.lock
)

cd "$(git rev-parse --show-toplevel)"

unexpected=()
while IFS= read -r name; do
    [ -n "$name" ] || continue
    found=0
    for allowed in "${ALLOWED[@]}"; do
        if [ "$name" = "$allowed" ]; then
            found=1
            break
        fi
    done
    [ "$found" -eq 1 ] || unexpected+=("$name")
done < <(git ls-files -z | tr '\0' '\n' | cut -d/ -f1 | sort -u)

if [ ${#unexpected[@]} -eq 0 ]; then
    exit 0
fi

echo "ERROR: ルート直下に許可の一覧に無い名前があります" >&2
printf '  - %s\n' "${unexpected[@]}" >&2
echo "" >&2
echo "置き場所は .claude/rules/repo-root-layout.md の表で決めます。" >&2
echo "  リポ全体のスクリプト: .githooks/scripts/" >&2
echo "  hook: .githooks/<stage>/" >&2
echo "  プラグインの中身: plugins/<name>/" >&2
echo "  ライブラリ: libs/<name>/" >&2
echo "  作業ファイル: .pecot/work/<Issue番号>/" >&2
echo "どうしてもルートに足すときは、このスクリプトの ALLOWED と上の表を同じ変更で直してください。" >&2
exit 1
