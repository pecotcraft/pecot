#!/usr/bin/env bash
# pre-commit（commit 時）で nx affected の lint target を実行する root 共通のチェック。
#
# Hook stage: pre-commit
#
# lint 範囲の決定を nx project graph に一本化する。
# 従来の path 正規表現ベースの `<plugin>-run-lint`（`files: ^plugins/<plugin>/`）は廃止した。
# 本フック 1 本で `nx affected -t <lint レーン名の列挙>` を実行する。
# これにより project.json の lint / lint-* target 経由で dispatch する。
#
# 起点の `lint`（nx:noop）ではなく、レーンを名前で要求する。
# その理由とレーン名の集め方は lib/nx-lanes.sh を参照（#1232）。
# pecot-tools の `lint` は実体の target です。
# pecot-visual / pecot-workflow の `lint` は lint-* を束ねる起点で、nx.json の nx:noop の inputs: [] により全レーンを連れてこない。
#
# テストのチェック（run-affected-tests.sh、pre-push）と違い、push range の解決は不要。
# pre-commit framework が pass_filenames で渡す staged の変更ファイル一覧を、
# そのまま `nx affected --files=<csv>` の入力にする。
# commit 時の評価対象は「いまコミットしようとしている変更」であり、merge-base 計算の出る幕がない。
#
# 制約: nx の --files はカンマ区切りのため、カンマを含むファイル名は扱えない。
# リポ管理ファイルの命名規約上、存在しない前提とする。
#
# 判定不能時の方針は、テストのチェックと同型の fail-closed とする。
#   - nx / node が解決不能 → 復旧手順入り ERROR + exit 1。
#     緊急回避は `git commit --no-verify` が標準の逃げ道で、専用 skip env は設けない。
#   - 変更ファイルなし（引数 0 個）→ exit 0。lint 対象なしで、graph も計算しない。
#   - nx graph からレーン名を集められない → ERROR + exit 1。空の -t で nx を起動しない（lib/nx-lanes.sh）。
#   - affected に lint レーンが届かなければ nx が no-op exit 0。

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -z "$repo_root" ]; then
    echo "ERROR: repo root を解決できません（git rev-parse --show-toplevel 失敗）。" >&2
    exit 1
fi

# shellcheck source=lib/push-range.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/push-range.sh"
# shellcheck source=lib/nx-lanes.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/nx-lanes.sh"

if ! command -v node > /dev/null 2>&1; then
    cat >&2 <<'EOF'
ERROR: node が見つからないため affected lint を実行できません。
       node をインストールしてから再度 commit してください。
       緊急で回避する場合のみ `git commit --no-verify` を使ってください。
EOF
    exit 1
fi
if ! nx_bin=$(resolve_nx "$repo_root"); then
    cat >&2 <<'EOF'
ERROR: nx 実行ファイルが見つからないため affected lint を実行できません。
       リポジトリルートで依存を導入してください:
         npm ci    （または pnpm install）
       緊急で回避する場合のみ `git commit --no-verify` を使ってください。
EOF
    exit 1
fi

# pass_filenames で渡された変更ファイルが無ければ lint 対象なし。
if [ "$#" -eq 0 ]; then
    exit 0
fi

# nx の --files はカンマ区切り 1 引数。
files_csv=$(IFS=','; printf '%s' "$*")

# lint レーン名が取れなければ fail-closed（nx_lane_targets が ERROR を stderr へ出す）。
lint_lanes=$(nx_lane_targets "$nx_bin" "$repo_root" lint) || exit 1

# affected に lint レーンが届かなければ nx は no-op exit 0。
# lint 失敗時の非 0 はサブシェルの exit code が set -e に捕捉され即終了する。
(cd "$repo_root" && "$nx_bin" affected -t "$lint_lanes" \
    --files="$files_csv" --parallel=1 --output-style=stream)
