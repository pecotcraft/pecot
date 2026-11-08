#!/usr/bin/env bash
# ルート直下の . で始まらないディレクトリを、許可の一覧のものだけにする。
# 一覧は .claude/rules/repo-root-layout.md の表と同じにする。増やすにはユーザーの明示の同意が要る。

set -euo pipefail

ALLOWED=(
    libs
    plugins
    specs
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
done < <(git ls-files -z | tr '\0' '\n' | grep '/' | cut -d/ -f1 | grep -v '^\.' | sort -u)

if [ ${#unexpected[@]} -eq 0 ]; then
    exit 0
fi

echo "ERROR: ルート直下に、許可の一覧に無いディレクトリがあります" >&2
printf '  - %s/\n' "${unexpected[@]}" >&2
echo "" >&2
echo "許可の一覧と置き場所は .claude/rules/repo-root-layout.md にあります。" >&2
echo "  リポ全体のスクリプト: .githooks/scripts/" >&2
echo "  プラグインの中身: plugins/<name>/" >&2
echo "  ライブラリ: libs/<name>/" >&2
echo "  作業ファイル: .pecot/work/<Issue番号>/" >&2
echo "一覧を増やすには、ユーザーの明示の同意が要ります。" >&2
exit 1
