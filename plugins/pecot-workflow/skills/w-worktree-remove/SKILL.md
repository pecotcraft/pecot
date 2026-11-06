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

`pecot worktree remove` でワークツリーを削除する。devcontainer 内で実行すること（プロジェクトの devcontainer が整えるマウント構造に依存）。

削除は **ローカルブランチも同時に消す**（`--keep-branch` で残せる）。リモートブランチはこのコマンドの対象外。

## 手順

### Step 1: remove を叩く

対象リポの main WT で実行:

```bash
cd <project-root>/base/<repo>
pecot worktree remove <NAME> -D . [--force] [--keep-branch]
```

オプションは `pecot worktree remove --help`。変更が残っているサブ WT を消すときは `--force`。

`<project-root>/<NAME>/` ディレクトリが空になれば自動で rmdir される。

### Step 2: 並行作業セットを解体する

セットに含まれる各リポで、順に remove を実行する。

```bash
cd <project-root>/base/<repo-A>
pecot worktree remove wt1 -D . --force

cd <project-root>/base/<repo-B>
pecot worktree remove wt1 -D . --force
```

最後のリポを remove した時点で、`<project-root>/wt1/` が rmdir される。

### Step 3: リモートブランチも消す場合

remove はローカルブランチまでしか消さない。リモートの同名ブランチまで消す場合は、別途次を実行する。

```bash
pecot delete-branch <owner>/<repo-A> wt1
pecot delete-branch <owner>/<repo-B> wt1
```
