---
name: w-worktree-remove
description: |
  ワークツリーを削除します（単発／並行作業セット対応）。
  Use when the user wants to remove a git worktree via the pecot CLI — single-repo or a parallel-work set spanning multiple repositories.
  Do NOT use for creation (use w-worktree-add).
when_to_use: "ワークツリーを削除したい、使い終えた作業ディレクトリを片付けたい"
argument-hint: "[WT 名]"
---

# ワークツリー削除

`worktree_remove` でワークツリーを削除する。devcontainer 内で実行すること（プロジェクトの devcontainer が整えるマウント構造に依存）。

削除は **ローカルブランチも同時に消す**（`keep_branch: true` で残せる）。リモートブランチはこのツールの対象外。

## 手順

### Step 1: remove を呼ぶ

対象リポの main WT を指して、`worktree_remove` を `name: "<NAME>"`・`directory: "<project-root>/base/<repo>"` で呼ぶ。必要なら `force: true`・`keep_branch: true` を足す。ツールは作業ディレクトリを `directory` で受けるので、`cd` しない。

`<NAME>` は `worktree_add` が付けた名前（`wt1` など）。サブ WT が機能ブランチに移っていても、この名前で削除できる。消えるローカルブランチは `<NAME>` で、機能ブランチは残る。

入力は `worktree_remove` の入力の定義で確かめる。変更が残っているサブ WT を消すときは `force: true`。

`<project-root>/<NAME>/` ディレクトリが空になれば自動で rmdir される。

### Step 2: 並行作業セットを解体する

セットに含まれる各リポで、順に `worktree_remove` を呼ぶ。

1. `name: "wt1"`・`directory: "<project-root>/base/<repo-A>"`・`force: true`
2. `name: "wt1"`・`directory: "<project-root>/base/<repo-B>"`・`force: true`

最後のリポを remove した時点で、`<project-root>/wt1/` が rmdir される。

### Step 3: リモートブランチも消す場合

remove はローカルブランチまでしか消さない。リモートの同名ブランチまで消す場合は、別途 `branch_delete` を呼ぶ。

1. `repo_ref: "<owner>/<repo-A>"`・`branch: "wt1"`
2. `repo_ref: "<owner>/<repo-B>"`・`branch: "wt1"`
