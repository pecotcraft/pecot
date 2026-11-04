#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."   # repo root

# .githooks 配下の Python（japanese_rule.py 等）を pyright --strict で確認する。
# 構成は preflight → venv キャッシュ → pyright の順で、
# plugins/pecot-workflow/scripts/ci/run-lint.sh を手本にしている。

if ! command -v uv &>/dev/null; then
    echo "ERROR: .githooks lint 実行に uv が必要です (pre-commit フック githooks-lint)。" >&2
    echo "  インストール: https://docs.astral.sh/uv/getting-started/installation/" >&2
    exit 1
fi

if ! command -v npx &>/dev/null; then
    echo "ERROR: .githooks lint の pyright 実行に Node/npx が必要です (pre-commit フック githooks-lint)。" >&2
    echo "  インストール: https://nodejs.org/ または nvm 等で Node.js を導入してください。" >&2
    exit 1
fi

VENV_DIR=".githooks/gitlint/.venv"

# 型の確認に使う gitlint は、commit-msg で実際に動く gitlint と同じバージョンにする。
# バージョンの定義元は .pre-commit-config.yaml の gitlint repo の rev 1 つだけで、
# ここでは別に宣言しない。
# gitlint は gitlint-core を同一バージョンで固定するため、gitlint だけ指定すれば揃う。
GITLINT_VERSION=$(awk '
    /^[[:space:]]*-[[:space:]]*repo:[[:space:]]*https:\/\/github\.com\/jorisroovers\/gitlint[[:space:]]*$/ { found = 1; next }
    found && /^[[:space:]]*rev:/ { sub(/^[[:space:]]*rev:[[:space:]]*"?v?/, ""); sub(/"?[[:space:]]*$/, ""); print; exit }
' .pre-commit-config.yaml)
if [[ -z "$GITLINT_VERSION" ]]; then
    echo "ERROR: .pre-commit-config.yaml から gitlint の rev を読めません (pre-commit フック githooks-lint)。" >&2
    exit 1
fi

uv venv "$VENV_DIR" --quiet --allow-existing
uv pip install --quiet --python "$VENV_DIR/bin/python" "gitlint==$GITLINT_VERSION"

# pyright --strict で .githooks/gitlint/ 配下の Python を確認する。
# --project で pyrightconfig.json を指定し、
# reportMissingTypeStubs/reportUnnecessaryTypeIgnoreComment を制御する。
npx --yes pyright@1.1.410 --pythonpath "$VENV_DIR/bin/python" --project .githooks/gitlint
