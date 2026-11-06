# shellcheck shell=bash
# 開発環境の依存導入 (#1297, #113)。install.sh などが source する。set はしない。

# pecotv_dev_install <plugin root> <pnpm 起動コマンド>
pecotv_dev_install() {
    local root="$1" pnpm="$2" repo_root
    repo_root="$(cd "$root/../.." && pwd)" || return 1

    # `$pnpm` は意図的に quote しない（"corepack pnpm" を 2 トークンに分割するため）
    echo "==> $pnpm install --frozen-lockfile (cwd=$repo_root)"
    # shellcheck disable=SC2086
    ( cd "$repo_root" && $pnpm install --frozen-lockfile )
}
