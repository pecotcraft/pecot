# マージされた後の片付け

PR がマージされた後に、GitHub 側と手元を片付け、Epic と後続の Issue にコメントを書く手順。

次の場面で使う。どのスキルも、同じ中身の写しを自分の `references/after-merge.md` に持つ。

- w-pr の Step 6 で、待ち受けが `MERGED` を受けたとき
- w-merge でマージしたとき
- w-active・w-quick・w-breakdown で、`session_start` の結果に `leftovers` があったとき。前の PR の後片付けが残っている

## 片付け

pecot-workflow の MCP ツール `session_finish` を使って、マージ後の片付けをする。リモートブランチも消す（`delete_branch: true`）。

警告が出たら、その文に従って手で対応する。ワークツリー環境の手順は、この後の [ワークツリー環境での手作業](#ワークツリー環境での手作業) にある。

結果に判定の変化（`readinessChanges`）があれば、着手できるようになった Issue を利用者に伝える。
子ブランチ（`restack`）があれば、そのブランチの作業ディレクトリでスタックし直しが要ることを利用者に伝える。ほかの作業ディレクトリには入らない。

## Epic への merge-diff

PR が閉じた Issue に親 Epic があるときだけ行う。親 Epic は、pecot-workflow の MCP ツール `issue_show` で確かめる。

PR が閉じた Issue は、片付けの結果の `closedIssues` の Issue と、`skippedIssues` の `already-closed` の Issue。
`already-closed` の Issue は、`pr_show` で読む PR の closing issues にあるものだけを数える。

`session_start` の `leftovers` から来たときは、書く先を、その PR の `mergeDiff` の Epic にする。`mergeDiff` が空なら、この節は飛ばす。

1. マージした PR の変更と、Issue の本文の計画を比べる
2. pecot-workflow の MCP サーバの resource `pecot-template://comment/merge-diff` を読み、Epic 宛てのファイルを作る。frontmatter の `pr_ref` には、マージした PR を `owner/repo/N` で書く
3. テンプレのガイドに従って本文を書き、`issue_comment` を使って Epic に投稿する

計画どおりで差分が無いときも、その旨を投稿する。変更ファイルの一覧は本文に書かない。

## 後続への precede-notify

speckit 由来のタスクで、後続のフェーズに影響する変更があるときだけ行う。speckit 由来とは、Issue の本文か、親 Epic のほかのサブタスクが `specs/`・`.specify/` に触れているものを指す。

1. 通知する Issue を選ぶ。片付けの結果に判定の変化（`readinessChanges`）があれば、その Issue を選ぶ。無ければ、`issue_show` を使って親 Epic を読み、現在のタスク以外の OPEN のサブタスクを選ぶ
2. `issue_comment` を使って、その Issue 宛ての precede-notify テンプレのファイルを作る
3. テンプレのガイドに従って本文を書き、`issue_comment` を使って投稿する

## ワークツリー環境での手作業

手元の片付けは `session_finish` が行う。この節は、`skip_local_cleanup: true` を使ったときと、`session_finish` の手元の片付けが警告で止まったときのためのものだ。

`session_finish` は `pr_ref: "<owner>/<repo>/<番号>"` と `delete_branch: true` で呼ぶ。

- `delete_branch`: リモートブランチを削除
- `skip_local_cleanup`: ローカルの後処理をスキップ

### ワークツリー判定

ワークツリー環境かどうかを判定し、処理を分岐する。

```bash
# ワークツリーかどうか確認（git worktree listの結果を変数に格納して判定）
git worktree list
# 出力から現在のディレクトリがワークツリーかを判断

# wtX ブランチが存在するか確認
git branch
# wt1, wt2, wt3などのwtX形式のブランチがあるか確認
```

ワークツリー環境の条件は次の 2 つ。

1. `git worktree list`で現在のディレクトリがワークツリーとして表示される
2. `wt1`、`wt2`などの`wtX`形式のブランチが存在する

以下で「開発ブランチ」と書く箇所は、config から決まる。
2ブランチモードでは config の `develop_branch`（例: `develop`）、単一ブランチモード（`develop` == `release` / trunk-based）では `main`。
どちらのモードでも、pecot-workflow の MCP ツール `pr_check` の結果の `baseBranch` から求められる。
先頭の remote の名前と `/` を除いたブランチ（`origin/main` なら `main`）が開発ブランチだ。

### 通常環境（ワークツリー未使用）

デフォルトブランチ（`pr_check` の結果の `baseBranch` から、先頭の remote の名前と `/` を除いたブランチ。`origin/main` なら `main`）に切り替え:

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
#    pr_check の結果の `worktree.directoryName` の値を使用
#    例: wt1, wt2, wt3
git checkout <worktree.directoryName の値>

# 2. git pullで開発ブランチをマージ
git pull <remote> <開発ブランチ>  # remote は origin、無ければ最初の remote

# 3. マージしたローカルブランチを削除
git branch -D <マージしたブランチ>
```

リモートブランチは `session_finish`（`delete_branch: true`）が消す。
手で消すときは、pecot-workflow の MCP ツール `branch_delete` を使う（`repo: "<owner/repo>"`・`branch: "<branch>"`）。

**禁止事項**:

- `cd`コマンドでmainワークツリーや他のワークツリーに移動しない
- mainワークツリーのブランチを更新しない
- 各ワークツリーは独立して動作する

**理由**:

- ワークツリーでは開発ブランチ（単一ブランチモードなら`main`、2ブランチモードなら`develop_branch` の値）に切り替えると、他のワークツリーと競合する
- ワークツリー専用ブランチ（wt1, wt2等）をベースとして使い、`git pull`で最新を維持する
- mainワークツリーを更新したいときは、個別に更新すればよい

**注意事項**:

- mainブランチからPRを作成しようとしている場合は警告してブランチ作成を提案
- ワークツリー環境では`wtX`ブランチを削除しないこと（ベースブランチ）
