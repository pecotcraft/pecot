# ワークツリー環境でのPRマージ後処理

> WT後処理は `pecot pr cleanup` コマンドが自動実行します。
> 通常はこのドキュメントを参照する必要はありません。
> `--skip-local-cleanup` を使用した場合や、自動処理でエラーが発生した場合のリファレンスです。

## PRマージ後の片付け（ブランチ削除込み）

マージは `gh pr merge <番号> --repo <owner>/<repo> --squash` で行い、マージされたあとの片付けに `pecot pr cleanup` コマンドを使用します。

```bash
pecot pr cleanup <owner>/<repo>/<番号> --delete-branch
```

**オプション**:

- `--delete-branch, -d`: リモートブランチを削除
- `--dry-run, -n`: ドライラン（実際には片付けない）
- `--skip-local-cleanup`: ローカルの後処理をスキップ

## ワークツリー環境でのマージ後処理

ワークツリー環境かどうかを判定し、処理を分岐する。

### ワークツリー判定

```bash
# ワークツリーかどうか確認（git worktree listの結果を変数に格納して判定）
git worktree list
# 出力から現在のディレクトリがワークツリーかを判断

# wtX ブランチが存在するか確認
git branch
# wt1, wt2, wt3などのwtX形式のブランチがあるか確認
```

**ワークツリー環境の条件**:

1. `git worktree list`で現在のディレクトリがワークツリーとして表示される
2. `wt1`、`wt2`などの`wtX`形式のブランチが存在する

> **ブランチモードについて**: 以下で「開発ブランチ」と表記する箇所は config 由来で
> 決まる。2ブランチモードでは `develop-aist`、単一ブランチモード（`develop` == `release` /
> trunk-based）では `main`。`pecot pr preflight` の出力で
> 決定されたブランチを使えば、どちらのモードでも正しい開発ブランチに揃う。

### 通常環境（ワークツリー未使用）

デフォルトブランチ（pecot pr preflightで決定されたブランチ）に切り替え:

```bash
# デフォルトブランチに切り替え（開発ブランチ または main）
git checkout <デフォルトブランチ>
git pull <remote> <デフォルトブランチ>  # remote は origin、無ければ最初の remote
git branch -D <マージしたブランチ>
```

### ワークツリー環境

ワークツリー環境では、現在のワークツリー内で処理を完結させる。
mainワークツリーへの移動や更新は**不要**。

ワークツリー専用ブランチに切り替えて、`git pull`で開発ブランチと同期:

```bash
# 1. ワークツリー専用ブランチに切り替え
#    pecot pr preflightの出力「Current directory name:」の値を使用
#    例: wt1, wt2, wt3
git checkout <Current directory nameの値>

# 2. git pullで開発ブランチをマージ
git pull <remote> <開発ブランチ>  # remote は origin、無ければ最初の remote

# 3. マージしたローカルブランチを削除
git branch -D <マージしたブランチ>
```

> **Note**: リモートブランチは `pecot pr cleanup --delete-branch` で自動削除される。
> 手動でリモートブランチを削除する場合は:
>
> ```bash
> pecot delete-branch <owner/repo> <branch>
> ```

**禁止事項**:

- `cd`コマンドでmainワークツリーや他のワークツリーに移動しない
- mainワークツリーのブランチを更新しない
- 各ワークツリーは独立して動作する

**理由**:

- ワークツリーでは開発ブランチ（単一ブランチモードなら`main`、2ブランチモードなら`develop-aist`）に
  切り替えると他のワークツリーと競合する
- ワークツリー専用ブランチ（wt1, wt2等）をベースとして使い、`git pull`で最新を維持する
- mainワークツリーを更新したいときは、個別に更新すればよい

## 注意事項

- mainブランチからPRを作成しようとしている場合は警告してブランチ作成を提案
- ワークツリー環境では`wtX`ブランチを削除しないこと（ベースブランチ）
