#!/bin/bash
# 共通ブランチガード: featureブランチ判定関数。
#
# 提供関数: is_feature_branch
# 配置: hooks/lib/core/branch-guard.sh。
#
# 使用方法（各フックスクリプトの冒頭）は次のとおり。
#   source "${SCRIPT_DIR%/*}/core/branch-guard.sh"
#   is_feature_branch || return 0
#
# 判定ロジックは次のとおり。
#   - wt[0-9]+, develop-aist, main → false（非featureブランチ）
#   - それ以外 → true（featureブランチ）
#
# hooks-config.json 制御は次のとおり。
#   "branch-guard": false にすると常に true を返す（全ブランチで動作）。

_BRANCH_GUARD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${_BRANCH_GUARD_DIR}/config-dispatcher.sh"

# @param $1 repo_dir  対象リポジトリのパス（省略時はカレントディレクトリ）。
# @return 0 = featureブランチ、1 = 非featureブランチ（wt*, develop-aist, main）。
is_feature_branch() {
    local repo_dir="${1:-.}"

    # hooks-config.json で branch-guard が false → 常に true（全ブランチで動作）。
    if ! pecot_hook_enabled "branch-guard" true; then
        return 0
    fi

    # pre-commit/pre-push フック内では GIT_DIR 等が親リポジトリを指すため、
    # テスト用リポジトリの操作に影響しないよう除外する。
    local _git="env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES git"

    # git リポジトリでなければ false。
    if ! $_git -C "$repo_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        return 1
    fi

    # 現在のブランチを取得（detached HEAD なら false）。
    local current_branch
    current_branch=$($_git -C "$repo_dir" symbolic-ref --short HEAD 2>/dev/null)
    if [[ -z "$current_branch" ]]; then
        return 1
    fi

    # 非featureブランチパターン: wt[0-9]+, develop-aist, main。
    local non_feature_pattern='^(wt[0-9]+|develop-aist|main)$'
    if [[ "$current_branch" =~ $non_feature_pattern ]]; then
        return 1
    fi

    return 0
}
